# Terraform / IaC deployment

Infrastructure-as-code for the Cloudflare side of agent-greenhopper. Provisions
everything except the Worker code itself (that's handled by `wrangler deploy`).

## What it creates

| Resource | Terraform type | Purpose |
| --- | --- | --- |
| Cloudflare Tunnel | `cloudflare_zero_trust_tunnel_cloudflared` | Private path from Workers to your cluster |
| VPC Service | `cloudflare_connectivity_directory_service` | Pins Workers to HA's host:port, prevents SSRF |
| D1 Database | `cloudflare_d1_database` | Long-term readings, alert state, audit log |
| MCP Access application | `cloudflare_zero_trust_access_application` | Email and service-token authentication for MCP |
| R2 Bucket | `cloudflare_r2_bucket` | Terraform state storage (S3-compatible) |

## State stored in R2

Terraform state lives in a Cloudflare R2 bucket using the S3-compatible backend.
This keeps the entire system self-contained within Cloudflare — no AWS account
needed.

**Bootstrap (one-time, before `terraform init`):**

```bash
# Create the state bucket manually (chicken-and-egg problem)
wrangler r2 bucket create greenhopper-tfstate

# Create a scoped R2 API token:
#   Dashboard → R2 → Manage R2 API tokens → Create API token
#   Permissions: Object Read & Write
#   Scope: greenhopper-tfstate bucket only
#   Save the Access Key ID and Secret Access Key
```

## Usage

```bash
cd deploy/terraform

# Copy and fill in variables
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your account_id and Home Assistant hostname/port

# Set R2 backend credentials (never in tfvars — these are for the state bucket)
export AWS_ACCESS_KEY_ID="<R2 token access key>"
export AWS_SECRET_ACCESS_KEY="<R2 token secret key>"
export AWS_ENDPOINT_URL_S3="https://<account_id>.r2.cloudflarestorage.com"

# Set Cloudflare provider auth
export CLOUDFLARE_API_TOKEN="<your API token>"

# Initialise (connects to R2 for state)
terraform init

# Preview changes
terraform plan

# Apply
terraform apply
```

`mcp_service_token_id` is the service token's Cloudflare resource ID, not its
Client ID ending in `.access`. Find it under **Zero Trust → Access → Service
Auth → Service Tokens**, or retrieve it from the Access API. Terraform uses the
ID to create a `Service Auth` policy (`decision = "non_identity"`) on the MCP
application; MCP clients continue to send the corresponding Client ID and
Client Secret as request headers.

## After apply

Terraform outputs the values you need for the next steps:

```bash
# Get the tunnel token for Kubernetes
terraform output -raw tunnel_token
# → Store as: kubectl -n greenhopper create secret generic cloudflared-tunnel --from-literal=token='<value>'

# Get the VPC Service ID and D1 Database ID for wrangler.jsonc
terraform output vpc_service_id
terraform output d1_database_id
```

Then update `workers/mcp/wrangler.jsonc` and `workers/agent/wrangler.jsonc` with
those IDs, and deploy the Workers:

```bash
cd ../../workers/mcp && wrangler deploy
cd ../agent && wrangler deploy
```

The MCP Wrangler configuration is intentionally bound to the Access-protected
custom domain and disables both `workers.dev` and preview URLs. Keep that custom
domain identical to `mcp_worker_domain`; deploying an alternate public hostname
would bypass the hostname-scoped Access application.

## What it does NOT manage

- **Worker code deployments** — handled by `wrangler deploy`, which is faster
  iteration than Terraform for code changes.
- **D1 schema migrations** — run via `wrangler d1 execute` (the migration SQL is
  in `packages/storage/migrations/`).
- **Worker secrets** (HASS_TOKEN, HASS_BASE_URL) — managed via `wrangler secret put`.
- **The Kubernetes cloudflared Deployment** — that's in `deploy/kubernetes/`.
  Terraform creates the tunnel; Kubernetes runs the connector.

This separation is deliberate: infrastructure changes (tunnel, VPC service, D1
database) are infrequent and benefit from plan/apply review. Code and config
changes are frequent and benefit from `wrangler deploy`'s speed.

## Required Cloudflare API token permissions

Create a single API token with these permissions:

| Permission | Scope |
| --- | --- |
| Account > Workers R2 Storage > Edit | For the state bucket |
| Account > Cloudflare Tunnel > Edit | To create/manage the tunnel |
| Account > D1 > Edit | To create the database |
| Account > Workers Scripts > Edit | If you later add Worker resources |
| Account > Access: Apps and Policies > Edit | To manage the MCP Access application and policies |
| Account > Access: Service Tokens > Read | To look up the service token resource ID |

## Security notes

- `terraform.tfvars` contains the tunnel secret — **never commit it**.
- The R2 API token for the state backend is separate from the Cloudflare API
  token used by the provider. Scope it to only the state bucket.
- State may contain sensitive outputs (tunnel token). R2 encrypts at rest, but
  consider enabling bucket-level access policies if multiple people access the
  account.
- The MCP Worker verifies the Cloudflare Access JWT signature, issuer, audience,
  and expiry against the team's JWKS. Set `CF_ACCESS_TEAM_DOMAIN` and
  `CF_ACCESS_AUD` as Worker secrets before deployment.
