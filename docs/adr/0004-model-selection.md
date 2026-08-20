# ADR 0004: Workers AI with granite-4.0-h-micro as the reasoning model

Date: 2026-08-17
Status: Accepted

## Context

The agent needs a model to turn deterministic findings into a readable
explanation, and occasionally to reason about a combination of signals that the
rules flag but cannot interpret (for example, low DLI plus high VPD plus a
steepening dry-down slope).

Options were Workers AI models via the `AI` binding, or an external frontier
model through AI Gateway.

## Decision

Use Workers AI with `@cf/ibm-granite/granite-4.0-h-micro`, routed **through AI
Gateway** rather than called directly on the `AI` binding.

Verified model properties at time of writing:

| Property | Value |
| --- | --- |
| Model ID | `@cf/ibm-granite/granite-4.0-h-micro` |
| Context window | 131,000 tokens |
| Function calling | Yes |
| Pricing | $0.017 / M input, $0.11 / M output |
| Cost for hourly loop | ~921 Neurons/day — 9% of the free 10,000/day allocation |

## Rationale

It is the cheapest function-calling model in the catalogue and leaves a 10x
margin inside the free daily Neuron allocation, so inference is effectively free
at this workload. Its 131k context window is far more than a handful of plants
needs.

Being a small model is acceptable here specifically *because* the system is
alert-only (ADR 0003). The model summarises and explains; it does not decide to
actuate. A weak judgement produces a slightly worse notification, not a drowned
plant. Under the earlier actuation design this choice would have been harder to
defend.

Routing through AI Gateway rather than the bare `AI` binding is what makes spend
limits and rate limiting apply to the calls, and it provides request logs. That
is worth the extra configuration for an unattended hourly loop.

## Consequences

- The model ID belongs in configuration, not inline in code, so swapping it is a
  config change. `granite-4.0-h-micro` is the default, not a hard-coded constant.
- Function calling on Workers AI is currently Beta. If it proves unreliable, the
  fallback is to drop tool use and pass a pre-assembled context to the model,
  since the deterministic layer already gathers everything needed.
- If reasoning quality disappoints, `@cf/qwen/qwen3-30b-a3b-fp8` and
  `@cf/zai-org/glm-4.7-flash` also fit inside the free allocation (28% and 33%
  respectively) and add reasoning capability.

## Revisit when

Notification quality is visibly poor, or function calling leaves Beta with
breaking changes.
