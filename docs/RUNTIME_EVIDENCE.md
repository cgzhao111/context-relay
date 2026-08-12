# Zero-pollution runtime evidence

This document separates two different claims:

1. an ephemeral Windows runner can install, cache, list, and remove each
   Marketplace plugin independently; and
2. a fresh Codex task can discover and explicitly invoke the expected Skill.

The first claim is automated by GitHub Actions. The second is collected in
Windows Sandbox because `codex plugin list` cannot prove what a fresh model
task actually receives.

## Immutable test inputs

The first evidence run is pinned to:

| Component | Pinned value |
| --- | --- |
| Repository commit under test | `dd3cbfb1f10c29808193dee167f4d595e7046f38` |
| Codex CLI | `0.144.5` |
| Codex Windows x64 package SHA512 integrity | `sha512-DnsSTlnnzleTxvLwIGnBitKInscxn2I7qASqosS8Fv+qysBygd+ZiBn/SQsRCgQ28PAlsNzmd3Gf3ZTecolAmg==` |
| Node.js | `22.23.2` |
| Node.js Windows x64 ZIP SHA256 | `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97` |
| MinGit | `2.55.0.windows.4` |
| MinGit Windows x64 ZIP SHA256 | `4e03f94c2ffbf70be337e005cee02661c732dbfc81031a078bda9299b9a7d644` |

Evidence from this run must not be reused for a different repository commit,
CLI version, Node version, or harness revision. A later change requires a new
report.

## Layer 1: ephemeral GitHub Actions runner

Run the **Plugin isolation evidence** workflow manually or from its pull
request. The workflow uses a disposable `windows-latest` runner and exercises:

- core only;
- Execution Budget only;
- Async Wait Guard only;
- all three plugins;
- removing each plugin while confirming the remaining selections.

The harness stores each redacted `plugin list --available --json` result, a
recursive plugin-relative cache inventory, source/cache tree digests, a
sanitized JSONL state log, a machine-readable report, and SHA256 checksums.
Each installed tree must byte-for-byte match the plugin source tree at the
fixed Marketplace commit. It never reads or modifies a maintainer's local
Codex configuration.

The uploaded artifact is an explicit allowlist: `report.json`,
`matrix-details.json`, `matrix-events.jsonl`, `privacy-scan.txt`, and
`checksums.sha256`. Finalization and strict validation must both pass before
any artifact is uploaded; a privacy-scan failure uploads nothing.

This layer proves only installation state, cache separation, and removal on
the named runner. It does not prove Skill discovery or model behavior.

### Published Layer 1 result

The first Layer 1 run passed on 2026-08-12:

