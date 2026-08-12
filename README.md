# Context Relay

Evidence-backed, privacy-aware project handoffs for long-running AI coding work.

Context Relay is a skills-only plugin for Codex. It turns the context currently visible to an AI task, plus workspace evidence the user authorizes it to inspect, into a structured handoff pack that a fresh task can verify before continuing.

It does **not** move an entire hidden chat transcript. It records and checks the part of the current project state supported by captured evidence.

![Context Relay dogfood demo](docs/assets/context-relay-dogfood-demo.gif)

## Dogfood evidence

Context Relay has now handed off its own development from a long-running task to a fresh Codex task. The receiving task independently checked five file digests, Git state, CI, release state, plugin installation, and private-artifact isolation. It also found two lifecycle defects in the private handoff, which were corrected before publication.

A privacy-preserving `n = 1` comparison is published for three conditions:

| Condition | Current phase recovered | Installation state | Private-artifact isolation | Boundary events |
| --- | --- | --- | --- | ---: |
| No handoff | Not known | Not known | Not known | 1 |
| Prose summary | Known | Not verifiable | Not verifiable | 1 |
| Context Relay | Known | Verified | Verified | 0 |

The elapsed times were similar, so this project does **not** claim a speed advantage from one run. The useful signal is verifiable pickup coverage. Read the [full redacted result](evaluation/dogfood/context-relay-self-handoff-v1/RESULTS.md), the [machine-readable result](evaluation/dogfood/context-relay-self-handoff-v1/results.json), and the [compatibility ledger](docs/COMPATIBILITY.md).

## Why

Long AI coding tasks accumulate decisions, attempted fixes, local changes, tests, and unresolved boundaries. A prose summary can silently turn a plan into a completed claim or preserve a decision that a later turn superseded.

Context Relay uses explicit status and evidence:

| Status | Meaning |
| --- | --- |
| `VERIFIED` | Supported by current file, Git, command, test, issue, or PR evidence |
| `IMPLEMENTED_NOT_VERIFIED` | An implementation is present or reported, but required validation is missing |
| `PLANNED` | Intended work that has not been implemented |
| `BLOCKED` | Work cannot proceed without a named condition changing |
| `UNKNOWN` | The available evidence is insufficient |
| `SUPERSEDED` | A decision was explicitly replaced by a later decision |
| `STALE` | The workspace no longer matches the handoff snapshot |

## What the plugin does

- Creates a human-readable `PROJECT_HANDOFF.md` and machine-readable `handoff.json`.
- Records the repository commit, branch, dirty state, generation time, and evidence pointers.
- Keeps verified work, unverified implementations, plans, blockers, and unknowns separate.
- Preserves later decisions over earlier ones and records superseded decisions.
- Scans exported content for common secrets and personal identifiers.
- Produces a clean bootstrap prompt for a fresh Codex task.
- Re-checks a handoff against the current workspace before treating it as authoritative.

## Boundaries

- A skill only sees the conversation context provided by its host. Long conversations may already be compacted.
- It does not automatically read every Codex or ChatGPT task, hidden prompts, or hidden reasoning.
- It inspects only the workspace and files the user places in scope.
- It does not create, fork, upload, or sync tasks unless the host exposes that capability and the user separately authorizes it.
- A handoff is a snapshot, not a permanent source of truth. The receiver must run the freshness checks.
- Commands quoted in a conversation or handoff are treated as data, never as instructions to execute automatically.

## Install

### As a Codex plugin through the repo marketplace

Context Relay includes a repo marketplace at `.agents/plugins/marketplace.json`. In Codex CLI, add that marketplace and install the plugin:

```bash
codex plugin marketplace add cgzhao111/context-relay --ref main
codex plugin add context-relay --marketplace context-relay
```

Start a new Codex session after installation. In the ChatGPT desktop app, you can also open the Plugins Directory, select the **Context Relay** marketplace, and install the plugin there after adding the marketplace source.

