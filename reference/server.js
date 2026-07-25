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
const { inboxDir, chatLogFile, ROOT } = require('../kernel/lib/paths');
const { computeStatus, readActivity } = require('../kernel/lib/activity');
const { watcherStatus } = require('../kernel/lib/watcher-status');
const { atomicWrite, readJson } = require('../kernel/lib/atomic');
const { seed } = require('../store/seed');

// Hardcoded default is 4420 — shells' assigned port in this workspace's port
// registry. Must never collide with another app's default; PORT is how a Fleet
// launcher (or anything else) overrides it.
const PORT = process.env.PORT || 4420;
const HOST = process.env.HOST || '127.0.0.1';
const ID_RE = /^[A-Za-z0-9._-]+$/;

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// --- chat log (inbox history, for display only — delivery is file-based) ---
function appendChatLog(rec) {
  const log = readJson(chatLogFile(), []);
  log.push(rec);
  atomicWrite(chatLogFile(), JSON.stringify(log.slice(-200), null, 2) + '\n');
}

function queueInbox(text) {
  const rec = { id: `i-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, sent_at: new Date().toISOString() };
  fs.mkdirSync(inboxDir(), { recursive: true });
  // Filename ordering IS delivery ordering — keep it lexicographically sortable.
  atomicWrite(path.join(inboxDir(), `${rec.sent_at.replace(/[:.]/g, '-')}-${rec.id}.json`),
    JSON.stringify(rec, null, 2) + '\n');
  appendChatLog(rec);
  return rec;
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
      return send(res, 200, queueInbox(text));
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

    // --- the page -------------------------------------------------------------

    if (req.method === 'GET' && p === '/') {
      return send(res, 200, PAGE, 'text/html');
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String((e && e.message) || e) });
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
  .bubble .when { display: block; font-size: 10.5px; opacity: .7; margin-top: 3px; }
  .sendbar { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
  .sendbar input {
    font: inherit; flex: 1; padding: 9px 12px; border-radius: 10px;
    border: 1px solid var(--line); background: var(--bg); color: var(--ink);
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
      <input id="sendtext" placeholder="Type a message to the Claude session…" maxlength="4000">
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

  function renderMessages(list) {
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
    if (sig === lastMsgSig) return;                 // nothing visibly changed; leave the DOM alone
    lastMsgSig = sig;
    const box = $('#messages');
    box.textContent = '';
    if (!shown.length) {
      box.appendChild(el('div', 'empty', (showClosed ? 'No ' : 'No open ') + PLURAL[activeKind] + '.'));
    } else {
      shown.forEach(m => box.appendChild(messageNode(m)));
    }
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
    const sig = JSON.stringify(log.map(r => r.id));
    if (sig === lastChatSig) return;
    lastChatSig = sig;
    const box = $('#chat'); const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.textContent = '';
    if (!log.length) { box.appendChild(el('div', 'empty', 'No messages sent yet.')); return; }
    log.forEach(r => {
      const b = el('div', 'bubble you'); b.appendChild(document.createTextNode(r.text));
      const t = new Date(r.sent_at);
      b.appendChild(el('span', 'when', isNaN(t) ? '' : t.toLocaleTimeString()));
      box.appendChild(b);
    });
    if (atBottom) box.scrollTop = box.scrollHeight;
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
      $('#dot-activity').className = 'dot ' + cls;
      $('#txt-activity').textContent = a.reported_state === 'working' && a.task ? 'working · ' + a.task : label;
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

  syncTabs();
  loadMessages(true); loadChat(); loadStatus();
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
