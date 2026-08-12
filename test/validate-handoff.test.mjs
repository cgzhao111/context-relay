import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  EXIT_CODES,
  runCli,
  scanSensitiveData,
  validateHandoff,
} from '../skills/project-handoff/scripts/validate-handoff.mjs';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'context-relay-'));
  const content = 'verified project output\n';
  const artifactPath = join(root, 'artifact.txt');
  await writeFile(artifactPath, content, 'utf8');
  const info = await stat(artifactPath);
  const digest = sha256(content);
  const now = '2026-08-12T20:00:00.000Z';
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Synthetic Tester']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'tester@example.invalid']);
  execFileSync('git', ['-C', root, 'add', 'artifact.txt']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'synthetic fixture']);
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const branch = execFileSync('git', ['-C', root, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  return {
    root,
    handoff: {
      schema_version: '1.0.0',
      handoff_id: 'demo-20260812',
      generated_at: now,
      source_completeness: 'VISIBLE_CONTEXT_ONLY',
      project: { name: 'Demo project', root: '.', repository_url: null },
      snapshot: {
        captured_at: now,
        digest_algorithm: 'sha256',
        git: { commit, branch, dirty: false },
        files: [{ path: 'artifact.txt', digest, size: info.size, modified_at: info.mtime.toISOString() }],
        coverage_notes: 'Only the synthetic artifact was included.',
      },
      source_precedence: ['CURRENT_DISK', 'GIT_STATE', 'VISIBLE_CONTEXT'],
      objective: 'Preserve the current verified project state for a new task.',
      deliverables: [{
        id: 'artifact',
        name: 'Artifact',
        path: 'artifact.txt',
        status: 'VERIFIED',
        summary: 'The artifact exists and matches the captured digest.',
        evidence: [{ type: 'FILE_DIGEST', ref: 'artifact.txt', digest, observed_at: now }],
      }],
      work_items: [{
        id: 'next',
        title: 'Next improvement',
        status: 'PLANNED',
        summary: 'Not implemented yet.',
        evidence: [],
      }],
      decisions: [{
        id: 'decision-1',
        status: 'ACTIVE',
        summary: 'Use an evidence-backed JSON handoff.',
        evidence: [{ type: 'GIT_COMMIT', ref: commit }],
      }],
      constraints: ['Do not claim planned work is implemented.'],
      references: [{ kind: 'FILE', value: 'artifact.txt', status: 'VERIFIED', digest }],
      next_actions: [{ title: 'Read the handoff before editing.' }],
      bootstrap_prompt: 'Read this handoff, validate it, and report the current state.',
      privacy: { scan_status: 'PASSED', scanned_at: now, redactions_applied: false, findings: [] },
    },
  };
}

test('schema is strict at the top level and defines required provenance fields', async () => {
  const schemaPath = new URL('../skills/project-handoff/references/handoff.schema.json', import.meta.url);
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('handoff_id'));
  assert.ok(schema.required.includes('source_completeness'));
  assert.deepEqual(schema.properties.decisions.items.$ref, '#/$defs/decision');
  assert.ok(!schema.$defs.workStatus.enum.includes('SUPERSEDED'));
});

test('published synthetic example conforms to the JSON Schema', async () => {
  const schemaPath = new URL('../skills/project-handoff/references/handoff.schema.json', import.meta.url);
  const examplePath = new URL('../examples/basic/handoff.json', import.meta.url);
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const example = JSON.parse(await readFile(examplePath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(example), true, JSON.stringify(validate.errors, null, 2));
});

test('valid handoff passes core, digest, freshness, and sensitive-data checks', async (t) => {
  const { root, handoff } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await validateHandoff(handoff, {
    projectRoot: root,
    checkDigests: true,
    maxAgeHours: 24,
    now: new Date('2026-08-12T21:00:00.000Z'),
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
  assert.deepEqual(result.summary, { errors: 0, warnings: 0, findings: 0 });
  assert.equal(result.checks.digest, 'completed');
  assert.equal(result.checks.freshness, 'completed');
});

test('VERIFIED status requires strong evidence', async (t) => {
  const { root, handoff } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  handoff.deliverables[0].evidence = [{ type: 'USER_CONFIRMATION', ref: 'User said it was done.' }];
  const result = await validateHandoff(handoff);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((entry) => entry.code === 'VERIFIED_WITHOUT_STRONG_EVIDENCE'));
});

test('unknown top-level fields are rejected to keep the protocol deterministic', async (t) => {
  const { root, handoff } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  handoff.unexpected = true;
  const result = await validateHandoff(handoff);
  assert.ok(result.errors.some((entry) => entry.code === 'ADDITIONAL_PROPERTY'));
});

test('superseded decisions must point to an existing later decision', async (t) => {
  const { root, handoff } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  handoff.decisions[0].status = 'SUPERSEDED';
  handoff.decisions[0].superseded_by = 'missing-decision';
  const result = await validateHandoff(handoff);
  assert.ok(result.errors.some((entry) => entry.code === 'BROKEN_SUPERSESSION'));

  handoff.decisions.push({
    id: 'missing-decision',
    status: 'ACTIVE',
    summary: 'This is the current decision.',
    evidence: [],
  });
  const repaired = await validateHandoff(handoff);
  assert.equal(repaired.errors.some((entry) => entry.code === 'BROKEN_SUPERSESSION'), false);
});

test('digest mismatch and stale handoff fail independently', async (t) => {
  const { root, handoff } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'artifact.txt'), 'changed after snapshot\n', 'utf8');
  const result = await validateHandoff(handoff, {
    projectRoot: root,
    checkDigests: true,
    maxAgeHours: 1,
    now: new Date('2026-08-13T20:00:00.000Z'),
  });
  assert.ok(result.errors.some((entry) => entry.code === 'DIGEST_MISMATCH'));
  assert.ok(result.errors.some((entry) => entry.code === 'STALE_HANDOFF'));
});

