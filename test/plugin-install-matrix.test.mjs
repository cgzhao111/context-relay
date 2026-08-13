import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateRuntimeReport } from "../evaluation/compatibility/validate-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(root, ".github", "workflows", "plugin-isolation.yml"), "utf8");
const harness = readFileSync(join(root, "tools", "run-plugin-install-matrix.ps1"), "utf8");

const sourceCommit = "dd3cbfb1f10c29808193dee167f4d595e7046f38";
const nodeChecksum = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97";
const codexIntegrity = "sha512-jjB+K+OMv572mKhS+2QuLxWXDJNdpwbPenf+V+8bdq7wg4Scqt3cn6WEekD8wPqDVZqck0HSX17K9rD9kbDJQA==";
const codexWindowsIntegrity = "sha512-DnsSTlnnzleTxvLwIGnBitKInscxn2I7qASqosS8Fv+qysBygd+ZiBn/SQsRCgQ28PAlsNzmd3Gf3ZTecolAmg==";
const plugins = ["context-relay", "execution-budget", "async-wait-guard"];

function runTreeProbe(scriptPath, sourcePath, cachePath) {
  const execution = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, sourcePath, cachePath,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  return JSON.parse(execution.stdout);
}

test("Windows evidence workflow pins the source and executable toolchain", () => {
  assert.match(workflow, /pull_request:\s*[\s\S]*paths:/);
  assert.match(workflow, /push:\s*[\s\S]*codex\/runtime-evidence/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /NODE_VERSION:\s*22\.23\.2/);
  assert.match(workflow, /CODEX_CLI_VERSION:\s*0\.144\.5/);
  assert.match(workflow, /\$npmPrefix = Join-Path \$env:RUNNER_TEMP 'codex-npm-prefix'/);
  assert.match(workflow, /"NPM_CONFIG_PREFIX=\$npmPrefix"[^\r\n]*\$env:GITHUB_ENV/);
  assert.doesNotMatch(workflow, /NPM_CONFIG_PREFIX:\s*\$\{\{ runner\.temp/);
  assert.ok(workflow.includes(`NODE_ZIP_SHA256: ${nodeChecksum}`));
  assert.ok(workflow.includes(`CODEX_NPM_INTEGRITY: ${codexIntegrity}`));
  assert.ok(workflow.includes(`CODEX_WINDOWS_NPM_INTEGRITY: ${codexWindowsIntegrity}`));
  assert.match(workflow, /MINGIT_ARCHIVE_SHA256:\s*4e03f94c2ffbf70be337e005cee02661c732dbfc81031a078bda9299b9a7d644/);
  assert.ok(workflow.includes(`default: ${sourceCommit}`));
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.source_commit \|\| 'dd3cbfb1f10c29808193dee167f4d595e7046f38'/);
  assert.match(workflow, /https:\/\/nodejs\.org\/dist\/v\$env:NODE_VERSION\/SHASUMS256\.txt/);
  assert.match(workflow, /@openai\/codex@\$env:CODEX_CLI_VERSION/);
  assert.match(workflow, /npm\.cmd view .* dist --json/);
  assert.match(workflow, /installed Codex binary did not match the checksum-verified Windows package/i);
  assert.match(workflow, /run-plugin-install-matrix\.ps1/);
  assert.match(workflow, /npm\.cmd ci --ignore-scripts --no-audit --no-fund/);
});

test("workflow publishes an always-attempted sanitized evidence artifact", () => {
  assert.match(workflow, /uses:\s*actions\/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f\s*# v6/);
  assert.match(workflow, /uses:\s*actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\s*# v7/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /id:\s*matrix[\s\S]*continue-on-error:\s*true/);
  assert.match(workflow, /id:\s*finalize[\s\S]*if:\s*always\(\)/);
  assert.match(workflow, /id:\s*validate[\s\S]*steps\.finalize\.outcome == 'success'/);
  assert.match(workflow, /steps\.finalize\.outcome == 'success' && steps\.validate\.outcome == 'success'/);
  assert.match(workflow, /report\.json[\s\S]*matrix-details\.json[\s\S]*privacy-scan\.txt[\s\S]*checksums\.sha256/);
  assert.match(workflow, /Enforce matrix result after safe evidence handling/);
  assert.match(workflow, /if-no-files-found:\s*error/);
  assert.match(workflow, /plugin-isolation-\$\{\{ env\.SOURCE_COMMIT \}\}/);
  assert.doesNotMatch(workflow, /codex\s+login|OPENAI_API_KEY|CODEX_API_KEY/i);
  assert.match(workflow, /validate-report\.mjs/);
  assert.match(workflow, /--check-evidence/);
  assert.match(workflow, /--expected-commit \$env:SOURCE_COMMIT/);
  assert.match(workflow, /-FinalizeOnly/);
});

test("PowerShell harness verifies single, combined, and independent removal states", () => {
  assert.ok(harness.includes(`[string]$SourceCommit = '${sourceCommit}'`));
  for (const plugin of plugins) assert.ok(harness.includes(`'${plugin}'`));
  assert.match(harness, /foreach \(\$plugin in \$pluginNames\)[\s\S]*single-\$plugin-installed[\s\S]*single-\$plugin-removed/);
  assert.match(harness, /Save-StateSnapshot -StepId 'all-three-installed'/);
  assert.match(harness, /foreach \(\$plugin in @\('async-wait-guard', 'execution-budget', 'context-relay'\)\)/);
  assert.match(harness, /Save-StateSnapshot -StepId "removed-\$plugin-independently"/);
  assert.match(harness, /exact-installed-set/);
  assert.match(harness, /exact-cache-set/);
  assert.match(harness, /\[string\]\$ExpectedVersion/);
  assert.match(harness, /cached versions/);
  assert.match(harness, /\$manifest\.version -ne \$ExpectedVersion/);
  assert.match(harness, /pluginVersions\[\$PluginName\]/);
  assert.match(harness, /Join-Path \$cacheNamespace \$PluginName\) \(\[string\]\$result\.version\)/);
});

test("harness refuses CODEX_HOME overrides and emits bounded evidence", () => {
  assert.match(harness, /Test-Path Env:CODEX_HOME/);
  assert.match(harness, /\$env:GITHUB_ACTIONS -ne 'true'/);
  assert.match(harness, /OutputDirectory must be a child of RUNNER_TEMP/);
  assert.match(harness, /Use -FinalizeOnly for local artifact validation/);
  assert.doesNotMatch(harness, /\$env:CODEX_HOME\s*=|Set-Item\s+(?:-Path\s+)?Env:CODEX_HOME|CODEX_HOME=/i);
  assert.doesNotMatch(harness, /codex\s+login|OPENAI_API_KEY|CODEX_API_KEY/i);
  assert.match(harness, /runtimeTriggerVerified = \$false/);
  assert.match(harness, /report\.json/);
  assert.match(harness, /matrix-details\.json/);
  assert.match(harness, /matrix-events\.jsonl/);
  assert.match(harness, /privacy-scan\.txt/);
  assert.match(harness, /checksums\.sha256/);
  assert.match(harness, /Get-FileHash -Algorithm SHA256/);
  assert.match(harness, /function Get-PluginTree/);
  assert.match(harness, /contentMatchesSource = \$true/);
  assert.match(harness, /treeSha256 = \$cacheTree\.treeSha256/);
  assert.match(harness, /Plugin cache content did not match the pinned source tree/);
  assert.match(harness, /MATRIX_FAILED/);
  assert.doesNotMatch(harness, /Set-Content[^\r\n]*(?:\$stdout|\$stderr)/i);
  const evidenceProjection = harness.slice(
    harness.indexOf("$sanitizedEntries ="),
    harness.indexOf("function Install-Plugin")
  );
  assert.doesNotMatch(evidenceProjection, /installedPath|installedRoot|marketplaceSource|\bsource\s*=/);
});

test("PowerShell tree inventory binds exact relative paths and bytes", {
  skip: process.platform !== "win32",
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "context-relay-tree-binding-"));
  try {
    const source = join(directory, "source");
    const cache = join(directory, "cache");
    mkdirSync(join(source, "skills"), { recursive: true });
    mkdirSync(join(cache, "skills"), { recursive: true });
    writeFileSync(join(source, "plugin.json"), "{\"version\":\"1.0.0\"}\n", "utf8");
    writeFileSync(join(source, "skills", "SKILL.md"), "synthetic skill\n", "utf8");
    writeFileSync(join(cache, "plugin.json"), "{\"version\":\"1.0.0\"}\n", "utf8");
    writeFileSync(join(cache, "skills", "SKILL.md"), "synthetic skill\n", "utf8");

    const functionStart = harness.indexOf("function Get-PluginTree {");
    const functionEnd = harness.indexOf("function Write-MatrixEvents {");
    assert.ok(functionStart >= 0 && functionEnd > functionStart);
    const probePath = join(directory, "probe.ps1");
    writeFileSync(probePath, [
      "param([string]$SourceRoot, [string]$CacheRoot)",
      "$ErrorActionPreference = 'Stop'",
      "$utf8NoBom = New-Object System.Text.UTF8Encoding($false)",
      harness.slice(functionStart, functionEnd),
      "$result = [ordered]@{ source = Get-PluginTree -Root $SourceRoot; cache = Get-PluginTree -Root $CacheRoot }",
      "$result | ConvertTo-Json -Depth 20",
    ].join("\n"), "utf8");

    const matching = runTreeProbe(probePath, source, cache);
    assert.equal(matching.source.treeSha256, matching.cache.treeSha256);
    assert.deepEqual(matching.source.files.map(({ path }) => path), ["plugin.json", "skills/SKILL.md"]);
    assert.deepEqual(matching.source.files, matching.cache.files);

    writeFileSync(join(cache, "skills", "SKILL.md"), "synthetic skill changed\n", "utf8");
    const changed = runTreeProbe(probePath, source, cache);
    assert.notEqual(changed.source.treeSha256, changed.cache.treeSha256);
    assert.notEqual(changed.source.files[1].sha256, changed.cache.files[1].sha256);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("installation matrix refuses to touch a normal host profile", {
  skip: process.platform !== "win32",
}, () => {
  const directory = join(tmpdir(), `context-relay-host-guard-${Date.now()}`);
  const childEnv = { ...process.env };
  delete childEnv.CODEX_HOME;
  delete childEnv.GITHUB_ACTIONS;
  delete childEnv.RUNNER_TEMP;
  const execution = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "tools", "run-plugin-install-matrix.ps1"),
    "-SourceCommit", sourceCommit, "-OutputDirectory", directory,
  ], { cwd: root, env: childEnv, encoding: "utf8" });
  assert.notEqual(execution.status, 0);
  assert.match(execution.stderr, /only on an ephemeral GitHub Actions runner/i);
  assert.equal(existsSync(directory), false, "the guarded run created an evidence directory on the normal host");
});

