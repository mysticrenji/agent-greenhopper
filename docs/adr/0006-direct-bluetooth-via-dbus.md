# ADR 0006: Direct Raspberry Pi Bluetooth through D-Bus

Date: 2026-08-24

Status: Accepted

## Context

Home Assistant and `cloudflared` run as Kubernetes pods on a Raspberry Pi. The
actual deployment uses the Raspberry Pi Bluetooth adapter, not ESPHome Bluetooth
proxies. Mi Flora sensors need passive Bluetooth advertisements for their soil
signals and an active connection for battery telemetry.

## Decision

BlueZ runs on the Raspberry Pi host. The Home Assistant pod is privileged and
mounts the host system D-Bus socket at `/run/dbus` read-only. Kubernetes schedules
the pod onto the node that owns the Bluetooth adapter.

The Worker remains isolated from Bluetooth: it reads Home Assistant only through
the private Workers VPC Service and has no path to the host D-Bus socket.

## Consequences

Good:

- No ESPHome proxy hardware, firmware, or Wi-Fi placement is required.
- Passive Mi Flora broadcasts and active battery reads are available through the
  local adapter.
- BLE traffic remains entirely inside the home network.

Costs:

- The privileged HA pod is a larger trust boundary than the former proxy design.
- HA has node affinity: moving the pod away from the Raspberry Pi removes BLE
  access.
- Bluetooth range is fixed by the Raspberry Pi's location; walls and distance
  can require a future hardware/topology change.

## Replaces

The BLE-ingestion decision in ADR 0005. Its Cloudflare Tunnel and Workers VPC
decisions remain in force.
