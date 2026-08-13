# Windows Sandbox runtime evidence harness

This directory prepares an isolated, private evidence run for the three plugins in the public
`context-relay` marketplace. It deliberately does not install or remove anything in the host Codex
profile.

## Security boundary

- The generated `.wsb` disables clipboard, printer, audio input, video input, and vGPU redirection.
- Only one user-selected, existing, empty evidence directory is mapped into the Sandbox.
- The repository, the host user profile, and the host `.codex` directory are never mapped.
- The host baseline commands only read `codex --version` and `codex plugin list --available --json`.
- Device authentication is an explicit interactive gate. Its command is not redirected to an
  evidence file and PowerShell transcription is not enabled.
- Sandbox networking is enabled for downloads and device authentication. The `.wsb` format used
  here does not enforce an egress allowlist; the scripts separately pin expected download hosts,
  versions, commits, and package digests where applicable.
- Sandbox output is private raw evidence. It must not be committed or published without human
  review and redaction.

## Fixed inputs

- Node.js `22.23.2`, archive SHA256
  `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`
- `@openai/codex` `0.144.5`
- Windows x64 Codex payload integrity
  `sha512-DnsSTlnnzleTxvLwIGnBitKInscxn2I7qASqosS8Fv+qysBygd+ZiBn/SQsRCgQ28PAlsNzmd3Gf3ZTecolAmg==`
- MinGit `2.55.0.windows.4`, archive SHA256
  `4e03f94c2ffbf70be337e005cee02661c732dbfc81031a078bda9299b9a7d644`
- `cgzhao111/context-relay` commit
  `dd3cbfb1f10c29808193dee167f4d595e7046f38`

## Host commands

Create a new empty directory outside the repository and outside `.codex`. The example uses a
dedicated directory on `D:`; replace it if needed.

```powershell
cd D:\context-relay
$harnessCommit = (git rev-parse HEAD).Trim()
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$evidence = "D:\context-relay-sandbox-evidence-$stamp"
$private = "D:\context-relay-sandbox-private-$stamp"
New-Item -ItemType Directory -Path $evidence,$private | Out-Null

powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  "D:\context-relay\tools\windows-sandbox\New-ContextRelaySandbox.ps1" `
  -EvidenceDirectory $evidence `
  -ConfigPath "$private\context-relay-runtime.wsb" `
  -HostBaselinePath "$private\host-before.private.json" `
  -HarnessCommit $harnessCommit

Start-Process "$private\context-relay-runtime.wsb"
```

Inside Windows Sandbox, complete the device authorization only when the explicit yellow manual
gate appears. When the run ends, inspect the evidence while it remains private and close Windows
Sandbox.

After Sandbox closes, compare the host plugin inventory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  "D:\context-relay\tools\windows-sandbox\Invoke-HostBaseline.ps1" `
  -Mode Compare `
  -BaselinePath "$private\host-before.private.json" `
  -ReportPath "$evidence\host-after-comparison.private.json"
```

The expected terminal result is `HOST_BASELINE_UNCHANGED`. A mismatch returns exit code `3` and
must be investigated; the harness does not attempt to repair or mutate the host Codex profile.

`$harnessCommit` must already be pushed to the public repository and contain
the same harness files as the local checkout. The generator hashes the local
bootstrap and refuses a downloaded mismatch.

## Evidence interpretation

- Plugin inventory assertions are deterministic installation/removal evidence.
- Each `codex exec --ephemeral` invocation is a fresh task and writes private JSONL plus its last
  message.
- Runtime responses are always marked `human_review_required` and are not automatically certified.
- The async-wait probe does not run a host wait and always records
  `actual_host_wait_verified: false`.
- Raw output may still contain account or environment information despite prompt constraints. Never
  publish it directly.
