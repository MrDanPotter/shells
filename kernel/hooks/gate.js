#!/usr/bin/env node
'use strict';

// Inbound delivery — the load-bearing trick this whole kit exists to demonstrate.
//
// A Claude Code session has no listening socket and no way for an external process
// to "call in". The ONLY channel back into a running turn is what a hook returns.
// Two of those hooks are enough to build a full inbound path with no polling loop
// inside the model and no network:
//
//   UserPromptSubmit    runs at the start of a turn. Anything this hook prints to
//                       stdout is injected as extra context for that turn. Cannot
//                       block — the turn is already starting.
//
//   Stop                runs when the assistant is about to end its turn. If this
//                       hook's stdout is {"decision":"block","reason":"..."}, the
//                       harness does NOT end the turn — it feeds `reason` back in
//                       as if it were new input and lets the assistant keep going.
//                       THIS is the trick: it turns "the turn is ending" into "one
//                       more round, with fresh instructions", which is the only way
//                       anything outside the model can make it act on new
//                       information without the user typing in the terminal.
//
// Net effect: a front end write to state/inbox/ or a message the user answered
// reaches the session within seconds if the session is actively working (via Stop
// blocking), or on its very next turn if the session is idle (via UserPromptSubmit
// injection). Nothing can reach a session that has fully ended (SessionEnd already
// fired) — that is a harness limit, not a bug, and doctor.js verifies this kit
// reports that state honestly rather than pretending otherwise.
//
// Two independent things are delivered here, each with ITS OWN loop guard:
//
//   (a) INBOX — free-text, chat-style messages a front end drops as files in
//       state/inbox/. Loop guard: draining DELETES the file. A message that no
//       longer exists cannot be delivered twice, full stop — no bookkeeping needed.
//
//   (b) AWAITING MESSAGES — decision/task messages the user has replied to
//       (store.listAwaiting()) that the agent hasn't resolve()d yet. These must NOT
//       be deleted — closing them is the agent's job, once it's actually applied
//       the reply. So blocking the Stop hook on the same unresolved item every
//       single time would chain the turn forever. Guard: a delivered-SET
//       (state/delivered.json) records which items have already been used to chain
//       a Stop once. An item already delivered this way falls back to the (safe to
//       repeat) UserPromptSubmit injection instead of blocking again. The set is
//       pruned of any id that has left the awaiting list (resolved, or answered
//       again), so a later reply on the same message chains again.
//
//   node gate.js prompt     UserPromptSubmit — plain stdout injection, never blocks
//   node gate.js stop       Stop — may emit {"decision":"block",...} to chain the turn

const fs = require('fs');
const path = require('path');
const { atomicWrite, readJson } = require('../lib/atomic');
const { inboxDir, deliveredFile } = require('../lib/paths');
const { patchActivity } = require('../lib/activity');
const store = require('../../store/store');

const mode = process.argv[2] || 'prompt';

// One line, trimmed — matches the style used for the activity header.
function tidy(text, max = 160) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one;
}

// Drains state/inbox/*.json in filename order (so lexicographic == arrival order),
// DELETING each file as it's read. Delete-before-return: a crash between delete and
// delivery loses a message rather than replaying it, which is the safer failure —
// silently dropping one rare message beats an inbox that can loop forever.
function drainInbox() {
  let names;
  try { names = fs.readdirSync(inboxDir()).filter(f => f.endsWith('.json')).sort(); }
  catch { return []; }

  const out = [];
  for (const f of names) {
    const full = path.join(inboxDir(), f);
    const rec = readJson(full, null);
    try { fs.unlinkSync(full); } catch { continue; }
    if (rec && rec.text) out.push(rec);
  }
  return out;
}

function loadDelivered() {
  const arr = readJson(deliveredFile(), []);
  return new Set(Array.isArray(arr) ? arr : []);
}
function saveDelivered(set) {
  atomicWrite(deliveredFile(), JSON.stringify([...set], null, 2) + '\n');
}

function describe(awaiting, inboxMsgs) {
  const out = [];
  if (awaiting.length) {
    out.push(`[shells-inbound] ${awaiting.length} message(s) the user replied to are `
      + `waiting on you — handle each, then resolve it so this clears:`);
    for (const m of awaiting) {
      out.push(`- ${m.kind.toUpperCase()} ${m.id} ${JSON.stringify(m.title)}`);
      out.push(`    verdict: ${m.verdict}${m.chosen ? `  (you had chosen ${JSON.stringify(m.chosen)})` : ''}`);
      if (m.response) out.push(`    reply: ${JSON.stringify(m.response)}`);
      out.push(`    when applied: node store/cli.js resolve ${m.id}`);
    }
  }
  if (inboxMsgs.length) {
    const label = inboxMsgs.length > 1 ? `${inboxMsgs.length} messages` : 'a message';
    out.push(`[shells-inbound] ${label} arrived from the front end. Treat as user input:`);
    for (const m of inboxMsgs) out.push(`> ${String(m.text).replace(/\r?\n/g, '  |  ')}`);
  }
  return out.join('\n');
}

try {
  const awaiting = store.listAwaiting();
  const inboxMsgs = drainInbox();

  if (mode !== 'stop') {
    // Non-blocking context injection. Safe to repeat on every single prompt — this
    // is exactly why awaiting items need NO loop guard here, only in stop mode.
    if (awaiting.length || inboxMsgs.length) {
      process.stdout.write(describe(awaiting, inboxMsgs) + '\n');
      const first = inboxMsgs[0];
      if (first) patchActivity({ task: tidy(first.text), task_source: 'inbox', task_at: new Date().toISOString() });
    }
    process.exit(0);
  }

  // --- stop mode -----------------------------------------------------------
  const delivered = loadDelivered();
  const present = new Set(awaiting.map(m => `${m.id}@${m.responded_at}`));

  // Prune tokens that left the awaiting set (resolved, or a later reply that changed
  // responded_at) so a fresh reply on the same message can chain again.
  let pruned = false;
  for (const token of [...delivered]) {
    if (!present.has(token)) { delivered.delete(token); pruned = true; }
  }

  const freshAwaiting = awaiting.filter(m => !delivered.has(`${m.id}@${m.responded_at}`));

  // Inbox messages always chain — they were just deleted above, so there is nothing
  // to guard against re-delivering.
  if (!freshAwaiting.length && !inboxMsgs.length) {
    if (pruned) saveDelivered(delivered);
    process.exit(0);
  }

  for (const m of freshAwaiting) delivered.add(`${m.id}@${m.responded_at}`);
  saveDelivered(delivered);

  // The Stop activity hook (which runs before this one — see .claude/settings.json)
  // has already flipped the state to idle. Blocking means the turn keeps going, so
  // put it back to working or the front end's spinner lies for the rest of the turn.
  const first = inboxMsgs[0];
  patchActivity({
    state: 'working',
    last_event: new Date().toISOString(),
    task: tidy(first ? first.text : `reply on ${freshAwaiting[0].id}: ${freshAwaiting[0].title}`),
    task_source: 'inbound',
    task_at: new Date().toISOString(),
    subtask: ''
  });

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: describe(freshAwaiting, inboxMsgs)
      + '\n\nThis arrived from the front end while you were working. Handle it now '
      + 'rather than ending the turn.'
  }));
} catch {
  // Never block a turn on gate trouble — silent failure here beats an unrelated
  // outage taking down every prompt in the workspace.
}
process.exit(0);
