# Context Relay self-handoff dogfood v1

This directory publishes a privacy-preserving, aggregate result from one
self-handoff evaluation. It compares three pickup conditions:

1. `no_handoff` — the receiver starts without a handoff artifact;
2. `prose_summary` — the receiver gets a conventional prose summary;
3. `context_relay` — the receiver gets a Context Relay handoff and validates
   its evidence.

The source revision is
`d5cd032e9b3db82f29a194d687f2608d3cc2e419`. Each condition was observed once
(`n = 1`). Source completeness was declared as `VISIBLE_CONTEXT_ONLY`. The
model, model version, and host version were not exposed to the evaluator and
are recorded as `not_exposed`.

## Published files

- [`RESULTS.md`](RESULTS.md) is the human-readable scorecard and interpretation.
- [`results.json`](results.json) is the machine-readable aggregate result.
- [`result.schema.json`](result.schema.json) defines the published JSON contract.

## Privacy boundary

The public artifact intentionally excludes:

- task or conversation identifiers;
- absolute filesystem paths;
- original conversation text;
- organization or internal project names;
- user email addresses;
- raw private handoff artifacts and prohibited fixture values.

Private evidence was used during the evaluation but is not needed to understand
the aggregate scorecard. Consequently, this public directory is an evidence
summary, not a replay bundle.

## What this result can and cannot show

The run demonstrates that the Context Relay condition could validate its
handoff without unsupported `VERIFIED` claims, repository modifications, or
validator findings in this case. It also retained and verified information
that the baselines did not fully recover.

This is a self-run with one observation per condition. It does **not** establish
a general speed, quality, security, or reliability advantage. Independent,
multi-run reproduction is required before making population-level claims.
