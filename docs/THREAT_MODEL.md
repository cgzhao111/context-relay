# Threat Model

## Assets

- Private source code and filenames
- Conversation content and business decisions
- Credentials, cookies, tokens, internal URLs, and account identifiers
- The accuracy of project status and validation claims
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

## Non-goals

- Protecting a compromised host operating system
- Recovering context that the host never exposed
- Proving that all sensitive information was detected
- Authenticating remote collaborators
- Acting as a backup or cross-device synchronization service

## Security tests

The repository includes synthetic tests for common credentials and personal identifiers, missing evidence, invalid states, malformed documents, and snapshot freshness. New detector rules must include positive and negative examples.
