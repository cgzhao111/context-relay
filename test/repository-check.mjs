import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, ".codex-plugin", "plugin.json"), "utf8"));
const marketplace = JSON.parse(readFileSync(join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

assert.equal(manifest.name, "context-relay");
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.skills, "./skills/");
assert.equal(manifest.license, "Apache-2.0");
assert.ok(existsSync(join(root, "skills", "project-handoff", "SKILL.md")));
assert.equal(packageJson.version, manifest.version);
assert.equal(packageLock.version, manifest.version);
assert.equal(packageLock.packages?.[""]?.version, manifest.version);
assert.match(
  readFileSync(join(root, "CHANGELOG.md"), "utf8"),
  new RegExp(`^## ${manifest.version.replaceAll(".", "\\.")} —`, "m"),
  "CHANGELOG.md must include the current plugin version",
);

assert.equal(marketplace.name, manifest.name);
assert.equal(marketplace.interface?.displayName, manifest.interface?.displayName);
assert.equal(marketplace.plugins?.length, 1);
assert.equal(marketplace.plugins[0]?.name, manifest.name);
assert.equal(marketplace.plugins[0]?.source?.source, "local");
assert.equal(marketplace.plugins[0]?.source?.path, "./");
assert.equal(marketplace.plugins[0]?.policy?.installation, "AVAILABLE");
assert.equal(marketplace.plugins[0]?.category, manifest.interface?.category);

const excluded = new Set([".git", "node_modules"]);
const textExtensions = new Set([".md", ".json", ".mjs", ".yml", ".yaml", ""]);
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
  /Authorization:\s*Bearer\s+[A-Za-z0-9._~+\/-]{12,}/i
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
