import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { buildCalibration } from "../plugins/execution-budget/skills/execution-budget/scripts/calibrate-budget.mjs";
import { estimateExecutionBudget } from "../plugins/execution-budget/skills/execution-budget/scripts/estimate-budget.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(root, "plugins", "execution-budget");
const references = join(pluginRoot, "skills", "execution-budget", "references");
const request = JSON.parse(readFileSync(join(pluginRoot, "examples", "request.json"), "utf8"));
const publicRuns = readFileSync(join(pluginRoot, "examples", "runs.jsonl"), "utf8")
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));
const telemetryRuns = publicRuns.map((record) => ({ ...record, usage_source: "HOST_REPORTED" }));

function schema(name) {
  return JSON.parse(readFileSync(join(references, name), "utf8"));
}

function assertOrdered(range) {
  assert.ok(range.min <= range.max, JSON.stringify(range));
}

test("heuristic estimate is conservative, ordered, and never an exact whole-task claim", () => {
  const result = estimateExecutionBudget(request);
  assert.equal(result.estimate_kind, "HEURISTIC_RANGE");
  assert.deepEqual(result.options.map(({ mode }) => mode), ["quick", "standard", "deep"]);
  for (const option of result.options) {
    assertOrdered(option.token_estimate);
    assertOrdered(option.time_estimate_minutes);
    assert.equal(option.token_estimate.basis, "HEURISTIC_RANGE");
  }
  assert.ok(result.options[0].token_estimate.max < result.options[1].token_estimate.max);
  assert.ok(result.options[1].token_estimate.max < result.options[2].token_estimate.max);
  assert.equal(JSON.stringify(result).includes("likely"), false);
  assert.match(result.caveats.join(" "), /not an exact prediction/i);
  assert.doesNotMatch(JSON.stringify(result), /EXACT_WHOLE_TASK/i);
});

test("trivial low-risk work skips the card unless explicitly requested", () => {
  const compact = structuredClone(request);
  compact.task.task_type = "status_query";
  compact.signals.expected_files = 0;
  compact.signals.expected_tests = 0;
  compact.signals.ambiguity = "low";
  compact.preferences.time_limit_minutes = null;
  compact.preferences.token_limit = null;
  compact.preferences.force_card = false;
  assert.equal(estimateExecutionBudget(compact).show_budget_card, false);
  compact.preferences.force_card = true;
  assert.equal(estimateExecutionBudget(compact).show_budget_card, true);
});

test("safety boundaries remain point-of-action hard gates without a duplicate preflight Yes", () => {
  for (const mode of ["quick", "standard", "deep"]) {
    const risky = structuredClone(request);
    risky.preferences.mode = mode;
    risky.preferences.time_limit_minutes = null;
    risky.preferences.token_limit = null;
    risky.signals.external_writes = true;
    risky.signals.credentials = true;
    const result = estimateExecutionBudget(risky);
    assert.equal(result.requires_upfront_confirmation, false);
    assert.match(result.autonomy.pause_when.join(" "), /external publication/i);
    assert.match(result.autonomy.pause_when.join(" "), /credentials/i);
    assert.match(result.caveats.join(" "), /Quick mode never removes required safety/i);
  }
});

test("five caller-attested telemetry records enable only the matching calibrated bucket", () => {
  const calibration = buildCalibration(telemetryRuns, { generatedAt: "2026-08-12T12:00:00Z" });
  assert.equal(calibration.eligible_records, 5);
  assert.equal(calibration.excluded_records, 0);
  assert.equal(calibration.buckets[0].usable, true);
  const result = estimateExecutionBudget(request, calibration);
  assert.equal(result.estimate_kind, "CALIBRATED_RANGE");
  const standard = result.options.find(({ mode }) => mode === "standard");
  const quick = result.options.find(({ mode }) => mode === "quick");
  assert.equal(standard.token_estimate.basis, "CALIBRATED_RANGE");
  assert.equal(standard.token_estimate.samples, 5);
  assert.equal(standard.token_estimate.confidence, "low");
  assert.ok(standard.token_estimate.min <= 38000);
  assert.ok(standard.token_estimate.max >= 57000);
  assert.equal(quick.token_estimate.basis, "HEURISTIC_RANGE");
});

