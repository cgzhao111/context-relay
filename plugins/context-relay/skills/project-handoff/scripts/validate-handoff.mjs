#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

export const EXIT_CODES = Object.freeze({
  OK: 0,
  INVALID: 1,
  USAGE_OR_JSON: 2,
  IO_ERROR: 3,
});

const SCHEMA_VERSION = '1.0.0';
const SOURCE_COMPLETENESS = new Set([
  'VISIBLE_CONTEXT_ONLY',
  'USER_TRANSCRIPT',
  'FULL_THREAD_READ',
  'PARTIAL_THREAD_READ',
]);
const WORK_STATUSES = new Set([
  'VERIFIED',
  'IMPLEMENTED_NOT_VERIFIED',
  'PLANNED',
  'UNKNOWN',
  'BLOCKED',
  'STALE',
]);
const DECISION_STATUSES = new Set(['ACTIVE', 'SUPERSEDED']);
const EVIDENCE_TYPES = new Set([
  'FILE',
  'FILE_DIGEST',
  'GIT_COMMIT',
  'TEST_RESULT',
  'COMMAND_OUTPUT',
  'DEPLOYMENT',
  'USER_CONFIRMATION',
  'EXTERNAL_LINK',
]);
const STRONG_EVIDENCE = new Set(['FILE_DIGEST', 'GIT_COMMIT', 'TEST_RESULT', 'DEPLOYMENT']);
const SHA256_RE = /^(?:sha256:)?[a-f\d]{64}$/i;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const SENSITIVE_PATTERNS = [
  {
    kind: 'PRIVATE_KEY',
    label: 'private key material',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
  {
    kind: 'SECRET',
    label: 'OpenAI-style API key',
    regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: 'SECRET',
    label: 'GitHub token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    kind: 'SECRET',
    label: 'AWS access key',
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    kind: 'SECRET',
    label: 'Bearer token',
    regex: /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*\b/gi,
  },
  {
    kind: 'SECRET',
    label: 'assigned credential',
    regex: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{12,}["']?/gi,
  },
  {
    kind: 'EMAIL',
    label: 'email address',
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  },
  {
    kind: 'PHONE',
    label: 'mainland China mobile number',
    regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  },
  {
    kind: 'NATIONAL_ID',
    label: 'mainland China national ID',
    regex: /(?<!\d)\d{17}[\dXx](?!\d)/g,
  },
];

function issue(level, code, path, message, details = undefined) {
  return { level, code, path, message, ...(details === undefined ? {} : { details }) };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDateTime(value) {
  return typeof value === 'string' && DATE_TIME_RE.test(value) && Number.isFinite(Date.parse(value));
}

function escapePointer(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function normalizeDigest(value) {
  return String(value).replace(/^sha256:/i, '').toLowerCase();
}

function pushRequired(errors, object, fields, path = '') {
  for (const field of fields) {
    if (!(field in object)) {
      errors.push(issue('error', 'REQUIRED_FIELD', `${path}/${escapePointer(field)}`, `Missing required field: ${field}`));
    }
  }
}

function rejectUnknown(errors, object, allowed, path = '') {
  if (!isObject(object)) return;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key)) {
      errors.push(issue('error', 'ADDITIONAL_PROPERTY', `${path}/${escapePointer(key)}`, `Unknown field: ${key}`));
    }
  }
}

function validateEvidenceList(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(issue('error', 'TYPE', path, 'Evidence must be an array.'));
    return;
  }
  value.forEach((entry, index) => {
    const entryPath = `${path}/${index}`;
    if (!isObject(entry)) {
      errors.push(issue('error', 'TYPE', entryPath, 'Evidence entry must be an object.'));
      return;
    }
    pushRequired(errors, entry, ['type', 'ref'], entryPath);
    rejectUnknown(errors, entry, ['type', 'ref', 'digest', 'outcome', 'observed_at', 'note'], entryPath);
    if (!EVIDENCE_TYPES.has(entry.type)) {
      errors.push(issue('error', 'ENUM', `${entryPath}/type`, `Unsupported evidence type: ${String(entry.type)}`));
    }
    if (!isNonEmptyString(entry.ref)) {
      errors.push(issue('error', 'TYPE', `${entryPath}/ref`, 'Evidence ref must be a non-empty string.'));
    }
    if (entry.type === 'FILE_DIGEST' && !SHA256_RE.test(entry.digest ?? '')) {
      errors.push(issue('error', 'DIGEST_REQUIRED', `${entryPath}/digest`, 'FILE_DIGEST evidence requires a SHA-256 digest.'));
    }
    if (entry.type === 'GIT_COMMIT' && !/^[a-f\d]{7,64}$/i.test(entry.ref ?? '')) {
      errors.push(issue('error', 'COMMIT_FORMAT', `${entryPath}/ref`, 'GIT_COMMIT evidence ref must be a 7-64 digit hexadecimal commit ID.'));
    }
    if (entry.type === 'TEST_RESULT' && !['PASSED', 'FAILED', 'UNKNOWN'].includes(entry.outcome)) {
      errors.push(issue('error', 'TEST_OUTCOME_REQUIRED', `${entryPath}/outcome`, 'TEST_RESULT evidence requires PASSED, FAILED, or UNKNOWN outcome.'));
    }
    if ('digest' in entry && !SHA256_RE.test(entry.digest ?? '')) {
      errors.push(issue('error', 'DIGEST_FORMAT', `${entryPath}/digest`, 'Evidence digest must be SHA-256.'));
    }
    if ('outcome' in entry && !['PASSED', 'FAILED', 'UNKNOWN'].includes(entry.outcome)) {
      errors.push(issue('error', 'ENUM', `${entryPath}/outcome`, 'Evidence outcome must be PASSED, FAILED, or UNKNOWN.'));
    }
    if (entry.type === 'TEST_RESULT' && !isDateTime(entry.observed_at)) {
      errors.push(issue('error', 'TEST_OBSERVED_AT_REQUIRED', `${entryPath}/observed_at`, 'TEST_RESULT evidence requires observed_at with timezone.'));
    }
    if ('observed_at' in entry && !isDateTime(entry.observed_at)) {
      errors.push(issue('error', 'DATE_TIME', `${entryPath}/observed_at`, 'observed_at must be an ISO 8601 date-time with timezone.'));
    }
    if ('note' in entry && typeof entry.note !== 'string') {
      errors.push(issue('error', 'TYPE', `${entryPath}/note`, 'Evidence note must be a string.'));
    }
  });
}

