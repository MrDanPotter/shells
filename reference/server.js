#!/usr/bin/env node
'use strict';

// The included web UI — the front end shells ships with, implementing protocol.md.
//
// This is the interface a fresh install comes with ON PURPOSE: a barebones setup
// with no UI leaves the user with no idea what to do, so this ships by default
// (`--no-ui` opts out) and `shells.js dev` launches it alongside the session. It is
// still a clean, single-file implementation of protocol.md — read that file and you
// can replace this with your own front end in any stack — but it is meant to be run,
// not just diffed against. The page is styled and live: it polls the JSON API and
// re-renders, so a message the agent pushes shows up on its own within a poll
// interval — you actually see the agent talk back.
//
// Layout: one centered column — chat (what you send to the session) on top, then a
// tabbed message panel (one tab per message kind) for what the agent sends you.
//
// Every UI behaviour here is a worked example of a "bruise" from protocol.md §5:
//   - all agent/user text is rendered via textContent, never innerHTML — escape by
//     construction, so a stray "<" or "*" can never break the page;
//   - the messages list is NOT redrawn while a reply box is focused or dirty, nor
//     for a short window after you touch the list (no clobbering input, no reflow
//     under the pointer);
//   - closing anything is reversible (reopen), and the closed items stay listable;
//   - server_stale is reported honestly and separately — a reload will NOT fix a
//     stale server process, only a restart will.
//
// Zero dependencies: Node's http module only. Local-only by design: binds to
// 127.0.0.1 with no auth. This kit has no reason to be reachable off the machine it
// runs on — if a real front end of yours needs to be, that is your problem to solve
// deliberately, not something to inherit by accident here.
//
//   node reference/server.js            -> http://127.0.0.1:4420
//   PORT=xxxx node reference/server.js  -> override

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('../store/store');
const { inboxDir, chatLogFile, stateDir, ROOT } = require('../kernel/lib/paths');
const { computeStatus, readActivity } = require('../kernel/lib/activity');
const { watcherStatus } = require('../kernel/lib/watcher-status');
const { atomicWrite, readJson } = require('../kernel/lib/atomic');
const { seed } = require('../store/seed');
const chat = require('../store/chat');
const issues = require('../store/issues');

// Hardcoded default is 4420 — shells' assigned port in this workspace's port
// registry. Must never collide with another app's default; PORT is how a Fleet
// launcher (or anything else) overrides it.
const PORT = process.env.PORT || 4420;
const HOST = process.env.HOST || '127.0.0.1';
const ID_RE = /^[A-Za-z0-9._-]+$/;

// --- CORS for embedded front ends (e.g. the overlay widget) -----------------
// The overlay runs on YOUR app's origin and calls this server cross-origin, so
// the browser needs a CORS grant. We reflect the request Origin — but ONLY
// loopback origins by default (localhost / 127.0.0.1, any port), which is exactly
// the set a single-dev local setup needs and, not incidentally, defeats DNS
// rebinding: a public page pointed at 127.0.0.1 carries its OWN public Origin,
// which we refuse to echo. To embed from a non-loopback origin (a deployed page
// hitting your machine), opt in explicitly:
//   SHELLS_CORS_ORIGINS="https://my.site,https://other.site" node reference/server.js
const EXTRA_ORIGINS = new Set((process.env.SHELLS_CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean));
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function corsOrigin(origin) {
  if (!origin) return null;
  if (LOOPBACK_ORIGIN.test(origin) || EXTRA_ORIGINS.has(origin)) return origin;
  return null;
}

// Set CORS headers via setHeader so they survive the later writeHead in send()
// (writeHead merges with previously-set headers, only overriding same-named ones,
// and send() sets only Content-Type). Returns true if this was a preflight it
// fully answered — the caller then returns without routing further.
function applyCors(req, res) {
  const allow = corsOrigin(req.headers.origin);
  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Chrome's Private Network Access preflight for a public page -> local server.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
  return false;
}

// --- staleness signal #2: is THIS process running the code on disk? -------
// Two different things can be stale, and only one is fixed by a page reload:
//   - the embedded page below changing is fixed by a reload;
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

// Body cap. The old guard was 1MB enforced by req.destroy() — which killed the
// socket with no status, so the browser saw a bare "Failed to fetch" with no clue
// why. That's a strictly worse experience than a message that's simply too big
// getting a real answer. So the cap is now 25MB (~25M characters — unreachable by
// typing or by pasting a file) and going over it gets a proper HTTP 413 the UI can
// show, not a dropped connection. readBody takes `res` so it can send that answer
// before closing; it then rejects, and the top-level catch skips its own send
// because the 413's headers are already out (res.headersSent).
const MAX_BODY = 25 * 1024 * 1024;

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', c => {
      data += c;
      if (data.length > MAX_BODY && !tooBig) {
        tooBig = true;
        if (res) send(res, 413, { error: 'message too large (over 25MB)' });   // 413 when a caller passed res
        req.destroy();
        reject(new Error('message too large (over 25MB)'));
      }
    });
    req.on('end', () => { if (!tooBig) resolve(data); });
    req.on('error', err => { if (!tooBig) reject(err); });
  });
}