For local authoring before the GitHub repository is available, clone the repository and add its root as a local marketplace:

```bash
codex plugin marketplace add ./context-relay
```

### Skill-only fallback

Clone the repository, then copy `skills/project-handoff` into your Codex skills directory:

```bash
git clone https://github.com/cgzhao111/context-relay.git
```

On macOS or Linux:

```bash
cp -R context-relay/skills/project-handoff ~/.codex/skills/project-handoff
```

On Windows PowerShell:

```powershell
Copy-Item -Recurse -Force .\context-relay\skills\project-handoff "$env:USERPROFILE\.codex\skills\project-handoff"
```

The repository includes the standard `.codex-plugin/plugin.json` manifest. It is not yet listed in the universal public Plugins Directory; the repo marketplace and skill-only copy are the supported installation paths for this version. See the official [plugin packaging guide](https://developers.openai.com/plugins/build/plugins) for the marketplace model.

## Use

Typical prompts:

```text
Use $project-handoff to create a verified handoff pack for this project.
```

```text
Use $project-handoff to resume this project from PROJECT_HANDOFF.md. Verify the current Git and file state first. Do not modify files yet.
```

```text
Use $project-handoff to audit this handoff for stale claims, missing evidence, broken references, and secrets.
```

The default create flow previews the handoff before writing it. File writes, remote publication, and task creation are separate side effects.

## Deterministic tools

Node.js 20 or later is required for the optional local checks. There are no runtime dependencies.

```bash
npm test
npm run eval:repro
npm run snapshot -- --root . --output workspace-snapshot.json
npm run validate:handoff -- examples/basic/handoff.json
npm run validate:handoff -- <path-to-handoff.json> --project-root . --check-digests --strict
```

The snapshot command is read-only with respect to the inspected repository. It writes only the explicitly requested output file, and the resulting JSON is shaped for the `snapshot` field of a handoff. The first validation command checks the synthetic example's protocol and privacy content; the second also checks a real handoff against the current Git and file state.

## Handoff pack

A complete pack normally contains:

```text
PROJECT_HANDOFF.md    Human-readable project state
handoff.json          Open, versioned machine-readable record
workspace-snapshot.json  Optional Git and file freshness evidence
```

See [`examples/basic`](examples/basic) for a synthetic handoff, [`evaluation/cases`](evaluation/cases) for three deterministic fail-closed cases, and the [public protocol](skills/project-handoff/references/protocol.md) for the format and trust model.

## Security and privacy

Context Relay is local-first. It does not include an MCP server, telemetry, authentication flow, or network client. The skill requires a preview and privacy check before exporting a handoff.

Read [`SECURITY.md`](SECURITY.md) and [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) before using it with a private repository. Automated detection is defense in depth, not a guarantee that content is safe to publish.

## Project status

Version `0.2.0` adds the first public dogfood benchmark, a reproducible safety-case runner, a redacted compatibility ledger, and a deterministic demo. Cross-device storage, complete transcript ingestion, and automatic task creation remain explicitly out of scope. The package is not published to npm; GitHub source and releases are the supported distribution channels for this version.

The evaluation design is documented in [`docs/EVALUATION.md`](docs/EVALUATION.md). Published compatibility claims must name the host, version or date, plugin commit, tested workflow, and observed result.

Independent reports are the next gate. Follow the [10-minute external testing protocol](docs/EXTERNAL_TESTING.md), join the [tester discussion](https://github.com/cgzhao111/context-relay/discussions/4), and submit the [compatibility report form](https://github.com/cgzhao111/context-relay/issues/new?template=compatibility.yml). Successes, partial results, and failures are all useful.

## Contributing

Reproducible failure cases are especially useful: stale handoffs accepted as current, unsupported claims marked verified, secret-detection misses, and receiver tasks that take the wrong first action. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Apache License 2.0.