function validateStatusRecord(record, path, errors, { deliverable = false } = {}) {
  if (!isObject(record)) {
    errors.push(issue('error', 'TYPE', path, `${deliverable ? 'Deliverable' : 'Work item'} must be an object.`));
    return;
  }
  pushRequired(errors, record, deliverable ? ['id', 'name', 'status', 'evidence'] : ['id', 'title', 'status', 'summary', 'evidence'], path);
  rejectUnknown(errors, record, deliverable
    ? ['id', 'name', 'path', 'status', 'summary', 'evidence', 'blocked_by', 'stale_reason']
    : ['id', 'title', 'status', 'summary', 'evidence', 'blocked_by', 'stale_reason'], path);
  if (!isNonEmptyString(record.id)) errors.push(issue('error', 'TYPE', `${path}/id`, 'Record id must be non-empty.'));
  if (deliverable) {
    if (!isNonEmptyString(record.name)) errors.push(issue('error', 'TYPE', `${path}/name`, 'Deliverable name must be non-empty.'));
    if ('path' in record && record.path !== null && typeof record.path !== 'string') errors.push(issue('error', 'TYPE', `${path}/path`, 'Deliverable path must be a string or null.'));
    if ('summary' in record && typeof record.summary !== 'string') errors.push(issue('error', 'TYPE', `${path}/summary`, 'Deliverable summary must be a string.'));
  } else {
    if (!isNonEmptyString(record.title)) errors.push(issue('error', 'TYPE', `${path}/title`, 'Work item title must be non-empty.'));
    if (!isNonEmptyString(record.summary)) errors.push(issue('error', 'TYPE', `${path}/summary`, 'Work item summary must be non-empty.'));
  }
  if ('blocked_by' in record && !isNonEmptyString(record.blocked_by)) errors.push(issue('error', 'TYPE', `${path}/blocked_by`, 'blocked_by must be a non-empty string.'));
  if ('stale_reason' in record && !isNonEmptyString(record.stale_reason)) errors.push(issue('error', 'TYPE', `${path}/stale_reason`, 'stale_reason must be a non-empty string.'));
  if (!WORK_STATUSES.has(record.status)) {
    errors.push(issue('error', 'ENUM', `${path}/status`, `Unsupported work status: ${String(record.status)}`));
  }
  validateEvidenceList(record.evidence, `${path}/evidence`, errors);
  if (record.status === 'VERIFIED') {
    if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
      errors.push(issue('error', 'VERIFIED_WITHOUT_EVIDENCE', `${path}/evidence`, 'VERIFIED status requires evidence.'));
    } else {
      const strong = record.evidence.some((entry) => {
        if (!isObject(entry) || !STRONG_EVIDENCE.has(entry.type)) return false;
        return entry.type !== 'TEST_RESULT' || entry.outcome === 'PASSED';
      });
      if (!strong) {
        errors.push(issue('error', 'VERIFIED_WITHOUT_STRONG_EVIDENCE', `${path}/evidence`, 'VERIFIED requires file digest, Git commit, passing test, or deployment evidence.'));
      }
    }
  }
  if (record.status === 'BLOCKED' && !isNonEmptyString(record.blocked_by)) {
    errors.push(issue('error', 'BLOCK_REASON_REQUIRED', `${path}/blocked_by`, 'BLOCKED status requires blocked_by.'));
  }
  if (record.status === 'STALE' && !isNonEmptyString(record.stale_reason)) {
    errors.push(issue('error', 'STALE_REASON_REQUIRED', `${path}/stale_reason`, 'STALE status requires stale_reason.'));
  }
}

