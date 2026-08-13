#!/usr/bin/env node

import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TASK_TYPES = new Set([
  "status_query", "research", "single_file_change", "multi_file_change",
  "debugging", "architecture", "release", "migration", "other",
]);
const SIZE_BUCKETS = new Set(["small", "medium", "large"]);
const MODES = new Set(["quick", "standard", "deep"]);
const USAGE_SOURCES = new Set(["HOST_REPORTED", "API_RESPONSE"]);
const HOST_FAMILIES = new Set(["generic", "codex"]);
const MODEL_TIERS = new Set(["unknown", "balanced", "frontier"]);
const REASONING_EFFORTS = new Set(["unknown", "low", "medium", "high", "max", "ultra"]);
const PARALLELISM = new Set(["single", "multi"]);
const ALLOWED_FIELDS = new Set([
  "schema_version", "task_type", "size_bucket", "mode", "runtime",
  "usage_source",
  "actual_total_tokens", "actual_duration_minutes", "success",
  "quality_gate_passed", "rework_required", "observed_at",
]);

function validRuntime(runtime) {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return false;
  const keys = Object.keys(runtime).sort();
  const expected = [
    "host_family", "host_version_bucket", "model_tier", "parallelism", "reasoning_effort",
  ].sort();
  return JSON.stringify(keys) === JSON.stringify(expected)
    && HOST_FAMILIES.has(runtime.host_family)
    && typeof runtime.host_version_bucket === "string"
    && /^(?:unknown|[0-9]+(?:\.[0-9]+){0,2})$/.test(runtime.host_version_bucket)
    && MODEL_TIERS.has(runtime.model_tier)
    && REASONING_EFFORTS.has(runtime.reasoning_effort)
    && PARALLELISM.has(runtime.parallelism);
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))];
}

function classifyRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "invalid_shape";
  if (Object.keys(record).some((key) => !ALLOWED_FIELDS.has(key))) return "unknown_or_private_field";
  if ([...ALLOWED_FIELDS].some((key) => !(key in record))) return "missing_field";
  if (record.schema_version !== "1.0") return "unsupported_schema";
  if (!TASK_TYPES.has(record.task_type) || !SIZE_BUCKETS.has(record.size_bucket) || !MODES.has(record.mode)) {
    return "unsupported_category";
  }
  if (!validRuntime(record.runtime)) return "invalid_runtime";
  if (record.usage_source === "SYNTHETIC") return "synthetic_example";
  if (!USAGE_SOURCES.has(record.usage_source)) return "unverified_usage_source";
  if (!Number.isInteger(record.actual_total_tokens) || record.actual_total_tokens <= 0) return "invalid_tokens";
  if (!Number.isFinite(record.actual_duration_minutes) || record.actual_duration_minutes <= 0) return "invalid_duration";
  if (typeof record.observed_at !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(record.observed_at)
    || !Number.isFinite(Date.parse(record.observed_at))) {
    return "invalid_observed_at";
  }
  if (typeof record.success !== "boolean"
    || typeof record.quality_gate_passed !== "boolean"
    || typeof record.rework_required !== "boolean") return "invalid_outcome";
  return "eligible";
}

function bucketKey(record) {
  return [
    record.runtime.host_family, record.runtime.host_version_bucket, record.runtime.model_tier,
    record.runtime.reasoning_effort, record.runtime.parallelism,
    record.task_type, record.size_bucket, record.mode,
  ].join("|");
}

