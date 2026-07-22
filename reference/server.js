#!/usr/bin/env node
'use strict';

// Reference client — a plain, throwaway front end implementing protocol.md.
//
// This is deliberately NOT meant to be used as-is. It exists so a real front end
// can be checked against something that works: read protocol.md, build your own
// server (any language, any framework), and diff its behaviour against this one if
// something doesn't line up. There is no CSS to speak of and no attempt at a good
// UI — that's the point.
//
// Zero dependencies: Node's http module only. Local-only by design: binds to
// 127.0.0.1 with no auth. This kit has no reason to ever be reachable off the
// machine it runs on — if you build a real front end and it needs to be, that is
// your problem to solve deliberately, not something to inherit by accident here.
//
//   node reference/server.js            -> http://127.0.0.1:4390
//   PORT=xxxx node reference/server.js  -> override

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('../store/store');
const { inboxDir, chatLogFile, ROOT } = require('../kernel/lib/paths');
const { computeStatus, readActivity } = require('../kernel/lib/activity');
const { watcherStatus } = require('../kernel/lib/watcher-status');
const { atomicWrite, readJson } = require('../kernel/lib/atomic');

const PORT = process.env.PORT || 4390;
const HOST = process.env.HOST || '127.0.0.1';
const ID_RE = /^[A-Za-z0-9._-]+$/;

// --- staleness signal #2: is THIS process running the code on disk? -------
// Two different things can be stale, and only one is fixed by a page reload:
//   - `ui` changing means the embedded page below changed — reload picks it up.
//   - `server_stale` means server.js on disk differs from what THIS process
//     booted with — reloading the page does nothing; the process itself needs a
//     restart. Captured once at boot so later edits are detectable at all.
function fileSig(p) { try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return '0'; } }
const SERVER_SIG_AT_START = fileSig(__filename);