test("insufficient, unverified, or private observations cannot calibrate", () => {
  const unverified = { ...telemetryRuns[0] };
  delete unverified.usage_source;
  const privateRecord = { ...telemetryRuns[1], raw_prompt: "synthetic private content" };
  const calibration = buildCalibration([...telemetryRuns.slice(0, 4), unverified, privateRecord]);
  assert.equal(calibration.buckets[0].samples, 4);
  assert.equal(calibration.buckets[0].usable, false);
  assert.equal(calibration.exclusions.missing_field, 1);
  assert.equal(calibration.exclusions.unknown_or_private_field, 1);
  assert.equal(estimateExecutionBudget(request, calibration).estimate_kind, "HEURISTIC_RANGE");
});

test("failed, quality-failed, and reworked terminal runs remain in cost calibration", () => {
  const outcomes = telemetryRuns.map((record, index) => ({
    ...record,
    success: index !== 0,
    quality_gate_passed: index !== 1,
    rework_required: index === 2,
  }));
  const calibration = buildCalibration(outcomes, { generatedAt: "2026-08-12T12:00:00Z" });
  assert.equal(calibration.eligible_records, 5);
  assert.deepEqual(calibration.buckets[0].outcomes, {
    success_count: 4,
    quality_passed_count: 4,
    rework_required_count: 1,
    success_rate: 0.8,
    quality_pass_rate: 0.8,
    rework_rate: 0.2,
  });
});

test("limits compare against the conservative upper bound, not the midpoint", () => {
  const limited = structuredClone(request);
  limited.preferences.token_limit = 80000;
  limited.preferences.time_limit_minutes = 60;
  const result = estimateExecutionBudget(limited);
  const selected = result.options.find(({ mode }) => mode === result.recommended_mode);
  assert.ok(selected.token_estimate.min < limited.preferences.token_limit);
  assert.ok(selected.token_estimate.max > limited.preferences.token_limit);
  assert.equal(result.limit_conflicts.token, true);
  assert.equal(result.requires_upfront_confirmation, true);
});

test("calibration metadata must be ordered, usable, and non-identifying", () => {
  const calibration = buildCalibration(telemetryRuns, { generatedAt: "2026-08-12T12:00:00Z" });
  const malformed = structuredClone(calibration);
  malformed.buckets[0].token_percentiles.p20 = malformed.buckets[0].token_percentiles.p90 + 1;
  assert.throws(
    () => estimateExecutionBudget(request, malformed),
    /complete calibration contract/,
  );

  const privateCalibration = structuredClone(calibration);
  privateCalibration.raw_prompt = "synthetic private field";
  assert.throws(
    () => estimateExecutionBudget(request, privateCalibration),
    /complete calibration contract/,
  );

  const missingMetadata = { buckets: calibration.buckets };
  assert.throws(
    () => estimateExecutionBudget(request, missingMetadata),
    /complete calibration contract/,
  );

  const identifying = structuredClone(request);
  identifying.runtime.host_version_bucket = "customer-project-a";
  assert.throws(() => estimateExecutionBudget(identifying), /numeric version bucket/);
  const privateRun = structuredClone(telemetryRuns[0]);
  privateRun.runtime.host_version_bucket = "customer-project-a";
  assert.equal(buildCalibration([privateRun]).exclusions.invalid_runtime, 1);
});

test("duplicate observations and non-UTC timestamps cannot inflate calibration", () => {
  const duplicated = buildCalibration(Array(5).fill(telemetryRuns[0]));
  assert.equal(duplicated.eligible_records, 1);
  assert.equal(duplicated.exclusions.duplicate_record, 4);
  assert.equal(duplicated.buckets[0].usable, false);

  const nonUtc = { ...telemetryRuns[0], observed_at: "2026-08-01 12:00:00" };
  assert.equal(buildCalibration([nonUtc]).exclusions.invalid_observed_at, 1);
  assert.throws(
    () => buildCalibration(telemetryRuns, { generatedAt: "2026-08-12 12:00:00" }),
    /RFC 3339 UTC/,
  );
});

test("runtime validation rejects fields the strict request schema does not allow", () => {
  assert.throws(
    () => estimateExecutionBudget({ ...request, repository_name: "synthetic" }),
    /unsupported fields/,
  );
  const malformed = structuredClone(request);
  delete malformed.signals.credentials;
  assert.throws(() => estimateExecutionBudget(malformed), /missing required fields/);
  const nonInteger = structuredClone(request);
  nonInteger.signals.expected_files = 1.5;
  assert.throws(() => estimateExecutionBudget(nonInteger), /non-negative integer/);
  const tooLarge = structuredClone(request);
  tooLarge.signals.expected_tests = 100001;
  assert.throws(() => estimateExecutionBudget(tooLarge), /no greater than 100000/);
});

