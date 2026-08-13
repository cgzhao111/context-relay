#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STATES = new Set(["NOT_STARTED", "RUNNING", "COMPLETED"]);
const TOOLS = new Set(["WRITE_STDIN", "FUNCTIONS_WAIT", "FUNCTIONS_EXEC_NESTED_WAIT", "OTHER"]);
const REQUEST_KEYS = [
  "schema_version", "state", "tool", "has_nonempty_input",
  "intermediate_output_needed", "inner_wait_ms", "host_max_yield_ms",
];

function assertExactKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request must be an object");
  }
  const actual = Object.keys(value).sort();
  const expected = [...REQUEST_KEYS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("request contains missing or unsupported fields");
  }
}

function optionalPositiveInteger(value, name) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer or null`);
  }
  return value;
}

function boundedYield(recommended, hostMaximum, warnings) {
  if (hostMaximum === null || hostMaximum >= recommended) return recommended;
  warnings.push(`host maximum ${hostMaximum} ms is below the recommended ${recommended} ms`);
  return hostMaximum;
}

export function planAsyncWait(request) {
  assertExactKeys(request);
  if (request.schema_version !== "1.0") throw new Error("schema_version must be 1.0");
  if (!STATES.has(request.state)) throw new Error("unsupported state");
  if (!TOOLS.has(request.tool)) throw new Error("unsupported tool");
  if (typeof request.has_nonempty_input !== "boolean") throw new Error("has_nonempty_input must be boolean");
  if (typeof request.intermediate_output_needed !== "boolean") {
    throw new Error("intermediate_output_needed must be boolean");
  }
  const innerWait = optionalPositiveInteger(request.inner_wait_ms, "inner_wait_ms");
  const hostMaximum = optionalPositiveInteger(request.host_max_yield_ms, "host_max_yield_ms");
  const warnings = [];

  const base = request.intermediate_output_needed ? 180000 : 300000;
  const result = {
    schema_version: "1.0",
    action: "DO_NOT_WAIT",
    recommended_yield_time_ms: null,
    effective_yield_time_ms: null,
    outer_exec_yield_time_ms: null,
    reason: "no wait is required",
    warnings,
  };

  if (request.state !== "RUNNING") {
    result.reason = request.state === "COMPLETED"
      ? "the asynchronous work is already complete"
      : "no running handle or cell has been established";
    return result;
  }

  if (request.has_nonempty_input) {
    if (request.tool !== "WRITE_STDIN") {
      return {
        ...result,
        action: "FOLLOW_TOOL_CONTRACT",
        reason: "non-empty interactive input is defined only for WRITE_STDIN in this policy",
        warnings: ["inspect the current tool contract before sending input"],
      };
    }
    return {
      ...result,
      action: "SEND_INPUT_NOW",
      reason: "interactive input must not be delayed by the long-wait policy",
    };
  }

  if (request.tool === "OTHER") {
    return {
      ...result,
      action: "FOLLOW_TOOL_CONTRACT",
      reason: "this tool has no wait rule in the policy",
      warnings: ["inspect the current tool contract before waiting"],
    };
  }

  const recommended = request.tool === "FUNCTIONS_EXEC_NESTED_WAIT"
    ? Math.max(base, innerWait ?? base)
    : base;
  const effective = request.tool === "FUNCTIONS_EXEC_NESTED_WAIT"
    ? recommended
    : boundedYield(recommended, hostMaximum, warnings);
  let outerYield = null;
  if (request.tool === "FUNCTIONS_EXEC_NESTED_WAIT") {
    outerYield = recommended + 30000;
    if (!Number.isSafeInteger(outerYield)) throw new Error("outer yield exceeds the safe-integer range");
    if (hostMaximum !== null && hostMaximum < outerYield) {
      warnings.push(`declared host maximum ${hostMaximum} ms cannot satisfy the outer margin ${outerYield} ms`);
    }
  } else if (innerWait !== null) {
    warnings.push("inner_wait_ms is ignored unless tool is FUNCTIONS_EXEC_NESTED_WAIT");
  }

  const contractConflict = hostMaximum !== null && (
    request.tool === "FUNCTIONS_EXEC_NESTED_WAIT"
      ? hostMaximum < outerYield
      : hostMaximum < recommended
  );
  return {
    ...result,
    action: contractConflict ? "FOLLOW_TOOL_CONTRACT" : "WAIT",
    recommended_yield_time_ms: recommended,
    effective_yield_time_ms: effective,
    outer_exec_yield_time_ms: outerYield,
    reason: contractConflict
      ? "the declared host maximum cannot fully satisfy the long-wait policy"
      : "use one long wait and return early on completion",
  };
}

function parseArgs(argv) {
  if (argv.length === 0) return { request: null };
  if (argv.length !== 2 || argv[0] !== "--request" || !argv[1]) {
    throw new Error("usage: plan-wait.mjs [--request <path>]");
  }
  return { request: argv[1] };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const text = args.request
      ? readFileSync(resolve(args.request), "utf8")
      : readFileSync(0, "utf8");
    const normalized = text.replace(/^\uFEFF/, "");
    process.stdout.write(`${JSON.stringify(planAsyncWait(JSON.parse(normalized)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`ASYNC_WAIT_GUARD_ERROR ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