function validateCore(document) {
  const errors = [];
  const warnings = [];
  if (!isObject(document)) {
    return { errors: [issue('error', 'TYPE', '', 'Handoff document must be a JSON object.')], warnings };
  }

  const required = [
    'schema_version', 'handoff_id', 'generated_at', 'source_completeness', 'project', 'snapshot',
    'source_precedence', 'objective', 'deliverables', 'work_items', 'decisions', 'constraints',
    'references', 'next_actions', 'bootstrap_prompt', 'privacy',
  ];
  pushRequired(errors, document, required);
  const allowedTopLevel = new Set(required);
  for (const key of Object.keys(document)) {
    if (!allowedTopLevel.has(key)) {
      errors.push(issue('error', 'ADDITIONAL_PROPERTY', `/${escapePointer(key)}`, `Unknown top-level field: ${key}`));
    }
  }
  if (document.schema_version !== SCHEMA_VERSION) {
    errors.push(issue('error', 'SCHEMA_VERSION', '/schema_version', `Expected schema_version ${SCHEMA_VERSION}.`));
  }
  if (!isNonEmptyString(document.handoff_id) || !/^[A-Za-z0-9._-]+$/.test(document.handoff_id ?? '')) {
    errors.push(issue('error', 'HANDOFF_ID', '/handoff_id', 'handoff_id must contain only letters, digits, dot, underscore, or hyphen.'));
  }
  if (typeof document.handoff_id === 'string' && document.handoff_id.length > 128) {
    errors.push(issue('error', 'HANDOFF_ID', '/handoff_id', 'handoff_id must be at most 128 characters.'));
  }
  if (!isDateTime(document.generated_at)) {
    errors.push(issue('error', 'DATE_TIME', '/generated_at', 'generated_at must be an ISO 8601 date-time with timezone.'));
  }
  if (!SOURCE_COMPLETENESS.has(document.source_completeness)) {
    errors.push(issue('error', 'SOURCE_COMPLETENESS', '/source_completeness', 'Invalid or missing source completeness declaration.'));
  }

  if (!isObject(document.project)) {
    errors.push(issue('error', 'TYPE', '/project', 'project must be an object.'));
  } else {
    pushRequired(errors, document.project, ['name', 'root'], '/project');
    rejectUnknown(errors, document.project, ['name', 'root', 'repository_url', 'description', 'recipient'], '/project');
    if (!isNonEmptyString(document.project.name)) errors.push(issue('error', 'TYPE', '/project/name', 'Project name must be non-empty.'));
    if (typeof document.project.name === 'string' && document.project.name.length > 200) errors.push(issue('error', 'TYPE', '/project/name', 'Project name must be at most 200 characters.'));
    if (!isNonEmptyString(document.project.root)) errors.push(issue('error', 'TYPE', '/project/root', 'Project root must be non-empty.'));
    if ('repository_url' in document.project && document.project.repository_url !== null && typeof document.project.repository_url !== 'string') errors.push(issue('error', 'TYPE', '/project/repository_url', 'repository_url must be a string or null.'));
    if ('description' in document.project && typeof document.project.description !== 'string') errors.push(issue('error', 'TYPE', '/project/description', 'description must be a string.'));
    if ('recipient' in document.project && document.project.recipient !== null && typeof document.project.recipient !== 'string') errors.push(issue('error', 'TYPE', '/project/recipient', 'recipient must be a string or null.'));
  }

  if (!isObject(document.snapshot)) {
    errors.push(issue('error', 'TYPE', '/snapshot', 'snapshot must be an object.'));
  } else {
    pushRequired(errors, document.snapshot, ['captured_at', 'digest_algorithm', 'files'], '/snapshot');
    rejectUnknown(errors, document.snapshot, ['captured_at', 'digest_algorithm', 'git', 'files', 'deleted_files', 'coverage_notes'], '/snapshot');
    if (!isDateTime(document.snapshot.captured_at)) errors.push(issue('error', 'DATE_TIME', '/snapshot/captured_at', 'captured_at must be an ISO 8601 date-time with timezone.'));
    if (document.snapshot.digest_algorithm !== 'sha256') errors.push(issue('error', 'DIGEST_ALGORITHM', '/snapshot/digest_algorithm', 'Only sha256 is supported.'));
    if ('coverage_notes' in document.snapshot && typeof document.snapshot.coverage_notes !== 'string') errors.push(issue('error', 'TYPE', '/snapshot/coverage_notes', 'coverage_notes must be a string.'));
    if (!Array.isArray(document.snapshot.files)) {
      errors.push(issue('error', 'TYPE', '/snapshot/files', 'snapshot.files must be an array.'));
    } else {
      document.snapshot.files.forEach((file, index) => {
        const path = `/snapshot/files/${index}`;
        if (!isObject(file)) {
          errors.push(issue('error', 'TYPE', path, 'Snapshot file must be an object.'));
          return;
        }
        pushRequired(errors, file, ['path', 'digest', 'size', 'modified_at'], path);
        rejectUnknown(errors, file, ['path', 'digest', 'size', 'modified_at'], path);
        if (!isNonEmptyString(file.path)) errors.push(issue('error', 'TYPE', `${path}/path`, 'File path must be non-empty.'));
        if (!SHA256_RE.test(file.digest ?? '')) errors.push(issue('error', 'DIGEST_FORMAT', `${path}/digest`, 'File digest must be SHA-256.'));
        if (!Number.isInteger(file.size) || file.size < 0) errors.push(issue('error', 'TYPE', `${path}/size`, 'File size must be a non-negative integer.'));
        if (!isDateTime(file.modified_at)) errors.push(issue('error', 'DATE_TIME', `${path}/modified_at`, 'modified_at must be an ISO 8601 date-time with timezone.'));
      });
    }
    if ('deleted_files' in document.snapshot) {
      if (!Array.isArray(document.snapshot.deleted_files) || document.snapshot.deleted_files.some((entry) => !isNonEmptyString(entry))) {
        errors.push(issue('error', 'TYPE', '/snapshot/deleted_files', 'deleted_files must be an array of non-empty paths.'));
      } else if (new Set(document.snapshot.deleted_files).size !== document.snapshot.deleted_files.length) {
        errors.push(issue('error', 'DUPLICATE_VALUE', '/snapshot/deleted_files', 'deleted_files entries must be unique.'));
      }
    }
    if (document.snapshot.git !== undefined && document.snapshot.git !== null) {
      const git = document.snapshot.git;
      if (!isObject(git)) errors.push(issue('error', 'TYPE', '/snapshot/git', 'git must be an object or null.'));
      else {
        pushRequired(errors, git, ['commit', 'branch', 'dirty'], '/snapshot/git');
        rejectUnknown(errors, git, ['commit', 'branch', 'dirty'], '/snapshot/git');
        if (!/^[a-f\d]{7,64}$/i.test(git.commit ?? '')) errors.push(issue('error', 'COMMIT_FORMAT', '/snapshot/git/commit', 'Git commit must be 7-64 hexadecimal digits.'));
        if (git.branch !== null && typeof git.branch !== 'string') errors.push(issue('error', 'TYPE', '/snapshot/git/branch', 'git.branch must be a string or null.'));
        if (typeof git.dirty !== 'boolean') errors.push(issue('error', 'TYPE', '/snapshot/git/dirty', 'git.dirty must be boolean.'));
      }
    }
  }

  if (!Array.isArray(document.source_precedence) || document.source_precedence.length === 0 || document.source_precedence.some((entry) => !isNonEmptyString(entry))) {
    errors.push(issue('error', 'SOURCE_PRECEDENCE', '/source_precedence', 'source_precedence must contain at least one non-empty source, strongest first.'));
  }
  if (Array.isArray(document.source_precedence) && new Set(document.source_precedence).size !== document.source_precedence.length) {
    errors.push(issue('error', 'SOURCE_PRECEDENCE', '/source_precedence', 'source_precedence entries must be unique.'));
  }
  if (!isNonEmptyString(document.objective)) errors.push(issue('error', 'TYPE', '/objective', 'objective must be non-empty.'));
  if (!isNonEmptyString(document.bootstrap_prompt)) errors.push(issue('error', 'TYPE', '/bootstrap_prompt', 'bootstrap_prompt must be non-empty.'));

  for (const [field, label] of [['deliverables', 'deliverable'], ['work_items', 'work item']]) {
    if (!Array.isArray(document[field])) {
      errors.push(issue('error', 'TYPE', `/${field}`, `${field} must be an array.`));
    } else {
      const ids = new Set();
      document[field].forEach((record, index) => {
        validateStatusRecord(record, `/${field}/${index}`, errors, { deliverable: field === 'deliverables' });
        if (isObject(record) && isNonEmptyString(record.id)) {
          if (ids.has(record.id)) errors.push(issue('error', 'DUPLICATE_ID', `/${field}/${index}/id`, `Duplicate ${label} id: ${record.id}`));
          ids.add(record.id);
        }
      });
    }
  }

  if (!Array.isArray(document.decisions)) {
    errors.push(issue('error', 'TYPE', '/decisions', 'decisions must be an array.'));
  } else {
    const ids = new Set();
    document.decisions.forEach((decision, index) => {
      const path = `/decisions/${index}`;
      if (!isObject(decision)) {
        errors.push(issue('error', 'TYPE', path, 'Decision must be an object.'));
        return;
      }
      pushRequired(errors, decision, ['id', 'status', 'summary', 'evidence'], path);
      rejectUnknown(errors, decision, ['id', 'status', 'summary', 'rationale', 'decided_at', 'superseded_by', 'evidence'], path);
      if (ids.has(decision.id)) errors.push(issue('error', 'DUPLICATE_ID', `${path}/id`, `Duplicate decision id: ${decision.id}`));
      if (isNonEmptyString(decision.id)) ids.add(decision.id);
      if (!isNonEmptyString(decision.id)) errors.push(issue('error', 'TYPE', `${path}/id`, 'Decision id must be non-empty.'));
      if (!DECISION_STATUSES.has(decision.status)) errors.push(issue('error', 'ENUM', `${path}/status`, `Unsupported decision status: ${String(decision.status)}`));
      if (!isNonEmptyString(decision.summary)) errors.push(issue('error', 'TYPE', `${path}/summary`, 'Decision summary must be non-empty.'));
      validateEvidenceList(decision.evidence, `${path}/evidence`, errors);
      if (!Array.isArray(decision.evidence) || decision.evidence.length === 0) errors.push(issue('error', 'DECISION_EVIDENCE_REQUIRED', `${path}/evidence`, 'Every decision requires provenance evidence.'));
      if ('rationale' in decision && typeof decision.rationale !== 'string') errors.push(issue('error', 'TYPE', `${path}/rationale`, 'Decision rationale must be a string.'));
      if ('decided_at' in decision && !isDateTime(decision.decided_at)) errors.push(issue('error', 'DATE_TIME', `${path}/decided_at`, 'decided_at must be an ISO 8601 date-time with timezone.'));
      if (decision.status === 'SUPERSEDED' && !isNonEmptyString(decision.superseded_by)) {
        errors.push(issue('error', 'SUPERSEDED_BY_REQUIRED', `${path}/superseded_by`, 'SUPERSEDED decision requires superseded_by.'));
      }
      if (decision.status === 'ACTIVE' && 'superseded_by' in decision) {
        errors.push(issue('error', 'ACTIVE_HAS_SUPERSESSION', `${path}/superseded_by`, 'ACTIVE decision cannot have superseded_by.'));
      }
    });
    const positions = new Map(document.decisions.filter(isObject).map((decision, index) => [decision.id, index]));
    document.decisions.forEach((decision, index) => {
      if (!isObject(decision) || decision.status !== 'SUPERSEDED' || !isNonEmptyString(decision.superseded_by)) return;
      if (!ids.has(decision.superseded_by)) {
        errors.push(issue('error', 'BROKEN_SUPERSESSION', `/decisions/${index}/superseded_by`, `No decision exists with id ${decision.superseded_by}.`));
      } else if (positions.get(decision.superseded_by) <= index) {
        errors.push(issue('error', 'SUPERSESSION_NOT_LATER', `/decisions/${index}/superseded_by`, 'A superseded decision must point to a later decision in the ordered decision list.'));
      }
    });
  }

  for (const field of ['constraints', 'references', 'next_actions']) {
    if (!Array.isArray(document[field])) errors.push(issue('error', 'TYPE', `/${field}`, `${field} must be an array.`));
  }
  if (Array.isArray(document.constraints)) {
    document.constraints.forEach((constraint, index) => {
      if (!isNonEmptyString(constraint)) errors.push(issue('error', 'TYPE', `/constraints/${index}`, 'Constraint must be a non-empty string.'));
    });
  }
  if (Array.isArray(document.references)) {
    document.references.forEach((reference, index) => {
      const path = `/references/${index}`;
      if (!isObject(reference)) {
        errors.push(issue('error', 'TYPE', path, 'Reference must be an object.'));
        return;
      }
      pushRequired(errors, reference, ['kind', 'value', 'status'], path);
      rejectUnknown(errors, reference, ['kind', 'value', 'status', 'digest', 'note'], path);
      if (!['FILE', 'URL', 'COMMIT', 'DOCUMENT'].includes(reference.kind)) errors.push(issue('error', 'ENUM', `${path}/kind`, 'Invalid reference kind.'));
      if (!['VERIFIED', 'UNVERIFIED', 'MISSING'].includes(reference.status)) errors.push(issue('error', 'ENUM', `${path}/status`, 'Invalid reference status.'));
      if (!isNonEmptyString(reference.value)) errors.push(issue('error', 'TYPE', `${path}/value`, 'Reference value must be non-empty.'));
      if ('digest' in reference && !SHA256_RE.test(reference.digest ?? '')) errors.push(issue('error', 'DIGEST_FORMAT', `${path}/digest`, 'Reference digest must be SHA-256.'));
      if ('note' in reference && typeof reference.note !== 'string') errors.push(issue('error', 'TYPE', `${path}/note`, 'Reference note must be a string.'));
    });
  }
  if (Array.isArray(document.next_actions)) {
    document.next_actions.forEach((action, index) => {
      const path = `/next_actions/${index}`;
      if (!isObject(action)) errors.push(issue('error', 'TYPE', path, 'Next action must be an object.'));
      else {
        pushRequired(errors, action, ['title'], path);
        rejectUnknown(errors, action, ['title', 'details', 'owner'], path);
        if (!isNonEmptyString(action.title)) errors.push(issue('error', 'TYPE', `${path}/title`, 'Next action title must be non-empty.'));
        if ('details' in action && typeof action.details !== 'string') errors.push(issue('error', 'TYPE', `${path}/details`, 'Next action details must be a string.'));
        if ('owner' in action && action.owner !== null && typeof action.owner !== 'string') errors.push(issue('error', 'TYPE', `${path}/owner`, 'Next action owner must be a string or null.'));
      }
    });
  }

  if (!isObject(document.privacy)) {
    errors.push(issue('error', 'TYPE', '/privacy', 'privacy must be an object.'));
  } else {
    pushRequired(errors, document.privacy, ['scan_status', 'redactions_applied', 'findings'], '/privacy');
    rejectUnknown(errors, document.privacy, ['scan_status', 'scanned_at', 'redactions_applied', 'findings'], '/privacy');
    if (!['NOT_RUN', 'PASSED', 'FINDINGS', 'REDACTED'].includes(document.privacy.scan_status)) errors.push(issue('error', 'ENUM', '/privacy/scan_status', 'Invalid privacy scan status.'));
    if (typeof document.privacy.redactions_applied !== 'boolean') errors.push(issue('error', 'TYPE', '/privacy/redactions_applied', 'redactions_applied must be boolean.'));
    if (!Array.isArray(document.privacy.findings)) errors.push(issue('error', 'TYPE', '/privacy/findings', 'privacy.findings must be an array.'));
    else document.privacy.findings.forEach((finding, index) => {
      const path = `/privacy/findings/${index}`;
      if (!isObject(finding)) {
        errors.push(issue('error', 'TYPE', path, 'Privacy finding must be an object.'));
        return;
      }
      pushRequired(errors, finding, ['kind', 'path'], path);
      rejectUnknown(errors, finding, ['kind', 'path', 'redacted', 'note'], path);
      if (!['SECRET', 'EMAIL', 'PHONE', 'NATIONAL_ID', 'PRIVATE_KEY', 'OTHER_PII'].includes(finding.kind)) errors.push(issue('error', 'ENUM', `${path}/kind`, 'Invalid privacy finding kind.'));
      if (!isNonEmptyString(finding.path)) errors.push(issue('error', 'TYPE', `${path}/path`, 'Privacy finding path must be non-empty.'));
      if ('redacted' in finding && typeof finding.redacted !== 'boolean') errors.push(issue('error', 'TYPE', `${path}/redacted`, 'Privacy finding redacted must be boolean.'));
      if ('note' in finding && typeof finding.note !== 'string') errors.push(issue('error', 'TYPE', `${path}/note`, 'Privacy finding note must be a string.'));
    });
    if (['PASSED', 'FINDINGS', 'REDACTED'].includes(document.privacy.scan_status) && !isDateTime(document.privacy.scanned_at)) {
      errors.push(issue('error', 'DATE_TIME', '/privacy/scanned_at', 'A completed privacy scan requires scanned_at.'));
    }
    if (document.privacy.scan_status === 'FINDINGS' && (!Array.isArray(document.privacy.findings) || document.privacy.findings.length === 0)) {
      errors.push(issue('error', 'PRIVACY_FINDINGS_REQUIRED', '/privacy/findings', 'FINDINGS status requires at least one finding.'));
    }
    if (document.privacy.scan_status === 'REDACTED' && document.privacy.redactions_applied !== true) {
      errors.push(issue('error', 'REDACTION_STATE', '/privacy/redactions_applied', 'REDACTED status requires redactions_applied=true.'));
    }
    if (document.privacy.scan_status === 'NOT_RUN') {
      warnings.push(issue('warning', 'PRIVACY_SCAN_DECLARED_NOT_RUN', '/privacy/scan_status', 'The handoff declares that its own privacy scan was not run.'));
    }
  }
  return { errors, warnings };
}