test("budget previews never grant unrequested write or test authority", () => {
  const previewOnly = structuredClone(request);
  previewOnly.authorization.authorized_actions = [];
  const preview = estimateExecutionBudget(previewOnly);
  assert.deepEqual(preview.autonomy.may_proceed, []);

  const readOnly = structuredClone(request);
  readOnly.authorization.authorized_actions = ["READ_SCOPE"];
  assert.deepEqual(estimateExecutionBudget(readOnly).autonomy.may_proceed, [
    "read within the authorized project scope",
  ]);
});

test("token limits are advisory without live telemetry and monitored only with it", () => {
  const advisory = estimateExecutionBudget(request);
  assert.equal(advisory.usage_observability, "NONE");
  assert.equal(advisory.enforcement, "ADVISORY");
  assert.doesNotMatch(advisory.autonomy.pause_when.join(" "), /observed usage reaches/i);

  const monitoredRequest = structuredClone(request);
  monitoredRequest.usage_observability = "LIVE_HOST_TELEMETRY";
  const monitored = estimateExecutionBudget(monitoredRequest);
  assert.equal(monitored.enforcement, "MONITORED");
  assert.match(monitored.autonomy.pause_when.join(" "), /live host-reported usage/i);
});

test("a budget conflict always displays the card, even for trivial work", () => {
  const limited = structuredClone(request);
  limited.task.task_type = "status_query";
  limited.signals.expected_files = 0;
  limited.signals.expected_tests = 0;
  limited.signals.ambiguity = "low";
  limited.preferences.token_limit = 1;
  limited.preferences.time_limit_minutes = 1;
  limited.preferences.force_card = false;
  const result = estimateExecutionBudget(limited);
  assert.equal(result.requires_upfront_confirmation, true);
  assert.deepEqual(result.limit_conflicts, { token: true, time: true });
  assert.equal(result.show_budget_card, true);
});

test("caller-attested calibration cannot downgrade the automatic execution mode", () => {
  const candidate = structuredClone(request);
  candidate.task.task_type = "research";
  candidate.signals.expected_files = 1;
  candidate.signals.expected_tests = 1;
  candidate.signals.ambiguity = "low";
  candidate.preferences.mode = "auto";
  const withoutCalibration = estimateExecutionBudget(candidate);
  assert.equal(withoutCalibration.recommended_mode, "standard");

  const runtime = candidate.runtime;
  const records = Array.from({ length: 5 }, (_, index) => ({
    ...telemetryRuns[index],
    task_type: "research",
    size_bucket: "small",
    mode: "standard",
    runtime,
    actual_total_tokens: 1,
    actual_duration_minutes: 1,
  }));
  const calibration = buildCalibration(records, { generatedAt: "2026-08-12T12:00:00Z" });
  const calibrated = estimateExecutionBudget(candidate, calibration);
  assert.equal(calibrated.recommended_mode, "standard");
});

test("each execution mode exposes a decision-relevant scope and validation contract", () => {
  const result = estimateExecutionBudget(request);
  const quick = result.options.find(({ mode }) => mode === "quick");
  const standard = result.options.find(({ mode }) => mode === "standard");
  const deep = result.options.find(({ mode }) => mode === "deep");
  assert.match(quick.scope.validation, /required targeted/i);
  assert.ok(quick.scope.omits.length > 0);
  assert.match(standard.scope.validation, /all required/i);
  assert.match(deep.scope.includes.join(" "), /edge-case/i);
  assert.deepEqual(deep.scope.omits, []);
});

test("schemas strictly validate public examples and generated artifacts", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validators = {
    request: ajv.compile(schema("request.schema.json")),
    run: ajv.compile(schema("run-record.schema.json")),
    estimate: ajv.compile(schema("execution-budget.schema.json")),
    calibration: ajv.compile(schema("calibration.schema.json")),
  };
  assert.equal(validators.request(request), true, JSON.stringify(validators.request.errors));
  for (const record of publicRuns) {
    assert.equal(validators.run(record), true, JSON.stringify(validators.run.errors));
  }
  const publicCalibration = buildCalibration(publicRuns, { generatedAt: "2026-08-12T12:00:00Z" });
  assert.equal(publicCalibration.eligible_records, 0);
  assert.equal(publicCalibration.exclusions.synthetic_example, 5);
  const calibration = buildCalibration(telemetryRuns, { generatedAt: "2026-08-12T12:00:00Z" });
  assert.equal(validators.calibration(calibration), true, JSON.stringify(validators.calibration.errors));
  const estimate = estimateExecutionBudget(request, calibration);
  assert.equal(validators.estimate(estimate), true, JSON.stringify(validators.estimate.errors));
  assert.equal(validators.run({ ...publicRuns[0], repository: "synthetic" }), false);
});

