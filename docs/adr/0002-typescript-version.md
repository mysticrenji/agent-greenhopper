# ADR 0002: Pin TypeScript 6.x rather than 7.x

Date: 2026-08-17
Status: Accepted

## Context

At the time of scaffolding, `npm view typescript version` reported 7.0.2 as
`latest`, with 6.0.3 as the previous stable line. TypeScript 7 is the native
(Go) port of the compiler.

This project relies on composite project references (`tsc --build`) across a
workspace, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and
`verbatimModuleSyntax`, and it must interoperate with Vitest, Biome, and
eventually Wrangler's type generation.

## Decision

Pin `typescript@6.0.3` exactly.

## Rationale

Reproducibility and toolchain compatibility outrank being on the newest major.
The native port is a compiler reimplementation; project-reference and
incremental-build behaviour is the exact area where a reimplementation is most
likely to differ, and it is load-bearing here. One major version behind is a
cheap insurance premium.

## Consequences

- `pnpm install` prints a notice that 7.0.2 is available. That is expected.
- Revisiting is a deliberate, isolated change: bump the version, run
  `pnpm verify`, and confirm `tsc --build` still produces correct incremental
  output across all project references.

## Revisit when

Wrangler, Vitest, and Biome all document TypeScript 7 support, or the project no
longer depends on composite project references.