test("public report follows the shared compatibility evidence contract", () => {
  assert.match(harness, /schema_version = '1\.0\.0'/);
  assert.match(harness, /report_id = 'gha-plugin-install-matrix'/);
  assert.match(harness, /id = 'bundle'/);
  assert.match(harness, /repository_commit = \$SourceCommit/);
  assert.match(harness, /surface = 'github-actions-windows'/);
  assert.match(harness, /workflow = 'marketplace-install-matrix'/);
  assert.match(harness, /mode = 'not-applicable'/);
  assert.match(harness, /status = 'not-applicable'/);
  assert.match(harness, /raw_private_artifacts_excluded = \$true/);
  assert.match(harness, /path = 'matrix-details\.json'/);
  assert.match(harness, /path = 'matrix-events\.jsonl'/);
  assert.match(harness, /media_type = 'application\/jsonl'/);
  assert.match(harness, /sha256 = \$detailsHash/);
  assert.match(harness, /scanPublicEvidence\(\{ scanRoots:/);
  assert.match(harness, /public_evidence_scan = if \(\$publicEvidenceScanPassed\)/);
  assert.match(harness, /result = if \(\$fullyPassed\) \{ 'success' \}/);
});

test("Windows finalization scans the exact detail artifact and emits a strict valid report", {
  skip: process.platform !== "win32",
}, () => {
  const output = mkdtempSync(join(tmpdir(), "context-relay-install-report-"));
  try {
    const details = {
      schemaVersion: "1.0.0",
      evidenceType: "codex-plugin-installation-isolation",
      status: "passed",
      startedAt: "2026-08-12T20:00:00.000Z",
      completedAt: "2026-08-12T20:01:00.000Z",
      source: { repository: "https://github.com/cgzhao111/context-relay", commit: sourceCommit },
      environment: { os: "Windows", nodeVersion: "v22.23.2", codexCliVersion: "codex-cli 0.144.5" },
      boundaries: {
        codexHomeOverrideUsed: false,
        loginUsed: false,
        runtimeTriggerVerified: false,
        verifiedClaims: ["marketplace-source-commit", "plugin-list-state", "plugin-cache-state", "independent-plugin-removal"],
      },
      marketplace: {
        name: "context-relay",
        sourceCommitVerified: true,
        pluginVersions: { "context-relay": "0.3.0-rc.2", "execution-budget": "0.1.0", "async-wait-guard": "0.1.0" },
      },
      steps: [{
        id: "all-three-installed",
        expectedInstalled: plugins,
        list: plugins.map((name) => ({
          pluginId: `${name}@context-relay`, name, marketplaceName: "context-relay", version: "0.1.0",
          installed: true, enabled: true, installPolicy: "AVAILABLE", authPolicy: "ON_INSTALL",
        })),
        cache: plugins.map((name) => ({
          name, present: true, fileCount: 3, skillCount: 1, manifestSha256: "a".repeat(64), topLevelEntries: [".codex-plugin", "skills"],
        })),
        assertions: ["complete-marketplace-inventory", "exact-installed-set", "exact-cache-set"],
      }],
      failure: null,
    };
    const detailsPath = join(output, "matrix-details.json");
    writeFileSync(detailsPath, `${JSON.stringify(details, null, 2)}\n`, "utf8");
    const eventsPath = join(output, "matrix-events.jsonl");
    writeFileSync(eventsPath, `${JSON.stringify({ schemaVersion: "1.0.0", event: "matrix-complete", ordinal: 1, status: "passed", failureCode: null, failureStage: null })}\n`, "utf8");
    const originalDigest = createHash("sha256").update(readFileSync(detailsPath)).digest("hex");
    const originalEventsDigest = createHash("sha256").update(readFileSync(eventsPath)).digest("hex");
    const childEnv = { ...process.env };
    delete childEnv.CODEX_HOME;
    const execution = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "tools", "run-plugin-install-matrix.ps1"),
      "-SourceCommit", sourceCommit, "-OutputDirectory", output, "-FinalizeOnly",
    ], { cwd: root, env: childEnv, encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    const finalDigest = createHash("sha256").update(readFileSync(detailsPath)).digest("hex");
    assert.equal(finalDigest, originalDigest, "the detail artifact changed after its privacy scan");
    const finalEventsDigest = createHash("sha256").update(readFileSync(eventsPath)).digest("hex");
    assert.equal(finalEventsDigest, originalEventsDigest, "the event artifact changed after its privacy scan");

    const reportPath = join(output, "report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const result = validateRuntimeReport(report, { reportPath, checkEvidence: true, expectedCommit: sourceCommit });
    assert.deepEqual(result, { valid: true, errors: [] });
    assert.equal(report.result, "success");
    assert.equal(report.privacy.public_evidence_scan, "pass");
    assert.equal(report.evidence.some(({ path }) => path === "matrix-events.jsonl"), true);
    assert.equal(readFileSync(join(output, "privacy-scan.txt"), "utf8").startsWith("PUBLIC_EVIDENCE_CHECK_OK"), true);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("Windows finalization emits a schema-valid privacy-scanned failure report", {
  skip: process.platform !== "win32",
}, () => {
  const output = mkdtempSync(join(tmpdir(), "context-relay-install-failure-"));
  try {
    const details = {
      schemaVersion: "1.0.0",
      evidenceType: "codex-plugin-installation-isolation",
      status: "failed",
      startedAt: "2026-08-12T20:00:00.000Z",
      completedAt: "2026-08-12T20:00:01.000Z",
      source: { repository: "https://github.com/cgzhao111/context-relay", commit: sourceCommit },
      environment: { os: "Windows", nodeVersion: null, codexCliVersion: null },
      boundaries: { codexHomeOverrideUsed: false, loginUsed: false, runtimeTriggerVerified: false, verifiedClaims: [] },
      marketplace: { name: "context-relay", sourceCommitVerified: false, pluginVersions: {} },
      steps: [],
      failure: { code: "MATRIX_FAILED", stage: "version-verification" },
    };
    const detailsPath = join(output, "matrix-details.json");
    writeFileSync(detailsPath, `${JSON.stringify(details, null, 2)}\n`, "utf8");
    writeFileSync(join(output, "matrix-events.jsonl"), `${JSON.stringify({ schemaVersion: "1.0.0", event: "matrix-complete", ordinal: 1, status: "failed", failureCode: "MATRIX_FAILED", failureStage: "single-install-context-relay" })}\n`, "utf8");
    const childEnv = { ...process.env };
    delete childEnv.CODEX_HOME;
    const execution = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "tools", "run-plugin-install-matrix.ps1"),
      "-SourceCommit", sourceCommit, "-OutputDirectory", output, "-FinalizeOnly",
    ], { cwd: root, env: childEnv, encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    const reportPath = join(output, "report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.result, "failure");
    assert.equal(report.plugin.version, "0.0.0");
    assert.equal(report.privacy.public_evidence_scan, "pass");
    assert.equal(validateRuntimeReport(report, { reportPath, checkEvidence: true, expectedCommit: sourceCommit }).valid, true);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
