# Project handoff: {{project.name}}

> Generated: `{{generated_at}}`
> Protocol: `{{schema_version}}`
> Handoff ID: `{{handoff_id}}`
> Source completeness: `{{source_completeness}}`
> Status: evidence-grounded snapshot, not a complete conversation transcript

## Project

- Root: `{{project.root}}`
- Repository: {{project.repository_url}}
- Intended recipient: {{project.recipient}}

## Snapshot

- Git branch: `{{snapshot.git.branch}}`
- Git commit: `{{snapshot.git.commit}}`
- Working tree dirty: `{{snapshot.git.dirty}}`
- Digested files: {{snapshot.files}}
- Deleted files: {{snapshot.deleted_files}}
- Coverage notes: {{snapshot.coverage_notes}}

## Source precedence

{{source_precedence}}

Later material overrides earlier material only when it addresses the same decision and has equal or stronger authority. Superseded decisions remain listed below.

## Current objective

{{objective}}

## Deliverables

{{deliverables}}

## Work items

Use only `VERIFIED`, `IMPLEMENTED_NOT_VERIFIED`, `PLANNED`, `UNKNOWN`, `BLOCKED`, or `STALE`.

{{work_items}}

## Decisions

Decision status is `ACTIVE` or `SUPERSEDED`. Each superseded decision identifies its replacement.

{{decisions}}

## Constraints and boundaries

{{constraints}}

## References

{{references}}

## Next actions

{{next_actions}}

## Privacy review

- Scan result: {{privacy.scan_status}}
- Redactions applied: {{privacy.redactions_applied}}
- Findings: {{privacy.findings}}

## Bootstrap prompt for a fresh task

```text
{{bootstrap_prompt}}
```

---

### Status legend

- `VERIFIED`: evidence proves the claim and relevant validation passed.
- `IMPLEMENTED_NOT_VERIFIED`: implementation exists, but validation is missing, incomplete, or failing.
- `PLANNED`: intended work without implementation evidence.
- `UNKNOWN`: current evidence is insufficient.
- `BLOCKED`: a named dependency or authorization prevents the next required action.
- `STALE`: recorded state conflicts with current evidence.
- `SUPERSEDED`: a decision was explicitly replaced by a later decision.