test('Git snapshot mismatch is rejected during current-state verification', async (t) => {
  const { root, handoff } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  handoff.snapshot.git.commit = '0000000000000000000000000000000000000000';
  handoff.snapshot.git.branch = 'definitely-not-current';
  handoff.snapshot.git.dirty = true;
  const result = await validateHandoff(handoff, { projectRoot: root, checkDigests: true });
  assert.ok(result.errors.some((entry) => entry.code === 'GIT_COMMIT_MISMATCH'));
  assert.ok(result.errors.some((entry) => entry.code === 'GIT_BRANCH_MISMATCH'));
  assert.ok(result.errors.some((entry) => entry.code === 'GIT_DIRTY_MISMATCH'));
});

test('a restored file invalidates a deleted-file snapshot claim', async (t) => {
  const { root, handoff } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'restored.txt'), 'restored after handoff\n', 'utf8');
  handoff.snapshot.deleted_files = ['restored.txt'];
  const result = await validateHandoff(handoff, { projectRoot: root, checkDigests: true });
  assert.ok(result.errors.some((entry) => entry.code === 'DELETED_FILE_RESTORED'));
});

test('digest checks reject files reached through an escaping directory link', async (t) => {
  const { root, handoff } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'context-relay-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const privateFile = join(outside, 'private.txt');
  const contents = 'synthetic private content\n';
  await writeFile(privateFile, contents, 'utf8');
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const info = await stat(privateFile);
  handoff.snapshot.files = [{
    path: 'linked/private.txt',
    digest: sha256(contents),
    size: info.size,
    modified_at: info.mtime.toISOString(),
  }];

  const result = await validateHandoff(handoff, { projectRoot: root, checkDigests: true });
  assert.ok(result.errors.some((entry) => entry.code === 'PATH_ESCAPE'));
});

test('secret and PII scanner reports paths without returning raw values', async (t) => {
  const { root, handoff } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwx'].join('-');
  handoff.constraints.push(`Do not expose ${fakeKey}.`);
  handoff.next_actions.push({ title: 'Contact owner at owner@corp.invalid.' });
  const findings = scanSensitiveData(handoff);
  assert.ok(findings.some((entry) => entry.kind === 'SECRET'));
  assert.ok(findings.some((entry) => entry.kind === 'EMAIL'));
  assert.ok(findings.every((entry) => !JSON.stringify(entry).includes('abcdefghijklmnopqrstuvwx')));
  const result = await validateHandoff(handoff);
  assert.ok(result.errors.some((entry) => entry.code === 'SENSITIVE_DATA_FOUND'));
  assert.ok(result.errors.some((entry) => entry.code === 'PRIVACY_SCAN_CONTRADICTION'));
});

test('sensitive data inside declared privacy findings is still detected', async (t) => {
  const { root, handoff } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const syntheticKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwx'].join('-');
  handoff.privacy.scan_status = 'FINDINGS';
  handoff.privacy.findings = [{ kind: 'SECRET', path: '/constraints/0', redacted: false, note: syntheticKey }];
  const result = await validateHandoff(handoff);
  assert.ok(result.errors.some((entry) => entry.code === 'SENSITIVE_DATA_FOUND'));
  assert.ok(result.findings.some((entry) => entry.path.endsWith('/note')));
});

test('CLI exposes stable exit codes for success, invalid JSON, invalid handoff, and I/O errors', async (t) => {
  const { root, handoff } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const good = join(root, 'good.json');
  const malformed = join(root, 'malformed.json');
  const invalid = join(root, 'invalid.json');
  await writeFile(good, JSON.stringify(handoff), 'utf8');
  await writeFile(malformed, '{', 'utf8');
  await writeFile(invalid, '{}', 'utf8');
  const quiet = { stdout: () => {}, stderr: () => {} };
  assert.equal(await runCli([good, '--json'], quiet), EXIT_CODES.OK);
  assert.equal(await runCli([malformed], quiet), EXIT_CODES.USAGE_OR_JSON);
  assert.equal(await runCli([invalid], quiet), EXIT_CODES.INVALID);
  assert.equal(await runCli([join(root, 'missing.json')], quiet), EXIT_CODES.IO_ERROR);
  assert.equal(await runCli([], quiet), EXIT_CODES.USAGE_OR_JSON);
});
