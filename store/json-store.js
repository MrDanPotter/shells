'use strict';

// Default store implementation: one JSON file per message under state/messages/.
// No beads, no database, no dependency — just files, because that is the whole
// point of this kit. A different backend (a beads adapter, sqlite, whatever) only
// has to export the same eight functions listed in store.js.
//
// Message shape (the entire on-disk contract for one file):
//
//   {
//     id, kind,                    // kind: decision | task | knowledge | notification
//     title, body,
//     project, issue_ref,          // free-text tags a front end can group/filter by
//     options, chosen, rationale,  // decisions only: the offered options and the
//                                  // conservative default the agent already took
//     status,                     // open -> answered|done -> closed  (decision/task)
//                                  // open -> closed                   (knowledge/notification)
//     response, verdict, responded_at,  // the user's reply
//     created_at, updated_at
//   }
//
// Closing is reversible everywhere in this module: `resolve`/`markRead` only ever
// flip `status`, never delete the file. An answer a user hasn't actually read yet
// must survive an accidental close — see reopen() and protocol.md.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWrite, readJson } = require('../kernel/lib/atomic');
const { messagesDir } = require('../kernel/lib/paths');

const KINDS = new Set(['decision', 'task', 'knowledge', 'notification']);

function file(id) {
  return path.join(messagesDir(), `${id}.json`);
}

function nextId() {
  return `m-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function create(input) {
  if (!input || !KINDS.has(input.kind)) {
    throw new Error(`create: kind must be one of ${[...KINDS].join(', ')}`);
  }
  if (!input.title) throw new Error('create: "title" is required');

  // A decision the user can't act on later is noise once the front end goes stale.
  // Forcing `chosen` here is what makes "never block waiting on the user" (contract/
  // CLAUDE.fragment.md) enforceable instead of aspirational.
  if (input.kind === 'decision' && !input.chosen) {
    throw new Error('create: a decision must include "chosen" — the conservative default '
      + 'you already took. Never create a decision to ask permission; act, then log it.');
  }

  const now = new Date().toISOString();
  const msg = {
    id: nextId(),
    kind: input.kind,
    title: String(input.title),
    body: input.body ? String(input.body) : '',
    project: input.project ? String(input.project) : '',
    issue_ref: input.issue_ref ? String(input.issue_ref) : '',
    options: Array.isArray(input.options) ? input.options.map(String) : [],
    chosen: input.chosen ? String(input.chosen) : '',
    rationale: input.rationale ? String(input.rationale) : '',
    status: 'open',
    response: '',
    verdict: '',
    responded_at: '',
    created_at: now,
    updated_at: now
  };
  atomicWrite(file(msg.id), JSON.stringify(msg, null, 2) + '\n');
  return msg.id;
}

function list(opts) {
  const { kind, all } = opts || {};
  let names;
  try { names = fs.readdirSync(messagesDir()).filter(f => f.endsWith('.json')); }
  catch { return []; }

  let out = names
    .map(f => readJson(path.join(messagesDir(), f), null))
    .filter(Boolean);
  if (!all) out = out.filter(m => m.status !== 'closed');
  if (kind) out = out.filter(m => m.kind === kind);
  return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function get(id) {
  return readJson(file(id), null);
}

// Messages the agent still owes work on: the user has replied (decision -> answered)
// or marked something done (task -> done), and nobody has resolve()d it yet. This is
// exactly the set the inbound gate hook chains the turn on — see kernel/hooks/gate.js.
function listAwaiting() {
  return list({ all: true }).filter(m => m.status === 'answered' || m.status === 'done');
}

function respond(id, reply) {
  const msg = get(id);
  if (!msg) throw new Error(`respond: ${id} not found`);
  const allowed = { decision: ['approved', 'revised'], task: ['done'] }[msg.kind];
  if (!allowed) {
    throw new Error(`respond: ${msg.kind} messages are one-way — use markRead(id) instead`);
  }
  const verdict = String((reply && reply.verdict) || '');
  if (!allowed.includes(verdict)) {
    throw new Error(`respond: verdict must be one of ${allowed.join(', ')}`);
  }
  if (verdict === 'revised' && !String((reply && reply.response) || '').trim()) {
    throw new Error('respond: a pushback ("revised") needs a non-empty response saying what is wrong');
  }

  msg.verdict = verdict;
  msg.response = reply && reply.response ? String(reply.response) : '';
  msg.responded_at = new Date().toISOString();
  msg.status = msg.kind === 'decision' ? 'answered' : 'done';
  msg.updated_at = msg.responded_at;

  // An approved decision with no note is the conservative default standing as-is —
  // there is no rework, so it can close itself instead of round-tripping the agent.
  if (msg.kind === 'decision' && verdict === 'approved' && !msg.response) {
    msg.status = 'closed';
  }

  atomicWrite(file(id), JSON.stringify(msg, null, 2) + '\n');
  return msg;
}

function markRead(id) {
  const msg = get(id);
  if (!msg) throw new Error(`markRead: ${id} not found`);
  if (msg.kind !== 'knowledge' && msg.kind !== 'notification') {
    throw new Error(`markRead: only knowledge/notification are one-way; ${msg.kind} needs respond()`);
  }
  msg.status = 'closed';
  msg.updated_at = new Date().toISOString();
  atomicWrite(file(id), JSON.stringify(msg, null, 2) + '\n');
  return msg;
}

function resolve(id) {
  const msg = get(id);
  if (!msg) throw new Error(`resolve: ${id} not found`);
  if (msg.status !== 'answered' && msg.status !== 'done') {
    throw new Error(`resolve: ${id} has no reply yet — only answered/done messages can be resolved`);
  }
  msg.status = 'closed';
  msg.updated_at = new Date().toISOString();
  atomicWrite(file(id), JSON.stringify(msg, null, 2) + '\n');
  return msg;
}

// Undo a close. Cheap on purpose: dismissing something is one click (or one poll
// race — see protocol.md's note on not reflowing a list under the pointer) and it
// must be recoverable, because an answer can be destroyed before it's actually read.
function reopen(id) {
  const msg = get(id);
  if (!msg) throw new Error(`reopen: ${id} not found`);
  msg.status = (msg.kind === 'decision' || msg.kind === 'task') && msg.responded_at
    ? (msg.kind === 'decision' ? 'answered' : 'done')
    : 'open';
  msg.updated_at = new Date().toISOString();
  atomicWrite(file(id), JSON.stringify(msg, null, 2) + '\n');
  return msg;
}

module.exports = { KINDS, create, list, get, listAwaiting, respond, markRead, resolve, reopen };
