// services/assistantService.js
//
// Conversational assistant: question -> signed read plan -> bounded
// server-owned investigation -> evidence-grounded answer and at most one typed
// task-action proposal. The browser never supplies accumulated evidence or
// follow-up plans; proposals change nothing until the signed-in user confirms.

'use strict';

const crypto = require('crypto');
const aiService = require('./aiService');
const reportService = require('./reportService');
const commsSearch = require('./commsArchiveSearch');
const knowledge = require('./assistantKnowledgeService');
const weather = require('./assistantWeatherService');
const attachmentService = require('./assistantAttachmentService');
const taskService = require('./taskService');
const eventService = require('./eventService');
const calendarTypeService = require('./calendarTypeService');
const contactPhoneService = require('./contactPhoneService');
const contactEmailService = require('./contactEmailService');
const contactAddressService = require('./contactAddressService');
const { FIRM_TZ, nowLocal, parseUserDateTime } = require('./timezoneService');
const { auditAdminAction } = require('../lib/auth.superuser');
const { validateSql } = require('../lib/reportSchema/validator');
const ticket = require('../lib/assistantTicket');

const MAX_QUESTION = 2000;
const MAX_HISTORY = 8;
const MAX_HISTORY_TEXT = 2000;
const MAX_STEPS = 5;
const MAX_SQL = 6000;
const MAX_ROWS = 50;
const MODEL_CELL_CHARS = 3000;
const SOURCE_CELL_CHARS = 600;
const MAX_EVIDENCE_CHARS = 60000;
const PLAN_TIMEOUT_MS = 60000;
const ANSWER_TIMEOUT_MS = 60000;
const INVESTIGATE_TIMEOUT_MS = 45000;
const INVESTIGATE_ATTEMPT_MAX_TOKENS = 1750;
const MAX_INVESTIGATION_ROUNDS = 3;
const MAX_INVESTIGATION_STEPS = 8;
const MAX_INVESTIGATION_ROWS = 250;
const MAX_INVESTIGATION_MS = 180000;
const MAX_INVESTIGATION_OUTPUT_TOKENS = 7000;
const MAX_SUGGESTIONS = 3;
const MAX_WORKSPACE_FILES = 20;
const WORKSPACE_TABS = new Set([
  'tabHome', 'tabCases', 'tabContacts', 'tabAppts', 'tabCalendar', 'tabEvents',
  'tabTasks', 'tabComms', 'tabLogs', 'tabBills', 'tabPipeline', 'tabMore',
  'tabSettings', 'tabAdmin', 'tabAll',
]);
const ASSISTANT_DESTINATIONS = Object.freeze({
  'automations.court_review': 'Open Court Review',
});
const TASK_CREATE_KEYS = new Set([
  'kind', 'title', 'description', 'assignee_user_id', 'link', 'start_date',
  'due_date', 'notify_assigner_on_completion', 'evidence',
]);
const TASK_TARGET_KEYS = new Set(['kind', 'task_id', 'evidence']);
const TASK_NOTE_KEYS = new Set(['kind', 'task_id', 'note', 'evidence']);
const TASK_TRANSFER_KEYS = new Set(['kind', 'task_id', 'assignee_user_id', 'evidence']);
const TASK_UPDATE_KEYS = new Set(['kind', 'task_id', 'changes', 'evidence']);
const TASK_UPDATE_CHANGE_KEYS = new Set([
  'title', 'description', 'start_date', 'due_date',
  'notify_assigner_on_completion', 'link',
]);
const TASK_ACTION_KINDS = new Set([
  'task.create.v1', 'task.update.v1', 'task.complete.v1', 'task.cancel.v1',
  'task.reopen.v1', 'task.transfer.v1',
]);
const EVENT_ACTION_KINDS = new Set([
  'event.create.v1', 'event.update.v1', 'event.complete.v1', 'event.cancel.v1',
]);
const APPT_ACTION_KINDS = new Set([
  'appt.create.v1', 'appt.update.v1', 'appt.attended.v1', 'appt.no_show.v1',
  'appt.cancel.v1', 'appt.reschedule.v1', 'appt.reschedule_later.v1',
]);
const APPT_CREATE_KEYS = new Set([
  'kind', 'contact_id', 'case_id', 'appt_type', 'appt_length', 'appt_platform',
  'appt_date', 'appt_with', 'note', 'confirm_sms', 'confirm_email',
  'confirm_message', 'evidence',
]);
const APPT_UPDATE_KEYS = new Set(['kind', 'appt_id', 'changes', 'evidence']);
const APPT_UPDATE_CHANGE_KEYS = new Set(['note', 'case_id']);
const APPT_NOTE_KEYS = new Set(['kind', 'appt_id', 'note', 'evidence']);
const APPT_NO_SHOW_KEYS = new Set(['kind', 'appt_id', 'note', 'enroll', 'evidence']);
const APPT_CANCEL_KEYS = new Set([
  'kind', 'appt_id', 'note', 'sms', 'email', 'confirm_message', 'cancel_gcal',
  'create_task', 'evidence',
]);
const APPT_RESCHEDULE_KEYS = new Set([
  'kind', 'appt_id', 'new_date', 'note', 'sms', 'email', 'confirm_message', 'evidence',
]);
const APPT_RESCHEDULE_LATER_KEYS = new Set(['kind', 'appt_id', 'note', 'create_task', 'evidence']);
const CONTACT_SUBRECORD_ACTION_KINDS = new Set([
  'contact.phone.create.v1', 'contact.phone.update.v1', 'contact.phone.end.v1',
  'contact.email.create.v1', 'contact.email.update.v1', 'contact.email.end.v1',
  'contact.address.create.v1', 'contact.address.update.v1', 'contact.address.end.v1',
]);
const CONTACT_PHONE_CREATE_KEYS = new Set(['kind', 'contact_id', 'phone', 'label', 'is_primary', 'sms_optout', 'mms_capable', 'start_date', 'notes', 'evidence']);
const CONTACT_EMAIL_CREATE_KEYS = new Set(['kind', 'contact_id', 'email', 'label', 'is_primary', 'email_optout', 'start_date', 'notes', 'evidence']);
const CONTACT_ADDRESS_CREATE_KEYS = new Set(['kind', 'contact_id', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'label', 'is_primary', 'start_date', 'notes', 'evidence']);
const CONTACT_PHONE_UPDATE_ACTION_KEYS = new Set(['kind', 'contact_id', 'phone_id', 'changes', 'evidence']);
const CONTACT_EMAIL_UPDATE_ACTION_KEYS = new Set(['kind', 'contact_id', 'email_id', 'changes', 'evidence']);
const CONTACT_ADDRESS_UPDATE_ACTION_KEYS = new Set(['kind', 'contact_id', 'address_id', 'changes', 'evidence']);
const CONTACT_PHONE_END_KEYS = new Set(['kind', 'contact_id', 'phone_id', 'end_date', 'end_reason', 'evidence']);
const CONTACT_EMAIL_END_KEYS = new Set(['kind', 'contact_id', 'email_id', 'end_date', 'end_reason', 'evidence']);
const CONTACT_ADDRESS_END_KEYS = new Set(['kind', 'contact_id', 'address_id', 'end_date', 'end_reason', 'evidence']);
const CONTACT_PHONE_UPDATE_KEYS = new Set(['label', 'is_primary', 'sms_optout', 'mms_capable', 'notes']);
const CONTACT_EMAIL_UPDATE_KEYS = new Set(['label', 'is_primary', 'email_optout', 'notes']);
const CONTACT_ADDRESS_UPDATE_KEYS = new Set(['address1', 'address2', 'city', 'state', 'zip', 'country', 'label', 'is_primary', 'notes']);
const EVENT_CREATE_KEYS = new Set([
  'kind', 'event_type', 'event_title', 'event_date', 'event_time', 'event_all_day',
  'event_length', 'event_location', 'event_link', 'event_note', 'link', 'event_with',
  'reminder', 'evidence',
]);
const EVENT_UPDATE_KEYS = new Set(['kind', 'event_id', 'changes', 'evidence']);
const EVENT_TRANSITION_KEYS = new Set(['kind', 'event_id', 'resolution', 'delete_gcal', 'evidence']);
const EVENT_UPDATE_CHANGE_KEYS = new Set([
  'event_type', 'event_title', 'event_date', 'event_time', 'event_all_day',
  'event_length', 'event_location', 'event_link', 'event_note', 'event_with', 'reminder',
]);
const TASK_DRAFT_LINKS = Object.freeze({
  contact: {
    id: 'contact_id',
    sql: 'SELECT contact_id, contact_name AS label FROM contacts WHERE contact_id = ? LIMIT 1',
  },
  case: {
    id: 'case_id',
    sql: 'SELECT case_id, case_number_full AS label FROM cases WHERE case_id = ? LIMIT 1',
  },
  appt: {
    id: 'appt_id',
    sql: 'SELECT appt_id, appt_type AS label FROM appts WHERE appt_id = ? LIMIT 1',
  },
  event: {
    id: 'event_id',
    sql: 'SELECT event_id, event_title AS label FROM events WHERE event_id = ? LIMIT 1',
  },
});

// Reports deliberately allow DOB/SSN for explicit staff reports. An open-ended
// conversational assistant is a different surface: those values are never
// necessary to identify the story of a person or matter, so this layer is
// narrower than the shared report validator.
const ASSISTANT_DENIED = [
  'contact_ssn', 'contact_dob', 'password', 'password_hash', 'reset_token',
  'contact_token', 'appt_manage_token', 'task_action_token', 'draft_key',
  'attachments', 'delivery_info',
];

function httpError(status, message, detail) {
  const e = new Error(message);
  e.status = status;
  if (detail) e.detail = detail;
  return e;
}

function cleanHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_HISTORY).map((m) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    text: String(m && m.text != null ? m.text : '').trim().slice(0, MAX_HISTORY_TEXT),
  })).filter((m) => m.text);
}

function historyText(history) {
  if (!history.length) return '(none)';
  return history.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join('\n');
}

function normalizeViewer(value, userId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid < 0) throw httpError(403, 'The assistant requires a valid signed-in staff user');
  const source = value && Number(value.user_id) === uid ? value : {};
  const roles = Array.isArray(source.roles)
    ? source.roles
    : String(source.roles || '').split(',');
  return {
    user_id: uid,
    display_name: String(source.display_name || '').trim().slice(0, 100),
    initials: String(source.initials || '').trim().slice(0, 10),
    roles: roles.map((role) => String(role).trim()).filter(Boolean).slice(0, 10),
  };
}

async function loadViewer(db, userId) {
  const viewer = normalizeViewer(null, userId);
  if (!db || typeof db.query !== 'function') throw httpError(500, 'The assistant could not resolve the signed-in staff user');
  const [rows] = await db.query(
    'SELECT user, user_name, user_initials, roles FROM users WHERE user = ? LIMIT 1',
    [viewer.user_id]
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || Number(row.user) !== viewer.user_id) {
    throw httpError(403, 'The signed-in staff user no longer exists');
  }
  return normalizeViewer({
    user_id: row.user,
    display_name: row.user_name,
    initials: row.user_initials,
    roles: row.roles,
  }, viewer.user_id);
}

function currentContext(viewer, workspace) {
  return `CURRENT TIME:\n${new Date().toISOString()} (server UTC)\n` +
    `${nowLocal().toISO()} (firm-local time; ${FIRM_TZ})\n` +
    `The signed-in user's browser timezone is not authoritative for firm appointments.\n\n` +
    `<current_staff server_verified="true">\n${JSON.stringify(viewer)}\n</current_staff>` +
    (workspace ? `\n\n<workspace_context server_verified="true" immutable_for_request="true">\n${JSON.stringify(workspace)}\n</workspace_context>` : '');
}

