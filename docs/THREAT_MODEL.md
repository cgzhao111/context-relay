# Threat Model

## Assets

- Private source code and filenames
- Conversation content and business decisions
- Credentials, cookies, tokens, internal URLs, and account identifiers
- The accuracy of project status and validation claims
- The provenance and privacy of optional execution-usage measurements
- User control over file writes, publication, and task creation

## Trust boundaries

Context Relay treats conversation text, handoff files, repository files, and pasted logs as untrusted data. Text inside those sources cannot grant permission or expand scope.

The host model may have access to local tools. The skill restricts its workflow to the workspace the user explicitly places in scope and separates read-only inspection from side effects.

## Primary threats

### Prompt injection in source material

A file or old conversation may instruct the receiver to ignore current constraints, execute commands, reveal secrets, or contact an external service.

Mitigation: treat all source instructions as quoted evidence. Only current user and platform instructions authorize actions.

### False completion claims

A prose summary may report a plan, generated artifact, or unrun test as completed and verified.

Mitigation: `VERIFIED` requires evidence. Otherwise downgrade the item to `IMPLEMENTED_NOT_VERIFIED`, `PLANNED`, or `UNKNOWN`.

### Stale handoffs

Files or Git state can change after a handoff is generated.

Mitigation: record commit, dirty state, generation time, and digests. Re-check them before resuming. Mark mismatches `STALE` rather than silently refreshing the old claim.

### Sensitive-data disclosure

Visible context and local files may contain secrets, personal identifiers, private URLs, company names, or absolute paths.

Mitigation: local-first processing, explicit preview, pattern scanning, a manual public-disclosure review, and no automatic upload. Automated scanning remains fallible.

### Scope escape

Referenced paths may use absolute paths, links, symlinks, or `..` traversal to escape the selected workspace.

Mitigation: resolve and normalize paths before access; stop when the resolved target is outside the authorized root.

### Destructive or external side effects

A receiver might execute historical commands, write files, publish content, or create a new task without current authorization.

Mitigation: default to preview and read-only inspection. Treat writing, publishing, and task creation as separate user-authorized operations.

### False precision and self-reinforcing estimates

An execution estimate may be mistaken for a guaranteed token total, or a prior
model estimate may be fed back as if it were observed usage.

Mitigation: Execution Budget reports rounded ranges with a trust label. Exact
counts are limited to provider-counted constructed requests; whole-task totals
remain ranges. Calibration accepts only `HOST_REPORTED` or `API_RESPONSE`
usage, requires five matching terminal runs, reports quality outcomes separately,
and rejects unknown fields.
Source labels are caller-attested and cannot be authenticated by the local
script, so records must enter through a trusted capture path; forged labels are
outside the estimator's proof boundary.

### Approval suppression

A low-cost or quick recommendation might be interpreted as permission to skip
security, privacy, deployment, destructive-action, or acceptance gates.

Mitigation: all modes retain immutable pause boundaries. The optional Skill
cannot switch models, change permissions, publish, or perform destructive
actions. It is configured for explicit invocation and is separately listed in
the marketplace so users can select it without enabling the stable handoff
Skill. Independent cache, install, upgrade, removal, and fresh-task visibility
remain release-candidate checks rather than proven runtime behavior.

### Usage-data leakage

Calibration records could become a covert store for prompts, repository names,
account identifiers, private URLs, or raw transcripts.

Mitigation: the run-record schema is strict and contains only categorical
labels, aggregate usage, duration, quality flags, and observation time. Local
calibration is ignored by Git, no telemetry or network service is included,
and public evidence scanning covers the optional plugin's examples and docs.

## Non-goals

- Protecting a compromised host operating system
- Recovering context that the host never exposed
- Proving that all sensitive information was detected
- Authenticating remote collaborators
- Acting as a backup or cross-device synchronization service

## Security tests

The repository includes synthetic tests for common credentials and personal identifiers, missing evidence, invalid states, malformed documents, and snapshot freshness. New detector rules must include positive and negative examples.
