import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSnapshot } from "../plugins/context-relay/skills/project-handoff/scripts/snapshot-workspace.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

test("snapshot records commit, dirty state, and explicit file digest", () => {
  const root = mkdtempSync(join(tmpdir(), "context-relay-test-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Synthetic Tester");
  git(root, "config", "user.email", "tester@example.invalid");
  writeFileSync(join(root, "state.txt"), "verified\n", "utf8");
  git(root, "add", "state.txt");
  git(root, "commit", "-q", "-m", "synthetic fixture");
  writeFileSync(join(root, "state.txt"), "changed\n", "utf8");

  const snapshot = createSnapshot({ root, output: null, includes: ["state.txt"] });

  assert.match(snapshot.git.commit, /^[a-f0-9]{40}$/);
  assert.equal(snapshot.git.dirty, true);
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0].path, "state.txt");
  assert.match(snapshot.files[0].digest, /^sha256:[a-f0-9]{64}$/);
});

test("snapshot rejects a path outside the authorized root", () => {
  const root = mkdtempSync(join(tmpdir(), "context-relay-test-"));
  assert.throws(
    () => createSnapshot({ root, output: null, includes: ["../outside.txt"] }),
    /escapes the authorized root/
  );
});

test("snapshot records deleted tracked files without failing", () => {
  const root = mkdtempSync(join(tmpdir(), "context-relay-test-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Synthetic Tester");
  git(root, "config", "user.email", "tester@example.invalid");
  writeFileSync(join(root, "removed.txt"), "temporary\n", "utf8");
  git(root, "add", "removed.txt");
  git(root, "commit", "-q", "-m", "add removable fixture");
  execFileSync(process.execPath, ["-e", "require('node:fs').unlinkSync(process.argv[1])", join(root, "removed.txt")]);

  const snapshot = createSnapshot({ root, output: null, includes: [] });
  assert.deepEqual(snapshot.files, []);
  assert.deepEqual(snapshot.deleted_files, ["removed.txt"]);
});

test("snapshot works when the authorized root is a repository subdirectory", () => {
  const repo = mkdtempSync(join(tmpdir(), "context-relay-test-"));
  const sub = join(repo, "sub");
  execFileSync(process.execPath, ["-e", "require('node:fs').mkdirSync(process.argv[1])", sub]);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Synthetic Tester");
  git(repo, "config", "user.email", "tester@example.invalid");
  writeFileSync(join(sub, "state.txt"), "before\n", "utf8");
  git(repo, "add", "sub/state.txt");
  git(repo, "commit", "-q", "-m", "subdirectory fixture");
  writeFileSync(join(sub, "state.txt"), "after\n", "utf8");

  const snapshot = createSnapshot({ root: sub, output: null, includes: [] });
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0].path, "state.txt");
});

test("snapshot rejects a file reached through an escaping directory link", () => {
  const root = mkdtempSync(join(tmpdir(), "context-relay-test-root-"));
  const outside = mkdtempSync(join(tmpdir(), "context-relay-test-outside-"));
  writeFileSync(join(outside, "private.txt"), "synthetic private content\n", "utf8");
  symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () => createSnapshot({ root, output: null, includes: ["linked/private.txt"] }),
    /resolves? .*outside|escapes the authorized root/i
  );
});