function workspaceRest(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length > 128) throw httpError(400, 'Workspace context has an invalid sub-view');
  const parts = text.split('~');
  if (parts.length > 4 || parts.some((part) => !/^[A-Za-z0-9_-]{1,32}$/.test(part))) {
    throw httpError(400, 'Workspace context has an invalid sub-view');
  }
  return parts.join('~');
}

function parseWorkspaceFile(spec) {
  const parts = String(spec || '').split('~');
  const head = parts.shift() || '';
  const match = /^([cpb])([A-Za-z0-9_-]{1,64})$/.exec(head);
  if (!match) throw httpError(400, 'Workspace context has an invalid file reference');
  const kinds = { c: 'case', p: 'contact', b: 'bill' };
  const rest = workspaceRest(parts.join('~'));
  if (match[1] === 'p') {
    const id = Number(match[2]);
    if (!/^\d+$/.test(match[2]) || !Number.isSafeInteger(id) || id < 0) throw httpError(400, 'Workspace context has an invalid contact reference');
  }
  return { kind: kinds[match[1]], id: match[2], rest };
}

function normalizeWorkspaceContext(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Number(raw.v) !== 1 || typeof raw.canonical_url !== 'string') {
    throw httpError(400, 'Workspace context is malformed');
  }
  if (!raw.canonical_url.startsWith('/') || raw.canonical_url.length > 4000) throw httpError(400, 'Workspace context has an invalid URL');
  let url;
  try { url = new URL(raw.canonical_url, 'https://workspace.invalid'); }
  catch (_) { throw httpError(400, 'Workspace context has an invalid URL'); }
  if (!['/', '/index.html'].includes(url.pathname) || url.hash) throw httpError(400, 'Workspace context has an invalid URL');
  for (const key of url.searchParams.keys()) if (!['files', 'open'].includes(key)) throw httpError(400, 'Workspace context contains an unsupported URL parameter');
  if (url.searchParams.getAll('files').length > 1 || url.searchParams.getAll('open').length > 1) throw httpError(400, 'Workspace context repeats a URL parameter');
  const rawSpecs = (url.searchParams.get('files') || '').split(',').filter(Boolean);
  if (rawSpecs.length > MAX_WORKSPACE_FILES) throw httpError(400, 'Workspace context has too many open files');
  const files = rawSpecs.map(parseWorkspaceFile);
  const open = url.searchParams.get('open') || 'tabHome';
  const fileOpen = /^file:(\d+)$/.exec(open);
  let active;
  if (fileOpen) {
    const index = Number(fileOpen[1]);
    if (!Number.isSafeInteger(index) || !files[index]) throw httpError(400, 'Workspace context points to a missing open file');
    active = { kind: 'file', index, entity: files[index] };
  } else {
    const parts = open.split('~');
    const tab = parts.shift() || 'tabHome';
    if (!WORKSPACE_TABS.has(tab)) throw httpError(400, 'Workspace context names an unavailable workspace tab');
    active = { kind: 'workspace', tab, rest: workspaceRest(parts.join('~')) };
  }
  const normalized = { v: 1, canonical_url: url.pathname + url.search, files, active };
  if (JSON.stringify(raw.files) !== JSON.stringify(files) || JSON.stringify(raw.active) !== JSON.stringify(active)) {
    throw httpError(400, 'Workspace context does not match its canonical URL');
  }
  return normalized;
}

async function validateWorkspaceContext(db, raw) {
  const workspace = normalizeWorkspaceContext(raw);
  if (!workspace) return null;
  const cases = [...new Set(workspace.files.filter((file) => file.kind === 'case').map((file) => file.id))];
  const contacts = [...new Set(workspace.files.filter((file) => file.kind === 'contact').map((file) => Number(file.id)))];
  if (cases.length) {
    const [rows] = await db.query(`SELECT case_id FROM cases WHERE case_id IN (${cases.map(() => '?').join(',')})`, cases);
    const found = new Set((rows || []).map((row) => String(row.case_id).toLowerCase()));
    if (cases.some((id) => !found.has(String(id).toLowerCase()))) throw httpError(403, 'Workspace context includes a case that is unavailable');
  }
  if (contacts.length) {
    const [rows] = await db.query(`SELECT contact_id FROM contacts WHERE contact_id IN (${contacts.map(() => '?').join(',')})`, contacts);
    const found = new Set((rows || []).map((row) => Number(row.contact_id)));
    if (contacts.some((id) => !found.has(id))) throw httpError(403, 'Workspace context includes a contact that is unavailable');
  }
  return workspace;
}

function normalizeDestinations(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const id = String(item && item.id || '');
    if (!ASSISTANT_DESTINATIONS[id] || out.some((entry) => entry.id === id)) continue;
    out.push({ id, mode: 'take', label: String(item.label || ASSISTANT_DESTINATIONS[id]).trim().slice(0, 120) || ASSISTANT_DESTINATIONS[id] });
  }
  return out.slice(0, 2);
}

function normalizeSuggestions(value) {
  const values = Array.isArray(value) ? [...value] : value == null ? [] : [value];
  const out = [];
  for (const item of values) {
    let query = '', label = '';
    if (item && typeof item === 'object') {
      query = String(item.query || '').trim();
      label = String(item.label || query).trim();
    } else {
      const text = String(item || '').trim();
      const quoted = [...text.matchAll(/[\u2018\u2019\u201c\u201d'\"]([^\u2018\u2019\u201c\u201d'\"]{3,300}\?)[\u2018\u2019\u201c\u201d'\"]/g)];
      if (quoted.length) {
        for (const match of quoted) values.push({ query: match[1], label: match[1] });
        continue;
      }
      query = text;
      label = text;
    }
    if (!query || query.length > 500) continue;
    out.push({ query, label: (label || query).slice(0, 300) });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

function onlyKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function taskDraftDate(value, field) {
  if (value == null || value === '') return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError(422, `Task draft ${field} must be an ISO date`);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw httpError(422, `Task draft ${field} is not a real date`);
  }
  return text;
}

function taskDraftText(value, field, max, { required = false } = {}) {
  const text = String(value == null ? '' : value).trim();
  if (required && !text) throw httpError(422, `Task draft ${field} is required`);
  if (text.length > max) throw httpError(422, `Task draft ${field} exceeds ${max} characters`);
  return text;
}

function taskDraftEvidence(value, evidence) {
  if (!Array.isArray(value) || !value.length || value.length > 8) {
    throw httpError(422, 'A task draft needs 1-8 evidence references');
  }
  return value.map((ref) => {
    if (!onlyKeys(ref, new Set(['query_id', 'row_number']))) throw httpError(422, 'Task draft evidence is malformed');
    const source = sourceFor(evidence, ref);
    if (!source) throw httpError(422, 'Task draft evidence is outside this investigation');
    return { query_id: source.query_id, row_number: source.row_number, label: source.label };
  });
}

function taskIdFromDraft(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw httpError(422, 'Task action task id is invalid');
  return id;
}

function evidenceSupportsTask(evidenceRefs, evidence, taskId) {
  return evidenceRefs.some((ref) => {
    const query = evidence.find((item) => item && item.id === ref.query_id);
    const row = query && Array.isArray(query.rows) ? query.rows[ref.row_number - 1] : null;
    return row && Number(row.task_id) === taskId;
  });
}

function taskActionTarget(task) {
  return {
    task_id: Number(task.id),
    title: taskDraftText(task.title, 'task title', 100) || `Task ${task.id}`,
    status: String(task.status || ''),
    assignee: task.to && task.to.id != null
      ? { user_id: Number(task.to.id), label: taskDraftText(task.to.name, 'assignee label', 100) || `User ${task.to.id}` }
      : null,
  };
}

function taskStoredDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

async function normalizeExistingTaskAction(db, value, evidence) {
  const allowed = value.kind === 'task.update.v1' ? TASK_UPDATE_KEYS
    : value.kind === 'task.transfer.v1' ? TASK_TRANSFER_KEYS
    : value.kind === 'task.complete.v1' || value.kind === 'task.cancel.v1' ? TASK_NOTE_KEYS
    : value.kind === 'task.reopen.v1' ? TASK_TARGET_KEYS : null;
  if (!allowed || !onlyKeys(value, allowed)) throw httpError(422, 'Task action contains unsupported fields');
  if (value.kind === 'task.update.v1' && !onlyKeys(value.changes, TASK_UPDATE_CHANGE_KEYS)) {
    throw httpError(422, 'Task update contains unsupported fields');
  }
  const taskId = taskIdFromDraft(value.task_id);
  const refs = taskDraftEvidence(value.evidence, evidence);
  if (!evidenceSupportsTask(refs, evidence, taskId)) {
    throw httpError(422, 'Task action evidence does not identify the target task');
  }
  const task = await taskService.getTask(db, taskId);
  if (!task) throw httpError(422, 'Task action target is unavailable');
  const base = {
    draft_id: crypto.randomUUID(), kind: value.kind, status: 'draft',
    task: taskActionTarget(task), evidence: refs,
  };

  if (value.kind === 'task.update.v1') {
    if (!value.changes || !Object.keys(value.changes).length) throw httpError(422, 'Task update needs at least one change');
    if (['Completed', 'Deleted'].includes(task.status)) throw httpError(422, `A ${task.status.toLowerCase()} task cannot be edited`);
    const changes = {};
    if ('title' in value.changes) changes.title = taskDraftText(value.changes.title, 'title', 100, { required: true });
    if ('description' in value.changes) changes.description = taskDraftText(value.changes.description, 'description', 1000);
    if ('start_date' in value.changes) changes.start_date = taskDraftDate(value.changes.start_date, 'start date');
    if ('due_date' in value.changes) changes.due_date = taskDraftDate(value.changes.due_date, 'due date');
    if ('notify_assigner_on_completion' in value.changes) {
      if (typeof value.changes.notify_assigner_on_completion !== 'boolean') {
        throw httpError(422, 'Task update completion notification must be true or false');
      }
      changes.notify_assigner_on_completion = value.changes.notify_assigner_on_completion;
    }
    if ('link' in value.changes) changes.link = await taskDraftLink(db, value.changes.link);
    const start = 'start_date' in changes ? changes.start_date : taskStoredDate(task.start);
    const due = 'due_date' in changes ? changes.due_date : taskStoredDate(task.due);
    if (start && due && due < start) throw httpError(422, 'Task update due date cannot precede its start date');
    return { ...base, changes };
  }

  if (value.kind === 'task.transfer.v1') {
    if (['Completed', 'Deleted'].includes(task.status)) throw httpError(422, `A ${task.status.toLowerCase()} task cannot be transferred`);
    const assigneeId = Number(value.assignee_user_id);
    if (!Number.isInteger(assigneeId) || assigneeId < 1) throw httpError(422, 'Task transfer assignee is invalid');
    const assignee = await taskService.findAssignableStaff(db, assigneeId);
    if (!assignee) throw httpError(422, 'Task transfer assignee is unavailable');
    if (Number(task.to && task.to.id) === assigneeId) throw httpError(422, 'Task is already assigned to that user');
    return { ...base, assignee: { user_id: Number(assignee.user), label: taskDraftText(assignee.user_name, 'assignee label', 100) || `User ${assigneeId}` } };
  }

  if (value.kind === 'task.complete.v1' || value.kind === 'task.cancel.v1') {
    if (value.kind === 'task.complete.v1' && task.status === 'Completed') throw httpError(422, 'Task is already completed');
    if (value.kind === 'task.complete.v1' && task.status === 'Deleted') throw httpError(422, 'A deleted task cannot be completed');
    if (value.kind === 'task.cancel.v1' && task.status === 'Deleted') throw httpError(422, 'Task is already canceled');
    return { ...base, note: taskDraftText(value.note, 'note', 500) };
  }

  if (value.kind === 'task.reopen.v1') {
    if (!['Completed', 'Deleted'].includes(task.status)) throw httpError(422, 'Only completed or canceled tasks can be reopened');
    return base;
  }

  throw httpError(422, 'Task action kind is unavailable');
}

function eventDraftText(value, field, max, { required = false } = {}) {
  const text = String(value == null ? '' : value).trim();
  if (required && !text) throw httpError(422, `Event action ${field} is required`);
  if (text.length > max) throw httpError(422, `Event action ${field} exceeds ${max} characters`);
  return text || null;
}

function eventDraftDate(value, field) {
  if (value == null || value === '') return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError(422, `Event action ${field} must be an ISO firm-local date`);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw httpError(422, `Event action ${field} is not a real date`);
  }
  return text;
}

function eventDraftTime(value, field = 'time') {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(text)) throw httpError(422, `Event action ${field} must be firm-local without a timezone suffix`);
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] || 0) > 59) {
    throw httpError(422, `Event action ${field} must be HH:MM or HH:MM:SS`);
  }
  return `${match[1]}:${match[2]}:${match[3] || '00'}`;
}

