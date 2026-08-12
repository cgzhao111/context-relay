import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  formatFindings,
  scanPublicEvidence
} from "../evaluation/scripts/check-public-evidence.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scannerSource = join(repositoryRoot, "evaluation", "scripts", "check-public-evidence.mjs");
const temporaryRoots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "context-relay-evidence-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "evaluation", "scripts"), { recursive: true });
  mkdirSync(join(root, "evaluation", "cases"), { recursive: true });
  mkdirSync(join(root, "docs", "assets"), { recursive: true });
  return root;
}

function write(root, relativePath, contents) {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return path;
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test("clean public evidence passes", () => {
  const root = fixture();
  write(root, "evaluation/cases/summary.md", "Synthetic case with no user identifiers.\n");
  write(root, "docs/assets/metrics.json", JSON.stringify({ elapsed_seconds: 18, status: "passed" }));

  const result = scanPublicEvidence({ repositoryRoot: root });
  assert.equal(result.filesScanned, 2);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(formatFindings(result), ["PUBLIC_EVIDENCE_CHECK_OK files=2"]);
});

test("blocks every built-in sensitive-data class without retaining matched values", () => {
  const root = fixture();
  const synthetic = [
    String.raw`workspace=C:\Users\Sample\private\handoff.md`,
    "workspace=/home/sample/private/handoff.md",
    ["person", "example.test"].join("@"),
    ["+1", "415", "555", "0199"].join("-"),
    ["ghp", "A".repeat(24)].join("_"),
    ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
    ["123e4567", "e89b", "42d3", "a456", "426614174000"].join("-"),
    ["source", "thread"].join("_") + ": synthetic",
    ["raw", "transcript"].join("_") + ": synthetic"
  ];
  write(root, "evaluation/cases/private.md", synthetic.join("\n"));

  const result = scanPublicEvidence({ repositoryRoot: root });
  assert.deepEqual(
    new Set(result.findings.map((finding) => finding.rule)),
    new Set([
      "ABSOLUTE_WINDOWS_PATH",
      "ABSOLUTE_UNIX_PATH",
      "EMAIL_ADDRESS",
      "PHONE_NUMBER",
      "TOKEN_OR_SECRET",
      "PRIVATE_KEY",
      "UUID",
      "THREAD_OR_SESSION_FIELD",
      "RAW_CONVERSATION_ARTIFACT"
    ])
  );
  const report = formatFindings(result).join("\n");
  for (const value of synthetic) assert.equal(report.includes(value), false);
  assert.equal(Object.hasOwn(result.findings[0], "value"), false);
  assert.equal(Object.hasOwn(result.findings[0], "snippet"), false);
});

test("blocks all thread/session field aliases, chat logs, and assigned credentials", () => {
  const root = fixture();
  const sensitiveLines = [
    "thread: synthetic",
    "session_id = synthetic",
    "sourceThreadId: synthetic",
    ["chat", "log"].join("_") + ": synthetic",
    "api_key=" + "Z".repeat(24)
  ];
  write(root, "evaluation/cases/aliases.yml", sensitiveLines.join("\n"));

  const result = scanPublicEvidence({ repositoryRoot: root });
  const counts = result.findings.reduce((current, { rule }) => {
    current[rule] = (current[rule] ?? 0) + 1;
    return current;
  }, {});
  assert.equal(counts.THREAD_OR_SESSION_FIELD, 3);
  assert.equal(counts.RAW_CONVERSATION_ARTIFACT, 1);
  assert.equal(counts.TOKEN_OR_SECRET, 1);
});

test("detects literal private denylist entries case-insensitively", () => {
  const root = fixture();
  const denylist = write(root, ".private-denylist", "InternalProjectFalcon\n# ignored comment\n");
  write(root, "docs/assets/case.md", "An INTERNALPROJECTFALCON rollout example.\n");

  const result = scanPublicEvidence({ repositoryRoot: root, denylistPath: denylist });
  assert.deepEqual(result.findings.map(({ rule }) => rule), ["PRIVATE_DENYLIST_MATCH"]);
  assert.equal(formatFindings(result).join("\n").includes("InternalProjectFalcon"), false);
});

test("redacts a sensitive filename in reports", () => {
  const root = fixture();
  const uuidName = ["123e4567", "e89b", "42d3", "a456", "426614174000"].join("-");
  write(root, `docs/assets/${uuidName}.md`, "Synthetic content.\n");

  const result = scanPublicEvidence({ repositoryRoot: root });
  assert.equal(result.findings.some(({ rule }) => rule === "UUID"), true);
  const report = formatFindings(result).join("\n");
  assert.equal(report.includes(uuidName), false);
  assert.match(report, /<redacted-path-\d+>/);
});

test("scanner source is excluded so detector definitions do not self-report", () => {
  const root = fixture();
  cpSync(scannerSource, join(root, "evaluation", "scripts", "check-public-evidence.mjs"));
  write(root, "evaluation/cases/clean.md", "Only synthetic, publishable evidence.\n");

  const result = scanPublicEvidence({ repositoryRoot: root });
  assert.equal(result.filesScanned, 1);
  assert.deepEqual(result.findings, []);
});

test("executable evaluation harness canaries are excluded while their artifacts are scanned", () => {
  const root = fixture();
  const canaryEmail = ["synthetic", "invalid.example"].join("@");
  write(root, "evaluation/generate-cases.mjs", `const canary = ${JSON.stringify(canaryEmail)};\n`);
  write(root, "evaluation/cases/generated.md", "Publishable generated evidence.\n");

  const result = scanPublicEvidence({ repositoryRoot: root });
  assert.equal(result.filesScanned, 1);
  assert.deepEqual(result.findings, []);
});

test("binary public assets are not decoded as text but sensitive filenames remain blocked", () => {
  const root = fixture();
  const binaryPath = join(root, "docs", "assets", "demo.gif");
  writeFileSync(binaryPath, Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x2f, 0x68, 0x6f, 0x6d, 0x65]));

  const clean = scanPublicEvidence({ repositoryRoot: root });
  assert.equal(clean.filesScanned, 1);
  assert.deepEqual(clean.findings, []);

  const sensitiveName = ["123e4567", "e89b", "42d3", "a456", "426614174000"].join("-");
  writeFileSync(join(root, "docs", "assets", `${sensitiveName}.gif`), Buffer.from("GIF89a\0/synthetic"));
  const blocked = scanPublicEvidence({ repositoryRoot: root });
  assert.equal(blocked.findings.some(({ rule }) => rule === "UUID"), true);
  assert.equal(formatFindings(blocked).join("\n").includes(sensitiveName), false);
});

