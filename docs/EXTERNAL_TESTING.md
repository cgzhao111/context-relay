# External testing guide

Independent evidence is the next validation gate for Context Relay. This guide
defines a small, privacy-safe protocol that contributors can reproduce without
sharing private conversations or repositories.

## Safety requirements

Use a synthetic fixture or a public repository. Do not submit:

- credentials, API keys, private keys, tokens, or authentication cookies;
- personal email addresses, phone numbers, or other personal identifiers;
- private task or conversation identifiers;
- absolute local paths;
- original private conversation text;
- employer, client, or internal project names without explicit permission.

Run the validator before publishing a result. Redact by replacing a value with
a category such as `not_exposed`; do not publish a reversible encoding or a
partial secret.

## Minimal protocol

1. Pin the Context Relay commit or release under test.
2. Prepare one synthetic/public project state with a clear next objective and
   at least one verifiable repository fact.
3. Create the handoff using only authorized sources.
4. Validate the handoff strictly and record error, warning, and finding counts.
5. Start a clean receiving context and ask it to state the objective, evidence,
   limitations, and next safe action.
6. Check whether every `VERIFIED` claim has direct evidence.
7. Confirm whether pickup modified the repository. A read-only pickup should
   report zero modifications.
8. Record elapsed time only if the start and stop criteria were fixed before
   the run.
9. Publish failures and boundary events alongside successes.

For comparisons, keep the fixture and scoring rubric identical across
conditions. Randomize condition order and run each condition more than once
before drawing comparative conclusions.

## Required result fields

Submit a Markdown explanation plus a machine-readable JSON object containing at
least:

```json
{
  "context_relay_revision": "40-character commit or release tag",
  "host_surface": "product name or not_exposed",
  "host_version": "version or not_exposed",
  "model": "model name or not_exposed",
  "model_version": "version or not_exposed",
  "source_completeness": "FULL_THREAD_READ | PARTIAL_THREAD_READ | USER_TRANSCRIPT | VISIBLE_CONTEXT_ONLY",
  "input_kind": "synthetic | public_repository",
  "workflow": "create | validate | resume | audit",
  "sample_size": 1,
  "checks": [
    {
      "name": "unsupported_verified_claims",
      "value": 0
    },
    {
      "name": "repository_modifications_during_read_only_pickup",
      "value": 0
    }
  ],
  "failures": [],
  "unverified_boundaries": []
}
```

If a product does not expose a version, record `not_exposed`; do not guess.
An empty `failures` array means no failures were observed in the stated scope,
not that the integration is defect-free.

## Review criteria

A report is eligible for the compatibility ledger when it:

- references an immutable commit or release;
- uses public or synthetic inputs;
- contains no prohibited sensitive content;
- makes the setup and checks reproducible;
- distinguishes `known`, `verified`, `not_verifiable`, and `not_known`;
- avoids population-level claims from a single observation;
- records source limitations and unresolved boundaries.

Reports that contain only screenshots, testimonials, or fluent summaries are
useful feedback but are not compatibility evidence on their own.
