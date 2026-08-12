# Reproducible safety cases

These cases exercise the deterministic handoff validator with synthetic data only.
They are intended to be run locally and in CI; they do not require a model, a
Codex account, or access to a private conversation.

Run all cases:

```bash
node evaluation/run-repro-cases.mjs
```

The runner currently verifies three fail-closed behaviors:

| Case | Mutation | Required result |
| --- | --- | --- |
| `stale-file-digest` | A snapshotted file changes after handoff generation | `DIGEST_MISMATCH` |
| `restored-deleted-file` | A file recorded as deleted exists again | `DELETED_FILE_RESTORED` |
| `privacy-secret` | A synthetic credential-like value enters the pack | `SENSITIVE_DATA_FOUND`, without echoing the value |

The JSON output contains only case IDs, expected and observed error codes, and a
pass/fail result. Temporary paths and synthetic sensitive values are never
printed.
