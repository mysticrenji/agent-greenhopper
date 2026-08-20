# ADR 0005: Container deployment topology and BLE ingestion via ESPHome proxies

Date: 2026-08-17
Status: Accepted

## Context

The owner runs Home Assistant and `cloudflared` as separate containers ("pods"),
not Home Assistant OS. Time zone is `Europe/Amsterdam`.

This resolves two open questions and surfaces a constraint that is not obvious
from the Cloudflare side of the design.

## Decisions

### 1. `cloudflared` version is directly controllable — no add-on constraint

Because `cloudflared` runs as its own container, its version is pinned by image
tag. Workers VPC requires **>= 2025.7.0** and QUIC transport. This would have been
awkward on Home Assistant OS, where `cloudflared` typically arrives as a
community add-on whose version lags. It is a non-issue here.

Requirements to hold:

- Pin the image tag; do not track `:latest`.
- Transport must be `auto` or `quic`, with egress UDP 7844 permitted.
- Do **not** autoscale the `cloudflared` deployment. Cloudflare's guidance is that
  downscaling breaks existing connections and replicas do not load-balance —
  replicas exist for availability only. Use a fixed replica count.

### 2. The VPC Service targets Home Assistant by in-cluster DNS name

`cloudflared` and Home Assistant share a cluster, so the tunnel can reach HA on
its internal Service address, for example
`home-assistant.<namespace>.svc.cluster.local:8123`.

Configure the VPC Service as `type: http` with a `hostname` host and
`resolver_network.tunnel_id` set to the tunnel. A `resolver_ips` override is
usually unnecessary: when omitted, `cloudflared` uses its own default system
resolver, which inside a pod is the cluster DNS service. Home Assistant therefore
needs no public hostname, no Ingress, and no NodePort.

### 3. Mi Flora data arrives via ESPHome Bluetooth proxies, not host Bluetooth

**This is the significant finding.** Home Assistant Container does not get
Bluetooth for free. Per Home Assistant's Bluetooth documentation, a containerised
install requires all of:

- the host running BlueZ (>= 5.63 recommended) with `dbus-broker`,
- the D-Bus socket mounted into the container (`/run/dbus:/run/dbus:ro`),
- the `NET_ADMIN` and `NET_RAW` capabilities granted to the container.

Without the capabilities, Bluetooth runs in a documented degraded mode where
"raw advertising data will be missing, causing unreliable updates for your
devices". Mi Flora depends entirely on passive advertisements, so degraded mode
directly undermines the data this project is built on.

In an orchestrated container environment this also pins the HA pod to whichever
node physically holds the Bluetooth adapter (node affinity), and couples BLE
range to that node's location in the house.

Home Assistant's own documentation recommends the alternative for precisely this
situation: *"a better approach than a directly connected adapter or card is to use
a Bluetooth proxy using an ESP32... particularly interesting to users who
virtualize their instance."*

**Decision:** ingest BLE through one or more ESPHome Bluetooth proxies. The HA pod
then needs no D-Bus mount, no elevated capabilities, and no node affinity, and BLE
coverage becomes a placement problem solved by putting cheap ESP32s near the
plants.

**Hardware constraint that follows:** the proxies must be **ESP32 devices running
ESPHome**, not Shelly or SMLIGHT. Mi Flora battery level can only be read over an
active BLE connection, and per HA's supported-adapter table only ESPHome proxies
support active connections (single connection from firmware 2022.9.3, multiple
from 2022.11.0). Shelly Gen2+ and SMLIGHT SLZB-U are advertisement-listening only,
which would silently cost the battery signal. Ethernet-powered ESP32 proxies
(for example Olimex ESP32-POE-ISO-EA) rank highest in HA's own performance list.

### 4. Alert policy time zone

`DEFAULT_ALERT_POLICY.timeZone` is `Europe/Amsterdam`, quiet hours 22:00–07:00
local. The IANA name matters: Amsterdam alternates CET/CEST, and a fixed +01:00
offset would shift quiet hours by an hour for half the year. A regression test
asserts correct behaviour on both sides of the DST boundary.

## Consequences

Good:

- The `cloudflared` version requirement for Workers VPC is trivially satisfiable.
- Home Assistant needs no public exposure at all — no Ingress, no NodePort.
- The HA pod stays unprivileged and freely schedulable, which is a meaningful
  security and operability win over mounting D-Bus and granting `NET_ADMIN`.
- BLE range stops being tied to server placement.

Costs:

- Requires buying ESP32 hardware (one per area with plants).
- The proxies are additional devices to flash, power, and keep on the network.
- Wi-Fi-connected proxies rank below Ethernet ones for reliability; PoE variants
  cost more.

## Open

Resolved: the runtime is **Kubernetes**. Manifests live in
[`deploy/kubernetes/`](../../deploy/kubernetes/) — a pinned `cloudflared`
Deployment with a fixed replica count, no HorizontalPodAutoscaler, explicit
`--protocol quic`, and an optional NetworkPolicy that documents the UDP 7844
egress requirement.
