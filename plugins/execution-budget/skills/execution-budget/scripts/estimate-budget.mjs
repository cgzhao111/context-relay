#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TASK_TYPES = new Set([
  "status_query",
  "research",
  "single_file_change",
  "multi_file_change",
  "debugging",
  "architecture",
  "release",
  "migration",
  "other",
]);
const LEVELS = new Set(["low", "medium", "high"]);
const MODES = new Set(["auto", "quick", "standard", "deep"]);
const HOST_FAMILIES = new Set(["generic", "codex"]);
const MODEL_TIERS = new Set(["unknown", "balanced", "frontier"]);
const REASONING_EFFORTS = new Set(["unknown", "low", "medium", "high", "max", "ultra"]);
const PARALLELISM = new Set(["single", "multi"]);
const AUTHORIZED_ACTIONS = new Set([
  "READ_SCOPE", "REVERSIBLE_EDIT", "LOCAL_TEST", "REPAIR_IN_SCOPE_TEST_FAILURE",
]);
const USAGE_OBSERVABILITY = new Set(["NONE", "POST_RUN", "LIVE_HOST_TELEMETRY"]);

const BASELINES = {
  status_query: { tokens: 3000, minutes: 3 },
  research: { tokens: 12000, minutes: 12 },
  single_file_change: { tokens: 9000, minutes: 10 },
  multi_file_change: { tokens: 24000, minutes: 24 },
  debugging: { tokens: 26000, minutes: 28 },
  architecture: { tokens: 30000, minutes: 30 },
  release: { tokens: 18000, minutes: 20 },
  migration: { tokens: 40000, minutes: 45 },
  other: { tokens: 15000, minutes: 18 },
};

const MODE_MULTIPLIERS = {
  quick: { tokens: 0.72, minutes: 0.7 },
  standard: { tokens: 1, minutes: 1 },
  deep: { tokens: 1.65, minutes: 1.6 },
};

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function assertExactKeys(value, expected, name) {
  const expectedSet = new Set(expected);
  const unknown = Object.keys(value).filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !(key in value));
  if (unknown.length > 0) throw new Error(`${name} contains unsupported fields`);
  if (missing.length > 0) throw new Error(`${name} is missing required fields`);
}

function integerNonNegative(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 100000) {
    throw new Error(`${name} must be a non-negative integer no greater than 100000`);
  }
  return value;
}