test("both CLIs are deterministic read-only previews when output is omitted", () => {
  const estimate = spawnSync(process.execPath, [
    join(pluginRoot, "skills", "execution-budget", "scripts", "estimate-budget.mjs"),
    "--request", join(pluginRoot, "examples", "request.json"),
  ], { cwd: root, encoding: "utf8" });
  assert.equal(estimate.status, 0, estimate.stderr);
  assert.equal(JSON.parse(estimate.stdout).schema_version, "1.0");

  const calibration = spawnSync(process.execPath, [
    join(pluginRoot, "skills", "execution-budget", "scripts", "calibrate-budget.mjs"),
    "--runs", join(pluginRoot, "examples", "runs.jsonl"),
    "--generated-at", "2026-08-12T12:00:00Z",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(calibration.status, 0, calibration.stderr);
  assert.equal(JSON.parse(calibration.stdout).eligible_records, 0);
  assert.equal(JSON.parse(calibration.stdout).exclusions.synthetic_example, 5);
});

test("estimate CLI is stdout-only and rejects an output path", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "execution-budget-estimate-output-"));
  try {
    const outputPath = join(temporaryRoot, "estimate.json");
    const result = spawnSync(process.execPath, [
      join(pluginRoot, "skills", "execution-budget", "scripts", "estimate-budget.mjs"),
      "--request", join(pluginRoot, "examples", "request.json"),
      "--output", outputPath,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown argument: --output/);
    assert.equal(existsSync(outputPath), false);
  } finally {
    const resolved = resolve(temporaryRoot);
    assert.ok(resolved.startsWith(resolve(tmpdir())));
    rmSync(resolved, { recursive: true, force: true });
  }
});

test("calibration output is restricted to an ignored local-data directory", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "execution-budget-output-"));
  try {
    const script = join(pluginRoot, "skills", "execution-budget", "scripts", "calibrate-budget.mjs");
    const outside = spawnSync(process.execPath, [
      script, "--runs", join(pluginRoot, "examples", "runs.jsonl"),
      "--output", "calibration.json",
    ], { cwd: temporaryRoot, encoding: "utf8" });
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /inside \.execution-budget/);
    assert.equal(existsSync(join(temporaryRoot, "calibration.json")), false);

    const localPath = join(".execution-budget", "calibration.local.json");
    const local = spawnSync(process.execPath, [
      script, "--runs", join(pluginRoot, "examples", "runs.jsonl"),
      "--generated-at", "2026-08-12T12:00:00Z",
      "--output", localPath,
    ], { cwd: temporaryRoot, encoding: "utf8" });
    assert.equal(local.status, 0, local.stderr);
    assert.equal(existsSync(join(temporaryRoot, localPath)), true);
  } finally {
    const resolved = resolve(temporaryRoot);
    assert.ok(resolved.startsWith(resolve(tmpdir())));
    rmSync(resolved, { recursive: true, force: true });
  }
});

test("calibration output rejects a junction or symlink escape", (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "execution-budget-link-root-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "execution-budget-link-outside-"));
  try {
    const localRoot = join(temporaryRoot, ".execution-budget");
    const escape = join(localRoot, "escape");
    mkdirSync(localRoot);
    try {
      symlinkSync(outsideRoot, escape, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`directory links are unavailable on this runner: ${error.code}`);
        return;
      }
      throw error;
    }

    const script = join(pluginRoot, "skills", "execution-budget", "scripts", "calibrate-budget.mjs");
    const escapedName = "escaped.local.json";
    const result = spawnSync(process.execPath, [
      script, "--runs", join(pluginRoot, "examples", "runs.jsonl"),
      "--output", join(".execution-budget", "escape", escapedName),
    ], { cwd: temporaryRoot, encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /symbolic link|reparse point|resolves outside/i);
    assert.equal(existsSync(join(outsideRoot, escapedName)), false);
  } finally {
    for (const candidate of [temporaryRoot, outsideRoot]) {
      const resolved = resolve(candidate);
      assert.ok(resolved.startsWith(resolve(tmpdir())));
      rmSync(resolved, { recursive: true, force: true });
    }
  }
});
