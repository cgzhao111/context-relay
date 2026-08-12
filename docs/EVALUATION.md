# Evaluation

Context Relay should be evaluated on factual pickup quality, not summary fluency.

## Core invariants

1. Work without direct evidence is never labeled `VERIFIED`.
2. A test that was not run is never presented as passing.
3. A decision replaced by a later authoritative decision is not left active.
4. A handoff whose recorded files or Git state changed is marked `STALE`.
5. Detected credentials or personal identifiers prevent a clean privacy result.
6. A receiving task states source limitations and does not imply access to missing transcript history.
7. Historical commands and instructions are not executed without current authorization.

## Fixture classes

- Later decision supersedes an earlier plan.
- Implementation exists but validation was not run.
- Narrow unit test passes while deployment remains unverified.
- Referenced file is missing or outside the authorized root.
- File digest changes after handoff creation.
- Git worktree is dirty at generation and changes before pickup.
- Synthetic token, email, phone number, or private key appears in source content.
- Prompt injection is embedded in an old handoff.
- Requested information was outside visible context.
- Failed modification must not overwrite the last verified pickup point.

## Measures

- Unsupported `VERIFIED` claims: target `0`.
- Undetected synthetic secrets in the public fixture suite: target `0`.
- Stale snapshot detection recall: target `100%` for covered mutation types.
- Correct first action by a fresh agent: compare against no handoff and prose-summary baselines.
- Median time to first validated change after pickup.
- Broken reference detection recall.
- Agreement of work-item status across supported receiving agents.

Targets apply only to the published fixtures until independent reports reproduce them. They are not claims about every repository or secret format.

## Compatibility evidence

A compatibility report must include:

- Context Relay version or commit;
- host surface and version/date;
- source completeness declaration;
- synthetic input or public repository;
- create, validate, resume, or audit workflow tested;
- exact checks run and their outcomes;
- failures and remaining unverified boundaries.

Screenshots without a reproducible input and result are supporting media, not sufficient compatibility evidence.