function eventDraftId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw httpError(422, 'Event action event id is invalid');
  return id;
}

function evidenceSupportsEvent(evidenceRefs, evidence, eventId) {
  return evidenceRefs.some((ref) => {
    const query = evidence.find((item) => item && item.id === ref.query_id);
    const row = query && Array.isArray(query.rows) ? query.rows[ref.row_number - 1] : null;
    return row && Number(row.event_id) === eventId;
  });
}

async function eventDraftType(db, value, { required = true } = {}) {
  const requested = eventDraftText(value, 'type', 60, { required });
  if (!requested) return { event_type: null, type_key: null, kind: null };
  const resolved = await calendarTypeService.resolveForCreate(db, null, requested);
  if (resolved.kind === 'meeting') throw httpError(422, 'Meeting types belong to Appointments, not Events');
  if (!resolved.type_key) return { event_type: requested, type_key: null, kind: 'other' };
  const row = await calendarTypeService.getType(db, resolved.type_key);
  if (!row || row.active !== 1) throw httpError(422, 'Event type is unavailable');
  return { event_type: row.label, type_key: row.type_key, kind: row.kind };
}

async function eventDraftLink(db, value) {
  if (value == null) return null;
  if (!onlyKeys(value, new Set(['type', 'id']))) throw httpError(422, 'Event action link is malformed');
  const type = String(value.type || '');
  if (!['case', 'contact', 'case_number'].includes(type)) throw httpError(422, 'Event action link type is unavailable');
  const raw = String(value.id == null ? '' : value.id).trim();
  if (!raw || raw.length > 20) throw httpError(422, 'Event action link id is invalid');
  let rows;
  if (type === 'case') {
    [rows] = await db.query('SELECT case_id, case_number_full AS label FROM cases WHERE case_id = ? LIMIT 1', [raw]);
  } else if (type === 'contact') {
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw httpError(422, 'Event action contact link id is invalid');
    [rows] = await db.query('SELECT contact_id, contact_name AS label FROM contacts WHERE contact_id = ? LIMIT 1', [Number(raw)]);
  } else {
    [rows] = await db.query('SELECT case_id, COALESCE(case_number_full, case_number) AS label FROM cases WHERE case_number = ? OR case_number_full = ? LIMIT 1', [raw, raw]);
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw httpError(422, 'Event action linked record is unavailable');
  return { type, id: raw, label: eventDraftText(row.label, 'link label', 200) || raw };
}

async function eventDraftProvider(db, value) {
  if (value == null || value === '') return { user_id: null, label: 'Everyone (firm-wide)' };
  const id = Number(value);
  if (!Number.isInteger(id) || id < 0) throw httpError(422, 'Event action calendar scope is invalid');
  if (id === 0) return { user_id: 0, label: "Nobody (doesn't block availability)" };
  const [rows] = await db.query('SELECT user, user_name FROM users WHERE user = ? AND does_appts = 1 LIMIT 1', [id]);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw httpError(422, 'Event action calendar provider is unavailable');
  return { user_id: Number(row.user), label: eventDraftText(row.user_name, 'provider label', 100) || `User ${id}` };
}

async function eventDraftReminder(db, value) {
  if (value == null) return null;
  if (!onlyKeys(value, new Set(['to', 'date']))) throw httpError(422, 'Event action reminder is malformed');
  const to = Number(value.to);
  if (!Number.isInteger(to) || to < 1) throw httpError(422, 'Event action reminder assignee is invalid');
  const assignee = await taskService.findAssignableStaff(db, to);
  if (!assignee) throw httpError(422, 'Event action reminder assignee is unavailable');
  const date = eventDraftDate(value.date, 'reminder date');
  if (!date) throw httpError(422, 'Event action reminder date is required');
  if (date < nowLocal().toFormat('yyyy-MM-dd')) throw httpError(422, 'Event action reminder date cannot be in the past');
  return { to: Number(assignee.user), date, label: taskDraftText(assignee.user_name, 'reminder assignee label', 100) || `User ${to}` };
}

function eventDraftLength(value) {
  if (value == null || value === '') return null;
  const length = Number(value);
  if (!Number.isInteger(length) || length < 1 || length > 1440) throw httpError(422, 'Event action length must be 1-1440 minutes');
  return length;
}

async function normalizeEventFields(db, value, { partial = false } = {}) {
  const out = {};
  if (!partial || 'event_type' in value) out.type = await eventDraftType(db, value.event_type, { required: !partial });
  if (!partial || 'event_title' in value) out.event_title = eventDraftText(value.event_title, 'title', 200, { required: true });
  if (!partial || 'event_date' in value) out.event_date = eventDraftDate(value.event_date, 'date');
  if (!partial && !out.event_date) throw httpError(422, 'Event action date is required');
  if ('event_all_day' in value || !partial) {
    if (typeof value.event_all_day !== 'boolean') throw httpError(422, 'Event action all-day value must be true or false');
    out.event_all_day = value.event_all_day;
  }
  if ('event_time' in value || !partial) out.event_time = eventDraftTime(value.event_time);
  if ('event_length' in value || !partial) out.event_length = eventDraftLength(value.event_length);
  const allDay = 'event_all_day' in out ? out.event_all_day : null;
  if (allDay === true) {
    out.event_time = null;
    out.event_length = null;
  }
  if (!partial && allDay === false && !out.event_time) throw httpError(422, 'A timed event requires a firm-local time');
  if ('event_location' in value || !partial) out.event_location = eventDraftText(value.event_location, 'location', 255);
  if ('event_link' in value || !partial) out.event_link = eventDraftText(value.event_link, 'URL/link', 500);
  if ('event_note' in value || !partial) out.event_note = eventDraftText(value.event_note, 'note', 10000);
  if (allDay === true) out.event_with = { user_id: null, label: 'Everyone (firm-wide)' };
  else if ('event_with' in value || !partial) out.event_with = await eventDraftProvider(db, value.event_with);
  if ('reminder' in value || !partial) out.reminder = await eventDraftReminder(db, value.reminder);
  return out;
}

function eventActionTarget(event) {
  return {
    event_id: Number(event.event_id), title: String(event.event_title || `Event ${event.event_id}`),
    status: String(event.event_status || ''), type: event.event_type == null ? null : String(event.event_type),
    kind: event.kind == null ? 'other' : String(event.kind), date: taskStoredDate(event.event_date),
    time: eventDraftTime(event.event_time), all_day: event.event_all_day === 1 || event.event_all_day === true || event.event_all_day === '1',
    google_calendar: event.event_gcal ? 'synced' : (event.event_calendar_id === 'none' ? 'opted_out' : 'not_synced'),
  };
}

async function normalizeEventAction(db, value, evidence) {
  const allowed = value.kind === 'event.create.v1' ? EVENT_CREATE_KEYS
    : value.kind === 'event.update.v1' ? EVENT_UPDATE_KEYS : EVENT_TRANSITION_KEYS;
  if (!onlyKeys(value, allowed)) throw httpError(422, 'Event action contains unsupported fields');
  const refs = taskDraftEvidence(value.evidence, evidence);
  if (value.kind === 'event.create.v1') {
    const fields = await normalizeEventFields(db, value);
    return { draft_id: crypto.randomUUID(), kind: value.kind, status: 'draft', ...fields,
      link: await eventDraftLink(db, value.link), evidence: refs };
  }
  const eventId = eventDraftId(value.event_id);
  if (!evidenceSupportsEvent(refs, evidence, eventId)) throw httpError(422, 'Event action evidence does not identify the target event');
  const event = await eventService.getEvent(db, eventId);
  if (!event) throw httpError(422, 'Event action target is unavailable');
  if (event.event_status !== 'Scheduled' || event.superseded_by_event_id != null) {
    throw httpError(422, `Only a current Scheduled event can be ${value.kind === 'event.update.v1' ? 'updated' : value.kind.includes('complete') ? 'completed' : 'canceled'}`);
  }
  const base = { draft_id: crypto.randomUUID(), kind: value.kind, status: 'draft', event: eventActionTarget(event), evidence: refs };
  if (value.kind === 'event.update.v1') {
    if (!onlyKeys(value.changes, EVENT_UPDATE_CHANGE_KEYS) || !Object.keys(value.changes || {}).length) throw httpError(422, 'Event update contains unsupported fields or no changes');
    const changes = await normalizeEventFields(db, value.changes, { partial: true });
    if ('event_time' in changes && !('event_all_day' in changes)) {
      changes.event_all_day = changes.event_time == null;
      if (changes.event_all_day) {
        changes.event_length = null;
        changes.event_with = { user_id: null, label: 'Everyone (firm-wide)' };
      }
    }
    if ('event_all_day' in changes && changes.event_all_day === false && !('event_time' in changes) && !event.event_time) {
      throw httpError(422, 'Changing an all-day event to timed requires a firm-local time');
    }
    if ('event_length' in changes && event.event_all_day && changes.event_all_day !== false) {
      throw httpError(422, 'An all-day event cannot have a duration unless it is changed to timed');
    }
    return { ...base, changes };
  }
  const resolution = value.resolution == null || value.resolution === ''
    ? eventService._defaultResolution(value.kind === 'event.complete.v1' ? 'Completed' : 'Canceled', event.kind)
    : String(value.resolution);
  try { eventService._validateResolution(resolution, value.kind === 'event.complete.v1' ? 'Completed' : 'Canceled', event.kind, { prefix: 'Ask Casey' }); }
  catch (_) { throw httpError(422, 'Event action resolution is invalid for this event kind'); }
  if (value.kind === 'event.complete.v1') {
    if (resolution === 'missed') throw httpError(422, 'Missed deadlines are resolved by the calendar sweep, not a reviewed completion action');
    if ('delete_gcal' in value) throw httpError(422, 'Event completion cannot choose Google Calendar deletion');
    return { ...base, resolution };
  }
  if ('delete_gcal' in value && typeof value.delete_gcal !== 'boolean') throw httpError(422, 'Event cancel delete_gcal must be true or false');
  return { ...base, resolution, delete_gcal: value.delete_gcal !== false };
}

function apptActionId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw httpError(422, 'Appointment action appointment id is invalid');
  return id;
}