function optionalLimit(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a finite positive number`);
  return value;
}

function requiredBoolean(value, name) {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function normalizeRuntime(value) {
  assertObject(value, "runtime");
  assertExactKeys(value, [
    "host_family", "host_version_bucket", "model_tier", "reasoning_effort", "parallelism",
  ], "runtime");
  if (!HOST_FAMILIES.has(value.host_family)) throw new Error("unsupported runtime.host_family");
  if (typeof value.host_version_bucket !== "string"
    || !/^(?:unknown|[0-9]+(?:\.[0-9]+){0,2})$/.test(value.host_version_bucket)) {
    throw new Error("runtime.host_version_bucket must be unknown or a numeric version bucket");
  }
  if (!MODEL_TIERS.has(value.model_tier)) throw new Error("unsupported runtime.model_tier");
  if (!REASONING_EFFORTS.has(value.reasoning_effort)) throw new Error("unsupported runtime.reasoning_effort");
  if (!PARALLELISM.has(value.parallelism)) throw new Error("unsupported runtime.parallelism");
  return { ...value };
}

function roundUseful(value) {
  if (value < 1000) return Math.max(1, Math.round(value / 10) * 10);
  return Math.max(1000, Math.round(value / 1000) * 1000);
}

function percentileRange(likely, confidence) {
  if (confidence === "high") return { min: likely * 0.8, max: likely * 1.35 };
  if (confidence === "medium") return { min: likely * 0.7, max: likely * 1.65 };
  return { min: likely * 0.55, max: likely * 2.1 };
}

function rankRisk(signals) {
  let score = 0;
  if (signals.production_impact) score += 4;
  if (signals.external_writes) score += 3;
  if (signals.destructive) score += 5;
  if (signals.credentials) score += 4;
  if (signals.personal_data) score += 4;
  if (signals.rollback_difficulty === "medium") score += 2;
  if (signals.rollback_difficulty === "high") score += 4;
  if (score >= 10) return "critical";
  if (score >= 6) return "high";
  if (score >= 3) return "medium";
  return "low";
}

export function sizeBucket(expectedFiles, expectedTests) {
  if (expectedFiles <= 2 && expectedTests <= 2) return "small";
  if (expectedFiles <= 10 && expectedTests <= 10) return "medium";
  return "large";
}

function normalizeRequest(request) {
  assertObject(request, "request");
  assertExactKeys(request, [
    "schema_version", "task", "signals", "preferences", "runtime",
    "authorization", "usage_observability",
  ], "request");
  if (request.schema_version !== "1.0") throw new Error("schema_version must be 1.0");
  assertObject(request.task, "task");
  assertExactKeys(request.task, ["task_type"], "task");
  const taskType = request.task.task_type;
  if (!TASK_TYPES.has(taskType)) throw new Error(`unsupported task_type: ${taskType}`);

  const sourceSignals = request.signals;
  assertObject(sourceSignals, "signals");
  assertExactKeys(sourceSignals, [
    "expected_files", "expected_tests", "ambiguity", "rollback_difficulty",
    "production_impact", "external_writes", "destructive", "credentials", "personal_data",
  ], "signals");
  const ambiguity = sourceSignals.ambiguity;
  const rollbackDifficulty = sourceSignals.rollback_difficulty;
  if (!LEVELS.has(ambiguity)) throw new Error("signals.ambiguity must be low, medium, or high");
  if (!LEVELS.has(rollbackDifficulty)) {
    throw new Error("signals.rollback_difficulty must be low, medium, or high");
  }
  const signals = {
    expected_files: integerNonNegative(sourceSignals.expected_files, "signals.expected_files"),
    expected_tests: integerNonNegative(sourceSignals.expected_tests, "signals.expected_tests"),
    ambiguity,
    rollback_difficulty: rollbackDifficulty,
    production_impact: requiredBoolean(sourceSignals.production_impact, "signals.production_impact"),
    external_writes: requiredBoolean(sourceSignals.external_writes, "signals.external_writes"),
    destructive: requiredBoolean(sourceSignals.destructive, "signals.destructive"),
    credentials: requiredBoolean(sourceSignals.credentials, "signals.credentials"),
    personal_data: requiredBoolean(sourceSignals.personal_data, "signals.personal_data"),
  };

  const sourcePreferences = request.preferences;
  assertObject(sourcePreferences, "preferences");
  assertExactKeys(sourcePreferences, ["mode", "token_limit", "time_limit_minutes", "force_card"], "preferences");
  const mode = sourcePreferences.mode;
  if (!MODES.has(mode)) throw new Error("preferences.mode must be auto, quick, standard, or deep");
  const preferences = {
    mode,
    token_limit: optionalLimit(sourcePreferences.token_limit, "preferences.token_limit"),
    time_limit_minutes: optionalLimit(sourcePreferences.time_limit_minutes, "preferences.time_limit_minutes"),
    force_card: requiredBoolean(sourcePreferences.force_card, "preferences.force_card"),
  };

  const runtime = normalizeRuntime(request.runtime);
  assertObject(request.authorization, "authorization");
  assertExactKeys(request.authorization, ["authorized_actions"], "authorization");
  if (!Array.isArray(request.authorization.authorized_actions)) {
    throw new Error("authorization.authorized_actions must be an array");
  }
  const authorizedActions = [...new Set(request.authorization.authorized_actions)];
  if (authorizedActions.length !== request.authorization.authorized_actions.length
    || authorizedActions.some((action) => !AUTHORIZED_ACTIONS.has(action))) {
    throw new Error("authorization.authorized_actions contains duplicates or unsupported actions");
  }
  if (!USAGE_OBSERVABILITY.has(request.usage_observability)) {
    throw new Error("unsupported usage_observability");
  }

  return {
    schema_version: "1.0",
    task: { task_type: taskType },
    signals,
    preferences,
    runtime,
    authorization: { authorized_actions: authorizedActions },
    usage_observability: request.usage_observability,
  };
}

function sameRuntime(left, right) {
  return left && right
    && left.host_family === right.host_family
    && left.host_version_bucket === right.host_version_bucket
    && left.model_tier === right.model_tier
    && left.reasoning_effort === right.reasoning_effort
    && left.parallelism === right.parallelism;
}

function calibrationKey(runtime, taskType, bucket, mode) {
  return [
    runtime.host_family, runtime.host_version_bucket, runtime.model_tier,
    runtime.reasoning_effort, runtime.parallelism, taskType, bucket, mode,
  ].join("|");
}

function consistentOutcomes(outcomes, samples) {
  if (!outcomes || typeof outcomes !== "object" || Array.isArray(outcomes)) return false;
  try {
    assertExactKeys(outcomes, [
      "success_count", "quality_passed_count", "rework_required_count",
      "success_rate", "quality_pass_rate", "rework_rate",
    ], "calibration bucket outcomes");
  } catch {
    return false;
  }
  const triples = [
    [outcomes.success_count, outcomes.success_rate],
    [outcomes.quality_passed_count, outcomes.quality_pass_rate],
    [outcomes.rework_required_count, outcomes.rework_rate],
  ];
  return triples.every(([count, rate]) => Number.isInteger(count)
    && count >= 0 && count <= samples
    && Number.isFinite(rate) && rate >= 0 && rate <= 1
    && Math.abs((count / samples) - rate) < 1e-9);
}

function strictUtcTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function orderedPercentiles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    assertExactKeys(value, ["p20", "p50", "p80", "p90"], "calibration percentiles");
  } catch {
    return false;
  }
  return [value.p20, value.p50, value.p80, value.p90].every((item) => Number.isFinite(item) && item > 0)
    && value.p20 <= value.p50
    && value.p50 <= value.p80
    && value.p80 <= value.p90;
}

function validCalibration(calibration) {
  if (!calibration || typeof calibration !== "object" || Array.isArray(calibration)) return false;
  try {
    assertExactKeys(calibration, [
      "schema_version", "generator_version", "provenance_trust", "generated_at",
      "minimum_usable_samples", "eligible_records", "excluded_records",
      "exclusions", "buckets", "privacy",
    ], "calibration");
  } catch {
    return false;
  }
  if (calibration.schema_version !== "1.0"
    || calibration.generator_version !== "0.1.0"
    || calibration.provenance_trust !== "CALLER_ATTESTED"
    || !strictUtcTimestamp(calibration.generated_at)
    || calibration.minimum_usable_samples !== 5
    || !Number.isInteger(calibration.eligible_records) || calibration.eligible_records < 0
    || !Number.isInteger(calibration.excluded_records) || calibration.excluded_records < 0
    || !calibration.exclusions || typeof calibration.exclusions !== "object"
    || Array.isArray(calibration.exclusions)
    || !Array.isArray(calibration.buckets)) return false;

  const exclusions = Object.values(calibration.exclusions);
  if (!exclusions.every((count) => Number.isInteger(count) && count >= 1)
    || exclusions.reduce((sum, count) => sum + count, 0) !== calibration.excluded_records) return false;

  const privacy = calibration.privacy;
  if (!privacy || typeof privacy !== "object" || Array.isArray(privacy)) return false;
  try {
    assertExactKeys(privacy, [
      "stores_raw_prompts", "stores_transcripts", "stores_source_files", "note",
    ], "calibration privacy");
  } catch {
    return false;
  }
  if (privacy.stores_raw_prompts !== false
    || privacy.stores_transcripts !== false
    || privacy.stores_source_files !== false
    || typeof privacy.note !== "string" || privacy.note.length === 0) return false;

  const seenKeys = new Set();
  let sampleTotal = 0;
  for (const entry of calibration.buckets) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    try {
      assertExactKeys(entry, [
        "key", "runtime", "task_type", "size_bucket", "mode", "samples",
        "usable", "confidence", "token_percentiles", "duration_percentiles", "outcomes",
      ], "calibration bucket");
    } catch {
      return false;
    }
    let runtime;
    try {
      runtime = normalizeRuntime(entry.runtime);
    } catch {
      return false;
    }
    if (!TASK_TYPES.has(entry.task_type)
      || !["small", "medium", "large"].includes(entry.size_bucket)
      || !["quick", "standard", "deep"].includes(entry.mode)
      || !Number.isInteger(entry.samples) || entry.samples < 1
      || typeof entry.usable !== "boolean"
      || !["insufficient", "low"].includes(entry.confidence)
      || entry.usable !== (entry.samples >= 5)
      || entry.confidence !== (entry.samples >= 5 ? "low" : "insufficient")
      || entry.key !== calibrationKey(runtime, entry.task_type, entry.size_bucket, entry.mode)
      || seenKeys.has(entry.key)
      || !orderedPercentiles(entry.token_percentiles)
      || !orderedPercentiles(entry.duration_percentiles)
      || !consistentOutcomes(entry.outcomes, entry.samples)) return false;
    seenKeys.add(entry.key);
    sampleTotal += entry.samples;
  }
  return sampleTotal === calibration.eligible_records;
}

function calibrationBucket(calibration, normalized, bucket, mode) {
  if (!calibration) return null;
  return calibration.buckets.find((entry) =>
    sameRuntime(entry?.runtime, normalized.runtime)
    && entry?.task_type === normalized.task.task_type
    && entry?.size_bucket === bucket
    && entry?.mode === mode
    && Number.isInteger(entry?.samples)
    && entry.samples >= 5
    && entry?.usable === true
    && entry?.confidence === "low"
    && entry?.key === calibrationKey(normalized.runtime, normalized.task.task_type, bucket, mode)
    && consistentOutcomes(entry?.outcomes, entry.samples)
    && orderedPercentiles(entry?.token_percentiles)
    && orderedPercentiles(entry?.duration_percentiles)
  ) ?? null;
}

function heuristicOption(normalized, mode) {
  const { signals, task } = normalized;
  const baseline = BASELINES[task.task_type];
  const fileScale = 1 + Math.min(1.4, Math.log2(Math.max(1, signals.expected_files) + 1) * 0.18);
  const testScale = 1 + Math.min(0.6, signals.expected_tests * 0.035);
  const ambiguityScale = { low: 0.9, medium: 1.1, high: 1.45 }[signals.ambiguity];
  const rollbackScale = { low: 1, medium: 1.12, high: 1.3 }[signals.rollback_difficulty];
  const productionScale = signals.production_impact ? 1.18 : 1;
  const modeScale = MODE_MULTIPLIERS[mode];
  const likelyTokens = Math.max(
    mode === "quick" ? 2500 : 3000,
    baseline.tokens * fileScale * testScale * ambiguityScale * rollbackScale * productionScale * modeScale.tokens,
  );
  const likelyMinutes = Math.max(
    2,
    baseline.minutes * fileScale * testScale * ambiguityScale * rollbackScale * modeScale.minutes,
  );
  const tokenRange = percentileRange(likelyTokens, "low");
  const timeRange = percentileRange(likelyMinutes, "low");

  return {
    mode,
    _token_anchor: roundUseful(likelyTokens),
    _time_anchor: Math.max(1, Math.round(likelyMinutes)),
    token_estimate: {
      min: roundUseful(tokenRange.min),
      max: roundUseful(tokenRange.max),
      confidence: "low",
      basis: "HEURISTIC_RANGE",
      samples: 0,
    },
    time_estimate_minutes: {
      min: Math.max(1, Math.round(timeRange.min)),
      max: Math.max(1, Math.round(timeRange.max)),
      confidence: "low",
    },
  };
}

function estimateOption(normalized, bucket, mode, calibration) {
  const heuristic = heuristicOption(normalized, mode);
  const matching = calibrationBucket(calibration, normalized, bucket, mode);
  if (!matching) return heuristic;

  return {
    mode,
    _token_anchor: heuristic._token_anchor,
    _time_anchor: heuristic._time_anchor,
    token_estimate: {
      min: heuristic.token_estimate.min,
      max: roundUseful(Math.max(matching.token_percentiles.p90, heuristic.token_estimate.max)),
      confidence: "low",
      basis: "CALIBRATED_RANGE",
      samples: matching.samples,
    },
    time_estimate_minutes: {
      min: heuristic.time_estimate_minutes.min,
      max: Math.max(1, Math.round(Math.max(
        matching.duration_percentiles.p90,
        heuristic.time_estimate_minutes.max,
      ))),
      confidence: "low",
    },
  };
}

function recommendation(normalized, risk, options) {
  if (normalized.preferences.mode !== "auto") return normalized.preferences.mode;
  if (risk === "critical" || risk === "high" || normalized.signals.ambiguity === "high") return "deep";
  const standard = options.find((entry) => entry.mode === "standard");
  const trivial = normalized.task.task_type === "status_query"
    || (normalized.signals.expected_files <= 1
      && normalized.signals.expected_tests <= 1
      && normalized.signals.ambiguity === "low");
  if (trivial && standard._token_anchor <= 10000 && risk === "low") return "quick";
  return "standard";
}

function modeScope(mode) {
  if (mode === "quick") {
    return {
      includes: ["core requested outcome", "minimum risk-proportionate validation"],
      omits: ["optional cross-checks", "additional edge-case evaluation"],
      validation: "required targeted validation only",
    };
  }
  if (mode === "deep") {
    return {
      includes: ["full requested scope", "additional cross-checks", "relevant edge-case evaluation"],
      omits: [],
      validation: "required validation plus additional risk-proportionate checks",
    };
  }
  return {
    includes: ["full requested scope", "proportionate implementation review"],
    omits: ["optional exhaustive evaluation not needed for acceptance"],
    validation: "all required relevant validation",
  };
}

function mayProceed(authorizedActions) {
  const labels = {
    READ_SCOPE: "read within the authorized project scope",
    REVERSIBLE_EDIT: "make reversible edits within the quoted scope",
    LOCAL_TEST: "run non-destructive required tests",
    REPAIR_IN_SCOPE_TEST_FAILURE: "repair in-scope defects found by those tests",
  };
  return authorizedActions.map((action) => labels[action]);
}

function pauseBoundaries(normalized, recommendedOption) {
  const boundaries = [
    "scope expands beyond the quoted task",
    "an irreversible or destructive action becomes necessary",
    "external publication, messaging, payment, or deployment becomes necessary",
    "credentials, secrets, or personal data become necessary",
  ];
  if (normalized.usage_observability === "LIVE_HOST_TELEMETRY") {
    boundaries.push(`live host-reported usage exceeds ${recommendedOption.token_estimate.max} tokens`);
  }
  if (normalized.preferences.token_limit !== null
    && normalized.usage_observability === "LIVE_HOST_TELEMETRY") {
    boundaries.push(`observed usage reaches the user limit of ${normalized.preferences.token_limit} tokens`);
  }
  if (normalized.preferences.time_limit_minutes !== null) {
    boundaries.push(`elapsed time reaches the user limit of ${normalized.preferences.time_limit_minutes} minutes`);
  }
  return boundaries;
}

function enforcementFor(observability) {
  if (observability === "LIVE_HOST_TELEMETRY") return "MONITORED";
  if (observability === "POST_RUN") return "POST_RUN_RECONCILE";
  return "ADVISORY";
}

export function estimateExecutionBudget(request, calibration = null) {
  const normalized = normalizeRequest(request);
  if (calibration !== null && !validCalibration(calibration)) {
    throw new Error("calibration does not satisfy the complete calibration contract");
  }
  const bucket = sizeBucket(normalized.signals.expected_files, normalized.signals.expected_tests);
  const risk = rankRisk(normalized.signals);
  const options = ["quick", "standard", "deep"].map((mode) =>
    estimateOption(normalized, bucket, mode, calibration));
  const recommendedMode = recommendation(normalized, risk, options);
  const recommendedOption = options.find((entry) => entry.mode === recommendedMode);
  const exceedsTokenLimit = normalized.preferences.token_limit !== null
    && recommendedOption.token_estimate.max > normalized.preferences.token_limit;
  const exceedsTimeLimit = normalized.preferences.time_limit_minutes !== null
    && recommendedOption.time_estimate_minutes.max > normalized.preferences.time_limit_minutes;
  const trivial = bucket === "small"
    && normalized.signals.ambiguity === "low"
    && risk === "low"
    && recommendedOption._token_anchor <= 10000;

  const publicOptions = options.map(({ _token_anchor, _time_anchor, ...option }) => ({
    ...option,
    scope: modeScope(option.mode),
  }));

  return {
    schema_version: "1.0",
    estimate_kind: recommendedOption.token_estimate.basis,
    task_type: normalized.task.task_type,
    size_bucket: bucket,
    workload: bucket,
    risk,
    ambiguity: normalized.signals.ambiguity,
    runtime: normalized.runtime,
    usage_observability: normalized.usage_observability,
    enforcement: enforcementFor(normalized.usage_observability),
    recommended_mode: recommendedMode,
    show_budget_card: normalized.preferences.force_card || !trivial || exceedsTokenLimit || exceedsTimeLimit,
    requires_upfront_confirmation: exceedsTokenLimit || exceedsTimeLimit,
    limit_conflicts: {
      token: exceedsTokenLimit,
      time: exceedsTimeLimit,
    },
    options: publicOptions,
    autonomy: {
      may_proceed: mayProceed(normalized.authorization.authorized_actions),
      pause_when: pauseBoundaries(normalized, recommendedOption),
    },
    caveats: [
      "This is a whole-task range, not an exact prediction.",
      "Future model output, tool results, retries, subagents, and scope changes are unknown before execution.",
      "Quick mode never removes required safety, privacy, backup, migration, or acceptance checks.",
      "Model selection and switching are outside this skill's authority.",
      normalized.usage_observability === "LIVE_HOST_TELEMETRY"
        ? "Token boundaries are monitored only while trusted live host telemetry remains available."
        : "No live token enforcement is available; token boundaries are advisory or reconciled after the run.",
    ],
  };
}

function parseArgs(argv) {
  const args = { request: null, calibration: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--request", "--calibration"].includes(key)) throw new Error(`unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${key} requires a path`);
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

function readJson(path, fallbackStdin = false) {
  const text = path ? readFileSync(resolve(path), "utf8") : (fallbackStdin ? readFileSync(0, "utf8") : null);
  return text === null ? null : JSON.parse(text);
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const request = readJson(args.request, true);
    const calibration = readJson(args.calibration, false);
    const result = estimateExecutionBudget(request, calibration);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`EXECUTION_BUDGET_ERROR ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
