#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateHandoff } from "../plugins/context-relay/skills/project-handoff/scripts/validate-handoff.mjs";

const NOW = "2026-08-12T20:00:00.000Z";

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "context-relay-case-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Synthetic Runner");
  git(root, "config", "user.email", "runner@example.invalid");

  const content = "verified synthetic state\n";
  const file = join(root, "state.txt");
  await writeFile(file, content, "utf8");
  git(root, "add", "state.txt");
  git(root, "commit", "-q", "-m", "synthetic fixture");
  const info = await stat(file);
  const commit = git(root, "rev-parse", "HEAD");
  const branch = git(root, "symbolic-ref", "--short", "HEAD");

  return {
    root,
    handoff: {
      schema_version: "1.0.0",
      handoff_id: "public-repro-case",
      generated_at: NOW,
      source_completeness: "VISIBLE_CONTEXT_ONLY",
      project: { name: "Synthetic project", root: ".", repository_url: null },
      snapshot: {
        captured_at: NOW,
        digest_algorithm: "sha256",
        git: { commit, branch, dirty: false },
        files: [{
          path: "state.txt",
          digest: digest(content),
          size: info.size,
          modified_at: info.mtime.toISOString(),
        }],
        deleted_files: [],
        coverage_notes: "Only synthetic state.txt is in scope.",
      },
      source_precedence: ["CURRENT_DISK", "GIT_STATE", "VISIBLE_CONTEXT"],
      objective: "Exercise one deterministic safety invariant.",
      deliverables: [{
        id: "state",
        name: "Synthetic state",
        path: "state.txt",
        status: "VERIFIED",
        summary: "The file matched the captured digest when the handoff was generated.",
        evidence: [{ type: "FILE_DIGEST", ref: "state.txt", digest: digest(content), observed_at: NOW }],
      }],
      work_items: [],
      decisions: [],
      constraints: ["Use synthetic data only."],
      references: [{ kind: "FILE", value: "state.txt", status: "VERIFIED", digest: digest(content) }],
      next_actions: [{ title: "Validate before continuing." }],
      bootstrap_prompt: "Validate this synthetic handoff before continuing.",
      privacy: { scan_status: "PASSED", scanned_at: NOW, redactions_applied: false, findings: [] },
    },
  };
}

function summarize(id, expected, result) {
  const observed = [...new Set(result.errors.map((entry) => entry.code))].sort();
  return {
    id,
    expected,
    observed,
    passed: expected.every((code) => observed.includes(code)),
  };
}

async function staleFileDigest() {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.root, "state.txt"), "changed after handoff\n", "utf8");
    const result = await validateHandoff(fixture.handoff, {
      projectRoot: fixture.root,
      checkDigests: true,
    });
    return summarize("stale-file-digest", ["DIGEST_MISMATCH"], result);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function restoredDeletedFile() {
  const fixture = await createFixture();
  try {
    fixture.handoff.snapshot.deleted_files = ["restored.txt"];
    await writeFile(join(fixture.root, "restored.txt"), "restored after handoff\n", "utf8");
    const result = await validateHandoff(fixture.handoff, {
      projectRoot: fixture.root,
      checkDigests: true,
    });
    return summarize("restored-deleted-file", ["DELETED_FILE_RESTORED"], result);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function privacySecret() {
  const fixture = await createFixture();
  try {
    const syntheticSecret = ["sk", "proj", "abcdefghijklmnopqrstuvwx"].join("-");
    fixture.handoff.constraints.push(`Synthetic secret for scanner test: ${syntheticSecret}`);
    const result = await validateHandoff(fixture.handoff);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(syntheticSecret), false, "validator output must not echo the sensitive value");
    return summarize("privacy-secret", ["SENSITIVE_DATA_FOUND"], result);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

export async function runReproCases() {
  const cases = await Promise.all([
    staleFileDigest(),
    restoredDeletedFile(),
    privacySecret(),
  ]);
  return {
    schema_version: "1.0.0",
    synthetic_only: true,
    cases,
    passed: cases.every((entry) => entry.passed),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await runReproCases();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}
