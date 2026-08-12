import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("release bundle contains all three selectable plugin manifests and no private runtime artifacts", () => {
  const executable = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm.cmd", "pack", "--ignore-scripts", "--dry-run", "--json"]
    : ["pack", "--ignore-scripts", "--dry-run", "--json"];
  const output = execFileSync(executable, args, {
    cwd: root,
    encoding: "utf8",
  });
  const report = JSON.parse(output)[0];
  const paths = new Set(report.files.map(({ path }) => path.replaceAll("\\", "/")));
  for (const required of [
    ".agents/plugins/marketplace.json",
    "plugins/context-relay/.codex-plugin/plugin.json",
    "plugins/context-relay/skills/project-handoff/SKILL.md",
    "plugins/execution-budget/.codex-plugin/plugin.json",
    "plugins/execution-budget/skills/execution-budget/SKILL.md",
    "plugins/execution-budget/skills/execution-budget/scripts/estimate-budget.mjs",
    "plugins/execution-budget/skills/execution-budget/scripts/calibrate-budget.mjs",
    "plugins/async-wait-guard/.codex-plugin/plugin.json",
    "plugins/async-wait-guard/skills/async-wait-guard/SKILL.md",
    "plugins/async-wait-guard/skills/async-wait-guard/agents/openai.yaml",
    "plugins/async-wait-guard/skills/async-wait-guard/scripts/plan-wait.mjs",
    "plugins/async-wait-guard/skills/async-wait-guard/references/policy.md",
  ]) {
    assert.ok(paths.has(required), `release bundle missing ${required}`);
  }
  for (const path of paths) {
    assert.equal(path.startsWith(".codex-plugin/"), false, `release bundle contains root plugin source ${path}`);
    assert.equal(path.startsWith("skills/"), false, `release bundle contains shared root Skill source ${path}`);
    assert.equal(path.startsWith("test/"), false, `release bundle contains ${path}`);
    assert.equal(path.startsWith(".github/"), false, `release bundle contains ${path}`);
    assert.equal(path.startsWith(".execution-budget/"), false, `release bundle contains ${path}`);
    assert.doesNotMatch(path, /(?:private|raw[-_]?transcript|chat[-_]?log)/i);
  }
});