function send(res, code, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8` });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Escape BEFORE formatting. User-supplied and agent-supplied text alike get
// rendered as literal text in the embedded page below — never interpolated as
// HTML/markdown first and escaped after, which is the order that lets a stray
// "<" or "*" quietly break the page or, worse, inject markup.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- chat log (inbox history, for display only — delivery is file-based) ---
function appendChatLog(rec) {
  const log = readJson(chatLogFile(), []);
  log.push(rec);
  atomicWrite(chatLogFile(), JSON.stringify(log.slice(-200), null, 2) + '\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // --- messages -----------------------------------------------------------

    if (req.method === 'GET' && p === '/api/messages') {
      return send(res, 200, store.list({ all: url.searchParams.get('all') === '1' }));
    }

    if (req.method === 'POST' && /^\/api\/messages\/[^/]+\/respond$/.test(p)) {
      const id = decodeURIComponent(p.split('/')[3]);
      if (!ID_RE.test(id)) return send(res, 400, { error: 'bad id' });
      const body = JSON.parse((await readBody(req)) || '{}');
      try { return send(res, 200, store.respond(id, body)); }
      catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    }

    if (req.method === 'POST' && /^\/api\/messages\/[^/]+\/read$/.test(p)) {
      const id = decodeURIComponent(p.split('/')[3]);
      if (!ID_RE.test(id)) return send(res, 400, { error: 'bad id' });
      try { return send(res, 200, store.markRead(id)); }
      catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    }

    // Undo a close. See store/json-store.js reopen() — closing must always be
    // reversible, because an answer can be destroyed before anyone reads it.
    if (req.method === 'POST' && /^\/api\/messages\/[^/]+\/reopen$/.test(p)) {
      const id = decodeURIComponent(p.split('/')[3]);
      if (!ID_RE.test(id)) return send(res, 400, { error: 'bad id' });
      try { return send(res, 200, store.reopen(id)); }
      catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    }

    // --- inbox (inbound, chat-style) -----------------------------------------

    if (req.method === 'GET' && p === '/api/inbox') {
      return send(res, 200, readJson(chatLogFile(), []).slice(-50));
    }

    if (req.method === 'POST' && p === '/api/inbox') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'empty message' });

      const rec = { id: `i-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, sent_at: new Date().toISOString() };
      fs.mkdirSync(inboxDir(), { recursive: true });
      // Filename ordering IS delivery ordering — keep it lexicographically sortable.
      atomicWrite(path.join(inboxDir(), `${rec.sent_at.replace(/[:.]/g, '-')}-${rec.id}.json`),
        JSON.stringify(rec, null, 2) + '\n');
      appendChatLog(rec);
      return send(res, 200, rec);
    }

    // --- activity / staleness -------------------------------------------------

    if (req.method === 'GET' && p === '/api/activity') {
      return send(res, 200, computeStatus(readActivity()));
    }

    if (req.method === 'GET' && p === '/api/watcher') {
      return send(res, 200, watcherStatus());
    }

    if (req.method === 'GET' && p === '/api/version') {
      return send(res, 200, { server_stale: fileSig(__filename) !== SERVER_SIG_AT_START });
    }

    // --- a deliberately plain page --------------------------------------------

    if (req.method === 'GET' && p === '/') {
      const messages = store.list({ all: true });
      const rows = messages.map(m => `
        <li>
          <b>[${esc(m.kind)}]</b> ${esc(m.title)} <i>(${esc(m.status)})</i><br>
          ${esc(m.body)}
          ${m.options.length ? `<br>options: ${m.options.map(esc).join(', ')}` : ''}
          ${m.chosen ? `<br>chosen: ${esc(m.chosen)}` : ''}
          ${m.response ? `<br>reply: ${esc(m.response)}` : ''}
          <form method="POST" action="/ui/act">
            <input type="hidden" name="id" value="${esc(m.id)}">
            ${m.kind === 'decision' && m.status === 'open' ? `
              <button name="verdict" value="approved">Approve</button>
              <input name="response" placeholder="revise note...">
              <button name="verdict" value="revised">Send back</button>` : ''}
            ${m.kind === 'task' && m.status === 'open' ? `<button name="verdict" value="done">Mark done</button>` : ''}
            ${(m.kind === 'knowledge' || m.kind === 'notification') && m.status === 'open'
              ? `<button name="verdict" value="read">Mark read</button>` : ''}
            ${m.status === 'closed' ? `<button name="verdict" value="reopen">Reopen</button>` : ''}
          </form>
        </li>`).join('\n');

      return send(res, 200, `<!doctype html><meta charset="utf-8">
<title>shells reference client</title>
<h1>shells — reference client (throwaway)</h1>
<p>This page is intentionally plain. It exists to prove protocol.md is enough to
build a front end from — read that file, not this one, before building a real one.</p>
<h2>Send an inbox message</h2>
<form method="POST" action="/ui/send">
  <input name="text" placeholder="message to the session" size="60">
  <button>Send</button>
</form>
<h2>Messages</h2>
<ul>${rows || '<li>(none)</li>'}</ul>
`, 'text/html');
    }

    // Tiny form-post shims so the plain page above needs no client JS at all.
    if (req.method === 'POST' && p === '/ui/send') {
      const body = await readBody(req);
      const text = String(new URLSearchParams(body).get('text') || '').trim();
      if (text) {
        const rec = { id: `i-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, sent_at: new Date().toISOString() };
        fs.mkdirSync(inboxDir(), { recursive: true });
        atomicWrite(path.join(inboxDir(), `${rec.sent_at.replace(/[:.]/g, '-')}-${rec.id}.json`), JSON.stringify(rec, null, 2) + '\n');
        appendChatLog(rec);
      }
      res.writeHead(302, { Location: '/' }); return res.end();
    }

    if (req.method === 'POST' && p === '/ui/act') {
      const body = await readBody(req);
      const form = new URLSearchParams(body);
      const id = form.get('id');
      const verdict = form.get('verdict');
      try {
        if (verdict === 'read') store.markRead(id);
        else if (verdict === 'reopen') store.reopen(id);
        else store.respond(id, { verdict, response: form.get('response') || '' });
      } catch { /* surfaced nowhere on this throwaway page — check the JSON API for real errors */ }
      res.writeHead(302, { Location: '/' }); return res.end();
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`shells reference client -> http://${HOST}:${PORT}  (local only, ^C to stop)`);
});