// A user turn: drop a file in the inbox dir (that's what actually gets DELIVERED to
// the session) AND append it to the shared chat transcript (role 'user') for display.
// Agent turns go into the same transcript via `store say` (role 'agent') — see
// store/chat.js — which is what makes the chat stream bidirectional.
function queueInbox(text) {
  const rec = { id: chat.rid('i'), role: 'user', text, sent_at: new Date().toISOString() };
  fs.mkdirSync(inboxDir(), { recursive: true });
  // Filename ordering IS delivery ordering — keep it lexicographically sortable.
  atomicWrite(path.join(inboxDir(), `${rec.sent_at.replace(/[:.]/g, '-')}-${rec.id}.json`),
    JSON.stringify(rec, null, 2) + '\n');
  chat.appendChat(rec);
  return rec;
}

// A context capture from the overlay's Inspect tool: an optional cropped PNG plus the
// element's DOM serialization. The image is written to state/context/<id>.png; the
// agent-facing DELIVERY (dropInbox) carries the DOM text + the file's absolute path so
// the agent can Read the picture; the chat DISPLAY gets a short bubble + a thumbnail URL.
function contextDir() { return path.join(stateDir(), 'context'); }
function firstLine(s) { const t = String(s || '').trim().split('\n')[0].trim(); return t.length > 80 ? t.slice(0, 80) + '…' : t; }

// Post a user turn into an ISSUE's own chat + deliver it to the agent tagged with the issue.
function postIssueChat(issueId, text) {
  const iss = issues.get(issueId);
  const title = iss ? iss.title : issueId;
  const rec = { id: chat.rid('i'), role: 'user', text, sent_at: new Date().toISOString() };
  chat.appendChat(rec, issueId);
  chat.dropInbox(`[issue ${issueId}: ${title}] ${text}`, issueId);
  return rec;
}

// Open an issue from a submission (chat or inspect), announce it in the MAIN chat with a
// clickable reference, and deliver it to the agent. dom/image/absPath/selector come from
// the inspect tool when present.
function openIssue({ text, dom, image, absPath, selector } = {}) {
  const title = firstLine(text) || (selector ? 'inspect: ' + selector : 'untitled issue');
  const iss = issues.create({ title, body: dom || text || '', image: image || null, origin: image ? 'inspect' : 'chat' });
  const disp = { id: chat.rid('c'), role: 'user', text: '🧩 opened issue: ' + iss.title, issue: iss.id, sent_at: new Date().toISOString() };
  if (image) disp.image = image;
  chat.appendChat(disp);
  const parts = ['[issue opened ' + iss.id + ': ' + iss.title + ']',
    (text && text !== title) ? text : '', dom || '',
    absPath ? '[screenshot attached — Read this file to see it: ' + absPath + ']' : ''];
  chat.dropInbox(parts.filter(Boolean).join('\n\n'), iss.id);
  return iss;
}

