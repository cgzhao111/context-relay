#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SCAN_ROOTS = [
  "evaluation",
  "docs",
  "plugins",
  ".agents/plugins/marketplace.json",
  "README.md",
  "CHANGELOG.md"
];
const DENYLIST_ENV = "CONTEXT_RELAY_PUBLIC_EVIDENCE_DENYLIST";
const EXCLUDED_PREFIXES = ["evaluation/scripts/"];
const EVALUATION_HARNESS_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".ts"]);
const KNOWN_BINARY_EXTENSIONS = new Set([
  ".7z", ".avi", ".bmp", ".doc", ".docx", ".gif", ".gz", ".ico", ".jpeg",
  ".jpg", ".mov", ".mp3", ".mp4", ".pdf", ".png", ".ppt", ".pptx", ".tar",
  ".tgz", ".webm", ".webp", ".xls", ".xlsx", ".zip"
]);

const SAFE_CREDENTIAL_VALUES = /^(?:redacted|placeholder|example|changeme|not[-_ ]?set|none|null|your[-_ ].*|test[-_ ].*)$/i;

const DETECTORS = [
  {
    id: "ABSOLUTE_WINDOWS_PATH",
    test: (line) => /(?:^|[\s"'`(\[={>])[A-Za-z]:[\\/][^\s"'`<>(){}\[\],;]*/.test(line)
  },
  {
    id: "ABSOLUTE_UNIX_PATH",
    test: (line) => /(?:^|[\s"'`(\[={>])\/(?!\/)[^\s"'`<>(){}\[\],;:]+/.test(line)
  },
  {
    id: "EMAIL_ADDRESS",
    test: (line) => /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(line)
  },
  {
    id: "PHONE_NUMBER",
    test: (line) =>
      /(?<!\d)1[3-9]\d{9}(?!\d)/.test(line) ||
      /(?<![\w])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]\d{3,4}[ .-]\d{4}(?!\w)/.test(line)
  },
  {
    id: "TOKEN_OR_SECRET",
    test: (line) =>
      /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/.test(line) ||
      hasUnsafeCredentialAssignment(line)
  },
  {
    id: "PRIVATE_KEY",
    test: (line) => /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/.test(line)
  },
  {
    id: "UUID",
    test: (line) => /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(line)
  },
  {
    id: "THREAD_OR_SESSION_FIELD",
    test: (line) => /\b(?:source[_-]?thread|thread|session)(?:[_-]?id)?\b\s*[:=]/i.test(line)
  },
  {
    id: "RAW_CONVERSATION_ARTIFACT",
    test: (line) => /\b(?:raw[_-]?transcript|chat[_-]?log|rawTranscript|chatLog)\b/i.test(line)
  }
];

function hasUnsafeCredentialAssignment(line) {
  const match = line.match(
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)\b\s*[:=]\s*["']?([^\s"',;}]{4,})/i
  );
  if (!match) return false;
  return !SAFE_CREDENTIAL_VALUES.test(match[1]);
}

function normalizeRelativePath(value) {
  return value.split(sep).join("/");
}

function isExecutableHarness(relativePath) {
  const isEvaluationSource = relativePath.startsWith("evaluation/");
  const isPluginScript = relativePath.startsWith("plugins/") && relativePath.includes("/scripts/");
  if (!isEvaluationSource && !isPluginScript) return false;
  const fileName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 && EVALUATION_HARNESS_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}

function extensionOf(relativePath) {
  const fileName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
}

function isBinaryContent(buffer, relativePath) {
  if (KNOWN_BINARY_EXTENSIONS.has(extensionOf(relativePath))) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 0x08 || (byte > 0x0d && byte < 0x20)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

function isInside(parent, child) {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function extractScannableText(buffer) {
  return buffer
    .toString("utf8")
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]+/g, "\n");
}

function loadDenylist(denylistPath, cwd = process.cwd()) {
  if (!denylistPath) return [];
  const resolved = resolve(cwd, denylistPath);
  try {
    return readFileSync(resolved, "utf8")
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry && !entry.startsWith("#"));
  } catch (error) {
    const wrapped = new Error("The configured private denylist could not be read.");
    wrapped.code = "DENYLIST_READ_FAILED";
    wrapped.cause = error;
    throw wrapped;
  }
}

function collectFiles(repositoryRoot, scanRoots) {
  const repositoryReal = realpathSync(repositoryRoot);
  const files = [];
  const structuralFindings = [];

  function walk(path, relativePath) {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      structuralFindings.push({
        file: "<redacted-path>",
        line: 0,
        rule: "SYMLINK_NOT_ALLOWED"
      });
      return;
    }
    const pathReal = realpathSync(path);
    if (!isInside(repositoryReal, pathReal)) {
      structuralFindings.push({
        file: "<redacted-path>",
        line: 0,
        rule: "PATH_ESCAPE"
      });
      return;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const childRelative = normalizeRelativePath(join(relativePath, entry.name));
        if (EXCLUDED_PREFIXES.some((prefix) => `${childRelative}/`.startsWith(prefix))) continue;
        walk(join(path, entry.name), childRelative);
      }
      return;
    }
    if (stats.isFile()) {
      const normalized = normalizeRelativePath(relativePath);
      // Executable harnesses intentionally contain regular expressions and
      // synthetic leak canaries. Their generated artifacts are scanned;
      // source-code credentials remain covered by repository-check.mjs.
      if (!isExecutableHarness(normalized)) files.push({ absolute: path, relative: normalized });
    }
  }

  for (const scanRoot of scanRoots) {
    const absolute = resolve(repositoryRoot, scanRoot);
    if (!existsSync(absolute)) continue;
    walk(absolute, normalizeRelativePath(scanRoot));
  }
  return { files, structuralFindings };
}

