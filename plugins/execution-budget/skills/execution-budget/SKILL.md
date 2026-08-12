---
name: execution-budget
description: Preview, compare, or calibrate an AI coding task's execution budget before work begins. Use when a user wants a token or effort estimate, wants quick/standard/deep execution choices, is uncertain whether repeated approvals are useful, wants explicit autonomy and pause boundaries, wants to cap a long task, or provides structured caller-attested usage for future calibration. Do not trigger for trivial one-step work unless the user explicitly asks for a budget.
---

# Execution Budget

Replace low-information Yes/No checkpoints with one compact execution quote and meaningful pause boundaries. Preserve safety and quality; never optimize tokens by skipping required validation.

## Boundaries

- Treat whole-task token use as an uncertain range. Never present a precise prediction for future model output, tool results, retries, subagents, or user changes.
- A provider-reported input-token count may be labeled exact only for the fully constructed request it counted. It is not an exact whole-task estimate.
- Do not make an extra model call merely to estimate a task. Reuse the current task understanding and deterministic workspace signals.
- Do not switch the current model, spawn agents, write files, or change permissions merely because the estimate recommends it. Those remain separate, host-dependent actions.
- Keep destructive actions, external publication, credentials, personal data, paid actions, scope expansion, and irreversible changes behind an explicit pause regardless of mode.
- Calibration may update a local data file, never this `SKILL.md`. Include every trusted-source terminal run in the cost distribution and report success, quality, and rework separately.

Read [references/protocol.md](references/protocol.md) before producing a budget card or calibration.

## Choose a workflow

- **Preview**: classify the request and return a recommended execution quote.
- **Compare**: show quick, standard, and deep options when the choice could materially change scope, time, or expected usage.
- **Calibrate**: summarize eligible historical run records into versioned bucket statistics.
- **Reconcile**: compare a prior estimate with observed usage and explain the miss without rewriting stable rules.

Skip the visible budget card when the task is trivial, low-risk, and the user did not ask for one. State one short sentence about the assumed standard scope if work will continue.

## Preview or compare

1. Use only signals already available from the request and proportionate read-only inspection: task type, expected files, tests, ambiguity, rollback difficulty, production impact, external writes, credentials, personal data, and destructive operations.
2. Do not scan the whole repository solely for estimation. For a large project, inspect Git status and the explicitly relevant paths only.
3. Build the compact request described in `references/protocol.md` in memory. Do not persist raw task text; the request contract does not contain it. Resolve the script relative to this `SKILL.md` instead of assuming the user's workspace is the Skill directory. Send JSON on stdin or run:

   ```text
   node {skill-root}/scripts/estimate-budget.mjs [--calibration <calibration.local.json>]
   ```

   The estimator is stdout-only and therefore remains a read-only preview.
4. Recommend `quick`, `standard`, or `deep`. `standard` is the default. Never let `quick` remove safety, backup, migration, privacy, or required acceptance checks.
5. Present only the recommended card unless the user requested comparison or the options differ materially.
6. Ask once only when an upfront decision is meaningful, such as a user limit conflict or materially different scope choice. Risk by itself does not justify a duplicate preflight Yes. After selection, proceed within the authorized scope and pause only at a listed hard boundary, a material budget overrun, or a new product decision.

Use this compact format:

```text
Recommended: Standard
Workload: medium | risk: medium | confidence: low
Expected tokens: 18k-46k (low-confidence heuristic range)
Expected time: 12-32 minutes
Includes: scoped inspection, implementation, required tests, result review
May proceed: local reads, scoped reversible edits, non-destructive tests
Pause for: external publication, credentials/PII, destructive or irreversible action, scope expansion
Token enforcement: advisory (no live host telemetry)
```

When actual token telemetry is unavailable, label observed usage `not_available`; do not infer it from response length or subscription quota.

## Calibrate

1. Accept structured run records only. Do not retain raw prompts, transcripts, source files, secrets, personal data, repository names, or internal URLs.
2. Accept only caller-attested provider/host usage from a trusted capture path. Include failed, reworked, and quality-failed terminal runs in cost, then report their outcome rates separately.
3. Require at least five distinct records in the same host/version, model tier, reasoning effort, parallelism, task type, size bucket, and mode before calibration can influence the range. Keep caller-attested calibration low confidence and never let it narrow the heuristic envelope.
4. Run:

   ```text
   node {skill-root}/scripts/calibrate-budget.mjs --runs <runs.jsonl> [--output .execution-budget/calibration.local.json]
   ```

   Run the command with the authorized project root as the working directory so any optional local calibration file stays inside that project's ignored `.execution-budget` directory.

5. Report sample and exclusion counts, P20/P50/P80/P90, runtime cohort, outcome rates, caller-attested provenance, and generation time. Do not claim general savings without a quality-controlled comparison.

## Reconcile

- Compare the observed total with the prior range.
- Attribute material differences only to observed factors such as extra tool output, retries, expanded scope, or more validation. Otherwise mark the cause unknown.
- A range miss does not authorize silently widening all future estimates. Add eligible evidence to calibration and retain version history.
- Optimize in this order: task success, safety, required quality, then token/time efficiency.

## Stop conditions

Pause when a requested budget cap would make the required result unsafe or unverifiable, the user requests exact whole-task usage, the project scope is too ambiguous to classify, actual usage telemetry is claimed but its provenance is unknown, or calibration data contains raw/private content. Explain the gap and offer the smallest safe next step.
