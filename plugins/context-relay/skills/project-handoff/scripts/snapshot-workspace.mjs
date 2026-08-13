#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

function usage() {
  return `Usage: context-relay-snapshot [--root PATH] [--output FILE] [--include FILE ...]\n\nCaptures Git state and SHA-256 evidence for changed files or explicitly included files.\nThe inspected workspace is never modified. Only --output, when provided, is written.`;
}

function parseArgs(argv) {
  const result = { root: process.cwd(), output: null, includes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--root") {
      result.root = argv[++index];
    } else if (arg === "--output") {
      result.output = argv[++index];
    } else if (arg === "--include") {
      result.includes.push(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!result.root) throw new Error("--root requires a path");
  if (argv.includes("--output") && !result.output) throw new Error("--output requires a file");
  if (argv.includes("--include") && result.includes.some((value) => !value)) {
    throw new Error("--include requires a file");
  }
  return result;
}

function git(root, args, fallback = null) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return fallback;
  }
}

function changedFiles(root, hasCommit) {
  const names = new Set();
  const addNulList = (text) => {
    if (!text) return;
    for (const name of text.split("\0")) {
      if (name) names.add(name);
    }
  };

  if (hasCommit) {
    addNulList(git(root, ["diff", "--name-only", "-z", "HEAD"], ""));
    addNulList(git(root, ["diff", "--cached", "--name-only", "-z"], ""));
    addNulList(git(root, ["ls-files", "--others", "--exclude-standard", "-z"], ""));
  } else {
    addNulList(git(root, ["ls-files", "-co", "--exclude-standard", "-z"], ""));
  }
  return [...names].sort();
}

function gitPrefix(root) {
  const prefix = git(root, ["rev-parse", "--show-prefix"], "");
  return prefix ? prefix.replaceAll("\\", "/") : "";
}

function relativeToAuthorizedRoot(candidate, prefix) {
  const normalized = candidate.replaceAll("\\", "/");
  if (!prefix) return normalized;
  if (!normalized.startsWith(prefix)) return null;
  return normalized.slice(prefix.length);
}

function resolveInside(root, candidate) {
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return absolute;
  throw new Error(`Path escapes the authorized root: ${candidate}`);
}

function digestFile(root, candidate) {
  const absolute = resolveInside(root, candidate);
  const target = realpathSync(absolute);
  const targetRel = relative(root, target);
  if (targetRel === ".." || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) {
    throw new Error(`Resolved path escapes the authorized root: ${candidate}`);
  }
  if (!statSync(target).isFile()) throw new Error(`Not a regular file: ${candidate}`);
  const bytes = readFileSync(target);
  return {
    path: relative(root, absolute).split(sep).join("/"),
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.byteLength,
    modified_at: statSync(target).mtime.toISOString()
  };
}

function writeAtomic(file, contents) {
  const target = resolve(file);
  const temp = mkdtempSync(resolve(dirname(target), ".context-relay-"));
  const staged = resolve(temp, "snapshot.json");
  try {
    writeFileSync(staged, contents, { encoding: "utf8", flag: "wx" });
    renameSync(staged, target);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function createSnapshot(options) {
  const root = realpathSync(resolve(options.root));
  if (!statSync(root).isDirectory()) throw new Error(`Not a directory: ${options.root}`);

  const commit = git(root, ["rev-parse", "HEAD"]);
  const insideGit = git(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
  const status = insideGit ? git(root, ["status", "--porcelain=v1"], "") : "";
  const branchValue = insideGit ? git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) : null;
  const prefix = insideGit ? gitPrefix(root) : "";
  const rawCandidates = options.includes.length > 0
    ? options.includes
    : insideGit
      ? changedFiles(root, Boolean(commit))
      : [];
  const candidates = options.includes.length > 0
    ? rawCandidates
    : rawCandidates.map((candidate) => relativeToAuthorizedRoot(candidate, prefix)).filter(Boolean);

  const outputAbsolute = options.output ? resolve(options.output) : null;
  const files = [...new Set(candidates)]
    .filter((candidate) => resolveInside(root, candidate) !== outputAbsolute)
    .filter((candidate) => {
      try {
        return statSync(resolveInside(root, candidate)).isFile();
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    })
    .map((candidate) => digestFile(root, candidate));

  const deleted_files = insideGit
    ? rawCandidates
      .map((candidate) => relativeToAuthorizedRoot(candidate, prefix))
      .filter(Boolean)
      .filter((candidate) => {
        try {
          statSync(resolveInside(root, candidate));
          return false;
        } catch (error) {
          if (error?.code === "ENOENT") return true;
          throw error;
        }
      })
      .sort()
    : [];

  return {
    captured_at: new Date().toISOString(),
    digest_algorithm: "sha256",
    git: insideGit && commit
      ? { commit, branch: branchValue || null, dirty: status.length > 0 }
      : null,
    files,
    deleted_files,
    coverage_notes: options.includes.length > 0
      ? "Only explicitly included files were digested."
      : insideGit
        ? "Changed and untracked files were digested; unchanged tracked files were not."
        : "No Git repository was detected and no files were included."
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const snapshot = createSnapshot(args);
    const json = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (args.output) writeAtomic(args.output, json);
    else process.stdout.write(json);
  } catch (error) {
    process.stderr.write(`context-relay-snapshot: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
