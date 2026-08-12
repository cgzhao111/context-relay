---
name: async-wait-guard
description: Prevent wasteful model wakeups while an already-started asynchronous tool or process is still running. Use when a command returns a running cell or process handle, when polling with empty write_stdin calls, when calling functions.wait, when nesting a wait inside functions.exec, or when auditing AGENTS.md long-wait policy. Do not use for ordinary synchronous commands, non-empty interactive input, or general task-budget estimation.
---

# Async Wait Guard

Reduce empty polling of long-running asynchronous work without weakening validation, responsiveness to required input, or tool safety.

Read [references/policy.md](references/policy.md) before generating an `AGENTS.md` rule, auditing a wait plan, or handling a tool contract that conflicts with the defaults below.

## Apply the runtime policy

1. Confirm that the tool or process has already started and returned a running handle, cell ID, or equivalent state. Do not invent a wait target.
2. Classify the next operation:
   - Send non-empty interactive input immediately. Do not apply the long-poll interval.
   - For an empty poll where intermediate output matters, wait at least `180000` ms.
   - For an empty poll where intermediate output is unnecessary, prefer `300000` ms.
   - For `functions.wait`, use at least `180000` ms and prefer `300000` ms when no intermediate output is needed.
3. When a wait is nested inside `functions.exec`, set the outer `@exec yield_time_ms` to at least the longest inner wait plus `30000` ms.
4. Treat all values as maximum yields, not mandatory sleeps. Accept an early return as soon as the process completes or produces a terminal result.
5. Do not wake the model only to say that work is still running. Resume on completion, meaningful output, required user input, a real error, or an applicable higher-priority progress rule.
6. Respect the current tool schema and its maximum timeout. If it cannot satisfy this policy, follow the tool contract and disclose that the long-wait recommendation could not be applied exactly.

## Preserve boundaries

- Do not start, retry, terminate, or mutate a process merely to optimize waiting.
- Do not delay non-empty prompts, passwords, confirmations, or other interactive input.
- Do not interpret silence or timeout as success.
- Do not suppress a user-requested live progress view or a higher-priority host requirement.
- Do not claim a fixed Token saving. Measure the same workload before and after if evidence is needed.
- Do not read or upload raw local sessions by default. Analyze only a user-authorized, privacy-reviewed summary.

## Use the deterministic planner selectively

Apply the table above directly during normal tool use; calling an extra script for every wait would create avoidable overhead. Use the bundled planner only to test a proposed wait, build fixtures, or audit an integration:

```text
node {skill-root}/scripts/plan-wait.mjs --request <wait-request.json>
```

The planner is stdout-only. Its request and response contracts are documented in [references/policy.md](references/policy.md).

## Report accurately

When asked what changed, state the selected wait interval, whether an outer yield margin was required, and any tool-limit fallback. Distinguish a configured policy from measured savings. Attribute the original observation to its source; do not present the reported approximately 25% reduction as a general benchmark.
