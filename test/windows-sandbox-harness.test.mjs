import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessRoot = join(root, "tools", "windows-sandbox");
const generator = join(harnessRoot, "New-ContextRelaySandbox.ps1");
const baseline = join(harnessRoot, "Invoke-HostBaseline.ps1");
const bootstrap = join(harnessRoot, "bootstrap.ps1");
const partialReport = join(harnessRoot, "New-CompatibilityPartialReport.ps1");
const contractValidator = join(root, "evaluation", "compatibility", "validate-report.mjs");
const temporary = [];
const windowsOnly = { skip: process.platform !== "win32" };

function fixture(name = "sandbox-harness") {
  const path = mkdtempSync(join(tmpdir(), `${name}-`));
  temporary.push(path);
  return path;
}

function ps(file, args = []) {
  return spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", file,
    ...args,
  ], { cwd: root, encoding: "utf8" });
}

function git(args, options = {}) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", ...options });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function inventory({ context = true, budget = false, wait = false } = {}) {
  const target = [
    ["context-relay@context-relay", "0.3.0-rc.2", context],
    ["execution-budget@context-relay", "0.1.0", budget],
    ["async-wait-guard@context-relay", "0.1.0", wait],
  ];
  return {
    installed: target.filter(([, , installed]) => installed).map(([pluginId, version]) => ({
      pluginId, version, installed: true, enabled: true,
    })),
    available: target.filter(([, , installed]) => !installed).map(([pluginId, version]) => ({
      pluginId, version, installed: false, enabled: false,
    })),
  };
}

