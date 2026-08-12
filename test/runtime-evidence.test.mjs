import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateRuntimeReport } from "../evaluation/compatibility/validate-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = join(root, "evaluation", "compatibility", "example-contract-report.json");
const base = JSON.parse(readFileSync(examplePath, "utf8"));
const temporary = [];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test.after(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

test("synthetic compatibility contract example is valid without claiming runtime success", () => {
  const result = validateRuntimeReport(base, { reportPath: examplePath });
  assert.equal(result.valid, true);
  assert.equal(base.result, "partial");
  assert.equal(base.trigger.status, "not-verifiable");
});

test("strict schema rejects unknown fields and absolute evidence paths", () => {
  const unknown = clone(base);
  unknown.private_note = "not allowed";
  assert.equal(validateRuntimeReport(unknown).valid, false);

  const absolute = clone(base);
  absolute.evidence = [{ path: "C:\\private\\result.json", sha256: "a".repeat(64), media_type: "application/json" }];
  assert.equal(validateRuntimeReport(absolute).valid, false);
});

test("success cannot hide failures, incomplete steps, or an unscanned artifact", () => {
  const report = clone(base);
  report.result = "success";
  report.failures = ["Synthetic failure."];
  report.privacy.public_evidence_scan = "not-run";
  const result = validateRuntimeReport(report);
  assert.equal(result.valid, false);
  assert.deepEqual(new Set(result.errors.map(({ code }) => code)), new Set([
    "SUCCESS_WITH_FAILURES",
    "SUCCESS_WITH_INCOMPLETE_STEP",
    "SUCCESS_WITHOUT_CHECKS",
    "SUCCESS_WITHOUT_EVIDENCE",
    "SUCCESS_WITHOUT_INSTALLATION",
    "SUCCESS_WITHOUT_PRIVACY_PASS",
  ]));
});

test("success requires passing checks and hashed evidence", () => {
  const report = clone(base);
  report.result = "success";
  report.installation.status = "success";
  report.steps[0].status = "pass";
  report.checks = [{ name: "install_state", status: "fail", value: false }];
  report.evidence = [{ path: "evidence/result.txt", sha256: "0".repeat(64), media_type: "text/plain" }];
  const result = validateRuntimeReport(report);
  assert.deepEqual(result.errors.map(({ code }) => code), ["SUCCESS_WITH_INCOMPLETE_CHECK"]);
});

test("runtime workflows require a fresh context", () => {
  const report = clone(base);
  report.host.surface = "codex-cli-windows-sandbox";
  report.workflow = "budget-preview";
  report.trigger = { mode: "explicit", status: "observed" };
  assert.equal(validateRuntimeReport(report).errors.some(({ code }) => code === "RUNTIME_REQUIRES_FRESH_CONTEXT"), true);
});

test("evidence digest verification is contained to the report directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-relay-runtime-report-"));
  temporary.push(directory);
  mkdirSync(join(directory, "evidence"));
  const evidencePath = join(directory, "evidence", "result.txt");
  writeFileSync(evidencePath, "synthetic evidence\n", "utf8");
  const report = clone(base);
  report.evidence = [{ path: "evidence/result.txt", sha256: "0".repeat(64), media_type: "text/plain" }];
  const result = validateRuntimeReport(report, { reportPath: join(directory, "report.json"), checkEvidence: true });
  assert.equal(result.errors.some(({ code }) => code === "EVIDENCE_DIGEST_MISMATCH"), true);
});

test("expected commit mismatch fails closed", () => {
  const result = validateRuntimeReport(base, { expectedCommit: "0".repeat(40) });
  assert.equal(result.errors.some(({ code }) => code === "COMMIT_MISMATCH"), true);
});

test("CLI rejects a missing or malformed expected commit instead of skipping the check", () => {
  const validator = join(root, "evaluation", "compatibility", "validate-report.mjs");
  for (const arguments_ of [
    [examplePath, "--expected-commit"],
    [examplePath, "--expected-commit", "not-a-commit"],
    [examplePath, "--expected-commit", "A".repeat(40)],
  ]) {
    const result = spawnSync(process.execPath, [validator, ...arguments_], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stderr).error, "ARGUMENT_INVALID");
  }
});
