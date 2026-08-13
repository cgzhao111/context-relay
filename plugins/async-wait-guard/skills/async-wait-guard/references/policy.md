# Async wait policy

## Purpose

Use longer event-style waits after a tool has already reported that work is still running. This avoids repeatedly waking the model for empty status checks. It does not reduce the reasoning or output needed to complete the task itself.

The policy is based on [Vincent's public X post](https://x.com/Vincent_AINotes/status/2086456379922137274). The author reported an approximately 25% reduction in one local comparison. Treat that number as an individual observation, not a product guarantee or transferable benchmark.

## Decision table

| State | Operation | Recommended action |
| --- | --- | --- |
| Not started or no handle | Any wait | Do not wait; obtain a real running handle first |
| Completed | Any wait | Do not poll again |
| Running | Non-empty interactive input | Send now; do not add a long delay |
| Running | Empty poll, intermediate output needed | Wait at least 180000 ms |
| Running | Empty poll, no intermediate output needed | Prefer 300000 ms |
| Running | `functions.wait` | Same 180000/300000 rule |
| Running | Wait nested in `functions.exec` | Outer yield is at least the longest inner wait plus 30000 ms |

Tool contracts and higher-priority instructions remain authoritative. A yield is a maximum: completion may return early.

## Planner request

The planner accepts JSON from `--request <path>` or stdin:

```json
{
  "schema_version": "1.0",
  "state": "RUNNING",
  "tool": "FUNCTIONS_WAIT",
  "has_nonempty_input": false,
  "intermediate_output_needed": false,
  "inner_wait_ms": null,
  "host_max_yield_ms": null
}
```

Allowed states are `NOT_STARTED`, `RUNNING`, and `COMPLETED`. Allowed tools are `WRITE_STDIN`, `FUNCTIONS_WAIT`, `FUNCTIONS_EXEC_NESTED_WAIT`, and `OTHER`. Millisecond values must be positive safe integers or `null`. `host_max_yield_ms` describes the maximum of the call being planned: the wait call for ordinary waits, or the outer `functions.exec` call for a nested wait.

The response contains:

- `action`: `WAIT`, `SEND_INPUT_NOW`, `DO_NOT_WAIT`, or `FOLLOW_TOOL_CONTRACT`;
- `recommended_yield_time_ms`: the policy target for the wait itself;
- `effective_yield_time_ms`: the target after applying a declared host maximum;
- `outer_exec_yield_time_ms`: the required outer margin for a nested wait;
- `warnings`: any contract conflict or misuse warning.

The planner does not execute, poll, terminate, or modify a process.

## Copy-ready `AGENTS.md` policy

Use this only after reviewing the current host's tool schema. Installing the Skill helps Codex recognize the workflow, but a repository or user-level `AGENTS.md` rule is the stronger option when every applicable task must follow it.

```md
# Long-running asynchronous tool waits

For long-running asynchronous work:

- Empty `write_stdin` polls MUST use `yield_time_ms >= 180000`;
  prefer `300000` when intermediate output is not needed.
- `functions.wait` MUST use `yield_time_ms >= 180000`.
- `functions.exec` MUST set its outer `@exec yield_time_ms` at least
  30000 ms longer than the longest nested tool wait, so the outer
  code cell does not yield first.
- Do not apply the long wait to non-empty `write_stdin` calls that
  send interactive input.
- These tools return early when the process or cell completes.
  Do not wake the model merely to report that work is still running.

These rules apply only to an already-started long-running process or cell and
do not override higher-priority instructions or explicit user requests.
```

## Measurement

For a meaningful A/B comparison, run the same task and environment with and without the policy. Record total Token usage, elapsed time, empty wait count, failures, and task-quality result. Do not optimize the Token metric by skipping required checks or changing scope between variants.
