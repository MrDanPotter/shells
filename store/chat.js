'use strict';

// The chat stream — the conversational thread between the human (front end) and the
// agent. It is SEPARATE from the message store (the decision/task/knowledge/
// notification queues): chat is an append-only transcript with no open/close
// lifecycle, the store holds the durable artifacts.
//
// It is bidirectional. The front end appends the human's turns (role 'user', written
// by reference/server.js on POST /api/inbox). The agent appends short replies (role
// 'agent') via `shells.js store say`, optionally carrying `links` — ids of store
// messages it just created — so the front end can render them as click-to-open
// jump-offs. The substance still lives in those linked store messages; the chat
// reply is the one- or two-line "here's what I did, here's where it is".

const fs = require('fs');
const path = require('path');
const { chatLogFile, inboxDir } = require('../kernel/lib/paths');
const { atomicWrite, readJson } = require('../kernel/lib/atomic');

const CAP = 200;   // keep only the tail in the transcript; the store is the durable record

function rid(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

function readChat(limit) {
  const log = readJson(chatLogFile(), []);
  return limit ? log.slice(-limit) : log;
}

function appendChat(rec) {
  const log = readJson(chatLogFile(), []);
  log.push(rec);
  atomicWrite(chatLogFile(), JSON.stringify(log.slice(-CAP), null, 2) + '\n');
  return rec;
}

// Drop a file into the delivery inbox (state/inbox/) so the watcher/gate hand the
// text to the session. Filename ordering == arrival order (lexicographic).
function dropInbox(text) {
  const now = new Date().toISOString();
  const id = rid('i');
  fs.mkdirSync(inboxDir(), { recursive: true });
  atomicWrite(path.join(inboxDir(), `${now.replace(/[:.]/g, '-')}-${id}.json`),
    JSON.stringify({ id, text, sent_at: now }, null, 2) + '\n');
  return id;
}

// The agent's side: a short reply into the chat stream. `links` is a list of store
// message ids (strings) — the front end resolves each to its kind/title and makes it
// clickable. Kept permissive: unknown/closed ids are fine (they still resolve, or
// degrade to a plain chip), because a link should never be able to fail a `say`.
function say({ text, links } = {}) {
  const body = String(text || '').trim();
  if (!body) throw new Error('say: text is required');
  const rec = {
    id: rid('c'),
    role: 'agent',
    text: body,
    links: Array.isArray(links) ? links.filter(x => typeof x === 'string' && x) : [],
    sent_at: new Date().toISOString()
  };
  return appendChat(rec);
}

// A message injected by an agent system OUTSIDE this session's bidirectional loop —
// not the human, not this agent. It shows in the chat stream under its own role so a
// front end can render it distinctly. `source` optionally names the origin system.
function external({ text, links, source } = {}) {
  const body = String(text || '').trim();
  if (!body) throw new Error('external: text is required');
  const rec = {
    id: rid('c'),
    role: 'external-agent',
    source: source ? String(source).slice(0, 60) : '',
    text: body,
    links: Array.isArray(links) ? links.filter(x => typeof x === 'string' && x) : [],
    sent_at: new Date().toISOString()
  };
  appendChat(rec);
  // Also DELIVER it to the session inbox so the agent can react — labeled so it is
  // never mistaken for the human. Chat keeps the clean body; delivery carries the label.
  dropInbox(`[external-agent${rec.source ? ' · ' + rec.source : ''}] ${body}`);
  return rec;
}

module.exports = { readChat, appendChat, say, external, dropInbox, rid, CAP };