export function buildCalibration(records, { generatedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(records)) throw new Error("records must be an array");
  if (typeof generatedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(generatedAt)
    || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("generatedAt must be an RFC 3339 UTC timestamp");
  }
  const groups = new Map();
  const seenFingerprints = new Set();
  const exclusions = {};
  let eligibleRecords = 0;

  for (const record of records) {
    let classification = classifyRecord(record);
    const fingerprint = classification === "eligible"
      ? [bucketKey(record),
        record.actual_total_tokens, record.actual_duration_minutes, record.observed_at].join("|")
      : null;
    if (fingerprint && seenFingerprints.has(fingerprint)) classification = "duplicate_record";
    if (classification !== "eligible") {
      exclusions[classification] = (exclusions[classification] ?? 0) + 1;
      continue;
    }
    seenFingerprints.add(fingerprint);
    eligibleRecords += 1;
    const key = bucketKey(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const buckets = [...groups.entries()].map(([key, group]) => {
    const tokens = group.map((record) => record.actual_total_tokens).sort((a, b) => a - b);
    const durations = group.map((record) => record.actual_duration_minutes).sort((a, b) => a - b);
    const first = group[0];
    const successCount = group.filter((record) => record.success).length;
    const qualityCount = group.filter((record) => record.quality_gate_passed).length;
    const reworkCount = group.filter((record) => record.rework_required).length;
    return {
      key,
      runtime: first.runtime,
      task_type: first.task_type,
      size_bucket: first.size_bucket,
      mode: first.mode,
      samples: group.length,
      usable: group.length >= 5,
      confidence: group.length >= 5 ? "low" : "insufficient",
      token_percentiles: {
        p20: percentile(tokens, 20),
        p50: percentile(tokens, 50),
        p80: percentile(tokens, 80),
        p90: percentile(tokens, 90),
      },
      duration_percentiles: {
        p20: percentile(durations, 20),
        p50: percentile(durations, 50),
        p80: percentile(durations, 80),
        p90: percentile(durations, 90),
      },
      outcomes: {
        success_count: successCount,
        quality_passed_count: qualityCount,
        rework_required_count: reworkCount,
        success_rate: successCount / group.length,
        quality_pass_rate: qualityCount / group.length,
        rework_rate: reworkCount / group.length,
      },
    };
  }).sort((a, b) => a.key.localeCompare(b.key));

  return {
    schema_version: "1.0",
    generator_version: "0.1.0",
    provenance_trust: "CALLER_ATTESTED",
    generated_at: generatedAt,
    minimum_usable_samples: 5,
    eligible_records: eligibleRecords,
    excluded_records: records.length - eligibleRecords,
    exclusions,
    buckets,
    privacy: {
      stores_raw_prompts: false,
      stores_transcripts: false,
      stores_source_files: false,
      note: "Only aggregate run metadata and separate outcome flags belong in this file.",
    },
  };
}

function parseRecords(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("JSON input must be an array");
    return parsed;
  }
  return trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`);
    }
  });
}

function parseArgs(argv) {
  const args = { runs: null, output: null, generatedAt: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--runs", "--output", "--generated-at"].includes(key)) throw new Error(`unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${key} requires a path`);
    if (key === "--generated-at") args.generatedAt = value;
    else args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

function isContained(root, target) {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function assertPlainDirectory(path, label) {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symbolic link or reparse point`);
  }
}

function localOutputPath(path) {
  const root = resolve(process.cwd(), ".execution-budget");
  const target = resolve(path);
  const relation = relative(root, target);
  if (relation === "" || !isContained(root, target)
    || !target.endsWith(".local.json")) {
    throw new Error("--output must be a .local.json file inside .execution-budget");
  }

  if (!existsSync(root)) mkdirSync(root);
  assertPlainDirectory(root, ".execution-budget");

  const parent = dirname(target);
  const parentRelation = relative(root, parent);
  let cursor = root;
  for (const segment of parentRelation.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) mkdirSync(cursor);
    assertPlainDirectory(cursor, "calibration output directory");
  }

  const realRoot = realpathSync(root);
  const realParent = realpathSync(parent);
  if (!isContained(realRoot, realParent)) {
    throw new Error("calibration output directory resolves outside .execution-budget");
  }
  return target;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const text = args.runs ? readFileSync(resolve(args.runs), "utf8") : readFileSync(0, "utf8");
    const result = buildCalibration(
      parseRecords(text),
      args.generatedAt ? { generatedAt: args.generatedAt } : undefined,
    );
    const rendered = `${JSON.stringify(result, null, 2)}\n`;
    if (args.output) writeFileSync(localOutputPath(args.output), rendered, { encoding: "utf8", flag: "wx" });
    else process.stdout.write(rendered);
  } catch (error) {
    process.stderr.write(`EXECUTION_CALIBRATION_ERROR ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
