# AGENTS.md

Context file for AI coding agents and new contributors. **Update this file in the
same change as any structural decision, new package, new dependency, or altered
convention.** It is the fastest path to understanding this repository; if it goes
stale it becomes a liability.

Last updated: 2026-08-22 · Status: foundation + domain layer complete (alert-only)

---

## 1. What this project is

`agent-greenhopper` monitors houseplants. Xiaomi Mi Flora (HHCCJCY01) sensors
report to Home Assistant on a Raspberry Pi. An agent running on Cloudflare
Workers reads that data hourly, assesses plant health, and **notifies a human**.
A remote MCP server exposes the same read capabilities to external clients such
as Claude, ChatGPT, or Kiro.

**This system does not water plants.** It is observe-and-notify only; there is no
pump, no switch, and no write path to Home Assistant. See ADR 0003. Adding
actuation is a scope change requiring a new ADR.

Home Assistant is **not** exposed to the internet. Workers reach it privately
through Workers VPC over an existing Cloudflare Tunnel.

Full design rationale: [`docs/architecture.md`](docs/architecture.md).

## 2. Monitored signals

Five measurement domains. Three are misleading if compared raw against a
threshold, so the domain layer converts them first:

| Signal | Source | Derived into |
| --- | --- | --- |
| Soil moisture | Mi Flora | dry-down slope (%/day), time-to-threshold |
| Soil temperature | Mi Flora | rolling min/max |
| Sunlight (lux) | Mi Flora | DLI, integrated over the photoperiod |
| Fertility (EC) | Mi Flora | value normalised to a reference moisture |
| Air temp + humidity | **separate room sensor** | VPD |

Mi Flora cannot measure air humidity. VPD therefore requires a second sensor per
room (for example `LYWSD03MMC`).

## 3. Repository layout

```
packages/domain/     Pure logic: signals, metrics, assessment rules, alert policy.
                     Depends on nothing but zod. Fully unit tested.
packages/hass/       Home Assistant adapter. READ-ONLY except notification send.
packages/storage/    D1 schema, migrations, repositories. Tested against real SQLite.
workers/mcp/         Remote MCP server (createMcpHandler, SDK v2, stateless).
workers/agent/       Scheduled cron Worker: assess → alert → notify pipeline.
deploy/kubernetes/   cloudflared Deployment + NetworkPolicy for Workers VPC.
deploy/terraform/    IaC: Tunnel, VPC Service, D1, R2 state bucket. State in R2.
docs/                Architecture, ADRs, diagrams.
```

### packages/domain modules

| Module | Responsibility |
| --- | --- |
| `signals.ts` | The five signals, per-signal staleness budgets, plausible ranges, pinned-probe detection |
| `metrics.ts` | VPD, DLI, dry-down slope, moisture-normalised EC |
| `plant.ts` | zod profile/registry schemas and per-species targets |
| `assess.ts` | Deterministic rules producing severity-tagged findings, plus the `escalate` flag |
| `alerts.ts` | Alert policy: dedup, re-notify intervals, escalation, recovery, quiet hours |
| `guardrails.ts` | **DORMANT.** Watering safety. Not exported; no caller. See ADR 0003 |

### packages/hass modules

| Module | Responsibility |
| --- | --- |
| `transport.ts` | Minimal structural `HttpFetch` — no DOM or Workers types. Throws `HassError` |
| `schema.ts` | zod schemas for HA REST; `toSample` handles `unavailable`/`unknown` |
| `entities.ts` | Mi Flora + climate-sensor entity ID mapping, registry schema; battery is optional when HA does not expose it |
| `reader.ts` | `HassReader`: states, latest samples, history. **No `callService`** |
| `notifier.ts` | `HassNotifier`: `notify.*` only, service name validated against escape |
| `services.ts` | Discovers available `notify.*` targets; resolves one with a documented preference order |
| `diagnostics.ts` | `checkSetup`: proves entity IDs, firmware adequacy and VPD availability empirically |
| `observations.ts` | Builds the domain `PlantObservation`; EC/moisture pairing; watering inference |

### packages/storage modules

| Module | Responsibility |
| --- | --- |
| `d1.ts` | Structural `D1Like` types (no Cloudflare import) and 15-minute bucket alignment |
| `readings.ts` | `ReadingsRepository` + `rollupSeries`: wide rollup table, COALESCE upsert, per-signal series |
| `alertState.ts` | `AlertStateRepository`: round-trips the domain `AlertState`; scoped replace implements resolution |
| `notifications.ts` | `NotificationLog`: append-only audit of notify/suppress/resolve |
| `testing/sqlite.ts` | `D1Like` over `node:sqlite`. **Separate entry point** — never import from `index.ts` |

