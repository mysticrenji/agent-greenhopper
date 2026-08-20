# ADR 0001: Layered monorepo with an inward dependency rule

Date: 2026-08-17
Status: Accepted

## Context

The system spans a Raspberry Pi, Home Assistant, Cloudflare Workers, D1, and an
LLM. The interesting logic — when a plant needs water, whether a probe is dead —
is small, but it is surrounded by a great deal of infrastructure. If that logic
lives inside Worker handlers it becomes slow to test, impossible to reuse, and
entangled with Cloudflare types.

Two Workers also need the *same* capabilities: the MCP server exposes them to
external clients, and the scheduled agent consumes them internally.

## Decision

A pnpm workspace with dependencies pointing inward only:

```
workers/*  ->  packages/hass, packages/storage, packages/graph  ->  packages/domain
```

`packages/domain` depends on nothing but `zod`. `packages/graph` is
domain-agnostic. Adapters know about the domain; the domain knows about nothing.
Workers are composition roots holding configuration and wiring, not logic.

## Consequences

Good:

- Domain tests run in milliseconds with no Workers runtime, no mocks, no network.
  74 tests execute in under 30 ms.
- The guardrails that prevent a plant being drowned are pure functions, so they
  can be exhaustively tested and held at 100% coverage.
- MCP tools and the agent share one implementation of every rule, so they cannot
  drift apart.
- `packages/graph` is publishable and reusable outside this project.

Costs:

- More packages than a single Worker would need, and project references to
  maintain.
- Contributors must respect the layering rule; pnpm's strict module isolation
  helps by making cross-boundary imports fail rather than silently resolve.

## Alternatives considered

**Single Worker.** Rejected: the MCP server and the agent would duplicate logic,
and testing would require the Workers runtime for everything.

**Domain logic inside the MCP server, agent calls it over MCP.** Rejected as the
primary path: MCP between two Workers in one account adds a network hop and an
auth handshake for no isolation benefit. MCP remains the *external* interface
only. See `docs/architecture.md`.