export function scanSensitiveData(value) {
  const findings = [];
  const seen = new Set();
  function visit(current, path) {
    if (typeof current === 'string') {
      for (const pattern of SENSITIVE_PATTERNS) {
        pattern.regex.lastIndex = 0;
        for (const match of current.matchAll(pattern.regex)) {
          const fingerprint = createHash('sha256').update(match[0]).digest('hex').slice(0, 12);
          const key = `${pattern.kind}|${path}|${fingerprint}`;
          if (!seen.has(key)) {
            seen.add(key);
            findings.push({ kind: pattern.kind, path, label: pattern.label, fingerprint });
          }
        }
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}/${index}`));
      return;
    }
    if (isObject(current)) {
      for (const [key, entry] of Object.entries(current)) {
        if (['digest', 'commit'].includes(key)) continue;
        visit(entry, `${path}/${escapePointer(key)}`);
      }
    }
  }
  visit(value, '');
  return findings;
}

async function fileDigest(path) {
  const buffer = await readFile(path);
  return createHash('sha256').update(buffer).digest('hex');
}

async function gitValue(root, args) {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function checkGitSnapshot(recorded, root, errors) {
  if (!isObject(recorded)) return;
  const actualCommit = await gitValue(root, ['rev-parse', 'HEAD']);
  if (!actualCommit) {
    errors.push(issue('error', 'GIT_REPOSITORY_MISSING', '/snapshot/git', 'The project root is not a readable Git worktree.'));
    return;
  }
  const actualBranch = await gitValue(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const status = await gitValue(root, ['status', '--porcelain=v1']);
  const actualDirty = typeof status === 'string' && status.length > 0;
  if (actualCommit.toLowerCase() !== String(recorded.commit).toLowerCase()) {
    errors.push(issue('error', 'GIT_COMMIT_MISMATCH', '/snapshot/git/commit', 'Current Git commit differs from the handoff snapshot.', { expected: recorded.commit, actual: actualCommit }));
  }
  const normalizedActualBranch = actualBranch || null;
  if (normalizedActualBranch !== recorded.branch) {
    errors.push(issue('error', 'GIT_BRANCH_MISMATCH', '/snapshot/git/branch', 'Current Git branch differs from the handoff snapshot.', { expected: recorded.branch, actual: normalizedActualBranch }));
  }
  if (actualDirty !== recorded.dirty) {
    errors.push(issue('error', 'GIT_DIRTY_MISMATCH', '/snapshot/git/dirty', 'Current working-tree dirty state differs from the handoff snapshot.', { expected: recorded.dirty, actual: actualDirty }));
  }
}

function safePath(root, candidate) {
  const absolute = resolve(root, candidate);
  const rel = relative(resolve(root), absolute);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) return null;
  return absolute;
}

async function checkFileRecord(record, jsonPath, root, errors, warnings) {
  const target = safePath(root, record.path ?? record.ref ?? record.value);
  if (!target) {
    errors.push(issue('error', 'PATH_ESCAPE', jsonPath, 'Referenced path escapes the project root.'));
    return;
  }
  let info;
  let canonicalTarget;
  try {
    const canonicalRoot = await realpath(resolve(root));
    canonicalTarget = await realpath(target);
    if (!safePath(canonicalRoot, canonicalTarget)) {
      errors.push(issue('error', 'PATH_ESCAPE', jsonPath, 'Referenced path resolves outside the project root.'));
      return;
    }
    info = await stat(canonicalTarget);
  } catch (error) {
    errors.push(issue('error', 'FILE_MISSING', jsonPath, `Referenced file does not exist: ${record.path ?? record.ref ?? record.value}`, { code: error.code }));
    return;
  }
  if (!info.isFile()) {
    errors.push(issue('error', 'NOT_A_FILE', jsonPath, 'Referenced path is not a file.'));
    return;
  }
  const expectedDigest = record.digest;
  if (!SHA256_RE.test(expectedDigest ?? '')) {
    errors.push(issue('error', 'DIGEST_REQUIRED', `${jsonPath}/digest`, 'Digest checking requires a SHA-256 digest.'));
  } else {
    const actual = await fileDigest(canonicalTarget);
    if (actual !== normalizeDigest(expectedDigest)) {
      errors.push(issue('error', 'DIGEST_MISMATCH', `${jsonPath}/digest`, 'File contents changed after the handoff snapshot.', { expected: normalizeDigest(expectedDigest), actual }));
    }
  }
  if (Number.isInteger(record.size) && info.size !== record.size) {
    errors.push(issue('error', 'SIZE_MISMATCH', `${jsonPath}/size`, 'File size differs from the snapshot.', { expected: record.size, actual: info.size }));
  }
  if (isDateTime(record.modified_at) && info.mtimeMs > Date.parse(record.modified_at) + 1500) {
    warnings.push(issue('warning', 'FILE_NEWER_THAN_SNAPSHOT', `${jsonPath}/modified_at`, 'File modification time is newer than the snapshot.', { snapshot: record.modified_at, actual: info.mtime.toISOString() }));
  }
}

async function checkDeletedFile(candidate, jsonPath, root, errors) {
  const target = safePath(root, candidate);
  if (!target) {
    errors.push(issue('error', 'PATH_ESCAPE', jsonPath, 'Deleted-file path escapes the project root.'));
    return;
  }
  try {
    const canonicalRoot = await realpath(resolve(root));
    const canonicalTarget = await realpath(target);
    if (!safePath(canonicalRoot, canonicalTarget)) {
      errors.push(issue('error', 'PATH_ESCAPE', jsonPath, 'Deleted-file path resolves outside the project root.'));
      return;
    }
    errors.push(issue('error', 'DELETED_FILE_RESTORED', jsonPath, 'A file recorded as deleted now exists and the handoff is stale.'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      errors.push(issue('error', 'FILE_CHECK_FAILED', jsonPath, 'Could not verify that the deleted file remains absent.', { code: error.code }));
    }
  }
}

export async function validateHandoff(document, options = {}) {
  const {
    projectRoot,
    checkDigests = false,
    scanSensitive = true,
    maxAgeHours,
    now = new Date(),
  } = options;
  const { errors, warnings } = validateCore(document);
  const checks = {
    schema: 'completed',
    digest: checkDigests ? 'completed' : 'not_requested',
    freshness: Number.isFinite(maxAgeHours) ? 'completed' : 'not_requested',
    sensitive_data: scanSensitive ? 'completed' : 'not_requested',
  };

  if (Number.isFinite(maxAgeHours) && isDateTime(document?.generated_at)) {
    const ageMs = now.getTime() - Date.parse(document.generated_at);
    if (ageMs < -5 * 60 * 1000) {
      errors.push(issue('error', 'FUTURE_HANDOFF', '/generated_at', 'generated_at is more than five minutes in the future.'));
    } else if (ageMs > maxAgeHours * 60 * 60 * 1000) {
      errors.push(issue('error', 'STALE_HANDOFF', '/generated_at', `Handoff is older than ${maxAgeHours} hours.`, { age_hours: ageMs / 3_600_000 }));
    }
  }
  if (isDateTime(document?.generated_at) && isDateTime(document?.snapshot?.captured_at)) {
    if (Date.parse(document.snapshot.captured_at) > Date.parse(document.generated_at) + 5 * 60 * 1000) {
      errors.push(issue('error', 'SNAPSHOT_AFTER_HANDOFF', '/snapshot/captured_at', 'Snapshot cannot be captured after handoff generation.'));
    }
  }

  if (checkDigests) {
    if (!isNonEmptyString(projectRoot)) {
      errors.push(issue('error', 'PROJECT_ROOT_REQUIRED', '', '--check-digests requires --project-root.'));
    } else {
      if (isObject(document?.snapshot?.git)) {
        await checkGitSnapshot(document.snapshot.git, projectRoot, errors);
      }
      for (const [index, candidate] of (Array.isArray(document?.snapshot?.deleted_files) ? document.snapshot.deleted_files : []).entries()) {
        if (isNonEmptyString(candidate)) await checkDeletedFile(candidate, `/snapshot/deleted_files/${index}`, projectRoot, errors);
      }
      for (const [index, file] of (Array.isArray(document?.snapshot?.files) ? document.snapshot.files : []).entries()) {
        if (isObject(file)) await checkFileRecord(file, `/snapshot/files/${index}`, projectRoot, errors, warnings);
      }
      for (const [section, records] of [['deliverables', document?.deliverables], ['work_items', document?.work_items], ['decisions', document?.decisions]]) {
        for (const [recordIndex, record] of (Array.isArray(records) ? records : []).entries()) {
          for (const [evidenceIndex, evidence] of (Array.isArray(record?.evidence) ? record.evidence : []).entries()) {
            if (evidence?.type === 'FILE_DIGEST') {
              await checkFileRecord(evidence, `/${section}/${recordIndex}/evidence/${evidenceIndex}`, projectRoot, errors, warnings);
            }
          }
        }
      }
      for (const [index, reference] of (Array.isArray(document?.references) ? document.references : []).entries()) {
        if (reference?.kind === 'FILE' && reference?.status === 'VERIFIED') {
          await checkFileRecord({ path: reference.value, digest: reference.digest }, `/references/${index}`, projectRoot, errors, warnings);
        }
      }
    }
  }

  const findings = scanSensitive ? scanSensitiveData(document) : [];
  if (findings.length > 0) {
    errors.push(issue('error', 'SENSITIVE_DATA_FOUND', '', `Found ${findings.length} possible secret or PII value(s).`, findings));
    if (document?.privacy?.scan_status === 'PASSED') {
      errors.push(issue('error', 'PRIVACY_SCAN_CONTRADICTION', '/privacy/scan_status', 'privacy.scan_status is PASSED but the validator found sensitive data.'));
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    findings,
    checks,
    summary: { errors: errors.length, warnings: warnings.length, findings: findings.length },
  };
}

function usage() {
  return `Context Relay handoff validator

Usage:
  node validate-handoff.mjs <handoff.json> [options]

Options:
  --project-root <path>   Root used to resolve snapshot paths
  --check-digests        Verify referenced files and SHA-256 digests
  --max-age-hours <n>    Fail when the handoff is older than n hours
  --no-sensitive-scan    Disable secret and PII scanning
  --strict               Treat warnings as a validation failure
  --json                 Emit machine-readable JSON
  -h, --help             Show this help

Exit codes:
  0  valid
  1  validation failed (or warning in --strict mode)
  2  bad arguments or malformed JSON
  3  file-system or unexpected I/O error`;
}

function parseArgs(argv) {
  const options = { checkDigests: false, scanSensitive: true, strict: false, json: false };
  let input;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true, options };
    if (arg === '--check-digests') options.checkDigests = true;
    else if (arg === '--no-sensitive-scan') options.scanSensitive = false;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--project-root') {
      if (++i >= argv.length) throw new Error('--project-root requires a path.');
      options.projectRoot = argv[i];
    } else if (arg === '--max-age-hours') {
      if (++i >= argv.length) throw new Error('--max-age-hours requires a positive number.');
      options.maxAgeHours = Number(argv[i]);
      if (!Number.isFinite(options.maxAgeHours) || options.maxAgeHours <= 0) throw new Error('--max-age-hours must be a positive number.');
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (input) throw new Error('Only one handoff JSON file may be provided.');
    else input = arg;
  }
  if (!input) throw new Error('A handoff JSON file is required.');
  return { input, options };
}

function textReport(result) {
  const lines = [result.valid ? 'VALID: handoff passed validation.' : 'INVALID: handoff failed validation.'];
  for (const entry of [...result.errors, ...result.warnings]) {
    lines.push(`[${entry.level.toUpperCase()}] ${entry.code} ${entry.path || '/'}: ${entry.message}`);
  }
  lines.push(`Checks: schema=${result.checks.schema}, digest=${result.checks.digest}, freshness=${result.checks.freshness}, sensitive_data=${result.checks.sensitive_data}`);
  lines.push(`Summary: ${result.summary.errors} error(s), ${result.summary.warnings} warning(s), ${result.summary.findings} sensitive finding(s).`);
  return lines.join('\n');
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const stderr = io.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    stderr(`Argument error: ${error.message}\n\n${usage()}`);
    return EXIT_CODES.USAGE_OR_JSON;
  }
  if (parsed.help) {
    stdout(usage());
    return EXIT_CODES.OK;
  }

  let raw;
  try {
    raw = await readFile(parsed.input, 'utf8');
  } catch (error) {
    stderr(`I/O error: ${error.message}`);
    return EXIT_CODES.IO_ERROR;
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    stderr(`JSON parse error: ${error.message}`);
    return EXIT_CODES.USAGE_OR_JSON;
  }

  try {
    const result = await validateHandoff(document, parsed.options);
    stdout(parsed.options.json ? JSON.stringify(result, null, 2) : textReport(result));
    if (!result.valid || (parsed.options.strict && result.warnings.length > 0)) return EXIT_CODES.INVALID;
    return EXIT_CODES.OK;
  } catch (error) {
    stderr(`I/O or validation runtime error: ${error.stack ?? error.message}`);
    return EXIT_CODES.IO_ERROR;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
