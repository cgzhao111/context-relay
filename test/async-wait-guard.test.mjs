import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { planAsyncWait } from "../plugins/async-wait-guard/skills/async-wait-guard/scripts/plan-wait.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(
  root,
  "plugins",
  "async-wait-guard",
  "skills",
  "async-wait-guard",
  "scripts",
  "plan-wait.mjs",
);

function request(overrides = {}) {
  return {
    schema_version: "1.0",
    state: "RUNNING",
    tool: "FUNCTIONS_WAIT",
    has_nonempty_input: false,
    intermediate_output_needed: false,
    inner_wait_ms: null,
    host_max_yield_ms: null,
    ...overrides,
  };
}

test("an empty wait without intermediate output uses one 300000 ms yield", () => {
  for (const tool of ["FUNCTIONS_WAIT", "WRITE_STDIN"]) {
    const result = planAsyncWait(request({ tool }));
    assert.equal(result.action, "WAIT");
    assert.equal(result.recommended_yield_time_ms, 300000);
    assert.equal(result.effective_yield_time_ms, 300000);
    assert.equal(result.outer_exec_yield_time_ms, null);
    assert.deepEqual(result.warnings, []);
  }
});

test("an empty wait that needs intermediate output uses the 180000 ms floor", () => {
  for (const tool of ["FUNCTIONS_WAIT", "WRITE_STDIN"]) {
    const result = planAsyncWait(request({ tool, intermediate_output_needed: true }));
    assert.equal(result.action, "WAIT");
    assert.equal(result.recommended_yield_time_ms, 180000);
    assert.equal(result.effective_yield_time_ms, 180000);
  }
});

test("non-empty write_stdin input is sent immediately instead of being delayed", () => {
  const result = planAsyncWait(request({
    tool: "WRITE_STDIN",
    has_nonempty_input: true,
  }));
  assert.equal(result.action, "SEND_INPUT_NOW");
  assert.equal(result.recommended_yield_time_ms, null);
  assert.equal(result.effective_yield_time_ms, null);
  assert.equal(result.outer_exec_yield_time_ms, null);

  const unsupportedInputTool = planAsyncWait(request({
    tool: "FUNCTIONS_WAIT",
    has_nonempty_input: true,
  }));
  assert.equal(unsupportedInputTool.action, "FOLLOW_TOOL_CONTRACT");
  assert.match(unsupportedInputTool.warnings.join(" "), /inspect the current tool contract/i);
});

test("a nested wait preserves a 30000 ms outer exec margin", () => {
  const selectedByDefault = planAsyncWait(request({
    tool: "FUNCTIONS_EXEC_NESTED_WAIT",
    inner_wait_ms: 240000,
  }));
  assert.equal(selectedByDefault.recommended_yield_time_ms, 300000);
  assert.equal(selectedByDefault.outer_exec_yield_time_ms, 330000);

  const selectedByInnerWait = planAsyncWait(request({
    tool: "FUNCTIONS_EXEC_NESTED_WAIT",
    inner_wait_ms: 420000,
  }));
  assert.equal(selectedByInnerWait.recommended_yield_time_ms, 420000);
  assert.equal(selectedByInnerWait.outer_exec_yield_time_ms, 450000);

  const outerContractConflict = planAsyncWait(request({
    tool: "FUNCTIONS_EXEC_NESTED_WAIT",
    inner_wait_ms: 240000,
    host_max_yield_ms: 320000,
  }));
  assert.equal(outerContractConflict.action, "FOLLOW_TOOL_CONTRACT");
  assert.equal(outerContractConflict.effective_yield_time_ms, 300000);
  assert.equal(outerContractConflict.outer_exec_yield_time_ms, 330000);
  assert.match(outerContractConflict.warnings.join(" "), /cannot satisfy the outer margin/i);
});

test("not-started and completed work never produce another wait", () => {
  for (const state of ["NOT_STARTED", "COMPLETED"]) {
    const result = planAsyncWait(request({ state }));
    assert.equal(result.action, "DO_NOT_WAIT");
    assert.equal(result.recommended_yield_time_ms, null);
    assert.equal(result.effective_yield_time_ms, null);
  }
});

test("a declared host maximum below policy returns an explicit contract conflict", () => {
  const result = planAsyncWait(request({ host_max_yield_ms: 120000 }));
  assert.equal(result.action, "FOLLOW_TOOL_CONTRACT");
  assert.equal(result.recommended_yield_time_ms, 300000);
  assert.equal(result.effective_yield_time_ms, 120000);
  assert.match(result.warnings.join(" "), /host maximum 120000 ms is below/i);
});

test("malformed and unsafe requests fail closed", () => {
  assert.throws(
    () => planAsyncWait({ ...request(), unexpected: true }),
    /missing or unsupported fields/,
  );

  const missing = request();
  delete missing.state;
  assert.throws(() => planAsyncWait(missing), /missing or unsupported fields/);
  assert.throws(
    () => planAsyncWait(request({ inner_wait_ms: Number.MAX_SAFE_INTEGER + 1 })),
    /positive safe integer/,
  );
  assert.throws(
    () => planAsyncWait(request({ has_nonempty_input: "false" })),
    /must be boolean/,
  );
});

test("CLI accepts JSON on stdin and emits only the deterministic plan", () => {
  const input = `${JSON.stringify(request({ intermediate_output_needed: true }))}\n`;
  const first = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    input,
  });
  const second = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    input,
  });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stderr, "");
  assert.equal(first.stdout, second.stdout);
  assert.equal(JSON.parse(first.stdout).recommended_yield_time_ms, 180000);
});
