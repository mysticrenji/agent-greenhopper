# Terraform infrastructure for agent-greenhopper
#
# Deploys all Cloudflare-side infrastructure:
#   - Cloudflare Tunnel (remotely-managed)
#   - VPC Service pointing at Home Assistant
#   - D1 database
#   - R2 bucket for Terraform state
#
# State is stored in a Cloudflare R2 bucket (S3-compatible backend), so the
# entire system is self-contained within Cloudflare — no AWS account needed.
#
# Usage:
#   cd deploy/terraform
#   terraform init
#   terraform plan
#   terraform apply
#
# Prerequisites:
#   - Cloudflare API token with: Account > Workers R2 Storage > Edit,
#     Account > Cloudflare Tunnel > Edit, Account > D1 > Edit,
#     Account > Workers Scripts > Edit
#   - An R2 bucket already created for state (chicken-and-egg: create manually once)
#   - cloudflared running in Kubernetes (deploy/kubernetes/cloudflared.yaml)

terraform {
  required_version = ">= 1.5"

  # State stored in Cloudflare R2 — S3-compatible, no AWS needed.
  # Create the bucket once manually:
  #   wrangler r2 bucket create greenhopper-tfstate
  # Then create an R2 API token scoped to that bucket with Object Read & Write.
  backend "s3" {
    bucket = "greenhopper-tfstate"
    key    = "cloudflare/terraform.tfstate"
    region = "auto"

    # Required for R2 compatibility — disables S3-specific validation
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true

    # Set these via environment variables:
    #   AWS_ACCESS_KEY_ID     = <R2 API token access key>
    #   AWS_SECRET_ACCESS_KEY = <R2 API token secret key>
    # endpoints.s3 via:
    #   AWS_ENDPOINT_URL_S3   = https://<account_id>.r2.cloudflarestorage.com
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.19"
    }
  }
}

# Authentication via CLOUDFLARE_API_TOKEN env var
provider "cloudflare" {}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "account_id" {
  type        = string
  description = "Cloudflare account ID"
}

variable "ha_hostname" {
  type        = string
  description = "In-cluster hostname of Home Assistant (e.g. home-assistant.home-assistant.svc.cluster.local)"
  default     = "home-assistant.home-assistant.svc.cluster.local"
}

variable "ha_port" {
  type        = number
  description = "HTTP port of Home Assistant"
  default     = 8123
}

variable "mcp_worker_domain" {
  type        = string
  description = "Public domain of the MCP worker (e.g. greenhopper-mcp.mysubdomain.workers.dev)"
}

variable "allowed_emails" {
  type        = list(string)
  description = "Email addresses allowed to access the MCP endpoint via Cloudflare Access"
}

variable "create_tunnel" {
  type        = bool
  description = "Whether Terraform creates the Cloudflare Tunnel; set false to use an existing tunnel"
  default     = true
}

variable "existing_tunnel_id" {
  type        = string
  description = "Existing Cloudflare Tunnel ID to use when create_tunnel is false"
  default     = null
  nullable    = true
}

# ---------------------------------------------------------------------------
# Cloudflare Tunnel (remotely-managed)
# ---------------------------------------------------------------------------

resource "cloudflare_zero_trust_tunnel_cloudflared" "greenhopper" {
  count = var.create_tunnel ? 1 : 0

  account_id = var.account_id
  name       = "greenhopper"
  config_src = "cloudflare"
}

locals {
  tunnel_id = var.create_tunnel ? cloudflare_zero_trust_tunnel_cloudflared.greenhopper[0].id : coalesce(
    var.existing_tunnel_id,
    "",
  )
}

# Kubernetes runs cloudflared with a remotely-managed tunnel token rather than
# a credentials file, so retrieve the token Cloudflare generates for this tunnel.
data "cloudflare_zero_trust_tunnel_cloudflared_token" "greenhopper" {
  account_id = var.account_id
  tunnel_id  = local.tunnel_id

  lifecycle {
    precondition {
      condition     = var.create_tunnel || local.tunnel_id != ""
      error_message = "existing_tunnel_id must be set when create_tunnel is false."
    }
  }
}

# ---------------------------------------------------------------------------
# VPC Service — the private path from Workers to Home Assistant
# ---------------------------------------------------------------------------

resource "cloudflare_connectivity_directory_service" "home_assistant" {
  account_id = var.account_id
  name       = "home-assistant"
  type       = "http"
  http_port  = var.ha_port

  host = {
    hostname = var.ha_hostname
    resolver_network = {
      tunnel_id = local.tunnel_id
      # resolver_ips omitted: cloudflared uses cluster DNS automatically
    }
  }
}

# ---------------------------------------------------------------------------
# D1 Database
# ---------------------------------------------------------------------------

resource "cloudflare_d1_database" "greenhopper" {
  account_id = var.account_id
  name       = "greenhopper"
  read_replication = {
    mode = "disabled"
  }
}

# ---------------------------------------------------------------------------
# R2 Bucket for Terraform state (declared here for documentation, but must
# exist BEFORE `terraform init` — bootstrap manually with wrangler)
# ---------------------------------------------------------------------------

# resource "cloudflare_r2_bucket" "tfstate" {
#   account_id = var.account_id
#   name       = "greenhopper-tfstate"
#   location   = "EEUR"
# }

# ---------------------------------------------------------------------------
# Cloudflare Access — protect the MCP endpoint
# ---------------------------------------------------------------------------

resource "cloudflare_zero_trust_access_application" "mcp" {
  account_id = var.account_id
  name       = "greenhopper-mcp"
  type       = "self_hosted"

  session_duration = "24h"

  destinations = [{
    type = "public"
    uri  = "https://${var.mcp_worker_domain}/mcp"
  }]

  policies = [{
    name       = "Allow configured emails"
    decision   = "allow"
    precedence = 1

    include = [
      for allowed_email in var.allowed_emails : {
        email = {
          email = allowed_email
        }
      }
    ]
  }]
}

# ---------------------------------------------------------------------------
# Outputs — feed these into wrangler.jsonc or CI
# ---------------------------------------------------------------------------

output "tunnel_id" {
  value       = local.tunnel_id
  description = "Tunnel ID — use in the Kubernetes cloudflared deployment"
}

output "tunnel_token" {
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.greenhopper.token
  description = "Tunnel token — store as Kubernetes secret 'cloudflared-tunnel'"
  sensitive   = true
}

output "vpc_service_id" {
  value       = cloudflare_connectivity_directory_service.home_assistant.service_id
  description = "VPC Service ID — put in wrangler.jsonc vpc_services[].service_id"
}

output "d1_database_id" {
  value       = cloudflare_d1_database.greenhopper.id
  description = "D1 Database ID — put in wrangler.jsonc d1_databases[].database_id"
}

output "cf_access_aud" {
  value       = cloudflare_zero_trust_access_application.mcp.aud
  description = "Cloudflare Access AUD tag — set as CF_ACCESS_AUD secret in the MCP worker"
}
