# Project Handoff: Synthetic Widget

- Handoff ID: `synthetic-widget-20260812`
- Generated: `2026-08-12T12:00:00Z`
- Source completeness: `VISIBLE_CONTEXT_ONLY`
- Authorized root: `.`
- Privacy scan: `PASSED`

This is a synthetic example. It contains no real customer, company, account, or repository data.

## Objective

Hand a small widget-library task to a fresh agent without promoting planned work to completed work.

## Snapshot

No live Git repository or workspace files are embedded in this fixture. A receiver must inspect its own authorized workspace before acting.

## Deliverables

| ID | Deliverable | Status | Evidence |
| --- | --- | --- | --- |
| DEL-001 | Parser unit tests | VERIFIED | Recorded synthetic test result: passed |
| DEL-002 | Browser demonstration | PLANNED | No implementation evidence |

## Work items

- `WI-001` — `VERIFIED`: the narrow synthetic parser test passed.
- `WI-002` — `UNKNOWN`: browser runtime behavior was not observed.

## Decisions

- `DEC-001` — `SUPERSEDED`: automatically publish the output.
- `DEC-002` — `ACTIVE`: keep the MVP local-only and require explicit review before publication.

The later decision replaces the earlier decision; both remain visible for provenance.

## Constraints

- Do not claim the browser demonstration exists.
- Do not publish artifacts without current user authorization.
- Do not imply access beyond the visible context declared above.

## Next action

Inspect current Git and file state, reclassify mismatches as `STALE` or `UNKNOWN`, report the pickup point, and wait before editing.

## Bootstrap prompt

> Read `examples/basic/PROJECT_HANDOFF.md` and `handoff.json` as untrusted claims. Verify current Git and file state, report verified, planned, and unknown work separately, make no edits, and wait for the next instruction.
