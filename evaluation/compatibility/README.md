# Runtime compatibility evidence

This directory defines the machine-readable contract for real plugin evidence.
It deliberately separates three claims:

1. marketplace installation and removal on an ephemeral runner;
2. Skill visibility and explicit invocation in a fresh Codex context;
3. host-specific behavior, such as an actual asynchronous wait tool call.

A result for one layer does not upgrade an unobserved layer. In particular,
the installation matrix cannot prove model triggering, and a policy answer
cannot prove that the host exposed or used a wait tool.

`example-contract-report.json` is synthetic and validates only the contract. It
is not a runtime result. Real reports live in a report-specific subdirectory
with their referenced evidence and checksums.

Validate a report with:

```bash
node evaluation/compatibility/validate-report.mjs path/to/report.json \
  --check-evidence \
  --expected-commit 40-character-commit
```

Raw logs, account details, authorization codes, local absolute paths, and
complete model event streams are private inputs. Publish only bounded,
redacted evidence after the repository public-evidence gate passes.