function evidenceSupportsAppt(evidenceRefs, evidence, apptId) {
  return evidenceRefs.some((ref) => {
    const query = evidence.find((item) => item && item.id === ref.query_id);
    const row = query && Array.isArray(query.rows) ? query.rows[ref.row_number - 1] : null;
    return row && Number(row.appt_id) === apptId;
  });
}

function apptActionText(value, field, max, { required = false } = {}) {
  const text = String(value == null ? '' : value).trim();
  if (required && !text) throw httpError(422, `Appointment action ${field} is required`);
  if (text.length > max) throw httpError(422, `Appointment action ${field} exceeds ${max} characters`);
  return text;
}

function apptActionDateTime(value, field = 'date/time') {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text) || /[Zz]|[+-]\d{2}:?\d{2}$/.test(text)) {
    throw httpError(422, `Appointment action ${field} must be a firm-local YYYY-MM-DD HH:MM[:SS] value`);
  }
  let instant;
  try { instant = parseUserDateTime(text); }
  catch (_) { throw httpError(422, `Appointment action ${field} is not a real firm-local date/time`); }
  if (!instant) throw httpError(422, `Appointment action ${field} is invalid`);
  const normalized = text.replace('T', ' ') + (text.length === 16 ? ':00' : '');
  if (instant.getTime() <= nowLocal().toUTC().toMillis()) throw httpError(422, `Appointment action ${field} must be in the future`);
  return normalized;
}

async function apptActionType(db, value) {
  const requested = apptActionText(value, 'type', 100, { required: true });
  const resolved = await calendarTypeService.resolveForCreate(db, null, requested);
  if (!resolved.type_key) throw httpError(422, 'Appointment action type must be an active meeting type');
  const row = await calendarTypeService.getType(db, resolved.type_key);
  if (!row || row.active !== 1 || row.kind !== 'meeting') throw httpError(422, 'Appointment action type must be an active meeting type');
  return { appt_type: row.label, type_key: row.type_key, singleton: row.singleton === 1 };
}

async function apptActionProvider(db, value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw httpError(422, 'Appointment action provider is invalid');
  const [rows] = await db.query('SELECT user, user_name FROM users WHERE user = ? AND does_appts = 1 AND user_auth = 1 LIMIT 1', [id]);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw httpError(422, 'Appointment action provider is unavailable');
  return { user_id: Number(row.user), label: apptActionText(row.user_name, 'provider label', 100) || `User ${id}` };
}

async function apptActionContact(db, value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw httpError(422, 'Appointment action contact is invalid');
  const [rows] = await db.query('SELECT contact_id, contact_name FROM contacts WHERE contact_id = ? LIMIT 1', [id]);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw httpError(422, 'Appointment action contact is unavailable');
  return { contact_id: Number(row.contact_id), label: apptActionText(row.contact_name, 'contact label', 200) || `Contact ${id}` };
}

async function apptActionCase(db, value) {
  if (value == null || value === '') return null;
  const id = String(value).trim();
  if (!id || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) throw httpError(422, 'Appointment action case is invalid');
  const [rows] = await db.query('SELECT case_id, COALESCE(case_number_full, case_number) AS label FROM cases WHERE case_id = ? LIMIT 1', [id]);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw httpError(422, 'Appointment action case is unavailable');
  return { case_id: String(row.case_id), label: apptActionText(row.label, 'case label', 200) || id };
}

async function assertApptContactCaseLink(db, contact, caseRecord) {
  if (!caseRecord) return;
  if (!contact) throw httpError(422, 'Appointment action cannot link a case without a selected contact');
  const [rows] = await db.query(
    'SELECT case_relate_id FROM case_relate WHERE case_relate_case_id = ? AND case_relate_client_id = ? LIMIT 1',
    [caseRecord.case_id, contact.contact_id]);
  if (!Array.isArray(rows) || !rows[0]) throw httpError(422, 'Appointment action case is not linked to the selected contact');
}

function apptActionBool(value, field, fallback = false) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') throw httpError(422, `Appointment action ${field} must be true or false`);
  return value;
}

function apptActionMessageFields(value, { cancel = false } = {}) {
  const sms = apptActionBool(value.sms ?? value.confirm_sms, 'SMS confirmation');
  const email = apptActionBool(value.email ?? value.confirm_email, 'email confirmation');
  const confirmMessage = apptActionText(value.confirm_message, 'confirmation message', 2000);
  if ((sms || email) && !confirmMessage) throw httpError(422, 'Appointment action confirmation message is required when sending SMS or email');
  return { [cancel ? 'sms' : 'confirm_sms']: sms, [cancel ? 'email' : 'confirm_email']: email, confirm_message: confirmMessage };
}

function apptActionTarget(row) {
  const date = row.appt_date instanceof Date ? row.appt_date.toISOString().slice(0, 19).replace('T', ' ') : String(row.appt_date || '').slice(0, 19).replace('T', ' ');
  return {
    appt_id: Number(row.appt_id), status: String(row.appt_status || ''), type: String(row.appt_type || ''),
    date, length: Number(row.appt_length) || null, platform: String(row.appt_platform || ''),
    note: String(row.appt_note || ''),
    contact: row.appt_client_id == null ? null : { contact_id: Number(row.appt_client_id), label: String(row.contact_name || `Contact ${row.appt_client_id}`) },
    case: row.appt_case_id ? { case_id: String(row.appt_case_id), label: String(row.case_number_display || row.appt_case_id) } : null,
    provider: row.appt_with == null ? null : { user_id: Number(row.appt_with), label: String(row.user_name || `User ${row.appt_with}`) },
    google_calendar: { firm: !!row.appt_gcal, provider: !!row.appt_gcal_user },
  };
}

async function loadApptActionTarget(db, apptId) {
  const [rows] = await db.query(
    `SELECT a.appt_id, a.appt_client_id, a.appt_case_id, a.appt_type, a.appt_length, a.appt_note,
            a.appt_platform, a.appt_status, a.appt_date, a.appt_with, a.appt_gcal,
            a.appt_gcal_user, a.rescheduled_from_appt_id, c.contact_name,
            COALESCE(cs.case_number_full, cs.case_number) AS case_number_display,
            u.user_name
       FROM appts a
       LEFT JOIN contacts c ON c.contact_id = a.appt_client_id
       LEFT JOIN cases cs ON cs.case_id = a.appt_case_id
       LEFT JOIN users u ON u.user = a.appt_with
      WHERE a.appt_id = ? LIMIT 1`, [apptId]);
  return Array.isArray(rows) ? rows[0] : null;
}

function assertApptStatus(kind, status) {
  const allowed = {
    'appt.update.v1': ['Scheduled'],
    'appt.attended.v1': ['Scheduled', 'No Show'],
    'appt.no_show.v1': ['Scheduled', 'Attended'],
    'appt.cancel.v1': ['Scheduled', 'Attended', 'No Show'],
    'appt.reschedule.v1': ['Scheduled', 'Attended', 'No Show'],
    'appt.reschedule_later.v1': ['Scheduled', 'Attended', 'No Show'],
  }[kind] || [];
  if (!allowed.includes(status)) throw httpError(422, `An appointment with status ${status || 'unknown'} cannot be used for this action`);
}

async function normalizeApptAction(db, value, evidence) {
  const allowed = value.kind === 'appt.create.v1' ? APPT_CREATE_KEYS
    : value.kind === 'appt.update.v1' ? APPT_UPDATE_KEYS
      : value.kind === 'appt.no_show.v1' ? APPT_NO_SHOW_KEYS
        : value.kind === 'appt.cancel.v1' ? APPT_CANCEL_KEYS
          : value.kind === 'appt.reschedule.v1' ? APPT_RESCHEDULE_KEYS
            : value.kind === 'appt.reschedule_later.v1' ? APPT_RESCHEDULE_LATER_KEYS : APPT_NOTE_KEYS;
  if (!onlyKeys(value, allowed)) throw httpError(422, 'Appointment action contains unsupported fields');
  const refs = taskDraftEvidence(value.evidence, evidence);
  if (value.kind === 'appt.create.v1') {
    const length = Number(value.appt_length);
    if (!Number.isInteger(length) || length < 1 || length > 1440) throw httpError(422, 'Appointment action length must be 1-1440 minutes');
    const messages = apptActionMessageFields(value);
    const contact = await apptActionContact(db, value.contact_id);
    const caseRecord = await apptActionCase(db, value.case_id);
    await assertApptContactCaseLink(db, contact, caseRecord);
    return {
      draft_id: crypto.randomUUID(), kind: value.kind, status: 'draft', firm_timezone: FIRM_TZ,
      contact, case: caseRecord,
      type: await apptActionType(db, value.appt_type), appt_length: length,
      appt_platform: apptActionText(value.appt_platform, 'platform', 255, { required: true }),
      appt_date: apptActionDateTime(value.appt_date), provider: await apptActionProvider(db, value.appt_with),
      note: apptActionText(value.note, 'note', 10000), ...messages, evidence: refs,
    };
  }
  const apptId = apptActionId(value.appt_id);
  if (!evidenceSupportsAppt(refs, evidence, apptId)) throw httpError(422, 'Appointment action evidence does not identify the target appointment');
  const row = await loadApptActionTarget(db, apptId);
  if (!row) throw httpError(422, 'Appointment action target is unavailable');
  assertApptStatus(value.kind, String(row.appt_status || ''));
  const base = { draft_id: crypto.randomUUID(), kind: value.kind, status: 'draft', firm_timezone: FIRM_TZ, appt: apptActionTarget(row), evidence: refs };
  if (value.kind === 'appt.update.v1') {
    if (!onlyKeys(value.changes, APPT_UPDATE_CHANGE_KEYS) || !Object.keys(value.changes || {}).length) throw httpError(422, 'Appointment update contains unsupported fields or no changes');
    const changes = {};
    if ('note' in value.changes) changes.note = apptActionText(value.changes.note, 'note', 10000);
    if ('case_id' in value.changes) {
      changes.case = await apptActionCase(db, value.changes.case_id);
      await assertApptContactCaseLink(db, base.appt.contact, changes.case);
    }
    return { ...base, changes };
  }
  const note = apptActionText(value.note, 'note', 10000);
  if (value.kind === 'appt.attended.v1') return { ...base, note };
  if (value.kind === 'appt.no_show.v1') return { ...base, note, enroll: apptActionBool(value.enroll, 'no-show enrollment') };
  if (value.kind === 'appt.cancel.v1') return { ...base, note, ...apptActionMessageFields(value, { cancel: true }),
    cancel_gcal: apptActionBool(value.cancel_gcal, 'Google Calendar deletion', true),
    create_task: apptActionBool(value.create_task, 'follow-up task') };
  if (value.kind === 'appt.reschedule.v1') {
    const newDate = apptActionDateTime(value.new_date, 'new date/time');
    if (newDate === base.appt.date) throw httpError(422, 'Appointment reschedule requires a different date/time');
    return { ...base, new_date: newDate, note, ...apptActionMessageFields(value, { cancel: true }) };
  }
  if (value.kind === 'appt.reschedule_later.v1') return { ...base, note,
    create_task: apptActionBool(value.create_task, 'follow-up task') };
  throw httpError(422, 'Appointment action kind is unavailable');
}