test.after(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

test("all PowerShell harness files parse without syntax errors", windowsOnly, () => {
  const command = [
    "$failed=$false",
    `Get-ChildItem -LiteralPath '${harnessRoot.replaceAll("'", "''")}' -Filter '*.ps1' | ForEach-Object {`,
    "$tokens=$null; $errors=$null",
    "[System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tokens,[ref]$errors) | Out-Null",
    "if($errors.Count -gt 0){$failed=$true; $errors | ForEach-Object { Write-Error $_.Message }}",
    "}",
    "if($failed){exit 1}",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("generator emits a single hardened evidence mapping and captures an offline host baseline", windowsOnly, () => {
  const directory = fixture("sandbox-safe-config");
  const evidence = join(directory, "evidence & output");
  const privateRoot = join(directory, "private files");
  mkdirSync(evidence);
  mkdirSync(privateRoot);
  const inventoryPath = join(directory, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify(inventory()), "utf8");
  const configPath = join(privateRoot, "context relay.wsb");
  const baselinePath = join(privateRoot, "host-before.private.json");
  const commitResult = git(["rev-parse", "HEAD"]);
  assert.equal(commitResult.status, 0, commitResult.stderr);
  const commit = commitResult.stdout.trim();

  const result = ps(generator, [
    "-EvidenceDirectory", evidence,
    "-ConfigPath", configPath,
    "-HostBaselinePath", baselinePath,
    "-HostInventoryJsonPath", inventoryPath,
    "-HarnessCommit", commit,
    "-SkipWindowsSandboxCheck",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WINDOWS_SANDBOX_CONFIG_READY/);

  const xml = readFileSync(configPath, "utf8");
  assert.equal((xml.match(/<MappedFolder>/g) ?? []).length, 1);
  assert.match(xml, /<SandboxFolder>C:\\EvidenceOut<\/SandboxFolder>/);
  assert.match(xml, /<ClipboardRedirection>Disable<\/ClipboardRedirection>/);
  assert.match(xml, /<PrinterRedirection>Disable<\/PrinterRedirection>/);
  assert.match(xml, /<AudioInput>Disable<\/AudioInput>/);
  assert.match(xml, /<VideoInput>Disable<\/VideoInput>/);
  assert.match(xml, /<VGpu>Disable<\/VGpu>/);
  assert.match(xml, /<ProtectedClient>Enable<\/ProtectedClient>/);
  const encoded = xml.match(/-EncodedCommand ([A-Za-z0-9+/=]+)<\/Command>/)?.[1];
  assert.ok(encoded);
  const launcher = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(launcher, new RegExp(`raw\\.githubusercontent\\.com/cgzhao111/context-relay/${commit}/tools/windows-sandbox/bootstrap\\.ps1`));
  assert.equal(launcher.includes("/main/tools/windows-sandbox/bootstrap.ps1"), false);
  assert.equal(xml.toLowerCase().includes("\\.codex"), false);
  assert.equal(xml.includes(root), false);

  const captured = JSON.parse(readFileSync(baselinePath, "utf8"));
  assert.equal(captured.evidence_class, "private-host-baseline");
  assert.equal(captured.codex_cli_version, "offline-fixture");
  assert.equal(captured.inventory.target_plugins.length, 3);
});

test("generator pins hashes to LF Git blobs when the checkout files use CRLF", windowsOnly, () => {
  const directory = fixture("sandbox-committed-byte-hashes");
  const repository = join(directory, "repository");
  const harness = join(repository, "tools", "windows-sandbox");
  const evidence = join(directory, "evidence");
  const privateRoot = join(directory, "private");
  mkdirSync(harness, { recursive: true });
  mkdirSync(evidence);
  mkdirSync(privateRoot);

  for (const name of [
    "New-ContextRelaySandbox.ps1",
    "SandboxHarness.Common.ps1",
    "Invoke-HostBaseline.ps1",
    "bootstrap.ps1",
    "New-CompatibilityPartialReport.ps1",
  ]) {
    copyFileSync(join(harnessRoot, name), join(harness, name));
  }
  writeFileSync(join(repository, ".gitattributes"), "* text=auto\n", "utf8");

  const runGit = (args) => spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "Sandbox Harness Test"],
    ["config", "user.email", "sandbox-harness@example.invalid"],
    ["add", "."],
    ["commit", "--quiet", "-m", "LF harness fixture"],
  ]) {
    const result = runGit(args);
    assert.equal(result.status, 0, result.stderr);
  }
  const commitResult = runGit(["rev-parse", "HEAD"]);
  assert.equal(commitResult.status, 0, commitResult.stderr);
  const commit = commitResult.stdout.trim();

  const pinnedPaths = ["bootstrap.ps1", "New-CompatibilityPartialReport.ps1"];
  const expected = {};
  const working = {};
  for (const name of pinnedPaths) {
    const relativePath = `tools/windows-sandbox/${name}`;
    const blob = spawnSync("git", ["show", `${commit}:${relativePath}`], { cwd: repository, encoding: null });
    assert.equal(blob.status, 0, blob.stderr.toString());
    expected[name] = sha256(blob.stdout);
    const crlf = readFileSync(join(harness, name), "utf8").replace(/\r?\n/g, "\r\n");
    writeFileSync(join(harness, name), crlf, "utf8");
    working[name] = sha256(readFileSync(join(harness, name)));
    assert.notEqual(working[name], expected[name]);
  }

  const inventoryPath = join(directory, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify(inventory()), "utf8");
  const configPath = join(privateRoot, "run.wsb");
  const baselinePath = join(privateRoot, "host-before.private.json");
  const generated = ps(join(harness, "New-ContextRelaySandbox.ps1"), [
    "-EvidenceDirectory", evidence,
    "-ConfigPath", configPath,
    "-HostBaselinePath", baselinePath,
    "-HostInventoryJsonPath", inventoryPath,
    "-HarnessCommit", commit,
    "-SkipWindowsSandboxCheck",
  ]);
  assert.equal(generated.status, 0, generated.stderr);

  const xml = readFileSync(configPath, "utf8");
  const encoded = xml.match(/-EncodedCommand ([A-Za-z0-9+/=]+)<\/Command>/)?.[1];
  assert.ok(encoded);
  const launcher = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(launcher, new RegExp(`actualHash -ne '${expected["bootstrap.ps1"]}'`));
  assert.match(launcher, /for \(\$attempt = 1; \$attempt -le 4; \$attempt\+\+\)/);
  assert.match(launcher, /Bootstrap download failed after four attempts/);
  assert.match(launcher, /SecurityProtocol -bor \[System\.Net\.SecurityProtocolType\]::Tls12/);
  assert.match(launcher, new RegExp(`PartialReportHelperSha256 '${expected["New-CompatibilityPartialReport.ps1"]}'`));
  assert.equal(launcher.includes(working["bootstrap.ps1"]), false);
  assert.equal(launcher.includes(working["New-CompatibilityPartialReport.ps1"]), false);
});

test("generator rejects a tree or missing HarnessCommit before creating host artifacts", windowsOnly, () => {
  const directory = fixture("sandbox-invalid-harness-commit");
  const evidence = join(directory, "evidence");
  const privateRoot = join(directory, "private");
  mkdirSync(evidence);
  mkdirSync(privateRoot);
  const inventoryPath = join(directory, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify(inventory()), "utf8");

  const treeResult = git(["rev-parse", "HEAD^{tree}"]);
  assert.equal(treeResult.status, 0, treeResult.stderr);
  const cases = [
    { name: "tree", commit: treeResult.stdout.trim(), message: /must identify a Git commit; found 'tree'/ },
    { name: "missing", commit: "0".repeat(40), message: /is not a locally available Git object/ },
  ];

  for (const current of cases) {
    const configPath = join(privateRoot, `${current.name}.wsb`);
    const baselinePath = join(privateRoot, `${current.name}-baseline.json`);
    const result = ps(generator, [
      "-EvidenceDirectory", evidence,
      "-ConfigPath", configPath,
      "-HostBaselinePath", baselinePath,
      "-HostInventoryJsonPath", inventoryPath,
      "-HarnessCommit", current.commit,
      "-SkipWindowsSandboxCheck",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, current.message);
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(baselinePath), false);
  }
});

test("generator fails closed for non-empty, repository, and .codex evidence paths", windowsOnly, () => {
  const directory = fixture("sandbox-rejected-paths");
  const privateRoot = join(directory, "private");
  mkdirSync(privateRoot);
  const inventoryPath = join(directory, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify(inventory()), "utf8");
  const common = [
    "-ConfigPath", join(privateRoot, "run.wsb"),
    "-HostBaselinePath", join(privateRoot, "baseline.json"),
    "-HostInventoryJsonPath", inventoryPath,
    "-HarnessCommit", "b".repeat(40),
    "-SkipWindowsSandboxCheck",
  ];

  const nonempty = join(directory, "nonempty");
  mkdirSync(nonempty);
  writeFileSync(join(nonempty, "existing.txt"), "do not map", "utf8");
  const nonemptyResult = ps(generator, ["-EvidenceDirectory", nonempty, ...common]);
  assert.notEqual(nonemptyResult.status, 0);
  assert.match(nonemptyResult.stderr, /must be empty/i);

  const repoResult = ps(generator, ["-EvidenceDirectory", root, ...common]);
  assert.notEqual(repoResult.status, 0);
  assert.match(repoResult.stderr, /protected host location/i);

  const fakeCodex = join(directory, ".codex", "evidence");
  mkdirSync(fakeCodex, { recursive: true });
  const codexResult = ps(generator, ["-EvidenceDirectory", fakeCodex, ...common]);
  assert.notEqual(codexResult.status, 0);
  assert.match(codexResult.stderr, /\.codex/i);
});

test("host artifact paths reject a junction parent", windowsOnly, (t) => {
  const directory = fixture("sandbox-junction");
  const evidence = join(directory, "evidence");
  const realPrivate = join(directory, "real-private");
  const junction = join(directory, "junction-private");
  mkdirSync(evidence);
  mkdirSync(realPrivate);
  try {
    symlinkSync(realPrivate, junction, "junction");
  } catch (error) {
    t.skip(`junction creation unavailable: ${error.code ?? error.message}`);
    return;
  }
  const inventoryPath = join(directory, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify(inventory()), "utf8");
  const result = ps(generator, [
    "-EvidenceDirectory", evidence,
    "-ConfigPath", join(junction, "run.wsb"),
    "-HostBaselinePath", join(realPrivate, "baseline.json"),
    "-HostInventoryJsonPath", inventoryPath,
    "-HarnessCommit", "c".repeat(40),
    "-SkipWindowsSandboxCheck",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reparse points are not accepted/i);
});

test("generator rejects identical config and baseline paths before writing either artifact", windowsOnly, () => {
  const directory = fixture("sandbox-identical-artifacts");
  const evidence = join(directory, "evidence");
  const privateRoot = join(directory, "private");
  mkdirSync(evidence);
  mkdirSync(privateRoot);
  const inventoryPath = join(directory, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify(inventory()), "utf8");
  const sharedPath = join(privateRoot, "shared.wsb");

  const result = ps(generator, [
    "-EvidenceDirectory", evidence,
    "-ConfigPath", sharedPath,
    "-HostBaselinePath", sharedPath,
    "-HostInventoryJsonPath", inventoryPath,
    "-HarnessCommit", "d".repeat(40),
    "-SkipWindowsSandboxCheck",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be different new files/i);
  assert.equal(existsSync(sharedPath), false);
});

test("generator never overwrites existing config or baseline artifacts", windowsOnly, () => {
  const directory = fixture("sandbox-existing-artifacts");
  const evidence = join(directory, "evidence");
  const privateRoot = join(directory, "private");
  mkdirSync(evidence);
  mkdirSync(privateRoot);
  const inventoryPath = join(directory, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify(inventory()), "utf8");
  const configPath = join(privateRoot, "existing.wsb");
  const baselinePath = join(privateRoot, "existing-baseline.json");
  writeFileSync(configPath, "CONFIG_SENTINEL", "utf8");

  const configResult = ps(generator, [
    "-EvidenceDirectory", evidence,
    "-ConfigPath", configPath,
    "-HostBaselinePath", baselinePath,
    "-HostInventoryJsonPath", inventoryPath,
    "-HarnessCommit", "e".repeat(40),
    "-SkipWindowsSandboxCheck",
  ]);
  assert.notEqual(configResult.status, 0);
  assert.match(configResult.stderr, /must not already exist/i);
  assert.equal(readFileSync(configPath, "utf8"), "CONFIG_SENTINEL");
  assert.equal(existsSync(baselinePath), false);

  rmSync(configPath);
  writeFileSync(baselinePath, "BASELINE_SENTINEL", "utf8");
  const baselineResult = ps(generator, [
    "-EvidenceDirectory", evidence,
    "-ConfigPath", configPath,
    "-HostBaselinePath", baselinePath,
    "-HostInventoryJsonPath", inventoryPath,
    "-HarnessCommit", "e".repeat(40),
    "-SkipWindowsSandboxCheck",
    "-ForceHostBaseline",
  ]);
  assert.notEqual(baselineResult.status, 0);
  assert.match(baselineResult.stderr, /must not already exist/i);
  assert.equal(readFileSync(baselinePath, "utf8"), "BASELINE_SENTINEL");
  assert.equal(existsSync(configPath), false);
});

test("generator rejects an existing config leaf symlink without touching its target", windowsOnly, (t) => {
  const directory = fixture("sandbox-leaf-symlink");
  const evidence = join(directory, "evidence");
  const privateRoot = join(directory, "private");
  const targetRoot = join(directory, "target");
  mkdirSync(evidence);
  mkdirSync(privateRoot);
  mkdirSync(targetRoot);
  const inventoryPath = join(directory, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify(inventory()), "utf8");
  const targetPath = join(targetRoot, "target.wsb");
  const linkPath = join(privateRoot, "linked.wsb");
  const baselinePath = join(privateRoot, "baseline.json");
  writeFileSync(targetPath, "SYMLINK_TARGET_SENTINEL", "utf8");
  try {
    symlinkSync(targetPath, linkPath, "file");
  } catch (error) {
    t.skip(`file symlink creation unavailable: ${error.code ?? error.message}`);
    return;
  }

  const result = ps(generator, [
    "-EvidenceDirectory", evidence,
    "-ConfigPath", linkPath,
    "-HostBaselinePath", baselinePath,
    "-HostInventoryJsonPath", inventoryPath,
    "-HarnessCommit", "f".repeat(40),
    "-SkipWindowsSandboxCheck",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reparse points are not accepted/i);
  assert.equal(readFileSync(targetPath, "utf8"), "SYMLINK_TARGET_SENTINEL");
  assert.equal(existsSync(baselinePath), false);
});

test("host baseline comparison is read-only, deterministic, and fails on drift", windowsOnly, () => {
  const directory = fixture("sandbox-baseline");
  const beforeInventory = join(directory, "before-inventory.json");
  const changedInventory = join(directory, "changed-inventory.json");
  const baselinePath = join(directory, "baseline.private.json");
  const unchangedReport = join(directory, "unchanged.private.json");
  const changedReport = join(directory, "changed.private.json");
  writeFileSync(beforeInventory, JSON.stringify(inventory()), "utf8");
  writeFileSync(changedInventory, JSON.stringify(inventory({ context: true, budget: true })), "utf8");

  const capture = ps(baseline, ["-Mode", "Capture", "-BaselinePath", baselinePath, "-InventoryJsonPath", beforeInventory]);
  assert.equal(capture.status, 0, capture.stderr);
  const same = ps(baseline, [
    "-Mode", "Compare", "-BaselinePath", baselinePath, "-ReportPath", unchangedReport,
    "-InventoryJsonPath", beforeInventory,
  ]);
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /HOST_BASELINE_UNCHANGED/);
  assert.equal(JSON.parse(readFileSync(unchangedReport, "utf8")).host_inventory_unchanged, true);

  const drift = ps(baseline, [
    "-Mode", "Compare", "-BaselinePath", baselinePath, "-ReportPath", changedReport,
    "-InventoryJsonPath", changedInventory,
  ]);
  assert.equal(drift.status, 3);
  const report = JSON.parse(readFileSync(changedReport, "utf8"));
  assert.equal(report.host_inventory_unchanged, false);
  assert.deepEqual(report.changed_plugin_ids, ["execution-budget@context-relay"]);
});

test("Windows tar extracts zip archives without the PowerShell.Archive module", windowsOnly, () => {
  const directory = fixture("sandbox-tar-zip");
  const source = join(directory, "source");
  const destination = join(directory, "destination");
  const archive = join(directory, "fixture.zip");
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, "payload.txt"), "verified zip payload\n", "utf8");

  const create = spawnSync("tar.exe", ["-a", "-cf", archive, "-C", source, "payload.txt"], {
    encoding: "utf8",
  });
  assert.equal(create.status, 0, create.stderr);
  const extract = spawnSync("tar.exe", ["-xf", archive, "-C", destination], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr);
  assert.equal(readFileSync(join(destination, "payload.txt"), "utf8"), "verified zip payload\n");
});

test("PowerShell 5.1 download retry clears partial files and keeps errors sanitized", windowsOnly, () => {
  const directory = fixture("sandbox-download-retry");
  const source = readFileSync(bootstrap, "utf8");
  const helperStart = source.indexOf("function Remove-DownloadArtifact");
  const helperEnd = source.indexOf("function Write-Utf8NoBom");
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helpers = source.slice(helperStart, helperEnd);
  const script = join(directory, "retry.ps1");
  const output = join(directory, "payload.bin");
  writeFileSync(script, [
    "$ErrorActionPreference = 'Stop'",
    "$script:CurrentStage = 'test'",
    "$script:calls = 0",
    "$script:sleeps = @()",
    "function Start-Sleep { param([double]$Seconds) $script:sleeps += [int]$Seconds }",
    "function Invoke-WebRequest {",
    "  param([switch]$UseBasicParsing,[string]$Uri,[string]$OutFile)",
    "  $script:calls++",
    "  [IO.File]::WriteAllText($OutFile, ('partial-' + $script:calls))",
    "  if ($script:calls -lt 3) { throw 'synthetic transient failure with private detail' }",
    "  [IO.File]::WriteAllText($OutFile, 'verified')",
    "}",
    helpers,
    `Invoke-DownloadWithRetry -Name 'synthetic-download' -Uri 'https://example.invalid/private?q=secret' -OutFile '${output.replaceAll("'", "''")}'`,
    "$result = [ordered]@{ calls=$script:calls; sleeps=@($script:sleeps); content=[IO.File]::ReadAllText('" + output.replaceAll("'", "''") + "') }",
    "$result | ConvertTo-Json -Compress",
  ].join("\r\n"), "utf8");
  const completed = ps(script);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(JSON.parse(completed.stdout.trim()), { calls: 3, sleeps: [2, 4], content: "verified" });

  const rejected = join(directory, "reject.ps1");
  writeFileSync(rejected, [
    "$ErrorActionPreference = 'Stop'",
    "$script:CurrentStage = 'test'",
    helpers,
    "try { Invoke-DownloadWithRetry -Name 'unsafe-source' -Uri 'http://example.invalid/private?q=secret' -OutFile 'C:\\private\\artifact.bin'; exit 9 }",
    "catch { Write-Output $_.Exception.Message; exit 0 }",
  ].join("\r\n"), "utf8");
  const failed = ps(rejected);
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stdout, /requires a valid HTTPS source/);
  assert.doesNotMatch(failed.stdout, /private|artifact\.bin|q=secret/i);

  const exhausted = join(directory, "exhausted.ps1");
  const exhaustedOutput = join(directory, "exhausted.private.bin");
  writeFileSync(exhausted, [
    "$ErrorActionPreference = 'Stop'",
    "$script:CurrentStage = 'test'",
    "$script:calls = 0",
    "function Start-Sleep { param([double]$Seconds) }",
    "function Invoke-WebRequest {",
    "  param([switch]$UseBasicParsing,[string]$Uri,[string]$OutFile)",
    "  $script:calls++",
    "  [IO.File]::WriteAllText($OutFile, 'partial-secret')",
    "  throw 'synthetic transient failure with private detail'",
    "}",
    helpers,
    `try { Invoke-DownloadWithRetry -Name 'exhausted-download' -Uri 'https://example.invalid/private?q=secret' -OutFile '${exhaustedOutput.replaceAll("'", "''")}'; exit 9 }`,
    "catch { [ordered]@{ calls=$script:calls; exists=(Test-Path -LiteralPath '" + exhaustedOutput.replaceAll("'", "''") + "'); message=$_.Exception.Message } | ConvertTo-Json -Compress; exit 0 }",
  ].join("\r\n"), "utf8");
  const exhaustedResult = ps(exhausted);
  assert.equal(exhaustedResult.status, 0, exhaustedResult.stderr);
  const exhaustedJson = JSON.parse(exhaustedResult.stdout.trim());
  assert.equal(exhaustedJson.calls, 4);
  assert.equal(exhaustedJson.exists, false);
  assert.match(exhaustedJson.message, /failed after 4 attempts from host 'example\.invalid'/);
  assert.doesNotMatch(exhaustedJson.message, /private|secret|artifact|exhausted\.private/i);
});

test("PowerShell 5.1 compatibility helpers preserve ordinal markers and relative evidence paths", windowsOnly, () => {
  const directory = fixture("sandbox-ps51-compat");
  const child = join(directory, "nested", "evidence.json");
  mkdirSync(dirname(child), { recursive: true });
  writeFileSync(child, "{}\n", "utf8");
  const source = readFileSync(bootstrap, "utf8");
  const start = source.indexOf("function Get-RelativeEvidencePath");
  const end = source.indexOf("function Invoke-CapturedProcess");
  assert.ok(start >= 0 && end > start);
  const helper = source.slice(start, end);
  const script = join(directory, "compat.ps1");
  writeFileSync(script, [
    "$ErrorActionPreference = 'Stop'",
    helper,
    `$relative = Get-RelativeEvidencePath -Root '${directory.replaceAll("'", "''")}' -Path '${child.replaceAll("'", "''")}'`,
    "$observed = ('ABC'.IndexOf('B',[System.StringComparison]::Ordinal) -ge 0)",
    "[ordered]@{ relative=$relative; observed=$observed } | ConvertTo-Json -Compress",
  ].join("\r\n"), "utf8");
  const completed = ps(script);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(JSON.parse(completed.stdout.trim()), { relative: "nested/evidence.json", observed: true });
});

test("bootstrap pins supply chain, keeps auth interactive, and emits fail-closed partial contracts", () => {
  const source = readFileSync(bootstrap, "utf8");
  const reportSource = readFileSync(partialReport, "utf8");
  assert.match(source, /22\.23\.2/);
  assert.match(source, /1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97/);
  assert.match(source, /0\.144\.5/);
  assert.match(source, /sha512-jjB\+K\+OMv572mKhS\+2QuLxWXDJNdpwbPenf\+V\+8bdq7wg4Scqt3cn6WEekD8wPqDVZqck0HSX17K9rD9kbDJQA==/);
  assert.match(source, /sha512-DnsSTlnnzleTxvLwIGnBitKInscxn2I7qASqosS8Fv\+qysBygd\+ZiBn\/SQsRCgQ28PAlsNzmd3Gf3ZTecolAmg==/);
  assert.match(source, /2\.55\.0\.windows\.4/);
  assert.match(source, /MinGit-2\.55\.0\.4-64-bit\.zip/);
  assert.match(source, /4e03f94c2ffbf70be337e005cee02661c732dbfc81031a078bda9299b9a7d644/);
  assert.match(source, /function Invoke-DownloadWithRetry/);
  assert.match(source, /\$Uri\.Scheme -ne \[Uri\]::UriSchemeHttps/);
  assert.match(source, /function Remove-DownloadArtifact/);
  assert.match(source, /TLS 1\.2 fallback after the system-default negotiation fails/);
  assert.match(source, /SecurityProtocol -bor \[System\.Net\.SecurityProtocolType\]::Tls12/);
  assert.match(source, /\[ValidateRange\(1, 6\)\]\[int\]\$MaxAttempts = 4/);
  assert.match(source, /Remove-DownloadArtifact -Name \$Name -Path \$OutFile/);
  assert.match(source, /Download step '\$Name' failed after \$MaxAttempts attempts/);
  assert.match(source, /failure_stage = \$script:CurrentStage/);
  assert.match(source, /function Get-RelativeEvidencePath/);
  assert.match(source, /\.IndexOf\(\$_, \[System\.StringComparison\]::Ordinal\) -ge 0/);
  assert.doesNotMatch(source, /\[System\.IO\.Path\]::GetRelativePath/);
  assert.doesNotMatch(source, /\.Contains\(\$_, \[System\.StringComparison\]::Ordinal\)/);
  assert.equal((source.match(/Invoke-WebRequest -UseBasicParsing/g) ?? []).length, 1);
  assert.doesNotMatch(source, /Expand-Archive/);
  assert.match(source, /Invoke-CapturedProcess -Name "extract-mingit" -FilePath "tar\.exe"/);
  assert.match(source, /Invoke-CapturedProcess -Name "extract-node" -FilePath "tar\.exe"/);
  assert.match(source, /git version \$GitVersion/);
  assert.match(source, /dd3cbfb1f10c29808193dee167f4d595e7046f38/);
  assert.match(source, /ComputeHash\(\$stream\)/);
  assert.match(source, /dist\.integrity/);
  assert.match(source, /Installed Codex binary did not match the checksum-verified Windows platform package/);
  assert.match(source, /\$marketplace\.marketplaceName -ne \$MarketplaceName/);
  assert.match(source, /\[bool\]\$marketplace\.alreadyAdded/);
  assert.doesNotMatch(source, /\$marketplace\.name/);
  assert.match(source, /resolvedMarketplaceCommit -ne \$RepositoryCommit/);
  assert.match(source, /unexpected plugin installation identity, version, or cache path/);
  assert.match(source, /unexpected plugin removal identity/);
  assert.match(source, /automatic_inventory_transition_matrix_verified = \$true/);
  assert.match(source, /automatic_cache_content_verified = \$false/);
  assert.doesNotMatch(source, /automatic_install_matrix_verified/);
  assert.match(source, /login --device-auth/);
  assert.doesNotMatch(source, /Start-Transcript/i);
  assert.doesNotMatch(source, /--ignore-user-config/);
  assert.match(source, /& \$FilePath @Arguments 1> \$stdoutPath 2> \$stderrPath/);
  assert.match(source, /if \(\$Plugin -eq "context-relay"\) \{ return "project-handoff" \}/);
  assert.match(source, /Invoke-ContextRelayArtifactProbe/);
  assert.match(source, /context-strict-validator/);
  assert.match(source, /context-stale-validator/);
  assert.match(source, /context-credential-validator/);
  assert.match(reportSource, /result = "partial"/);
  assert.match(reportSource, /fresh_context = \$true/);
  assert.match(reportSource, /status = "not-verifiable"/);
  assert.match(reportSource, /public_evidence_scan = "not-run"/);
  assert.match(source, /actual_async_host_wait_verified = \$false/);
  assert.match(source, /No actual host asynchronous wait was run or measured/);
  assert.match(
    source,
    /foreach \(\$plugin in @\("context-relay", "execution-budget", "async-wait-guard"\)\) \{[\s\S]*Save-Inventory -Name \("state-after-remove-" \+ \$plugin\) -ExpectedInstalled @\(\)[\s\S]*\}\s*foreach \(\$plugin in @\("context-relay", "execution-budget", "async-wait-guard"\)\) \{\s*Add-Plugin -Plugin \$plugin\s*\}/,
  );
});

test("generated partial compatibility report conforms to the shared runtime evidence contract", windowsOnly, () => {
  const directory = fixture("sandbox-partial-contract");
  const review = join(directory, "review.private.json");
  const output = join(directory, "contract");
  writeFileSync(review, JSON.stringify({
    schema_version: "1.0",
    evidence_class: "private-runtime-probe",
    human_review_required: true,
    automatically_certified: false,
  }), "utf8");
  const generated = ps(partialReport, [
    "-OutputDirectory", output,
    "-Plugin", "async-wait-guard",
    "-Version", "0.1.0",
    "-Workflow", "wait-policy",
    "-RepositoryCommit", "d".repeat(40),
    "-CodexVersion", "0.144.5",
    "-ReviewStatusPath", review,
    "-UnverifiedBoundaries", "No actual host asynchronous wait was run or measured.",
  ]);
  assert.equal(generated.status, 0, generated.stderr);
  const reportPath = join(output, "report.json");
  const validation = spawnSync(process.execPath, [contractValidator, reportPath, "--check-evidence", "--expected-commit", "d".repeat(40)], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  assert.equal(JSON.parse(validation.stdout).valid, true);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.doesNotMatch(readFileSync(partialReport, "utf8"), /Get-FileHash/);
  assert.equal(
    report.evidence[0].sha256,
    sha256(readFileSync(join(output, "evidence", "review-status.json"))),
  );
  assert.equal(report.result, "partial");
  assert.equal(report.installation.fresh_context, true);
  assert.equal(report.trigger.status, "not-verifiable");
  assert.equal(report.privacy.public_evidence_scan, "not-run");
  assert.equal(report.privacy.raw_private_artifacts_excluded, true);
});
