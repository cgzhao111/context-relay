# Compatibility and evidence status

Context Relay compatibility claims are evidence-scoped. A passing self-test on
one host does not imply support for every model, operating system, IDE, agent,
or repository layout.

## Published evidence

| Evidence set | Source revision | Source completeness | Surface | Model/version | Workflow evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Self-handoff dogfood v1 | `d5cd032e9b3db82f29a194d687f2608d3cc2e419` | `VISIBLE_CONTEXT_ONLY` | Codex host; version `not_exposed` | `not_exposed` | Pickup coverage, strict validation, five file digests, Git, CI, release, installation, and ignored private artifacts | Passed for the single published observation |
| Marketplace install v0.2.0 | `v0.2.0` / `d97f96be47e14d46c4012e5d9ae1924df686d580` | Not applicable | Codex CLI `0.144.5` on Windows, tested 2026-08-12 | Not applicable | Git marketplace refresh, plugin install, installed version check, official plugin validation, and official skill validation | Passed |
| Three-plugin selection pre-release | `dd3cbfb1f10c29808193dee167f4d595e7046f38` | Not applicable | Static repository and release-bundle gates | Not applicable | Separate `plugins/context-relay`, `plugins/execution-budget`, and `plugins/async-wait-guard` source roots, Marketplace identities, manifests, Skill catalogs, exact entries, release inventory | Passed structurally; install/cache/removal is verified by the next row, while fresh-task visibility and triggering remain unverified |
| GitHub Actions zero-pollution install matrix | Plugin revision `dd3cbfb1f10c29808193dee167f4d595e7046f38`; harness revision `a99863e363352224bd588b9f4d4e7d6f0ff38cfa` | Not applicable | GitHub Actions `windows-latest`, Codex CLI `0.144.5`, tested 2026-08-12 | Not applicable | Single-plugin install/remove, all-three install, independent removal, exact list/enabled/cache sets, source/cache tree hashes, strict report and public-evidence scan | Verified for install, list, cache, and removal in [run 31612238486](https://github.com/cgzhao111/context-relay/actions/runs/31612238486); fresh-task Skill discovery remains a separate Sandbox gate |

The detailed aggregate result is in
[`evaluation/dogfood/context-relay-self-handoff-v1/`](../evaluation/dogfood/context-relay-self-handoff-v1/).
It contains one observation per condition and does not establish a general
advantage.

The durable, privacy-scanned GitHub Actions installation evidence is in
[`evaluation/compatibility/runs/gha-windows-dd3cbfb1-20260812/`](../evaluation/compatibility/runs/gha-windows-dd3cbfb1-20260812/).
It proves the bounded installation claims recorded above, not fresh-task model
behavior.

## Compatibility language

Use these terms in issues and documentation:

- **Verified** — the named workflow was run on the stated surface and its
  supporting checks are published or described.
- **Reported** — a contributor supplied a reproducible report, but a maintainer
  has not independently repeated it.
- **Unverified** — no qualifying evidence has been published.
- **Unsupported** — a known product or protocol constraint prevents the
  workflow.

Absence from this document means **unverified**, not unsupported.

## Current boundaries

The following remain unverified by the published dogfood result:

- independent external users;
- multiple runs, randomized order, or statistical confidence;
- hosts and models whose versions are exposed and independently recorded;
- macOS and Linux behavior;
- non-Codex receiving agents;
- automatic access to hidden or unavailable conversation history;
- replay from the private source material used in the self-test.
- Execution Budget runtime triggering and estimate presentation in a fresh
  task. Installation, cache isolation, and independent removal are verified;
  model-visible Skill behavior is not.
- Async Wait Guard implicit triggering and wait behavior in a fresh task.
  Installation, cache isolation, and independent removal are verified;
  structural and deterministic checks do not establish host wait behavior.
- Token or elapsed-time savings from Async Wait Guard. The motivating X post
  reports an individual observation, not a general compatibility or performance
  result for this repository.

Context Relay is designed to state these limitations rather than infer missing
compatibility.

## Adding evidence

Follow [`EXTERNAL_TESTING.md`](EXTERNAL_TESTING.md). A qualifying report must
name the public revision, declare source completeness, use synthetic or public
inputs, include exact commands or actions, separate observed facts from
interpretation, and record failures as well as successes.

The maintainer runtime procedure is documented in
[`RUNTIME_EVIDENCE.md`](RUNTIME_EVIDENCE.md). The schema and hashes, rather
than screenshots alone, determine whether a run qualifies.