const CONTACT_SUBRECORD_CONFIG = Object.freeze({
  phone: {
    idField: 'phone_id', valueField: 'phone', table: 'contact_phones', alias: 'cp', plural: 'phones',
    createKeys: CONTACT_PHONE_CREATE_KEYS, updateActionKeys: CONTACT_PHONE_UPDATE_ACTION_KEYS,
    endKeys: CONTACT_PHONE_END_KEYS, updateKeys: CONTACT_PHONE_UPDATE_KEYS,
    validate: contactPhoneService.validatePhoneRow, get: contactPhoneService.getContactPhone,
  },
  email: {
    idField: 'email_id', valueField: 'email', table: 'contact_emails', alias: 'ce', plural: 'emails',
    createKeys: CONTACT_EMAIL_CREATE_KEYS, updateActionKeys: CONTACT_EMAIL_UPDATE_ACTION_KEYS,
    endKeys: CONTACT_EMAIL_END_KEYS, updateKeys: CONTACT_EMAIL_UPDATE_KEYS,
    validate: contactEmailService.validateEmailRow, get: contactEmailService.getContactEmail,
  },
  address: {
    idField: 'address_id', valueField: null, table: 'contact_addresses', alias: 'ca', plural: 'addresses',
    createKeys: CONTACT_ADDRESS_CREATE_KEYS, updateActionKeys: CONTACT_ADDRESS_UPDATE_ACTION_KEYS,
    endKeys: CONTACT_ADDRESS_END_KEYS, updateKeys: CONTACT_ADDRESS_UPDATE_KEYS,
    validate: contactAddressService.validateAddressRow, get: contactAddressService.getContactAddress,
  },
});

function contactActionParts(kind) {
  const match = /^contact\.(phone|email|address)\.(create|update|end)\.v1$/.exec(String(kind || ''));
  if (!match) throw httpError(422, 'Contact subrecord action kind is unavailable');
  return { family: match[1], operation: match[2], config: CONTACT_SUBRECORD_CONFIG[match[1]] };
}

function contactActionId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw httpError(422, `Contact subrecord action ${field} is invalid`);
  return id;
}

function contactActionText(value, field, max, { required = false } = {}) {
  const text = String(value == null ? '' : value).trim();
  if (required && !text) throw httpError(422, `Contact subrecord action ${field} is required`);
  if (text.length > max) throw httpError(422, `Contact subrecord action ${field} exceeds ${max} characters`);
  return text;
}