// A context capture from the overlay's Inspect tool: an optional cropped PNG plus the
// element's DOM serialization. Routes three ways: open a new issue (createIssue), attach
// to an existing issue's chat (issue), or post to the main chat (default).
function saveContext({ text, note, image, selector, createIssue, issue } = {}) {
  const dom = String(text || '').trim();
  const noteStr = String(note || '').trim();
  let imgRel = null, absPath = null;
  if (typeof image === 'string' && image.startsWith('data:image/png;base64,')) {
    const id = chat.rid('ctx');
    fs.mkdirSync(contextDir(), { recursive: true });
    absPath = path.join(contextDir(), id + '.png');
    fs.writeFileSync(absPath, Buffer.from(image.slice('data:image/png;base64,'.length), 'base64'));
    imgRel = '/api/context/' + id + '.png';
  }
  if (createIssue) {
    const iss = openIssue({ text: noteStr, dom, image: imgRel, absPath, selector });
    return { ok: true, image: imgRel, issue: iss.id };
  }
  const delivery = [noteStr, dom, absPath ? '[screenshot attached — Read this file to see it: ' + absPath + ']' : '']
    .filter(Boolean).join('\n\n');
  if (issue) {
    const rec = { id: chat.rid('i'), role: 'user', text: noteStr || ('🎯 ' + (selector || 'element')), sent_at: new Date().toISOString() };
    if (imgRel) rec.image = imgRel;
    chat.appendChat(rec, String(issue));
    chat.dropInbox(`[issue ${issue}] ${delivery}`, String(issue));
    return { ok: true, image: imgRel, issue: String(issue) };
  }
  chat.dropInbox(delivery);
  const disp = { id: chat.rid('c'), role: 'user', text: noteStr || ('🎯 shared element ' + (selector || '')), links: [], sent_at: new Date().toISOString() };
  if (imgRel) disp.image = imgRel;
  chat.appendChat(disp);
  return { ok: true, image: imgRel };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (applyCors(req, res)) return;   // answered a CORS preflight — nothing more to do

    // --- messages -----------------------------------------------------------

    if (req.method === 'GET' && p === '/api/messages') {
      return send(res, 200, store.list({ all: url.searchParams.get('all') === '1' }));
    }

    if (req.method === 'POST' && /^\/api\/messages\/[^/]+\/respond$/.test(p)) {
      const id = decodeURIComponent(p.split('/')[3]);
      if (!ID_RE.test(id)) return send(res, 400, { error: 'bad id' });
      const body = JSON.parse((await readBody(req, res)) || '{}');
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
      return send(res, 200, chat.readChat(50));
    }

    if (req.method === 'POST' && p === '/api/inbox') {
      const body = JSON.parse((await readBody(req, res)) || '{}');
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'empty message' });
      if (body.createIssue) return send(res, 200, openIssue({ text }));      // "Create an issue" checkbox
      if (body.issue) return send(res, 200, postIssueChat(String(body.issue), text));   // an issue's chat
      return send(res, 200, queueInbox(text));
    }

    // --- issues (first-class objects) ----------------------------------------

    if (req.method === 'GET' && p === '/api/issues') {
      return send(res, 200, issues.list({ all: url.searchParams.get('all') === '1' }));
    }
    if (req.method === 'POST' && p === '/api/issues') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try { return send(res, 200, issues.create(body)); }
      catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    }
    if (req.method === 'POST' && /^\/api\/issues\/[^/]+\/(close|reopen)$/.test(p)) {
      const parts = p.split('/'); const id = decodeURIComponent(parts[3]); const action = parts[4];
      if (!ID_RE.test(id)) return send(res, 400, { error: 'bad id' });
      try { return send(res, 200, action === 'close' ? issues.close(id) : issues.reopen(id)); }
      catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    }
    // an issue's own chat stream (its per-issue transcript)
    if (req.method === 'GET' && /^\/api\/issues\/[^/]+\/inbox$/.test(p)) {
      return send(res, 200, chat.readChat(50, decodeURIComponent(p.split('/')[3])));
    }
    if (req.method === 'POST' && /^\/api\/issues\/[^/]+\/inbox$/.test(p)) {
      const id = decodeURIComponent(p.split('/')[3]);
      if (!ID_RE.test(id)) return send(res, 400, { error: 'bad id' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'empty message' });
      return send(res, 200, postIssueChat(id, text));
    }
    if (req.method === 'GET' && /^\/api\/issues\/[^/]+$/.test(p)) {
      const iss = issues.get(decodeURIComponent(p.split('/')[3]));
      return iss ? send(res, 200, iss) : send(res, 404, { error: 'not found' });
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

    // --- the embeddable overlay widget ---------------------------------------
    // Served from disk per request (not baked into this process) so editing
    // overlay.js shows up on the next page load with no restart. Drop one line
    // into any local app to embed it:
    //   <script src="http://127.0.0.1:4420/overlay.js"></script>
    if (req.method === 'GET' && p === '/overlay.js') {
      let js;
      try { js = fs.readFileSync(path.join(__dirname, 'overlay.js'), 'utf8'); }
      catch { return send(res, 404, { error: 'overlay.js not found' }); }
      return send(res, 200, js, 'application/javascript');
    }

    // Inspect context capture: save the cropped PNG + deliver the DOM context.
    if (req.method === 'POST' && p === '/api/context') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return send(res, 200, saveContext(body));
    }
    // Serve a saved context image (for the chat thumbnail). Filename is id-shaped only.
    if (req.method === 'GET' && /^\/api\/context\/[A-Za-z0-9._-]+\.png$/.test(p)) {
      const abs = path.join(contextDir(), p.split('/').pop());
      let buf; try { buf = fs.readFileSync(abs); } catch { return send(res, 404, { error: 'not found' }); }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(buf);
    }

    // --- the page -------------------------------------------------------------

    if (req.method === 'GET' && p === '/') {
      return send(res, 200, PAGE, 'text/html');
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    // readBody may have already answered (e.g. a 413 for an oversized body) before
    // rejecting — don't write a second response over headers that are already out.
    if (!res.headersSent) send(res, 500, { error: String((e && e.message) || e) });
  }
});

