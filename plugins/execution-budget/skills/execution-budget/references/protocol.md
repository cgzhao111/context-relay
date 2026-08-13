# Execution Budget Protocol

## Trust labels

- `EXACT_INPUT_COUNT`: provider count for one fully constructed request only.
- `CALIBRATED_RANGE`: conservative range influenced by at least five matching, caller-attested observations.
- `HEURISTIC_RANGE`: deterministic range from coarse task signals and conservative multipliers.
- `NOT_AVAILABLE`: the host did not expose actual token usage.

Never relabel a local character estimate as an exact token count. This Beta does
not claim high-confidence calibration because it has no authenticated host
adapter or holdout-coverage proof.

## Estimate request

The request contains only categorical and numeric task signals. It deliberately
does not store the raw task text.

```json
{
  "schema_version": "1.0",
  "task": { "task_type": "multi_file_change" },
  "signals": {
    "expected_files": 6,
    "expected_tests": 4,
    "ambiguity": "medium",
    "rollback_difficulty": "low",
    "production_impact": false,
    "external_writes": false,
    "destructive": false,
    "credentials": false,
    "personal_data": false
  },
  "preferences": {
    "mode": "auto",
    "token_limit": 50000,
    "time_limit_minutes": 30,
    "force_card": false
  },
  "runtime": {
    "host_family": "codex",
    "host_version_bucket": "0.144",
    "model_tier": "frontier",
    "reasoning_effort": "high",
    "parallelism": "single"
  },
  "authorization": {
    "authorized_actions": ["READ_SCOPE"]
  },
  "usage_observability": "NONE"
}
```

`authorized_actions` is the only source for `autonomy.may_proceed`; an estimate
cannot grant file edits or tests that the user's request did not authorize.
Derive it conservatively from the user's actual request, not from the actions a
proposed plan would like to perform. When authorization is ambiguous, leave the
array empty. Any edit, test, or repair authorization requires `READ_SCOPE`;
repair additionally requires both `REVERSIBLE_EDIT` and `LOCAL_TEST`.
`usage_observability` is `NONE`, `POST_RUN`, or `LIVE_HOST_TELEMETRY`. With no
live telemetry, token boundaries are advisory and cannot cause an automatic
pause. Host/model/reasoning/parallelism fields are calibration cohort labels,
not commands to switch models or change host settings.

The estimator returns quick, standard, and deep options. Each option includes
its scope, omissions, validation level, token range, and time range. Low-
confidence output intentionally omits a precise-looking midpoint.

Machine-readable input must validate against [request.schema.json](request.schema.json),
and output against [execution-budget.schema.json](execution-budget.schema.json).
Run observations validate against [run-record.schema.json](run-record.schema.json),
and generated calibration against [calibration.schema.json](calibration.schema.json).

## Run record

Run records contain structured metadata only:

```json
{
  "schema_version": "1.0",
  "task_type": "multi_file_change",
  "size_bucket": "medium",
  "mode": "standard",
  "runtime": {
    "host_family": "codex",
    "host_version_bucket": "0.144",
    "model_tier": "frontier",
    "reasoning_effort": "high",
    "parallelism": "single"
  },
  "usage_source": "HOST_REPORTED",
  "actual_total_tokens": 42100,
  "actual_duration_minutes": 24,
  "success": true,
  "quality_gate_passed": true,
  "rework_required": false,
  "observed_at": "2026-08-12T12:00:00Z"
}
```

`HOST_REPORTED` and `API_RESPONSE` are caller-attested. The local script cannot
authenticate their origin, so import them only through a trusted capture path.
`SYNTHETIC` is reserved for public examples and is always excluded. Do not
reconstruct usage from visible text, and never add prompts, paths, project or
account names, thread IDs, URLs, or free-text notes.

## Calibration eligibility

Every schema-valid, trusted-source terminal run with positive observed usage is
included in the cost distribution, including failed, reworked, and quality-
failed runs. Outcome counts and rates are reported separately; excluding those
runs would understate expected cost through survivorship bias.

Group by host family/version bucket, model tier, reasoning effort, parallelism,
task type, size bucket, and execution mode. A bucket becomes usable at five
distinct observations. Because provenance remains caller-attested, confidence
stays `low`, and the calibrated range never narrows the conservative heuristic
envelope. Exact duplicate records are excluded; the caller remains responsible
for preventing the same run from being re-entered with altered timestamps.

## Meaningful approval rule

An upfront confirmation is meaningful when the conservative range conflicts
with a user token/time limit or materially different execution scopes require
a product choice. Risk alone does not justify a duplicate preflight Yes.
External or irreversible actions, credentials, and personal data remain point-
of-action hard gates under the host and `autonomy.pause_when`.
