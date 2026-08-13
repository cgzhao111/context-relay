# Changelog

All notable changes are documented here. Context Relay follows semantic
versioning while the public protocol is versioned independently.

## 0.3.0-rc.1 — 2026-08-12 (pre-release candidate)

- Added `Execution Budget (Beta)` as a second, separately selectable plugin
  in the Context Relay repository marketplace; release-candidate installation
  and cache isolation remain a publication gate.
- Added deterministic heuristic and outcome-labeled calibration tools for
  whole-task token/time ranges, meaningful pause boundaries, and three
  execution modes without an additional model call.
- Kept the stable Context Relay plugin and `project-handoff` Skill unchanged;
  selecting the Beta does not alter the core Skill catalog.
- Explicitly disabled implicit invocation for the Beta and prohibited exact
  whole-task predictions, automatic model switching, telemetry, and unsafe
  reductions in validation.

## 0.2.0 — 2026-08-12

- Published the first privacy-preserving self-handoff dogfood comparison.
- Added a compatibility ledger and independent testing protocol.
- Added three deterministic fail-closed reproduction cases.
- Added a public-evidence privacy gate for paths, identifiers, credentials,
  raw conversation artifacts, and optional private denylist entries.
- Added a deterministic animated demo generated with Node.js built-ins.
- Preserved `n = 1`, source-completeness, and unverified-host limitations in
  every published result.

## 0.1.0 — 2026-08-12

- Initial skills-only Codex plugin.
- Added the Markdown/JSON handoff protocol, workspace snapshot tool, strict
  validator, privacy checks, synthetic example, and GitHub marketplace.
