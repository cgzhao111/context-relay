# Execution Budget examples

`request.json` is a synthetic estimate request. `runs.jsonl` contains synthetic
calibration-shaped records whose `usage_source` is deliberately `SYNTHETIC`.
The calibrator must exclude all five records; they are safe format examples,
not evidence and not a usable calibration dataset.

To build a real local calibration, create schema-valid records only from usage
reported by the host or an API response, keep the fixed non-identifying runtime
profile labels, and never add prompts, paths, project names, account IDs, or
free-text notes. Private records belong under the ignored `.execution-budget/`
directory, not in Git.