Storage tests run the real migration DDL and real queries against real SQLite via
`node:sqlite`, because D1 *is* SQLite. A mistyped column or a broken `ON CONFLICT`
fails the suite rather than production. Reach the adapter through
`@greenhopper/storage/testing`; importing it from the package root would put
`node:sqlite` in a Worker bundle, where it does not exist.

### Schema notes worth knowing before editing

- Timestamps are **unix milliseconds** everywhere, matching the domain exactly.
- `readings` is deliberately **wide** (a column per signal) rather than narrow.
  D1 bills rows read and written; the narrow shape would multiply both by seven
  for a fixed set of signals. Air temp and humidity are duplicated across plants
  sharing a room sensor — intentional, so every query stays single-table.
- The upsert uses `COALESCE(excluded.x, readings.x)`. Without it, a later write
  carrying no battery reading would erase the stored one, since battery arrives
  once a day while soil signals arrive every minute.
- Battery telemetry is optional at the entity-mapping boundary: some BLE integrations
  expose no battery entity. When absent, it is neither requested nor assessed; it is
  never substituted with RSSI.
- Resolved alerts are **deleted**, not flagged. The domain treats absent state as
  "new", which is exactly what should happen when a problem recurs after clearing.

### Two questions the code answers instead of the operator

Both were open configuration questions; both are now self-resolving.

- **Notify service name.** `listNotifyServices()` reads `/api/services` and
  `resolveNotifyTarget()` picks one: an explicitly configured service if it
  exists, else any `mobile_app_*` (push to a phone is the point of alerting),
  else `persistent_notification`, which is always present. Configuration is
  optional and a renamed phone degrades gracefully with a loud log line rather
  than silently losing alerts.
- **Mi Flora firmware version.** Home Assistant's docs state that firmware below
  3.2.1 sends no usable BLE beacons, so the contrapositive settles it: if all four
  soil signals report numeric values, the firmware is adequate. `checkSetup()`
  asserts exactly that, so nobody needs to open the Flower Care app.

## 4. Layering rule (important)

Dependencies point **inward only**:

```
workers/*  ->  packages/hass, packages/storage  ->  packages/domain
```

- `packages/domain` must never import Cloudflare, Home Assistant, or storage
  types. If you are tempted, the logic belongs in an adapter instead.
- `packages/hass` must not import Cloudflare types either. It compiles with
  `lib: ES2022` and `types: []`, so `fetch`, `Response` and even
  `URLSearchParams` are unavailable by design — the transport is a structural
  `HttpFetch` the composition root supplies. That is what keeps it testable with
  a plain object literal and no runtime.
- Workers are composition roots. They wire adapters to domain logic and own
  configuration; they should contain little logic of their own.

A violation of this rule is a review blocker, not a preference.

## 5. Commands

```bash
pnpm install          # Corepack pins pnpm; do not use npm or yarn
pnpm verify           # lint + typecheck + test — run before every commit
pnpm lint             # Biome check
pnpm lint:fix         # Biome check --write
pnpm typecheck        # tsc --build across project references
pnpm test             # Vitest, all packages
pnpm test:watch
pnpm test:coverage    # enforces thresholds on domain and graph
```

`pnpm install` configures Git to use the tracked `.githooks/` directory. Its
`pre-commit` hook runs `pnpm run lint` before every commit. Run
`pnpm run prepare` to configure the hook manually when package lifecycle
scripts were skipped.

## 6. Toolchain and versions

Pinned deliberately for reproducibility across environments. Change these only
in a dedicated commit.

| Tool | Version | Notes |
| --- | --- | --- |
| Node | >= 22 (`.nvmrc`: 24) | |
| pnpm | 11.22.0 | pinned via `packageManager`, activated by Corepack |
| TypeScript | 6.0.3 | deliberately not 7.x — see ADR 0002 |
| Biome | 2.5.8 | lint + format in one tool |
| Vitest | 4.1.10 | |
| zod | 4.4.3 | only runtime dependency of the domain layer |

## 7. Coding standards

Enforced by Biome and `tsconfig.base.json`; CI fails on violations.

