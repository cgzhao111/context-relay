import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corePluginRoot = join(root, "plugins", "context-relay");
const manifest = JSON.parse(readFileSync(join(corePluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const budgetPluginRoot = join(root, "plugins", "execution-budget");
const budgetManifest = JSON.parse(readFileSync(join(budgetPluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const waitPluginRoot = join(root, "plugins", "async-wait-guard");
const waitManifest = JSON.parse(readFileSync(join(waitPluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const marketplace = JSON.parse(readFileSync(join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

assert.equal(manifest.name, "context-relay");
const strictSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
assert.match(manifest.version, strictSemver);
assert.equal(manifest.skills, "./skills/");
assert.equal(manifest.license, "Apache-2.0");
assert.ok(existsSync(join(corePluginRoot, "skills", "project-handoff", "SKILL.md")));
assert.deepEqual(
  readdirSync(join(corePluginRoot, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
  ["project-handoff"],
  "the context-relay Skill catalog must contain only project-handoff",
);
assert.equal(existsSync(join(root, ".codex-plugin")), false, "repository root must not be a plugin source");
assert.equal(existsSync(join(root, "skills")), false, "repository root must not expose a shared Skill catalog");
assert.equal(packageJson.version, manifest.version);
assert.equal(packageJson.private, true, "the GitHub release bundle must not be accidentally npm-publishable");
assert.equal(packageLock.version, manifest.version);
assert.equal(packageLock.packages?.[""]?.version, manifest.version);
assert.match(
  readFileSync(join(root, "CHANGELOG.md"), "utf8"),
  new RegExp(`^## ${manifest.version.replaceAll(".", "\\.")} — `, "m"),
  "CHANGELOG.md must include the current stable plugin version",
);

assert.equal(marketplace.name, manifest.name);
assert.equal(marketplace.interface?.displayName, manifest.interface?.displayName);
assert.deepEqual(
  marketplace.plugins?.map(({ name }) => name),
  ["context-relay", "execution-budget", "async-wait-guard"],
  "the marketplace order and exact separately selectable set must remain stable",
);

function assertMarketplaceEntry(entry, pluginManifest, expectedPath) {
  assert.equal(entry?.name, pluginManifest.name);
  assert.equal(entry?.source?.source, "local");
  assert.equal(entry?.source?.path, expectedPath);
  assert.equal(entry?.policy?.installation, "AVAILABLE");
  assert.equal(entry?.policy?.authentication, "ON_INSTALL");
  assert.equal(entry?.category, pluginManifest.interface?.category);

  const sourceRoot = resolve(root, entry.source.path);
  assert.equal(lstatSync(sourceRoot).isSymbolicLink(), false, `${entry.name} source may not be a symlink`);
  const repositoryReal = realpathSync(root);
  const sourceReal = realpathSync(sourceRoot);
  const sourceRelative = relative(repositoryReal, sourceReal);
  assert.ok(
    sourceRelative === "" || (!sourceRelative.startsWith("..") && !isAbsolute(sourceRelative)),
    `${entry.name} source must stay inside the repository`,
  );
  assert.ok(existsSync(join(sourceRoot, ".codex-plugin", "plugin.json")));
}

assertMarketplaceEntry(marketplace.plugins[0], manifest, "./plugins/context-relay");
assertMarketplaceEntry(marketplace.plugins[1], budgetManifest, "./plugins/execution-budget");
assertMarketplaceEntry(marketplace.plugins[2], waitManifest, "./plugins/async-wait-guard");

const pluginRoots = [corePluginRoot, budgetPluginRoot, waitPluginRoot].map((path) => realpathSync(path));
for (let index = 0; index < pluginRoots.length; index += 1) {
  for (let other = index + 1; other < pluginRoots.length; other += 1) {
    assert.ok(
      relative(pluginRoots[index], pluginRoots[other]).startsWith(".."),
      "each marketplace plugin source must be physically independent",
    );
    assert.ok(
      relative(pluginRoots[other], pluginRoots[index]).startsWith(".."),
      "each marketplace plugin source must be physically independent",
    );
  }
}

assert.equal(budgetManifest.name, "execution-budget");
assert.equal(budgetManifest.version, "0.1.0");
assert.match(budgetManifest.version, strictSemver);
assert.equal(budgetManifest.skills, "./skills/");
assert.equal(budgetManifest.license, "Apache-2.0");
assert.deepEqual(
  readdirSync(join(budgetPluginRoot, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
  ["execution-budget"],
);
const budgetSkillRoot = join(budgetPluginRoot, "skills", "execution-budget");
for (const required of [
  "SKILL.md",
  "agents/openai.yaml",
  "scripts/estimate-budget.mjs",
  "scripts/calibrate-budget.mjs",
  "references/request.schema.json",
  "references/execution-budget.schema.json",
  "references/run-record.schema.json",
  "references/calibration.schema.json",
]) {
  assert.ok(existsSync(join(budgetSkillRoot, ...required.split("/"))), `missing ${required}`);
}
const budgetOpenAi = readFileSync(join(budgetSkillRoot, "agents", "openai.yaml"), "utf8");
assert.match(budgetOpenAi, /default_prompt:\s*"[^"]*\$execution-budget/);
assert.match(budgetOpenAi, /allow_implicit_invocation:\s*false/);

assert.equal(waitManifest.name, "async-wait-guard");
assert.equal(waitManifest.version, "0.1.0");
assert.match(waitManifest.version, strictSemver);
assert.equal(waitManifest.skills, "./skills/");
assert.equal(waitManifest.license, "Apache-2.0");
assert.deepEqual(
  readdirSync(join(waitPluginRoot, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
  ["async-wait-guard"],
);
const waitSkillRoot = join(waitPluginRoot, "skills", "async-wait-guard");
for (const required of [
  "SKILL.md",
  "agents/openai.yaml",
  "scripts/plan-wait.mjs",
  "references/policy.md",
]) {
  assert.ok(existsSync(join(waitSkillRoot, ...required.split("/"))), `missing ${required}`);
}
const waitOpenAi = readFileSync(join(waitSkillRoot, "agents", "openai.yaml"), "utf8");
assert.match(waitOpenAi, /default_prompt:\s*"[^"]*\$async-wait-guard/);
assert.match(waitOpenAi, /allow_implicit_invocation:\s*true/);
for (const requiredPackagePath of [".agents/plugins/marketplace.json", "plugins/"]) {
  assert.ok(packageJson.files.includes(requiredPackagePath), `package files must include ${requiredPackagePath}`);
}
const excluded = new Set([".git", "node_modules"]);
const textExtensions = new Set([".md", ".json", ".jsonl", ".mjs", ".yml", ".yaml", ""]);
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (textExtensions.has(extname(entry.name)) || entry.name === "LICENSE") files.push(full);
  }
}

walk(root);

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._~+\/-]{12,}/i,
];

for (const file of files) {
  const contents = readFileSync(file, "utf8");
  assert.doesNotMatch(contents, /\[TODO(?::|\])/i, `${relative(root, file)} contains a TODO placeholder`);
  for (const pattern of secretPatterns) {
    assert.doesNotMatch(contents, pattern, `${relative(root, file)} resembles a committed credential`);
  }

  if (extname(file) === ".md") {
    for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
      const decoded = decodeURIComponent(target.replace(/^<|>$/g, ""));
      assert.ok(existsSync(resolve(dirname(file), decoded)), `${relative(root, file)} has broken link ${target}`);
    }
  }
}

console.log(`REPOSITORY_CHECK_OK files=${files.length}`);