test("CLI honors the optional denylist environment variable and never echoes a match", () => {
  const root = fixture();
  const copiedScanner = join(root, "evaluation", "scripts", "check-public-evidence.mjs");
  cpSync(scannerSource, copiedScanner);
  const privateTerm = "SyntheticPrivateCodename";
  const denylist = write(root, ".private-denylist", `${privateTerm}\n`);
  write(root, "evaluation/cases/case.md", `Contains ${privateTerm}.\n`);

  const execution = spawnSync(process.execPath, [copiedScanner], {
    cwd: root,
    env: { ...process.env, CONTEXT_RELAY_PUBLIC_EVIDENCE_DENYLIST: denylist },
    encoding: "utf8"
  });
  assert.equal(execution.status, 1);
  assert.match(execution.stdout, /PRIVATE_DENYLIST_MATCH/);
  assert.equal(execution.stdout.includes(privateTerm), false);
  assert.equal(execution.stderr.includes(privateTerm), false);
});

test("CLI reports unreadable denylist configuration without echoing its path", () => {
  const root = fixture();
  const copiedScanner = join(root, "evaluation", "scripts", "check-public-evidence.mjs");
  cpSync(scannerSource, copiedScanner);
  const unavailable = join(root, "private-location", "missing-denylist");

  const execution = spawnSync(process.execPath, [copiedScanner], {
    cwd: root,
    env: { ...process.env, CONTEXT_RELAY_PUBLIC_EVIDENCE_DENYLIST: unavailable },
    encoding: "utf8"
  });
  assert.equal(execution.status, 2);
  assert.match(execution.stderr, /DENYLIST_READ_FAILED/);
  assert.equal(execution.stderr.includes(unavailable), false);
});

test("repository public evidence currently passes the gate", () => {
  const output = execFileSync(process.execPath, [scannerSource], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert.match(output, /PUBLIC_EVIDENCE_CHECK_OK/);
});