function contactActionBool(value, field, fallback) {
  if (value == null && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw httpError(422, `Contact subrecord action ${field} must be true or false`);
  return value;
}

function contactActionDate(value, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw httpError(422, `Contact subrecord action ${field} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError(422, `Contact subrecord action ${field} must be an ISO firm-local date`);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw httpError(422, `Contact subrecord action ${field} is not a real date`);
  return text;
}

function contactActionTimestamp(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function contactEvidenceSupports(refs, evidence, contactId, config, recordId = null) {
  return refs.some((ref) => {
    const query = evidence.find((item) => item && item.id === ref.query_id);
    const row = query && Array.isArray(query.rows) ? query.rows[ref.row_number - 1] : null;
    return row && Number(row.contact_id) === contactId
      && (recordId == null || Number(row[config.idField]) === recordId);
  });
}

async function contactActionContact(db, contactId) {
  const [rows] = await db.query('SELECT contact_id, contact_name FROM contacts WHERE contact_id = ? LIMIT 1', [contactId]);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw httpError(422, 'Contact subrecord action parent contact is unavailable');
  return { contact_id: Number(row.contact_id), label: contactActionText(row.contact_name, 'contact label', 200) || `Contact ${contactId}` };
}

function validateContactRecord(config, fields, mode) {
  try { return config.validate(fields, { mode }); }
  catch (err) { throw httpError(422, err && err.message ? err.message : 'Contact subrecord action fields are invalid'); }
}

function contactActionTarget(family, row, contact) {
  const bit = (value) => value === 1 || value === true || value === '1';
  const base = {
    family, id: Number(row.id), contact, label: String(row.label || 'Other'),
    is_primary: row.is_primary === 1 || row.is_primary === true || row.is_primary === '1',
    start_date: taskStoredDate(row.start_date), end_date: taskStoredDate(row.end_date),
    notes: String(row.notes || ''), expected_updated_at: contactActionTimestamp(row.updated_at),
  };
  if (!base.expected_updated_at) throw httpError(422, 'Contact subrecord action target has no usable concurrency version');
  if (family === 'phone') return { ...base, phone: String(row.phone || ''), sms_optout: bit(row.sms_optout), mms_capable: bit(row.mms_capable) };
  if (family === 'email') return { ...base, email: String(row.email || ''), email_optout: bit(row.email_optout) };
  return { ...base, address1: String(row.address1 || ''), address2: String(row.address2 || ''), city: String(row.city || ''),
    state: String(row.state || ''), zip: String(row.zip || ''), country: String(row.country || '') };
}

async function contactCreatePrimaryEffect(db, config, contactId, makePrimary) {
  if (!makePrimary) return null;
  const valueSql = config.valueField ? `${config.alias}.${config.valueField} AS value` :
    `CONCAT_WS(', ', NULLIF(${config.alias}.address1, ''), NULLIF(${config.alias}.city, ''), NULLIF(${config.alias}.state, ''), NULLIF(${config.alias}.zip, '')) AS value`;
  const [rows] = await db.query(
    `SELECT ${config.alias}.id, ${valueSql}, ${config.alias}.label FROM ${config.table} ${config.alias} WHERE ${config.alias}.contact_id = ? AND ${config.alias}.is_primary = 1 AND ${config.alias}.end_date IS NULL LIMIT 1`,
    [contactId]);
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? { id: Number(row.id), value: String(row.value || ''), label: String(row.label || 'Other') } : null;
}

async function normalizeContactSubrecordAction(db, value, evidence) {
  const { family, operation, config } = contactActionParts(value.kind);
  const allowed = operation === 'create' ? config.createKeys : operation === 'update' ? config.updateActionKeys : config.endKeys;
  if (!onlyKeys(value, allowed)) throw httpError(422, 'Contact subrecord action contains unsupported fields');
  const refs = taskDraftEvidence(value.evidence, evidence);
  const contactId = contactActionId(value.contact_id, 'contact id');
  if (operation === 'create') {
    if (!contactEvidenceSupports(refs, evidence, contactId, config)) throw httpError(422, 'Contact subrecord action evidence does not identify the parent contact');
    const contact = await contactActionContact(db, contactId);
    const input = { ...value };
    delete input.kind; delete input.contact_id; delete input.evidence;
    if ('is_primary' in input) input.is_primary = contactActionBool(input.is_primary, 'primary value');
    if ('sms_optout' in input) input.sms_optout = contactActionBool(input.sms_optout, 'SMS opt-out');
    if ('mms_capable' in input) input.mms_capable = contactActionBool(input.mms_capable, 'MMS capability');
    if ('email_optout' in input) input.email_optout = contactActionBool(input.email_optout, 'email opt-out');
    if ('start_date' in input) {
      input.start_date = contactActionDate(input.start_date, 'start date');
      if (input.start_date && input.start_date > nowLocal().toFormat('yyyy-MM-dd')) throw httpError(422, 'Contact subrecord action start date cannot be in the future');
    }
    if ('notes' in input) input.notes = contactActionText(input.notes, 'notes', 5000);
    const fields = validateContactRecord(config, input, 'insert');
    if (family !== 'address') {
      const [collisions] = await db.query(
        `SELECT ${config.alias}.id, ${config.alias}.contact_id FROM ${config.table} ${config.alias} WHERE ${config.alias}.${config.valueField} = ? AND ${config.alias}.end_date IS NULL LIMIT 1`,
        [fields[config.valueField]]);
      if (Array.isArray(collisions) && collisions[0]) throw httpError(422, `That ${family} is already active on a contact; transfer is not available in this action`);
      if (fields.start_date) {
        const [overlaps] = await db.query(
          `SELECT ${config.alias}.id FROM ${config.table} ${config.alias} WHERE ${config.alias}.${config.valueField} = ? AND (${config.alias}.start_date IS NULL OR ${config.alias}.start_date <= ?) AND (${config.alias}.end_date IS NULL OR ${config.alias}.end_date >= ?) AND NOT (${config.alias}.start_date IS NOT NULL AND ${config.alias}.end_date IS NOT NULL AND ${config.alias}.end_date < ${config.alias}.start_date) LIMIT 1`,
          [fields[config.valueField], fields.start_date, fields.start_date]);
        if (Array.isArray(overlaps) && overlaps[0]) throw httpError(422, `Contact subrecord action start date overlaps existing ${family} ownership history`);
      } else {
        const [nextRows] = await db.query(
          `SELECT DATE_FORMAT(DATE_ADD(MAX(end_date), INTERVAL 1 DAY), '%Y-%m-%d') AS next_start FROM ${config.table} WHERE ${config.valueField} = ?`,
          [fields[config.valueField]]);
        fields.start_date = nextRows && nextRows[0] && nextRows[0].next_start ? String(nextRows[0].next_start) : null;
      }
    } else if (!fields.start_date) {
      fields.start_date = nowLocal().toFormat('yyyy-MM-dd');
    }
    if (fields.is_primary === undefined) {
      const [counts] = await db.query(`SELECT COUNT(*) AS row_count FROM ${config.table} WHERE contact_id = ?`, [contactId]);
      fields.is_primary = Number(counts && counts[0] && counts[0].row_count) === 0 ? 1 : 0;
    }
    const makePrimary = fields.is_primary === 1;
    return { draft_id: crypto.randomUUID(), kind: value.kind, status: 'draft', contact, family,
      fields: { ...fields, is_primary: makePrimary }, demoted_primary: await contactCreatePrimaryEffect(db, config, contactId, makePrimary), evidence: refs };
  }

  const recordId = contactActionId(value[config.idField], config.idField.replace('_', ' '));
  if (!contactEvidenceSupports(refs, evidence, contactId, config, recordId)) throw httpError(422, 'Contact subrecord action evidence does not identify the target record and parent contact');
  const [contact, row] = await Promise.all([contactActionContact(db, contactId), config.get(db, recordId)]);
  if (!row || Number(row.contact_id) !== contactId) throw httpError(422, 'Contact subrecord action target is unavailable on that contact');
  if (row.end_date != null) throw httpError(422, 'Only an active contact subrecord can be updated or ended');
  const target = contactActionTarget(family, row, contact);
  if (operation === 'end') {
    const endDate = contactActionDate(value.end_date, 'end date') || nowLocal().toFormat('yyyy-MM-dd');
    if (endDate > nowLocal().toFormat('yyyy-MM-dd')) throw httpError(422, 'Contact subrecord action end date cannot be in the future');
    if (target.start_date && endDate < target.start_date) throw httpError(422, 'Contact subrecord action end date cannot precede the start date');
    return { draft_id: crypto.randomUUID(), kind: value.kind, status: 'draft', family, target,
      changes: { end_date: endDate, end_reason: contactActionText(value.end_reason, 'end reason', 255, { required: true }) }, evidence: refs };
  }

  if (!onlyKeys(value.changes, config.updateKeys) || !Object.keys(value.changes || {}).length) throw httpError(422, 'Contact subrecord update contains unsupported fields or no changes');
  const input = { ...value.changes };
  for (const key of ['is_primary', 'sms_optout', 'mms_capable', 'email_optout']) {
    if (key in input) input[key] = contactActionBool(input[key], key.replaceAll('_', ' '));
  }
  if ('is_primary' in input && input.is_primary !== true) throw httpError(422, 'Contact subrecord update may promote a primary record but cannot leave the contact without one');
  if ('notes' in input) input.notes = contactActionText(input.notes, 'notes', 5000);
  const changes = validateContactRecord(config, input, 'update');
  for (const key of ['is_primary', 'sms_optout', 'mms_capable', 'email_optout']) if (key in changes) changes[key] = changes[key] === 1;
  if (family === 'address') {
    const merged = { ...target, ...changes };
    if (![merged.address1, merged.city, merged.state, merged.zip].some((part) => String(part || '').trim())) {
      throw httpError(422, 'Address update must retain at least one of address1, city, state, or zip');
    }
  }
  const changed = Object.entries(changes).some(([key, next]) => String(target[key] ?? '') !== String(next ?? ''));
  if (!changed) throw httpError(422, 'Contact subrecord update does not change any value');
  let demotedPrimary = null;
  if (changes.is_primary && !target.is_primary) {
    demotedPrimary = await contactCreatePrimaryEffect(db, config, contactId, true);
    if (demotedPrimary && demotedPrimary.id === target.id) demotedPrimary = null;
  }
  return { draft_id: crypto.randomUUID(), kind: value.kind, status: 'draft', family, target, changes,
    demoted_primary: demotedPrimary, evidence: refs };
}

async function taskDraftLink(db, value) {
  if (value == null) return null;
  if (!onlyKeys(value, new Set(['type', 'id']))) throw httpError(422, 'Task draft link is malformed');
  const type = String(value.type || '');
  if (type === 'bill') throw httpError(422, 'Bill-linked task drafts are unavailable because bills have no verifiable record source');
  const resolver = TASK_DRAFT_LINKS[type];
  if (!resolver) throw httpError(422, 'Task draft link type is unavailable');
  const rawId = String(value.id == null ? '' : value.id).trim();
  if (!rawId || rawId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(rawId)) throw httpError(422, 'Task draft link id is invalid');
  if (type !== 'case' && (!/^\d+$/.test(rawId) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) < 1)) {
    throw httpError(422, 'Task draft link id is invalid');
  }
  const id = type === 'case' ? rawId : Number(rawId);
  const [rows] = await db.query(resolver.sql, [id]);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw httpError(422, 'Task draft linked record is unavailable');
  return {
    type,
    id: String(row[resolver.id]),
    label: taskDraftText(row.label, 'link label', 200) || `${type === 'appt' ? 'Appointment' : type[0].toUpperCase() + type.slice(1)} ${rawId}`,
  };
}

async function normalizeActionDraft(db, value, evidence, { currentUserId = null } = {}) {
  if (value == null) return null;
  if (value && EVENT_ACTION_KINDS.has(value.kind)) return normalizeEventAction(db, value, evidence);
  if (value && APPT_ACTION_KINDS.has(value.kind)) return normalizeApptAction(db, value, evidence);
  if (value && CONTACT_SUBRECORD_ACTION_KINDS.has(value.kind)) return normalizeContactSubrecordAction(db, value, evidence);
  if (!value || !TASK_ACTION_KINDS.has(value.kind)) throw httpError(422, 'Action kind is unavailable');
  if (value.kind !== 'task.create.v1') return normalizeExistingTaskAction(db, value, evidence);
  if (!onlyKeys(value, TASK_CREATE_KEYS)) throw httpError(422, 'Task draft contains unsupported fields');
  const assigneeId = Number(value.assignee_user_id);
  if (!Number.isInteger(assigneeId) || assigneeId < 0) throw httpError(422, 'Task draft assignee is invalid');
  const assignee = await taskService.findAssignableStaff(db, assigneeId);
  if (!assignee) throw httpError(422, 'Task draft assignee is unavailable');
  if (value.notify_assigner_on_completion != null && typeof value.notify_assigner_on_completion !== 'boolean') {
    throw httpError(422, 'Task draft completion notification must be true or false');
  }
  const viewerId = Number(currentUserId);
  const notify = typeof value.notify_assigner_on_completion === 'boolean'
    ? value.notify_assigner_on_completion
    : Number.isSafeInteger(viewerId) && viewerId > 0 && viewerId !== assigneeId;
  const startDate = taskDraftDate(value.start_date, 'start date');
  const dueDate = taskDraftDate(value.due_date, 'due date');
  if (startDate && dueDate && dueDate < startDate) throw httpError(422, 'Task draft due date cannot precede its start date');
  return {
    draft_id: crypto.randomUUID(),
    kind: 'task.create.v1',
    status: 'draft',
    title: taskDraftText(value.title, 'title', 100, { required: true }),
    description: taskDraftText(value.description, 'description', 1000, { required: true }),
    assignee: { user_id: Number(assignee.user), label: taskDraftText(assignee.user_name, 'assignee label', 100) || `User ${assigneeId}` },
    link: await taskDraftLink(db, value.link),
    start_date: startDate,
    due_date: dueDate,
    notify_assigner_on_completion: notify,
    evidence: taskDraftEvidence(value.evidence, evidence),
  };
}

function unavailableTaskDraftAnswer() {
  return 'I completed the lookup, but I could not produce a valid reviewed action card. Nothing was changed. ' +
    'Ask me to prepare that action again. If the card still does not appear, open the cited record and perform the ' +
    'change directly in YisraCase.';
}

async function repairActionDraft(db, approved, evidence, rejectedValue, rejection, userId) {
  const ai = await aiService.call(db, {
    promptKey: 'assistant_task_draft_repair',
    userInput: `${currentContext(approved.viewer, approved.workspace)}\n\nCONVERSATION:\n${historyText(approved.history)}\n\n` +
      `QUESTION:\n${approved.question}\n\nREJECTION:\n${String(rejection && rejection.message || 'The action_draft field was absent.')}\n\n` +
      `REJECTED PROPOSAL:\n${JSON.stringify(rejectedValue == null ? null : rejectedValue)}\n\n` +
      `EVIDENCE (row_number is array position + 1):\n${JSON.stringify(evidence)}`,
    model: attachmentService.modelForMode(approved.modelMode),
    outputType: 'json', timeout_ms: ANSWER_TIMEOUT_MS,
    consumerRef: `assistant_task_draft_repair:u${Number(userId) || 0}`,
    logContent: false,
  });
  if (!ai.ok) return null;
  try {
    const draft = await normalizeActionDraft(db, ai.json && ai.json.action_draft, evidence, { currentUserId: userId });
    return draft || null;
  } catch (_) {
    return null;
  }
}

function taskDraftRequested(question, history = []) {
  const priorUserText = cleanHistory(history)
    .filter((message) => message.role === 'user')
    .slice(-4)
    .map((message) => message.text);
  const text = [...priorUserText, String(question || '')].join('\n');
  const task = /\b(?:task|to-do)\b/i.test(text) &&
    /\b(?:draft|propose|prepare|create|make|add|edit|update|change|complete|finish|done|cancel|delete|remove|reopen|restore|transfer|reassign|assign)\b/i.test(text);
  const event = /\bevent\b/i.test(text) &&
    /\b(?:draft|propose|prepare|create|make|add|edit|update|change|complete|finish|done|cancel)\b/i.test(text);
  const appt = /\b(?:appt|appointment)\b/i.test(text) &&
    /\b(?:draft|propose|prepare|create|make|add|edit|update|change|attend|attended|no[ -]?show|cancel|reschedule)\b/i.test(text);
  const contactSubrecord = /\b(?:contact|client)\b/i.test(text) &&
    /\b(?:phone|email|address)\b/i.test(text) &&
    /\b(?:draft|propose|prepare|create|make|add|edit|update|change|end|deactivate|remove)\b/i.test(text);
  return task || event || appt || contactSubrecord;
}

function contextualAnswer(question, history) {
  if (!/\bwhat\s+day(?:\s+of\s+the\s+week)?\s+(?:is|was)\s+(?:it|that)\b/i.test(question)) return null;
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) return null;
  const dates = [...new Set((lastAssistant.text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []))];
  if (dates.length !== 1) return null;
  const date = new Date(`${dates[0]}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(date);
  return `${dates[0]} is a ${weekday}.`;
}

function sqlLimit(sql) {
  const m = String(sql).match(/\bLIMIT\s+(\d+)\s*;?\s*$/i);
  return m ? Number(m[1]) : null;
}

function validateStep(query, index) {
  if (!query || typeof query !== 'object') throw httpError(422, `Step ${index + 1} is malformed`);
  const id = String(query.id || `q${index + 1}`).trim();
  const kind = String(query.kind || 'sql.read').trim();
  const purpose = String(query.purpose || '').trim();
  if (!/^q[1-9][0-9]?$/.test(id)) throw httpError(422, `Step ${index + 1} needs an id like q1`);
  if (!purpose || purpose.length > 500) throw httpError(422, `Query ${id} needs a short purpose`);
  if (kind === 'manual.search') {
    const search = String(query.query || '').trim();
    if (search.length < 2 || search.length > 120) throw httpError(422, `Step ${id} needs a 2-120 character manual search`);
    return { id, kind, purpose, query: search };
  }
  if (kind === 'comms.search') {
    const search = String(query.query || '').trim();
    const limit = Math.max(1, Math.min(Number(query.limit) || 20, 20));
    if (!search || search.length > 200) throw httpError(422, `Step ${id} needs a 1-200 character communications search`);
    return { id, kind, purpose, query: search, limit };
  }
  if (kind === 'weather.lookup') {
    const location = String(query.location || '').trim();
    if (location.length < 2 || location.length > 120) throw httpError(422, `Step ${id} needs a 2-120 character weather location`);
    return { id, kind, purpose, location };
  }
  if (kind !== 'sql.read') throw httpError(422, `Step ${id} uses an unavailable operation: ${kind}`);
  const sql = String(query.sql || '').trim();
  if (!sql || sql.length > MAX_SQL) throw httpError(422, `Query ${id} is empty or too long`);

  const valid = validateSql(sql, { expectedParams: 0 });
  if (!valid.ok) throw httpError(422, `Query ${id} was refused: ${valid.error}`, valid.detail);

  const lower = sql.toLowerCase();
  const denied = ASSISTANT_DENIED.find((name) => new RegExp(`\\b${name}\\b`, 'i').test(lower));
  if (denied) throw httpError(422, `Query ${id} asks for a field the assistant may not read: ${denied}`);

  const limit = sqlLimit(sql);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) {
    throw httpError(422, `Query ${id} must end with LIMIT 1-${MAX_ROWS}`);
  }
  if (valid.tables.includes('log')) {
    const hasBound = /\blog_date\s+(?:between|>=|>|=)/i.test(sql)
      || /\blog_date\s*<\s*(?:date|now|current_)/i.test(sql);
    if (!hasBound) throw httpError(422, `Query ${id} must put a concrete lower date bound on log.log_date`);
  }
  if (valid.tables.includes('email_log') && !/\bprocessed_at\s+(?:between|>=|>|=)/i.test(sql)) {
    throw httpError(422, `Query ${id} must put a concrete lower date bound on email_log.processed_at`);
  }
  return { id, kind, purpose, sql, tables: valid.tables };
}

function validatePlan(raw) {
  const rawSteps = raw && (raw.steps || raw.queries); // v1 repair tolerance
  if (!raw || raw.action !== 'query' || !Array.isArray(rawSteps)) {
    throw httpError(422, 'The assistant did not return a query plan');
  }
  if (rawSteps.length < 1 || rawSteps.length > MAX_STEPS) {
    throw httpError(422, `A plan needs 1-${MAX_STEPS} read steps`);
  }
  const steps = rawSteps.map(validateStep);
  if (new Set(steps.map((q) => q.id)).size !== steps.length) {
    throw httpError(422, 'Step ids must be unique');
  }
  if (new Set(steps.map(stepFingerprint)).size !== steps.length) {
    throw httpError(422, 'A plan cannot repeat the same read operation');
  }
  return {
    summary: String(raw.summary || 'Search the selected firm records.').trim().slice(0, 1000),
    steps,
  };
}

function stepFingerprint(step) {
  const kind = String(step && step.kind || '');
  if (kind === 'sql.read') return `${kind}:${String(step.sql || '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
  if (kind === 'weather.lookup') return `${kind}:${String(step.location || '').trim().toLowerCase()}`;
  return `${kind}:${String(step && step.query || '').replace(/\s+/g, ' ').trim().toLowerCase()}` +
    (kind === 'comms.search' ? `:${Number(step.limit) || 20}` : '');
}

function renumberPlan(plan, offset = 0) {
  return {
    summary: plan.summary,
    steps: plan.steps.map((step, index) => ({ ...step, id: `q${offset + index + 1}` })),
  };
}

const APPT_LOCAL_DATETIME_KEYS = new Set([
  'appt_date', 'appt_end', 'appt_date_local', 'appt_end_local',
]);

function scalar(value, cap, key = '') {
  if (value == null) return null;
  let text;
  if (value instanceof Date) {
    const iso = value.toISOString();
    if (APPT_LOCAL_DATETIME_KEYS.has(String(key).toLowerCase())) {
      text = `${iso.slice(0, 19).replace('T', ' ')} (firm-local wall time; ${FIRM_TZ}; not UTC)`;
    } else if (String(key).toLowerCase() === 'appt_date_utc') {
      text = `${iso} (UTC)`;
    } else {
      text = iso;
    }
  }
  else if (Buffer.isBuffer(value)) text = `[binary ${value.length} bytes]`;
  else if (typeof value === 'object') {
    try { text = JSON.stringify(value); } catch (_) { text = String(value); }
  } else text = String(value);
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function compactRows(rows, cellCap = MODEL_CELL_CHARS) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row || {})) out[key] = scalar(value, cellCap, key);
    return out;
  });
}

function trimEvidence(evidence) {
  let current = evidence;
  while (JSON.stringify(current).length > MAX_EVIDENCE_CHARS) {
    const target = [...current].reverse().find((q) => q.rows.length > 1);
    if (!target) break;
    target.rows.pop();
    target.truncated_for_ai = true;
  }
  return current;
}

async function plan(db, { question, history, userId, modelMode, temporaryAttachments, documentIds, workspaceContext } = {}) {
  const q = String(question || '').trim();
  if (!q) throw httpError(400, 'Ask a question first');
  if (q.length > MAX_QUESTION) throw httpError(400, `Question is too long (${MAX_QUESTION} character limit)`);
  const hist = cleanHistory(history);
  const mode = attachmentService.modelMode(modelMode);
  const attached = await attachmentService.preparePlan(db, {
    temporary: temporaryAttachments, documentIds,
  });
  const workspace = await validateWorkspaceContext(db, workspaceContext);
  const contextual = attached.claims.length ? null : contextualAnswer(q, hist);
  if (contextual) return { outcome: 'answer', answer: contextual, suggestions: [], callId: null, model_mode: mode };
  const viewer = await loadViewer(db, userId);
  const ai = await aiService.call(db, {
    promptKey: 'assistant_plan',
    userInput: `${currentContext(viewer, workspace)}\n\n` +
      `CONVERSATION:\n${historyText(hist)}\n\nATTACHED FILES:\n${attached.description}\n\nCURRENT QUESTION:\n${q}`,
    attachments: attached.blocks,
    model: attachmentService.modelForMode(mode),
    outputType: 'json', timeout_ms: PLAN_TIMEOUT_MS,
    consumerRef: `assistant_plan:u${Number(userId) || 0}`,
    logContent: false,
  });
  if (!ai.ok) throw httpError(502, 'The assistant planner could not be reached', ai.detail || ai.error);
  const raw = ai.json || {};
  if (raw.action === 'answer') {
    const answer = String(raw.answer || '').trim();
    if (!answer) throw httpError(422, 'The assistant returned an empty answer');
    return { outcome: 'answer', answer, suggestions: normalizeSuggestions(raw.suggestions || raw.suggestion), destinations: normalizeDestinations(raw.destinations), callId: ai.callId, model_mode: mode };
  }
  if (raw.action === 'refuse') {
    return {
      outcome: 'refused',
      reason: String(raw.reason || 'The available records cannot answer that safely.'),
      suggestions: normalizeSuggestions(raw.suggestions || raw.suggestion),
      destinations: normalizeDestinations(raw.destinations),
      callId: ai.callId, model_mode: mode,
    };
  }
  const built = renumberPlan(validatePlan(raw));
  const signed = ticket.sign({
    v: 1, uid: Number(userId), question: q, history: hist, model_mode: mode,
    viewer, workspace, attachments: attached.claims, plan: { action: 'query', ...built },
  });
  return {
    outcome: 'plan', ...built, ticket: signed, callId: ai.callId, model_mode: mode,
    investigation: { max_rounds: MAX_INVESTIGATION_ROUNDS, max_steps: MAX_INVESTIGATION_STEPS },
  };
}

function firstValue(row, keys) {
  for (const key of keys) if (row && row[key] != null && String(row[key]).trim()) return String(row[key]);
  return '';
}

function matchingValue(row, patterns) {
  for (const [key, value] of Object.entries(row || {})) {
    if (value == null || !String(value).trim()) continue;
    if (patterns.some((pattern) => pattern.test(String(key).toLowerCase()))) return String(value);
  }
  return '';
}

function actionsForRow(row) {
  const actions = [];
  const add = (kind, idKeys, idPatterns, labelKeys, fallback) => {
    const id = firstValue(row, idKeys) || matchingValue(row, idPatterns);
    if (!id || actions.some((a) => a.kind === kind && a.id === id)) return;
    actions.push({ kind, id, label: firstValue(row, labelKeys) || `${fallback} ${id}` });
  };
  add('case', ['case_id', 'appt_case_id', 'task_case_id', 'related_case_id'], [/(?:^|_)case_id$/], ['case_number_full', 'case_number', 'case_display', 'case_caption'], 'Case');
  add('contact', ['contact_id', 'client_id', 'appt_client_id', 'case_relate_client_id', 'related_contact_id'], [/(?:^|_)(?:contact|client)_id$/], ['contact_name', 'client_name', 'name'], 'Contact');
  add('appointment', ['appt_id', 'appointment_id'], [/(?:^|_)(?:appt|appointment)_id$/], ['appt_type', 'appointment_type'], 'Appointment');
  add('event', ['event_id', 'calendar_event_id'], [/(?:^|_)event_id$/], ['event_title', 'event_type'], 'Event');
  add('task', ['task_id', 'linked_task_id'], [/(?:^|_)task_id$/], ['task_title', 'task_name', 'title'], 'Task');
  return actions.slice(0, 5);
}

function actionsForEvidence(evidence) {
  const out = [];
  for (const query of evidence || []) {
    for (const row of query.rows || []) {
      for (const action of actionsForRow(row)) {
        if (!out.some((a) => a.kind === action.kind && a.id === action.id)) out.push(action);
        if (out.length >= 24) return out;
      }
    }
  }
  return out;
}

function validateTicket(payload, userId) {
  if (!payload || payload.v !== 1 || Number(payload.uid) !== Number(userId)) {
    throw httpError(403, 'This query plan belongs to a different signed-in user');
  }
  const question = String(payload.question || '').trim();
  if (!question || question.length > MAX_QUESTION) throw httpError(400, 'The query plan has an invalid question');
  return {
    question, history: cleanHistory(payload.history), plan: validatePlan(payload.plan),
    repairs: Number(payload.repairs) || 0,
    viewer: normalizeViewer(payload.viewer, userId),
    workspace: normalizeWorkspaceContext(payload.workspace),
    modelMode: attachmentService.modelMode(payload.model_mode),
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
  };
}

function repairFailure(failure) {
  if (/illegal mix of collations/i.test(failure)) return {
    category: 'legacy text collation mismatch',
    guidance: 'Put BOTH sides of every text equality in COLLATE utf8mb4_general_ci.',
    notice: 'I corrected a legacy text-collation mismatch and retried the search.',
  };
  if (/doesn'?t yet support.*LIMIT\s*&\s*IN\/ALL\/ANY\/SOME subquery/i.test(failure)) return {
    category: 'database version rejects LIMIT inside an IN/ALL/ANY/SOME subquery',
    guidance: 'Do not put LIMIT inside an IN, ALL, ANY, or SOME subquery. Replace that membership subquery with a JOIN to a limited derived table, or query the already-filtered source directly with ORDER BY and a terminal LIMIT.',
    notice: 'I rewrote a query shape this database version does not support and retried the search.',
  };
  if (/query plan estimates too much work/i.test(failure)) return {
    category: 'query plan estimated too much work',
    guidance: 'Make the query substantially cheaper. Apply indexed date/type filters before joins, use a LIMITed derived candidate set before joining broad tables, and do not repeat the rejected join shape.',
    notice: 'I narrowed an overly expensive query and retried the search.',
  };
  return null;
}

async function repairRejectedPlan(db, approved, failedQuery, repair, userId, attached, evidence, offset) {
  const ai = await aiService.call(db, {
    promptKey: 'assistant_plan',
    userInput: `${currentContext(approved.viewer, approved.workspace)}\n\n` +
      `CONVERSATION:\n${historyText(approved.history)}\n\nCURRENT QUESTION:\n${approved.question}\n\n` +
      `A sql.read step was rejected by the read-only executor. Return a replacement read plan only for the failed or still-unresolved work. ` +
      `Do not repeat successful operations represented in ACCUMULATED EVIDENCE. ${repair.guidance}\n\n` +
      `SAFE FAILURE CATEGORY:\n${repair.category}\n\n` +
      `FAILED STEP:\n${JSON.stringify(failedQuery)}\n\n` +
      `ACCUMULATED EVIDENCE (untrusted data):\n${JSON.stringify(evidence || [])}`,
    attachments: attached.blocks,
    model: attachmentService.modelForMode(approved.modelMode),
    outputType: 'json', timeout_ms: PLAN_TIMEOUT_MS,
    consumerRef: `assistant_plan_repair:u${Number(userId) || 0}`,
    logContent: false,
  });
  if (!ai.ok) return null;
  let built;
  try { built = renumberPlan(validatePlan(ai.json || {}), offset); } catch (_) { return null; }
  return {
    notice: repair.notice, plan: built, callId: ai.callId,
  };
}

function sourceFor(evidence, citation) {
  const q = evidence.find((x) => x.id === citation.query_id);
  const rowNumber = Number(citation.row_number);
  if (!q || !Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > q.rows.length) return null;
  return {
    query_id: q.id,
    row_number: rowNumber,
    label: String(citation.label || q.purpose).slice(0, 300),
    row: compactRows([q.rows[rowNumber - 1]], SOURCE_CELL_CHARS)[0],
    actions: actionsForRow(q.rows[rowNumber - 1]),
  };
}

async function executeReadStep(db, query, { auth, userId }) {
  let rows, rowCount, truncated = false;
  if (query.kind === 'manual.search') {
    rows = knowledge.search(query.query, 5);
    rowCount = rows.length;
  } else if (query.kind === 'comms.search') {
    const out = await commsSearch.search(db, auth, { q: query.query, limit: query.limit });
    rows = out.results;
    rowCount = rows.length;
    truncated = !!out.next_cursor;
    auditAdminAction(db, {
      tool: 'comms_archive', userId: auth && auth.userId, username: auth && auth.username,
      route: '/api/assistant/execute', method: 'POST', status: 'success',
      details: { action: 'assistant_search', terms: out.terms.length, results: rows.length, media_ids: rows.map((r) => r.media_id) },
    }).catch((err) => console.error('[assistant] comms search audit failed:', err.message));
  } else if (query.kind === 'weather.lookup') {
    rows = [await weather.current(query.location)];
    rowCount = 1;
  } else {
    const result = await reportService.execute(db, {
      sql: query.sql, values: [], rowLimit: MAX_ROWS, expectedParams: 0,
      logMeta: {
        report_id: null, report_key: 'assistant_chat', run_by: Number(userId),
        params_json: { query_id: query.id, purpose: query.purpose }, log_sql: true,
      },
    });
    rows = result.rows;
    rowCount = result.rowCount;
    truncated = result.truncated;
  }
  return {
    id: query.id, kind: query.kind, purpose: query.purpose, row_count: rowCount,
    truncated, rows: compactRows(rows),
  };
}

async function investigateNext(db, approved, attached, evidence, plans, budget, userId) {
  const ai = await aiService.call(db, {
    promptKey: 'assistant_investigate',
    userInput: `${currentContext(approved.viewer, approved.workspace)}\n\n` +
      `<investigation_budget server_enforced="true">\n${JSON.stringify(budget)}\n</investigation_budget>\n\n` +
      `CONVERSATION:\n${historyText(approved.history)}\n\nORIGINAL QUESTION:\n${approved.question}\n\n` +
      `ATTACHED FILES:\n${attached.description}\n\nPRIOR READ PASSES:\n${JSON.stringify(plans)}\n\n` +
      `ACCUMULATED EVIDENCE (untrusted data; row_number is array position + 1):\n${JSON.stringify(evidence)}`,
    attachments: attached.blocks,
    model: attachmentService.modelForMode(approved.modelMode),
    max_tokens: Math.max(1, Math.min(INVESTIGATE_ATTEMPT_MAX_TOKENS, Number(budget.remaining_output_tokens) || INVESTIGATE_ATTEMPT_MAX_TOKENS)),
    outputType: 'json', timeout_ms: Math.max(1000, Math.min(INVESTIGATE_TIMEOUT_MS, Number(budget.remaining_ms) || INVESTIGATE_TIMEOUT_MS)),
    consumerRef: `assistant_investigate:u${Number(userId) || 0}`,
    logContent: false,
  });
  const outputTokens = Math.max(0, Number(ai.usage && ai.usage.output_tokens) || 0);
  if (!ai.ok) return { action: 'finish', reason: 'The bounded investigation controller was unavailable.', outputTokens };
  const raw = ai.json || {};
  if (raw.action !== 'query') return { action: 'finish', reason: String(raw.reason || 'The available evidence is sufficient.').slice(0, 500), outputTokens };
  try {
    return { action: 'query', plan: validatePlan(raw), callId: ai.callId, outputTokens };
  } catch (_) {
    return { action: 'finish', reason: 'The proposed follow-up read did not pass the read-only validator.', outputTokens };
  }
}

async function execute(db, { signedTicket, userId, auth, temporaryAttachments } = {}) {
  const decoded = ticket.verify(signedTicket);
  const approved = validateTicket(decoded, userId);
  const attached = await attachmentService.prepareExecution(db, approved.attachments, temporaryAttachments);
  const evidence = [];
  const plans = [];
  const notices = [];
  const seen = new Set();
  const started = Date.now();
  let currentPlan = renumberPlan(approved.plan);
  let rounds = 0;
  let totalSteps = 0;
  let totalRows = 0;
  let repairs = approved.repairs;
  let controllerOutputTokens = 0;
  let stopReason = 'model_finished';

  investigation: while (rounds < MAX_INVESTIGATION_ROUNDS) {
    if (Date.now() - started >= MAX_INVESTIGATION_MS) {
      stopReason = 'time_budget';
      break;
    }
    rounds += 1;
    if (currentPlan.steps.length > MAX_INVESTIGATION_STEPS - totalSteps) {
      stopReason = 'step_budget';
      break;
    }
    plans.push({ round: rounds, summary: currentPlan.summary, steps: currentPlan.steps.map((step) => ({ id: step.id, kind: step.kind, purpose: step.purpose })) });

    for (const query of currentPlan.steps) {
      if (Date.now() - started >= MAX_INVESTIGATION_MS) {
        stopReason = 'time_budget';
        break investigation;
      }
      const fingerprint = stepFingerprint(query);
      if (seen.has(fingerprint)) {
        stopReason = 'repeated_query';
        break investigation;
      }
      seen.add(fingerprint);
      totalSteps += 1;
      let result;
      try {
        result = await executeReadStep(db, query, { auth, userId });
      } catch (err) {
        const repair = repairFailure(String(err && err.message));
        if (repairs < 1 && repair && rounds < MAX_INVESTIGATION_ROUNDS && totalSteps < MAX_INVESTIGATION_STEPS) {
          const repaired = await repairRejectedPlan(db, approved, query, repair, userId, attached, evidence, totalSteps);
          if (repaired) {
            repairs += 1;
            notices.push(repaired.notice);
            currentPlan = repaired.plan;
            continue investigation;
          }
        }
        if (repair) throw httpError(422, 'The assistant could not repair this read-only search automatically. Try asking the question a different way.');
        if (err && err.status === 400) {
          throw httpError(422, 'The generated read-only search could not run. Try rephrasing the question; developers can inspect the saved query log.');
        }
        throw err;
      }
      result.round = rounds;
      const rowRoom = Math.max(0, MAX_INVESTIGATION_ROWS - totalRows);
      if (result.rows.length > rowRoom) {
        result.rows = result.rows.slice(0, rowRoom);
        result.truncated = true;
        result.truncated_for_budget = true;
      }
      evidence.push(result);
      totalRows += result.rows.length;
      trimEvidence(evidence);
      if (totalRows >= MAX_INVESTIGATION_ROWS) {
        stopReason = 'row_budget';
        break investigation;
      }
      if (Date.now() - started >= MAX_INVESTIGATION_MS) {
        stopReason = 'time_budget';
        break investigation;
      }
    }

    if (rounds >= MAX_INVESTIGATION_ROUNDS) {
      stopReason = 'round_budget';
      break;
    }
    const remainingSteps = MAX_INVESTIGATION_STEPS - totalSteps;
    if (remainingSteps < 1) {
      stopReason = 'step_budget';
      break;
    }
    const remainingOutputTokens = MAX_INVESTIGATION_OUTPUT_TOKENS - controllerOutputTokens;
    if (remainingOutputTokens < 1) {
      stopReason = 'token_budget';
      break;
    }
    const decision = await investigateNext(db, approved, attached, evidence, plans, {
      round: rounds,
      remaining_rounds: MAX_INVESTIGATION_ROUNDS - rounds,
      remaining_steps: remainingSteps,
      remaining_rows: Math.max(0, MAX_INVESTIGATION_ROWS - totalRows),
      remaining_ms: Math.max(0, MAX_INVESTIGATION_MS - (Date.now() - started)),
      remaining_output_tokens: remainingOutputTokens,
      prior_operation_fingerprints: [...seen],
    }, userId);
    controllerOutputTokens += decision.outputTokens || 0;
    if (decision.action !== 'query') {
      stopReason = 'model_finished';
      break;
    }
    if (decision.plan.steps.length > remainingSteps) {
      stopReason = 'step_budget';
      break;
    }
    const nextPlan = renumberPlan(decision.plan, totalSteps);
    if (nextPlan.steps.some((step) => seen.has(stepFingerprint(step)))) {
      stopReason = 'repeated_query';
      break;
    }
    currentPlan = nextPlan;
  }

  const ai = await aiService.call(db, {
    promptKey: 'assistant_answer',
    userInput: `${currentContext(approved.viewer, approved.workspace)}\n\nCONVERSATION:\n${historyText(approved.history)}\n\nQUESTION:\n${approved.question}\n\n` +
      `ATTACHED FILES:\n${attached.description}\n\nREAD PASSES:\n${JSON.stringify(plans)}\n\n` +
      `INVESTIGATION STOP:\n${JSON.stringify({ reason: stopReason, rounds, total_steps: totalSteps, returned_rows: totalRows })}\n\n` +
      `EVIDENCE (row_number is array position + 1):\n${JSON.stringify(evidence)}`,
    attachments: attached.blocks,
    model: attachmentService.modelForMode(approved.modelMode),
    outputType: 'json', timeout_ms: ANSWER_TIMEOUT_MS,
    consumerRef: `assistant_answer:u${Number(userId) || 0}`,
    logContent: false,
  });
  if (!ai.ok) throw httpError(502, 'The assistant could not summarize the query results', ai.detail || ai.error);
  const body = ai.json || {};
  let answer = String(body.answer || '').trim();
  if (!answer) throw httpError(422, 'The assistant returned an empty answer');
  const citations = Array.isArray(body.citations) ? body.citations : [];
  const sources = citations.map((c) => sourceFor(evidence, c || {})).filter(Boolean).slice(0, 12);
  const draftRequested = taskDraftRequested(approved.question, approved.history);
  let actionDraft = null;
  let draftStatus = draftRequested ? 'unavailable' : 'not_requested';
  if (draftRequested) {
    let rejection = null;
    try {
      actionDraft = await normalizeActionDraft(db, body.action_draft, evidence, { currentUserId: userId });
      if (!actionDraft) rejection = httpError(422, 'The action_draft field was absent');
    } catch (err) {
      rejection = err;
    }
    if (rejection) {
      actionDraft = await repairActionDraft(db, approved, evidence, body.action_draft, rejection, userId);
      draftStatus = actionDraft ? 'repaired' : 'unavailable';
    } else {
      draftStatus = 'ready';
    }
    // Never let prose claim that a card exists when the typed, server-validated
    // payload that renders it is absent.
    if (!actionDraft) answer = unavailableTaskDraftAnswer();
  }
  return {
    answer,
    suggestions: normalizeSuggestions(body.suggestions || body.suggested_follow_up),
    destinations: normalizeDestinations(body.destinations),
    entities: actionsForEvidence(evidence),
    sources,
    ...(actionDraft ? { action_draft: actionDraft } : {}),
    steps: evidence.map((q) => ({ id: q.id, round: q.round, kind: q.kind, purpose: q.purpose, row_count: q.row_count, returned: q.rows.length, truncated: q.truncated || !!q.truncated_for_ai })),
    investigation: { rounds, total_steps: totalSteps, returned_rows: totalRows, controller_output_tokens: controllerOutputTokens, stop_reason: stopReason, repairs, notices,
      action_draft_status: draftStatus, task_draft_status: draftStatus },
    callId: ai.callId, model_mode: approved.modelMode,
  };
}

module.exports = {
  plan, execute, validatePlan, validateStep, cleanHistory, compactRows,
  normalizeSuggestions, contextualAnswer, actionsForRow, actionsForEvidence,
  normalizeWorkspaceContext, validateWorkspaceContext, normalizeDestinations,
  normalizeActionDraft, taskDraftRequested, unavailableTaskDraftAnswer, repairActionDraft,
  repairFailure, loadViewer, normalizeViewer, stepFingerprint, renumberPlan,
  MAX_STEPS, MAX_ROWS, MAX_INVESTIGATION_ROUNDS, MAX_INVESTIGATION_STEPS,
  MAX_INVESTIGATION_ROWS, MAX_INVESTIGATION_MS, MAX_INVESTIGATION_OUTPUT_TOKENS,
  ASSISTANT_DENIED,
};