- workflow: [GitHub Actions run 31612238486](https://github.com/cgzhao111/context-relay/actions/runs/31612238486);
- plugin revision: `dd3cbfb1f10c29808193dee167f4d595e7046f38`;
- harness revision: `a99863e363352224bd588b9f4d4e7d6f0ff38cfa`;
- Codex CLI: `0.144.5` on `windows-latest`;
- result: all eleven initial, single-plugin, combined, and independent-removal
  states passed, including exact source/cache tree comparison;
- durable evidence:
  [`evaluation/compatibility/runs/gha-windows-dd3cbfb1-20260812/`](../evaluation/compatibility/runs/gha-windows-dd3cbfb1-20260812/).

The report and all linked evidence pass the strict report validator and public
evidence scanner. This result does not upgrade any Layer 2 assertion.

## Layer 2: Windows Sandbox runtime

Windows Sandbox is a disposable Windows environment. The supplied `.wsb`
configuration does not map the host user profile, Codex configuration, source
workspace, or credentials. Clipboard, printer, microphone, camera, and video
input redirection are disabled. Only one initially empty evidence export
folder is mapped. The public harness is downloaded from the separately recorded
immutable harness commit and checked against the SHA256 calculated before the
Sandbox starts.

Network access is retained because the clean environment must download the
pinned public dependencies and complete Codex device authentication. The WSB
configuration does not provide an egress-domain allowlist, so this is a
documented residual boundary. Never copy a host token into the Sandbox.

The user performs only the two security-sensitive host actions:

1. enable **Windows Sandbox** in Windows Features and restart if Windows asks;
2. inside Sandbox, complete `codex login --device-auth` in the browser.

The generated launcher starts automatically inside Sandbox, installs
checksum-pinned MinGit, Node.js, and both the Codex launcher and Windows x64
payload, then installs from the pinned public commit. It compares the installed
Codex executable with the executable extracted from the verified Windows
package, pauses for device login, then creates a new ephemeral
Codex task after every plugin-state change and records each explicit Skill
probe. Closing Sandbox destroys its installed software, plugin cache, and login
state. Exact host commands are maintained beside the harness in
[`tools/windows-sandbox/README.md`](../tools/windows-sandbox/README.md).

### Target runtime assertions

#### Context Relay

- `$project-handoff` is visible in a fresh task;
- a synthetic project produces a handoff that passes the strict validator;
- stale evidence and a synthetic credential fail closed.

#### Execution Budget

- `$execution-budget` is visible only while installed;
- preview output contains a range, confidence, execution modes, and a pause
  boundary;
- a preview does not authorize or perform project modification.

#### Async Wait Guard

- `$async-wait-guard` is visible only while installed;
- an empty poll prefers `300000` ms;
- an outer nested yield is at least `30000` ms longer than its inner wait;
- non-empty interactive input such as `Y` is sent immediately.

If the Sandbox Codex surface does not expose a real asynchronous process tool,
the report must say that policy triggering passed while host wait behavior and
Token savings remain unverified.

#### Combined state

- all three Skills are visible when all three plugins are installed;
- after removing one plugin and opening a new task, its Skill is absent;
- the two remaining plugins continue to be visible.

## Evidence contract

Every public compatibility report must validate against
[`evaluation/compatibility/report.schema.json`](../evaluation/compatibility/report.schema.json).
The contract records the exact commit, environment, installation method,
fresh-context status, individual steps, checks, failures, unverified
boundaries, privacy scan result, and artifact SHA256 values.

Validate a prepared report from the directory that contains its evidence:

```powershell
npm run evidence:validate -- .\report.json --check-evidence --expected-commit dd3cbfb1f10c29808193dee167f4d595e7046f38
```

A report cannot be `success` if a step failed or was not verifiable, if a
failure is recorded, or if the public-evidence scan did not pass. Runtime
reports also require a fresh task. Screenshots without a validating report and
artifact hashes are illustrative material, not compatibility evidence.

## Privacy and publication flow

Raw logs first go to the user-selected evidence directory outside the
repository. They may contain transient account or machine details and must
never be committed. If a maintainer needs a temporary in-repository staging
area, only the ignored `.runtime-evidence-private/` directory may be used.

Before copying an artifact into `evaluation/compatibility/runs/`:

1. retain only commands, outcomes, plugin-relative cache names, and stable
   public version identifiers;
2. remove authorization codes, tokens, account/email values, user paths,
   Sandbox configuration state, task/session identifiers, and full raw model
   transcripts;
3. run `npm run evidence:validate -- ... --check-evidence`;
4. run `npm run check:public-evidence`;
5. review the diff manually before committing.

The public report must preserve failures and `unverified_boundaries`. Redaction
must never convert a partial result into a success.

## Host integrity check

The maintainer's normal Codex environment is not used to install, remove, or
run the tested plugins. Before and after Sandbox testing, the launcher reads a
normalized installed-state summary solely to detect unintended host drift. For
the initial run the expected host state is:

- `context-relay`: installed;
- `execution-budget`: not installed;
- `async-wait-guard`: not installed.

Do not install or remove plugins in the normal host merely to create evidence.

## Current scope

Layer 1 now certifies Marketplace installation, list state, cache content, and
independent removal for the pinned revision on Windows Codex CLI `0.144.5`.
Layer 2 fresh-task Skill visibility and explicit invocation still require the
Windows Sandbox run. Codex Desktop, macOS, Linux, implicit Skill triggering,
complete hidden task history, and a fixed percentage of Token savings remain
unverified unless a later report tests them directly.
