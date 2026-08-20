# ADR 0003: Alert-only — no automatic watering

Date: 2026-08-17
Status: Accepted
Supersedes: the actuation assumptions in earlier drafts of `docs/architecture.md`

## Context

The original design included watering a plant through a Home Assistant switch,
gated by pure guardrails in `packages/domain/src/guardrails.ts`.

The owner has decided the system should observe and notify only. Nothing in the
deployment will actuate hardware.

## Decision

No actuation. The agent assesses and alerts; a human waters.

Concretely:

- No `water_plant` MCP tool, no switch entity, no pump in the topology.
- `packages/hass` gets read access only. Any write capability is a scope change
  requiring a new ADR.
- `guardrails.ts` is retained but **dormant**: it is not exported from
  `src/index.ts` and no code path reaches it. It stays tested and correct so that
  adding actuation later is a wiring exercise, not a fresh design of safety logic.
- The domain gains `alerts.ts`, which is now the load-bearing policy module.

## Why the alert policy matters more than it sounds

Removing actuation does not reduce the domain logic; it relocates it. The agent
runs hourly, but a plant that is too dry stays too dry for days. Naively
notifying on every finding sends the same message 24 times a day and trains the
owner to ignore it. Alert fatigue — not missed detection — is the failure mode
that kills a monitoring system, and it is the mirror image of the risk that
guardrails addressed: previously the danger was acting too often, now it is
speaking too often.

`alerts.ts` therefore implements per-(plant, finding) suppression with
severity-scaled re-notify intervals, immediate delivery when a condition worsens,
recovery notices, and quiet hours that critical findings override.

## Consequences

Good:

- Materially smaller blast radius. The worst outcome is now a missed or noisy
  notification, not a drowned plant or water damage.
- No pump, relay, or plumbing to buy, install, or fail.
- The safety argument reduces to "does not write", which is trivially auditable.

Costs:

- The owner must act on alerts; the system cannot help a plant on its own.
- `guardrails.ts` is code with no caller. Justified by the low cost of keeping a
  pure, fully covered module against the high cost of redesigning safety logic
  under pressure later. Revisit if it starts drifting from reality.

## Revisit when

The owner wants unattended watering — for example before a holiday. At that
point: re-export `guardrails.ts`, add the write path to `packages/hass`, add the
KV kill switch, and write the ADR that supersedes this one.
