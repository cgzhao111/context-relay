# Evaluation suite

Context Relay evaluates factual pickup and fail-closed behavior rather than
summary fluency.

- [`dogfood/context-relay-self-handoff-v1`](dogfood/context-relay-self-handoff-v1/)
  contains a privacy-preserving, one-observation-per-condition comparison.
- [`cases`](cases/) documents three deterministic synthetic safety cases.
- [`run-repro-cases.mjs`](run-repro-cases.mjs) runs those cases without a model
  or private data.
- [`scripts/check-public-evidence.mjs`](scripts/check-public-evidence.mjs)
  prevents known private-data classes from entering public evidence files.
- [`compatibility`](compatibility/) defines the strict runtime-report contract,
  validator, and publication boundary for installation and fresh-task evidence.

Run the public cases and full repository gate:

```bash
npm run eval:repro
npm run evidence:validate -- evaluation/compatibility/example-contract-report.json
npm run check
```

See [`docs/EVALUATION.md`](../docs/EVALUATION.md) for invariants and measurement
rules. Results with `n = 1` are descriptive evidence, not general performance
claims.
