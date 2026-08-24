# Kubernetes deployment

Manifests for the in-cluster half of `agent-greenhopper`. Home Assistant itself is
assumed to already be running; only `cloudflared` is defined here, because it is
the piece the Cloudflare side depends on.

## What lives where

| File | Purpose |
| --- | --- |
| `cloudflared.yaml` | Namespace + Deployment providing the Workers VPC path to Home Assistant |
| `networkpolicy-cloudflared.yaml` | Egress rules — apply only if your CNI enforces NetworkPolicy |

## Apply

```bash
# 1. Create the tunnel in the Cloudflare dashboard (Workers VPC > Tunnels) and
#    copy its token. Never commit this.
kubectl create namespace greenhopper
kubectl -n greenhopper create secret generic cloudflared-tunnel \
  --from-literal=token='<tunnel-token>'

# 2. Deploy.
kubectl apply -f cloudflared.yaml
kubectl apply -f networkpolicy-cloudflared.yaml   # optional

# 3. Confirm the tunnel registered.
kubectl -n greenhopper logs -l app.kubernetes.io/name=cloudflared --tail=50
```

Look for `Registered tunnel connection` and a `protocol=quic` connection. If it
falls back to HTTP/2, Workers VPC will not work — see troubleshooting below.

## Then create the VPC Service

In the Cloudflare dashboard, create a VPC Service of type `http` pointing at Home
Assistant's in-cluster address through this tunnel:

```jsonc
{
  "type": "http",
  "name": "home-assistant",
  "http_port": 8123,
  "host": {
    "hostname": "home-assistant.home-assistant.svc.cluster.local",
    "resolver_network": {
      "tunnel_id": "<your-tunnel-id>"
      // resolver_ips omitted on purpose: cloudflared uses its own pod resolver,
      // which is cluster DNS, so Service names resolve without extra config.
    }
  }
}
```

Bind the resulting service ID in the Worker's `wrangler.jsonc`:

```jsonc
{
  "vpc_services": [
    { "binding": "HASS", "service_id": "<vpc-service-id>", "remote": true }
  ]
}
```

## Constraints worth not rediscovering the hard way

**Pin the image tag.** Workers VPC requires `cloudflared` >= 2025.7.0. Tracking
`:latest` means an unrelated upgrade can move a version-sensitive dependency.

**Do not autoscale.** Cloudflare's guidance is that removing a replica breaks the
connections it held, and that replicas do not load-balance — they are for
availability only. There is deliberately no HorizontalPodAutoscaler here.

**QUIC is mandatory.** Outbound UDP 7844 must be permitted. A default-deny egress
policy without that rule produces a tunnel that never registers, and the failure
surfaces in the Worker as a generic connection error rather than anything pointing
at the network.

**Home Assistant uses host Bluetooth through D-Bus.** The privileged HA pod mounts
the Raspberry Pi host's `/run/dbus` socket read-only and must run on the node with
the Bluetooth adapter. See [ADR 0006](../../docs/adr/0006-direct-bluetooth-via-dbus.md).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Tunnel logs show `protocol=http2` | UDP 7844 blocked; QUIC fell back |
| Worker `fetch` throws immediately | VPC Service host/port does not match the HA Service |
| `401` from Home Assistant | Long-lived token expired or wrong |
| Tunnel registers, HA unreachable | NetworkPolicy missing the HA namespace egress rule |