// The whole front end is static — it talks to the JSON API above with fetch(), the
// same API any real front end would use. No server-side templating, so there is no
// escape-before-format hazard here at all: every dynamic value reaches the DOM as
// textContent, never as interpolated HTML.
const PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shells — reference client</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --ink: #1b1f24; --muted: #667085;
    --line: #e6e8ec; --accent: #3b6ef5; --accent-ink: #ffffff;
    --decision: #b5651d; --task: #2f855a; --knowledge: #6b46c1; --notification: #667085;
    --ok: #2f855a; --warn: #b7791f; --bad: #c53030;
    --shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.10);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1216; --panel: #171b21; --ink: #e6e9ee; --muted: #9aa4b2;
      --line: #262c34; --accent: #5b86f7; --accent-ink: #0f1216;
      --decision: #e0a267; --task: #6ee7a8; --knowledge: #b794f6; --notification: #9aa4b2;
      --ok: #6ee7a8; --warn: #e8c37e; --bad: #f28b82;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 1px 3px rgba(0,0,0,.4);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  header {
    position: sticky; top: 0; z-index: 5;
    background: var(--panel); border-bottom: 1px solid var(--line); box-shadow: var(--shadow);
    padding: 12px 20px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  header h1 { font-size: 16px; margin: 0; letter-spacing: .2px; }
  header h1 .dim { color: var(--muted); font-weight: 500; }
  .pills { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; align-items: center; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 12.5px; padding: 4px 10px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--bg); color: var(--muted);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }
  .dot.working { background: conic-gradient(from 0deg, var(--ok), rgba(47,133,90,.12)); animation: pgwork .8s linear infinite; }
  @keyframes pgwork { to { transform: rotate(360deg); } }
  .banner {
    margin: 0; padding: 10px 20px; background: var(--bad); color: #fff;
    font-size: 13.5px; display: none;
  }
  .banner.show { display: block; }

  /* one centered column: chat on top, message tabs below */
  main { max-width: 720px; margin: 0 auto; padding: 20px; display: flex; flex-direction: column; gap: 20px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
  .sec-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .sec-head h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); margin: 0; }
  .toggle { font-size: 12px; color: var(--accent); cursor: pointer; user-select: none; background: none; border: 0; padding: 0; margin-left: auto; }

  /* chat / inbox */
  .chat { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; min-height: 120px; max-height: 40vh; overflow-y: auto; }
  .bubble { max-width: 85%; padding: 8px 12px; border-radius: 12px; font-size: 13.5px; white-space: pre-wrap; }
  .bubble.you { align-self: flex-end; background: var(--accent); color: var(--accent-ink); border-bottom-right-radius: 3px; }
  .bubble.agent { align-self: flex-start; background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-bottom-left-radius: 3px; }
  .bubble.external { align-self: flex-start; background: #e05a52; color: #fff; border-bottom-left-radius: 3px; }
  .bubble.external .src { display: block; font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; opacity: .85; margin-bottom: 3px; }
  .bubble .when { display: block; font-size: 10.5px; opacity: .7; margin-top: 3px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; max-width: 100%; }
  .chip:hover { border-color: var(--accent); }
  .chip.done { opacity: .45; }   /* linked item already acknowledged (read/done/closed) */
  .chip .cdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .chip .clabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip.k-decision .cdot { background: var(--decision); } .chip.k-task .cdot { background: var(--task); }
  .chip.k-knowledge .cdot { background: var(--knowledge); } .chip.k-notification .cdot { background: var(--notification); }
  @keyframes flash { from { background: rgba(59,110,245,.18); } to { background: transparent; } }
  .msg.flash { animation: flash 1.6s ease; }
  .bubble.typing { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; padding: 11px 13px; }
  .bubble.typing .d { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: pgtype 1.2s infinite ease-in-out; }
  .bubble.typing .d:nth-child(2) { animation-delay: .18s; }
  .bubble.typing .d:nth-child(3) { animation-delay: .36s; }
  @keyframes pgtype { 0%, 60%, 100% { transform: translateY(0); opacity: .4; } 30% { transform: translateY(-4px); opacity: .9; } }
  .sendbar { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); align-items: flex-end; }
  .sendbar textarea {
    font: inherit; flex: 1; padding: 9px 12px; border-radius: 10px;
    border: 1px solid var(--line); background: var(--bg); color: var(--ink);
    resize: vertical; min-height: 40px; max-height: 40vh; line-height: 1.4;
  }
  .sendbar button {
    font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 10px;
    border: 0; background: var(--accent); color: var(--accent-ink); cursor: pointer;
  }
  .note { padding: 8px 16px 14px; font-size: 12px; color: var(--muted); margin: 0; }

  /* message tabs */
  .tabs { display: flex; gap: 4px; padding: 8px 8px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .tab {
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    padding: 8px 12px; border: 0; border-bottom: 2px solid transparent;
    background: none; color: var(--muted); display: inline-flex; align-items: center; gap: 6px;
  }
  .tab:hover { color: var(--ink); }
  .tab.active { color: var(--ink); }
  .tab.k-decision.active { border-bottom-color: var(--decision); }
  .tab.k-task.active { border-bottom-color: var(--task); }
  .tab.k-knowledge.active { border-bottom-color: var(--knowledge); }
  .tab.k-notification.active { border-bottom-color: var(--notification); }
  .badge {
    font-size: 11px; font-weight: 700; min-width: 18px; text-align: center;
    padding: 1px 6px; border-radius: 999px; background: var(--bg); color: var(--muted); border: 1px solid var(--line);
  }
  .tab.active .badge { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .tab-tools { display: flex; padding: 8px 16px 0; }

  .msg { padding: 14px 16px; border-bottom: 1px solid var(--line); border-left: 3px solid var(--line); }
  .msg:last-child { border-bottom: 0; }
  .msg.k-decision { border-left-color: var(--decision); }
  .msg.k-task { border-left-color: var(--task); }
  .msg.k-knowledge { border-left-color: var(--knowledge); }
  .msg.k-notification { border-left-color: var(--notification); }
  .msg.closed { opacity: .55; }
  .msg-top { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  .title { font-weight: 600; }
  .status { font-size: 12px; color: var(--muted); margin-left: auto; }
  .body { white-space: pre-wrap; margin: 6px 0 0; color: var(--ink); }
  .meta { font-size: 12.5px; color: var(--muted); margin-top: 8px; }
  .meta b { color: var(--ink); font-weight: 600; }
  .reply { margin-top: 8px; padding: 8px 10px; background: var(--bg); border-radius: 8px; font-size: 13.5px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
  button.act {
    font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--bg); color: var(--ink); cursor: pointer;
  }
  button.act:hover { border-color: var(--accent); }
  button.act.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  button.act.ghost { color: var(--muted); }
  input.revise {
    font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink); flex: 1; min-width: 140px;
  }
  .empty { padding: 24px 16px; color: var(--muted); text-align: center; font-size: 13.5px; }
</style>

<header>
  <h1>shells <span class="dim">reference client</span></h1>
  <div class="pills">
    <span class="pill" id="pill-activity"><span class="dot" id="dot-activity"></span><span id="txt-activity">…</span></span>
    <span class="pill" id="pill-watcher"><span class="dot" id="dot-watcher"></span><span id="txt-watcher">…</span></span>
  </div>
</header>
<p class="banner" id="banner-stale">Server process is running <b>older code than what's on disk</b>. A page reload will NOT fix this — restart <code>node reference/server.js</code>.</p>

<main>
  <section>
    <div class="sec-head"><h2>Chat — send to the session</h2></div>
    <div class="chat" id="chat"><div class="empty">No messages sent yet.</div></div>
    <form class="sendbar" id="sendform" autocomplete="off">
      <textarea id="sendtext" rows="1" placeholder="Type a message to the Claude session… (Enter sends, Shift+Enter for a new line)"></textarea>
      <button type="submit">Send</button>
    </form>
    <p class="note" id="delivery-note">Free-text goes to the session's inbox. Delivery timing depends on the watcher state shown above.</p>
  </section>

  <section>
    <div class="tabs" id="tabs">
      <button class="tab k-decision" data-kind="decision">Decisions <span class="badge">0</span></button>
      <button class="tab k-task" data-kind="task">Tasks <span class="badge">0</span></button>
      <button class="tab k-knowledge" data-kind="knowledge">Knowledgebase <span class="badge">0</span></button>
      <button class="tab k-notification" data-kind="notification">Notifications <span class="badge">0</span></button>
    </div>
    <div class="tab-tools"><button class="toggle" id="toggle-closed">show closed</button></div>
    <div id="messages"><div class="empty">Loading…</div></div>
    <p class="note">The agent pushes these through <code>store/cli.js</code>. Decisions and tasks want a reply; knowledge and notifications just get marked read. Any close can be reopened.</p>
  </section>
</main>

<script>
(() => {
  "use strict";
  const $ = s => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const KINDS = ['decision', 'task', 'knowledge', 'notification'];
  const PLURAL = { decision: 'decisions', task: 'tasks', knowledge: 'knowledge messages', notification: 'notifications' };
  const KLABEL = { decision: 'Decision', task: 'Task', knowledge: 'Knowledge', notification: 'Notification' };
  let allMessages = [];          // last /api/messages snapshot — lets the chat resolve link ids
  let pendingFlash = null;       // a message id to scroll to + flash on the next render
  let activityState = '';        // reported_state — drives the working spinner + typing dots

  // --- bruise: never reflow a list under the pointer, never clobber unsaved input.
  // A poll that lands mid-interaction is held; a catch-up render is scheduled for
  // the moment the list is quiet and no reply box is focused or dirty.
  let holdUntil = 0;
  const HOLD_MS = 1200;
  const bumpHold = () => { holdUntil = Date.now() + HOLD_MS; };
  let lastMsgSig = '', showClosed = false, catchupTimer = null;
  let activeKind = 'decision', pickedInitialTab = false;

  function editingMessages() {
    const a = document.activeElement;
    if (a && a.classList && a.classList.contains('revise')) return true;   // focused reply box
    // any reply box with text typed but not yet sent
    return [...document.querySelectorAll('#messages input.revise')].some(i => i.value.trim() !== '');
  }

  async function api(path, opts) {
    const r = await fetch(path, opts);
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }

  async function act(path, refresh) {
    try { await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' } }); }
    catch (e) { alert(e.message); }
    if (refresh) loadMessages(true);
  }

  async function respond(id, verdict, response) {
    try {
      await api('/api/messages/' + encodeURIComponent(id) + '/respond', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict, response: response || '' })
      });
    } catch (e) { alert(e.message); return; }
    loadMessages(true);
  }

  function messageNode(m) {
    const wrap = el('div', 'msg k-' + m.kind + (m.status === 'closed' ? ' closed' : ''));
    wrap.dataset.id = m.id;
    const top = el('div', 'msg-top');
    top.appendChild(el('span', 'title', m.title));
    top.appendChild(el('span', 'status', m.status));
    wrap.appendChild(top);

    if (m.body) wrap.appendChild(el('p', 'body', m.body));

    if (m.kind === 'decision') {
      if (m.options && m.options.length) {
        const meta = el('div', 'meta'); meta.appendChild(el('b', null, 'options: '));
        meta.appendChild(document.createTextNode(m.options.join(' · '))); wrap.appendChild(meta);
      }
      if (m.chosen) {
        const meta = el('div', 'meta'); meta.appendChild(el('b', null, 'default taken: '));
        meta.appendChild(document.createTextNode(m.chosen)); wrap.appendChild(meta);
      }
      if (m.rationale) {
        const meta = el('div', 'meta'); meta.appendChild(el('b', null, 'why: '));
        meta.appendChild(document.createTextNode(m.rationale)); wrap.appendChild(meta);
      }
    }
    if (m.response) {
      const r = el('div', 'reply'); r.appendChild(el('b', null, (m.verdict || 'reply') + ': '));
      r.appendChild(document.createTextNode(m.response)); wrap.appendChild(r);
    }

    const actions = el('div', 'actions');
    if (m.status === 'closed') {
      const b = el('button', 'act ghost', 'Reopen'); b.onclick = () => act('/api/messages/' + encodeURIComponent(m.id) + '/reopen', true);
      actions.appendChild(b);
    } else if (m.kind === 'decision' && m.status === 'open') {
      const approve = el('button', 'act primary', 'Approve'); approve.onclick = () => respond(m.id, 'approved');
      const inp = el('input', 'revise'); inp.placeholder = 'revise note (required to send back)';
      const back = el('button', 'act', 'Send back'); back.onclick = () => {
        if (!inp.value.trim()) { inp.focus(); return; }
        respond(m.id, 'revised', inp.value.trim());
      };
      actions.append(approve, inp, back);
    } else if (m.kind === 'task' && m.status === 'open') {
      const b = el('button', 'act primary', 'Mark done'); b.onclick = () => respond(m.id, 'done');
      actions.appendChild(b);
    } else if ((m.kind === 'knowledge' || m.kind === 'notification') && m.status === 'open') {
      const b = el('button', 'act', 'Mark read'); b.onclick = () => act('/api/messages/' + encodeURIComponent(m.id) + '/read', true);
      actions.appendChild(b);
    } else if (m.status === 'answered' || m.status === 'done') {
      actions.appendChild(el('span', 'status', 'waiting on the agent to apply & resolve'));
    }
    if (actions.childNodes.length) wrap.appendChild(actions);
    return wrap;
  }

  function openCount(list, kind) { return list.filter(m => m.kind === kind && m.status !== 'closed').length; }

  function applyFlash() {
    if (!pendingFlash) return;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(pendingFlash) : pendingFlash;
    const node = document.querySelector('#messages .msg[data-id="' + sel + '"]');
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
    pendingFlash = null;
  }

  function renderMessages(list) {
    allMessages = list;
    // Tab badges reflect OPEN counts per kind — update every poll (cheap, guarded).
    KINDS.forEach(k => {
      const badge = document.querySelector('.tab[data-kind="' + k + '"] .badge');
      const n = String(openCount(list, k));
      if (badge && badge.textContent !== n) badge.textContent = n;
    });

    // On first data, land the user on the first tab that actually has something.
    if (!pickedInitialTab) {
      pickedInitialTab = true;
      const firstWithOpen = KINDS.find(k => openCount(list, k) > 0);
      if (firstWithOpen) activeKind = firstWithOpen;
      syncTabs();
    }

    const shown = list.filter(m => m.kind === activeKind && (showClosed || m.status !== 'closed'));
    const sig = activeKind + '|' + showClosed + '|' + JSON.stringify(shown.map(m => [m.id, m.status, m.updated_at, m.response]));
    if (sig === lastMsgSig) { applyFlash(); return; }   // content unchanged, but a flash may be pending
    lastMsgSig = sig;
    const box = $('#messages');
    box.textContent = '';
    if (!shown.length) {
      box.appendChild(el('div', 'empty', (showClosed ? 'No ' : 'No open ') + PLURAL[activeKind] + '.'));
    } else {
      shown.forEach(m => box.appendChild(messageNode(m)));
    }
    applyFlash();
  }

  // Jump to a linked message from a chat chip: reveal it (opening 'closed' view if
  // needed), switch to its tab, and flash it. Resolves against the last snapshot.
  function openMessage(id) {
    const m = allMessages.find(x => x.id === id);
    if (!m) return;
    if (m.status === 'closed' && !showClosed) {
      showClosed = true;
      $('#toggle-closed').textContent = 'hide closed';
    }
    pendingFlash = id;
    if (activeKind !== m.kind) { activeKind = m.kind; syncTabs(); }
    lastMsgSig = ''; loadMessages(true);
  }

  function syncTabs() {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.kind === activeKind));
  }

  async function loadMessages(force) {
    // Hold the redraw if the user is mid-interaction — but ALWAYS keep the data
    // moving forward: schedule a catch-up so the list refreshes the instant it's safe.
    if (!force && (editingMessages() || Date.now() < holdUntil)) {
      if (!catchupTimer) catchupTimer = setTimeout(() => { catchupTimer = null; loadMessages(false); }, 400);
      return;
    }
    try { renderMessages(await api('/api/messages?all=1')); } catch {}
  }

  // --- chat transcript (your inbound sends; delivery is file-based, this is display)
  let lastChatSig = '';
  async function loadChat() {
    let log; try { log = await api('/api/inbox'); } catch { return; }
    const sig = JSON.stringify(log.map(r => [r.id, r.role || 'user', (r.links || []).map(id => { const m = allMessages.find(x => x.id === id); return id + ':' + (m ? m.status : '?'); }).join('|')]));
    if (sig === lastChatSig) return;
    lastChatSig = sig;
    const box = $('#chat'); const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.textContent = '';
    if (!log.length) { box.appendChild(el('div', 'empty', 'No messages yet.')); return; }
    log.forEach(r => {
      const roleCls = r.role === 'agent' ? 'agent' : r.role === 'external-agent' ? 'external' : 'you';
      const b = el('div', 'bubble ' + roleCls);
      if (r.role === 'external-agent') b.appendChild(el('span', 'src', r.source ? ('external · ' + r.source) : 'external agent'));
      b.appendChild(document.createTextNode(r.text));
      const t = new Date(r.sent_at);
      b.appendChild(el('span', 'when', isNaN(t) ? '' : t.toLocaleTimeString()));
      if (r.links && r.links.length) b.appendChild(chipRow(r.links));
      box.appendChild(b);
    });
    updateTyping();
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  // Typing indicator: an animated-dots bubble at the bottom of #chat whenever the
  // session is actively working. Toggled on chat re-render and on each status poll.
  function updateTyping() {
    const box = $('#chat');
    const has = box.querySelector('.typing');
    const working = activityState === 'working';
    if (working && !has) {
      const t = el('div', 'bubble agent typing');
      t.append(el('span', 'd'), el('span', 'd'), el('span', 'd'));
      box.appendChild(t); box.scrollTop = box.scrollHeight;
    } else if (!working && has) { has.remove(); }
  }

  // Render an agent reply's links as click-to-open chips, resolved (kind + title)
  // against the last messages snapshot. An unresolved id still renders a clickable
  // chip — by click time the snapshot has almost always caught up.
  function chipRow(ids) {
    const row = el('div', 'chips');
    ids.forEach(id => {
      const m = allMessages.find(x => x.id === id);
      const chip = el('div', 'chip' + (m ? ' k-' + m.kind : '') + (m && m.status !== 'open' ? ' done' : ''));
      chip.appendChild(el('span', 'cdot'));
      const label = m ? (KLABEL[m.kind] + ': ' + m.title) : 'open item';
      chip.appendChild(el('span', 'clabel', label));
      chip.title = label;
      chip.onclick = () => openMessage(id);
      row.appendChild(chip);
    });
    return row;
  }

  // --- honest status: activity + watcher link + stale server ------------------
  const WATCHER_COPY = {
    live: ['ok', 'watcher live · delivered in ~1s'],
    queued: ['warn', 'no watcher · delivered on next turn'],
    offline: ['bad', 'offline · waiting on a session']
  };
  async function loadStatus() {
    try {
      const a = await api('/api/activity');
      const map = { working: ['ok', 'working'], idle: ['warn', 'idle'], compacting: ['ok', 'compacting'],
                    stale: ['bad', 'no signal'], ended: ['bad', 'session ended'] };
      const [cls, label] = map[a.reported_state] || ['warn', a.reported_state || 'unknown'];
      activityState = a.reported_state || '';
      $('#dot-activity').className = 'dot ' + cls + (activityState === 'working' ? ' working' : '');
      $('#txt-activity').textContent = a.reported_state === 'working' && a.task ? 'working · ' + a.task : label;
      updateTyping();
    } catch {}
    try {
      const w = await api('/api/watcher');
      const [cls, label] = WATCHER_COPY[w.link] || ['warn', w.link || 'unknown'];
      $('#dot-watcher').className = 'dot ' + cls;
      $('#txt-watcher').textContent = label;
      $('#delivery-note').textContent = w.link === 'live'
        ? 'Free-text reaches the session within ~1s while the watcher is armed.'
        : w.link === 'queued'
          ? 'No watcher armed — your message is delivered on the session\\'s next turn.'
          : 'No live session — your message sits in the inbox until a session starts.';
    } catch {}
    try { const v = await api('/api/version'); $('#banner-stale').classList.toggle('show', !!v.server_stale); } catch {}
  }

  // --- wiring -----------------------------------------------------------------
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      if (activeKind === t.dataset.kind) return;
      activeKind = t.dataset.kind; syncTabs();
      lastMsgSig = ''; loadMessages(true);          // explicit switch renders now
    });
  });
  $('#toggle-closed').onclick = () => {
    showClosed = !showClosed;
    $('#toggle-closed').textContent = showClosed ? 'hide closed' : 'show closed';
    lastMsgSig = ''; loadMessages(true);
  };
  const msgBox = $('#messages');
  ['pointerdown', 'keydown', 'input', 'focusin'].forEach(ev => msgBox.addEventListener(ev, bumpHold));

  $('#sendform').addEventListener('submit', async e => {
    e.preventDefault();
    const inp = $('#sendtext'); const text = inp.value.trim(); if (!text) return;
    inp.value = '';
    try { await api('/api/inbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); }
    catch (err) { alert(err.message); inp.value = text; return; }
    loadChat();
  });

  // A textarea (unlike the old <input>) does NOT submit on Enter — it inserts a
  // newline. Preserve the prior send-on-Enter behaviour, and use Shift+Enter for a
  // deliberate newline, which is the expected convention for a chat composer.
  $('#sendtext').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#sendform').requestSubmit(); }
  });

  syncTabs();
  loadMessages(true).then(loadChat); loadStatus();   // messages first so chat chips resolve on first paint
  setInterval(() => loadMessages(false), 2000);
  setInterval(loadChat, 2500);
  setInterval(loadStatus, 3000);
})();
</script>
</html>`;

server.listen(PORT, HOST, () => {
  // Seed example messages on startup so a freshly cloned repo shows a populated,
  // self-teaching UI instead of empty tabs. Idempotent (see store/seed.js) — a
  // dismissed example is never resurrected, so this is safe on every start.
  try {
    const created = seed();
    if (created.length) console.log(`seeded ${created.length} example message(s)`);
  } catch (e) { console.error('seed skipped:', String((e && e.message) || e)); }
  console.log(`shells reference client -> http://${HOST}:${PORT}  (local only, ^C to stop)`);
});
