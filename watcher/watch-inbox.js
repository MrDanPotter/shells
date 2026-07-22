#!/usr/bin/env node
'use strict';

// Keep-alive watcher — streams inbox messages as events for use with the harness
// Monitor tool. Each new message becomes one stdout line, which the harness turns
// into a notification delivered into the session even while it's IDLE — the one
// case kernel/hooks/gate.js cannot cover, because idle means no hook is firing at
// all (see kernel/hooks/session-start.js for why only the model can arm this).
//
//   node watch-inbox.js [pollMs]
//
// Delivery semantics match gate.js: draining a message DELETES its file, so
// whichever of the two — this watcher (idle case) or gate.js (active-turn case) —
// happens to see a given file first "wins" delivery, and the other sees nothing.
// A message is never delivered twice by construction, not by coordination.
//
// Also writes a heartbeat (state/watcher.json) on every tick. That heartbeat is
// the ONLY way anything else in the kit — doctor.js, a front end's status endpoint
// — can tell whether inbox delivery-while-idle is actually working right now. An
// inbox is a file drop with no visible failure mode: a message written with no
// watcher armed sits there identically to one that's about to be delivered. Only
// the heartbeat's freshness tells them apart (kernel/lib/watcher-status.js).
//
// No cleanup on process exit: a Monitor is killed, not asked to shut down cleanly,
// so an exit handler is not reliable here. Staleness of the heartbeat is the honest
// signal instead, and it needs no cooperation from a dying process.
//
// Cross-platform, zero dependencies: fs/path only, no shelling out, no
// platform-specific process listing.

const fs = require('fs');
const path = require('path');
const { atomicWrite, readJson } = require('../kernel/lib/atomic');
const { inboxDir, watcherFile } = require('../kernel/lib/paths');

const POLL = Math.max(50, parseInt(process.argv[2], 10) || 1000);
const STALE_MS = Math.max(1000, POLL) * 3 + 1000;

function beat() {
  atomicWrite(watcherFile(), JSON.stringify({
    pid: process.pid,
    poll_ms: POLL,
    beat_at: new Date().toISOString(),
    armed_at: ARMED_AT
  }) + '\n');
}

const ARMED_AT = new Date().toISOString();

function drain() {
  let names;
  try { names = fs.readdirSync(inboxDir()).filter(f => f.endsWith('.json')).sort(); }
  catch { return; } // directory may not exist yet — nothing to do

  for (const f of names) {
    const full = path.join(inboxDir(), f);
    const rec = readJson(full, null);
    // Delete first: a crash after this point loses the message rather than
    // replaying it on the next tick — the safer of the two failure modes.
    try { fs.unlinkSync(full); } catch { continue; }
    if (!rec || !rec.text) continue;
    // Newlines would split one message into several notification events.
    process.stdout.write(`[shells-inbox] ${String(rec.text).replace(/\r?\n/g, '  |  ')}\n`);
  }
}

// Single-listener guard. Two watchers draining the same directory would make
// delivery a race — each message reaches exactly one of them, unpredictably, with
// no way to tell which. Refuse to start a second one if a heartbeat is still fresh.
const existing = readJson(watcherFile(), null);
if (existing && existing.beat_at) {
  const age = Date.now() - Date.parse(existing.beat_at);
  if (Number.isFinite(age) && age < STALE_MS) {
    process.stdout.write(
      `[shells-inbox] NOT LISTENING — another watcher (pid ${existing.pid}) has a heartbeat `
      + `${Math.round(age / 1000)}s old, still within its staleness window. Run one watcher `
      + `at a time; stop it first if it's actually dead.\n`);
    process.exit(0);
  }
  // Stale heartbeat: the previous holder is presumed dead. Take over — this is the
  // ordinary "watcher restarted" case, not a rival session.
}

setInterval(() => { beat(); drain(); }, POLL);
beat();
drain();
