import assert from "node:assert/strict";
import test from "node:test";

import { runReproCases } from "../evaluation/run-repro-cases.mjs";

test("public reproducible cases fail closed without exposing sensitive values", async () => {
  const report = await runReproCases();
  assert.equal(report.synthetic_only, true);
  assert.equal(report.passed, true, JSON.stringify(report, null, 2));
  assert.deepEqual(
    report.cases.map((entry) => entry.id),
    ["stale-file-digest", "restored-deleted-file", "privacy-secret"],
  );
});
