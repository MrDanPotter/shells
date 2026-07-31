'use strict';

// Issues — a first-class object in the shells store, distinct from the four message
// kinds and from chat. An Issue is a CONTAINER/thread, not a leaf message: it has a
// title + description, an open/closed lifecycle, a set of `links` to other things
// (message ids, other issue ids), and — via store/chat.js keyed by its id — its own
// chat stream. Other records (messages, chat replies) point back at an issue through
// their `issue` field, so an Issue is really a lens over everything tied to it.
//
// One JSON file per issue under state/issues/, same "just files" approach as the
// message store. No lifecycle magic: an Issue is open until something explicitly
// closes it (unlike knowledge/notification which close on read).

const fs = require('fs');
const path = require('path');
const { issuesDir } = require('../kernel/lib/paths');
const { atomicWrite, readJson } = require('../kernel/lib/atomic');

function file(id) { return path.join(issuesDir(), id + '.json'); }
function rid() { return 'iss-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

function create({ title, body, links, image, origin } = {}) {
  const t = String(title || '').trim();
  if (!t) throw new Error('issue: title is required');
  const now = new Date().toISOString();
  const rec = {
    id: rid(),
    title: t,
    body: String(body || ''),
    status: 'open',
    links: Array.isArray(links) ? links.filter(x => typeof x === 'string' && x) : [],
    image: image || null,          // a screenshot path, when opened from the inspect tool
    origin: origin || null,        // e.g. 'chat' | 'inspect'
    created_at: now,
    updated_at: now
  };
  fs.mkdirSync(issuesDir(), { recursive: true });
  atomicWrite(file(rec.id), JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

function get(id) { return readJson(file(id), null); }

function list({ all } = {}) {
  let names;
  try { names = fs.readdirSync(issuesDir()).filter(f => f.endsWith('.json')); }
  catch { return []; }
  const items = names.map(n => readJson(path.join(issuesDir(), n), null)).filter(Boolean);
  items.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return all ? items : items.filter(i => i.status !== 'closed');
}

function patch(id, p) {
  const rec = get(id);
  if (!rec) throw new Error('issue ' + id + ' not found');
  const next = { ...rec, ...p, updated_at: new Date().toISOString() };
  atomicWrite(file(id), JSON.stringify(next, null, 2) + '\n');
  return next;
}

function close(id) { return patch(id, { status: 'closed' }); }
function reopen(id) { return patch(id, { status: 'open' }); }

// Add a reference from this issue to another object (message id / issue id), idempotent.
function addLink(id, targetId) {
  const rec = get(id);
  if (!rec) throw new Error('issue ' + id + ' not found');
  if (typeof targetId === 'string' && targetId && !rec.links.includes(targetId)) {
    return patch(id, { links: [...rec.links, targetId] });
  }
  return rec;
}

module.exports = { create, get, list, patch, close, reopen, addLink, rid };
