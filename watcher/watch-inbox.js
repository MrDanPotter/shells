#!/usr/bin/env node
'use strict';

// Keep-alive watcher — streams inbound events for use with the harness Monitor tool.
// Each event becomes one stdout line, which the harness turns into a notification
// delivered into the session even while it's IDLE — the one case kernel/hooks/gate.js
// cannot cover, because idle means no hook is firing at all (see
// kernel/hooks/session-start.js for why only the model can arm this).
//
//   node shells.js watch [pollMs]     (through the dispatcher; the arg is pollMs)
//
// It delivers the SAME two things gate.js does, so an idle session sees exactly what
// an active one would:
//   (a) INBOX — free-text messages a front end dropped in state/inbox/. Draining
//       DELETES the file, so whichever of watcher (idle) or gate (active turn) sees
//       it first wins; a message is never delivered twice, by construction.
//   (b) AWAITING REPLIES — decision/task messages the user answered but the agent
//       hasn't resolve()d yet (store.listAwaiting()). These are NOT deleted (only the
//       agent resolves them), so re-announcing every tick would spam. Guard: the same
//       delivered-set token (id@responded_at) gate.js uses in state/delivered.json —
//       announce a reply once, prune the token when it leaves the awaiting set so a
//       later reply on the same message announces again. Sharing that set with gate
//       means whichever path announces a given reply first, the other stays quiet.
//
// Also writes a heartbeat (state/watcher.json) on every tick. That heartbeat is the
// ONLY way anything else in the kit — doctor.js, a front end's status endpoint — can
// tell whether inbox delivery-while-idle is actually working right now. An inbox is a
// file drop with no visible failure mode: a message written with no watcher armed
// sits there identically to one about to be delivered. Only the heartbeat's freshness
// tells them apart (kernel/lib/watcher-status.js).
//
// No cleanup on process exit: a Monitor is killed, not asked to shut down cleanly, so
// an exit handler is not reliable here. Staleness of the heartbeat is the honest
// signal instead, and it needs no cooperation from a dying process.
//
// Cross-platform, zero dependencies: fs/path only, no shelling out, no
// platform-specific process listing.

const fs = require('fs');
const path = require('path');
const { atomicWrite, readJson } = require('../kernel/lib/atomic');
const { inboxDir, watcherFile, deliveredFile } = require('../kernel/lib/paths');
const store = require('../store/store');

function loadDelivered() {
  const arr = readJson(deliveredFile(), []);
  return new Set(Array.isArray(arr) ? arr : []);
}
function saveDelivered(set) {
  atomicWrite(deliveredFile(), JSON.stringify([...set], null, 2) + '\n');
}

// argv[0] is the poll interval in ms. Exported as run() so the shells.js dispatcher
// can start it; the guard at the bottom keeps it runnable standalone too. This is a
// long-running process — run() sets up the interval and returns, it never exits on
// its own (the event loop keeps it alive until the Monitor kills it).
function run(argv) {
  const POLL = Math.max(50, parseInt(argv[0], 10) || 1000);
  const STALE_MS = Math.max(1000, POLL) * 3 + 1000;
  const ARMED_AT = new Date().toISOString();

  function beat() {
    atomicWrite(watcherFile(), JSON.stringify({
      pid: process.pid,
      poll_ms: POLL,
      beat_at: new Date().toISOString(),
      armed_at: ARMED_AT
    }) + '\n');
  }

  // (a) free-text inbox — delete-on-read, one notification line per message.
  function drainInbox() {
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

  // (b) answered decision/task replies — announce each once, guarded by the shared
  // delivered-set token so the watcher and gate.js never both announce the same one.
  function drainAwaiting() {
    let awaiting;
    try { awaiting = store.listAwaiting(); } catch { return; }

    const delivered = loadDelivered();
    const present = new Set(awaiting.map(m => `${m.id}@${m.responded_at}`));
    let changed = false;

    // Prune tokens that left the awaiting set (resolved, or a newer reply) so the
    // same message can announce again on its next reply.
    for (const token of [...delivered]) {
      if (!present.has(token)) { delivered.delete(token); changed = true; }
    }

    for (const m of awaiting) {
      const token = `${m.id}@${m.responded_at}`;
      if (delivered.has(token)) continue;
      const title = String(m.title).replace(/\r?\n/g, ' ');
      process.stdout.write(`[shells-inbound] a reply is waiting on ${m.kind} ${m.id} `
        + `(${m.verdict}): ${title} — apply it, then resolve ${m.id} so this clears.\n`);
      delivered.add(token);
      changed = true;
    }

    if (changed) saveDelivered(delivered);
  }

  function tick() { beat(); drainInbox(); drainAwaiting(); }

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

  setInterval(tick, POLL);
  tick();
}

module.exports = { run };
if (require.main === module) run(process.argv.slice(2));