- TypeScript strict, plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUnusedLocals`.
  Array indexing yields `T | undefined` — handle it, do not assert.
- `any` is an error. Non-null assertions (`!`) are an error.
- Single quotes, semicolons, trailing commas, 100-column lines, 2-space indent.
- Cognitive complexity is capped at 12. When it trips, extract a function; do
  not suppress the rule.
- Use `.js` extensions on relative imports (ESM + `verbatimModuleSyntax`).
- Prefer pure total functions that return `null` for "insufficient input" over
  functions that throw. Callers then handle absent data explicitly.

### Comments

Comment **why**, not what. Explain non-obvious domain reasoning — for example why
EC must be compared at matched moisture, or why battery has a 48-hour staleness
budget. Do not narrate code that already reads clearly.

## 8. Testing conventions

- Tests live beside source as `*.test.ts`.
- Test behaviour through the public surface, not private helpers.
- Every test needs a reason to exist. Name it after the behaviour being
  guaranteed, not the function being called.
- Build fixtures with small helpers that take overrides, so each test varies one
  thing. See `guardrails.test.ts` for the pattern.
- Safety-critical modules (`guardrails.ts`) are held at 100% coverage.
- Coverage floors: 90% statements / 85% branches on `domain` and `graph`.

## 9. Safety invariants

The system is read-only against Home Assistant. That is the primary safety
property and it must not erode: no code in `packages/hass` may issue a write, and
no MCP tool may mutate state. See ADR 0003.

The remaining invariants concern not drowning the user in noise, which is the
real failure mode of an alert-only system. All are enforced in
`packages/domain/src/alerts.ts`, never in a prompt:

1. An unchanged condition must not re-notify inside its severity's interval.
2. A condition that worsens notifies immediately, overriding the interval.
3. Quiet hours suppress warnings but **never** suppress critical findings.
4. A condition that was reported and then clears produces exactly one recovery
   notice, and its state is cleared so a recurrence alerts as new.
5. A condition that was never reported must not produce a recovery notice.
6. Do not assess plant condition from a probe already flagged as faulty —
   confident nonsense is worse than no answer (`assess.ts`).

`guardrails.ts` holds the dormant watering constraints (deny by default, never
water blind, never water on a sensor fault, cooldown, duration cap, rolling 24h
limit, kill switch). It has no caller. Do not wire it up without a new ADR.

## 10. Model and cost posture

Reasoning model: **`@cf/ibm-granite/granite-4.0-h-micro`** on Workers AI, routed
through AI Gateway rather than the bare `AI` binding so that spend limits and
rate limits apply. 131k context, function calling, ~921 Neurons/day for the
hourly loop — 9% of the free 10,000/day allocation. See ADR 0004.

The model ID lives in configuration, never inline. Cloudflare cost is therefore
the $5 Workers Paid minimum with inference effectively free.

Deterministic rules run first and the model is consulted only when `assess()`
returns `escalate: true`. That gating is roughly a 25x cost reduction and is the
reason the flag exists. Hard caps and the alert/budget distinction:
[`docs/architecture.md`](docs/architecture.md).

## 11. Decisions

Recorded as ADRs in [`docs/adr/`](docs/adr/). Add one for any choice a future
reader would otherwise question.

## 12. Open questions

Carry these until answered; they gate later phases.

- None currently blocking. Configuration that used to be an open question is now
  discovered at runtime — see "Two questions the code answers" in section 3.

### Settled

- Watering actuation: **out of scope** (ADR 0003).
- Model: **`@cf/ibm-granite/granite-4.0-h-micro`** via AI Gateway (ADR 0004).
- Graph/DAG execution engine: **dropped**, not wanted.
- Deployment: **Kubernetes**. HA and `cloudflared` both run as pods; manifests in
  `deploy/kubernetes/`. `cloudflared` image tag is pinned to satisfy the Workers
  VPC >= 2025.7.0 requirement, with a fixed replica count and no autoscaling
  (ADR 0005).
- BLE ingestion: **ESPHome ESP32 Bluetooth proxies**, not host Bluetooth. A
  containerised HA would otherwise need a D-Bus mount plus `NET_ADMIN`/`NET_RAW`
  and would run in a degraded mode that drops raw advertising data — which is
  exactly what Mi Flora relies on. Shelly and SMLIGHT proxies are unsuitable:
  they cannot make active connections, so battery level would be lost (ADR 0005).
- Time zone: **`Europe/Amsterdam`**, quiet hours 22:00–07:00 local, DST-aware.

## 13. Known gaps

Tracked deliberately rather than forgotten.

- `PROBE_UNRESPONSIVE` in `assess.ts` needs `lastWateredAt`, which
  `inferLastWatering` derives from a moisture jump. A *completely* dead probe
  shows no jump, so no watering is inferred and the check cannot fire —
  circular. A flat-line detector (zero variance over many hours on a live plant)
  is the non-circular signal and is not yet implemented.
