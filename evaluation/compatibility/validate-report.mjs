#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(resolve(moduleRoot, "report.schema.json"), "utf8"));

function inside(parent, child) {
  const relation = relative(parent, child);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function safeEvidencePath(reportRoot, value) {
  const candidate = resolve(reportRoot, value);
  if (!inside(reportRoot, candidate)) throw Object.assign(new Error("Evidence path escapes the report root."), { code: "EVIDENCE_PATH_ESCAPE" });
  if (!existsSync(candidate)) throw Object.assign(new Error("Evidence file is missing."), { code: "EVIDENCE_MISSING" });
  const real = realpathSync(candidate);
  if (!inside(realpathSync(reportRoot), real)) throw Object.assign(new Error("Evidence path resolves outside the report root."), { code: "EVIDENCE_REALPATH_ESCAPE" });
  return real;
}

export function validateRuntimeReport(report, {
  reportPath = resolve(moduleRoot, "example-contract-report.json"),
  checkEvidence = false,
  expectedCommit,
} = {}) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const errors = [];
  if (!validate(report)) {
    for (const error of validate.errors ?? []) errors.push({ code: "SCHEMA_INVALID", path: error.instancePath || "/" });
  }
  if (expectedCommit && report?.plugin?.repository_commit !== expectedCommit) {
    errors.push({ code: "COMMIT_MISMATCH", path: "/plugin/repository_commit" });
  }
  if (report?.result === "success") {
    if ((report.failures ?? []).length > 0) errors.push({ code: "SUCCESS_WITH_FAILURES", path: "/failures" });
    if ((report.steps ?? []).some(({ status }) => status !== "pass")) errors.push({ code: "SUCCESS_WITH_INCOMPLETE_STEP", path: "/steps" });
    if ((report.checks ?? []).length === 0) errors.push({ code: "SUCCESS_WITHOUT_CHECKS", path: "/checks" });
    if ((report.checks ?? []).some(({ status }) => status !== "pass")) errors.push({ code: "SUCCESS_WITH_INCOMPLETE_CHECK", path: "/checks" });
    if ((report.evidence ?? []).length === 0) errors.push({ code: "SUCCESS_WITHOUT_EVIDENCE", path: "/evidence" });
    if (report?.installation?.status !== "success") errors.push({ code: "SUCCESS_WITHOUT_INSTALLATION", path: "/installation/status" });
    if (report?.privacy?.public_evidence_scan !== "pass") errors.push({ code: "SUCCESS_WITHOUT_PRIVACY_PASS", path: "/privacy/public_evidence_scan" });
  }
  if (report?.privacy?.raw_private_artifacts_excluded !== true) {
    errors.push({ code: "RAW_PRIVATE_ARTIFACTS_NOT_EXCLUDED", path: "/privacy/raw_private_artifacts_excluded" });
  }
  if (report?.workflow === "marketplace-install-matrix" && report?.trigger?.mode !== "not-applicable") {
    errors.push({ code: "INSTALL_MATRIX_TRIGGER_MUST_BE_NOT_APPLICABLE", path: "/trigger/mode" });
  }
  if (report?.result === "success" && report?.workflow !== "marketplace-install-matrix" && report?.trigger?.status !== "observed") {
    errors.push({ code: "RUNTIME_SUCCESS_WITHOUT_OBSERVED_TRIGGER", path: "/trigger/status" });
  }
  if (report?.workflow !== "marketplace-install-matrix" && report?.host?.surface !== "synthetic-contract" && report?.installation?.fresh_context !== true) {
    errors.push({ code: "RUNTIME_REQUIRES_FRESH_CONTEXT", path: "/installation/fresh_context" });
  }

  if (checkEvidence && errors.every(({ code }) => code !== "SCHEMA_INVALID")) {
    const reportRoot = dirname(resolve(reportPath));
    for (const [index, item] of (report.evidence ?? []).entries()) {
      try {
        const path = safeEvidencePath(reportRoot, item.path);
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        if (digest !== item.sha256) errors.push({ code: "EVIDENCE_DIGEST_MISMATCH", path: `/evidence/${index}/sha256` });
      } catch (error) {
        errors.push({ code: error.code ?? "EVIDENCE_CHECK_FAILED", path: `/evidence/${index}/path` });
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function parseArgs(argv) {
  const result = { reportPath: "", checkEvidence: false, expectedCommit: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check-evidence") result.checkEvidence = true;
    else if (value === "--expected-commit") {
      const candidate = argv[index + 1];
      if (!candidate || !/^[0-9a-f]{40}$/.test(candidate)) {
        throw Object.assign(new Error("--expected-commit requires a 40-character lowercase hexadecimal commit."), { code: "ARGUMENT_INVALID" });
      }
      result.expectedCommit = candidate;
      index += 1;
    }
    else if (!result.reportPath) result.reportPath = value;
    else throw Object.assign(new Error("Unexpected argument."), { code: "ARGUMENT_INVALID" });
  }
  if (!result.reportPath) throw Object.assign(new Error("A report path is required."), { code: "REPORT_PATH_REQUIRED" });
  return result;
}

function runCli() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const reportPath = resolve(args.reportPath);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const result = validateRuntimeReport(report, { ...args, reportPath });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ valid: false, error: error.code ?? "VALIDATION_FAILED" })}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