function lineRuleIds(line, denylist) {
  const ids = [];
  for (const detector of DETECTORS) {
    if (detector.test(line)) ids.push(detector.id);
  }
  const folded = line.toLocaleLowerCase("en-US");
  if (denylist.some((entry) => folded.includes(entry.toLocaleLowerCase("en-US")))) {
    ids.push("PRIVATE_DENYLIST_MATCH");
  }
  return ids;
}

function safeDisplayPath(relativePath, denylist, ordinal) {
  return lineRuleIds(relativePath, denylist).length > 0
    ? `<redacted-path-${ordinal}>`
    : relativePath;
}

export function scanPublicEvidence({
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  scanRoots = DEFAULT_SCAN_ROOTS,
  denylistPath = process.env[DENYLIST_ENV],
  cwd = process.cwd()
} = {}) {
  const root = resolve(repositoryRoot);
  const denylist = loadDenylist(denylistPath, cwd);
  const { files, structuralFindings } = collectFiles(root, scanRoots);
  const findings = [...structuralFindings];

  files.forEach((file, index) => {
    const displayPath = safeDisplayPath(file.relative, denylist, index + 1);
    const pathRules = lineRuleIds(file.relative, denylist);
    for (const rule of pathRules) findings.push({ file: displayPath, line: 0, rule });

    const contents = readFileSync(file.absolute);
    if (isBinaryContent(contents, file.relative)) return;
    const lines = extractScannableText(contents).split(/\r?\n/u);
    lines.forEach((line, lineIndex) => {
      for (const rule of lineRuleIds(line, denylist)) {
        findings.push({ file: displayPath, line: lineIndex + 1, rule });
      }
    });
  });

  return { filesScanned: files.length, findings };
}

export function formatFindings(result) {
  if (result.findings.length === 0) {
    return [`PUBLIC_EVIDENCE_CHECK_OK files=${result.filesScanned}`];
  }
  return [
    `PUBLIC_EVIDENCE_CHECK_FAILED findings=${result.findings.length}`,
    ...result.findings.map(({ file, line, rule }) =>
      `- file=${file} line=${line} rule=${rule}`
    )
  ];
}

function runCli() {
  try {
    const result = scanPublicEvidence();
    for (const line of formatFindings(result)) console.log(line);
    if (result.findings.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`PUBLIC_EVIDENCE_CHECK_ERROR code=${error.code ?? "SCAN_FAILED"}`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) runCli();
