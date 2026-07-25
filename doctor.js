#!/usr/bin/env node
'use strict';

// doctor.js — fires every lifecycle hook with a synthetic payload and checks the
// documented effect actually happened, against a THROWAWAY state directory (never
// your real state/). This is Tier 1, not polish: the whole pattern this kit
// demonstrates is coupled to how Claude Code's hooks behave, and the failure mode
// when that coupling breaks is silent — a hook that stops firing, or starts
// returning something the harness no longer honors, produces no error anywhere.
// Nothing else in this repo would ever tell you. This does.
//
// It ALSO specifically checks the unarmed-watcher case (§3 of protocol.md):
// inbound delivery-while-idle depends on a Monitor being armed from inside the
// model, and an unarmed watcher looks IDENTICAL to an armed one from the inbox's
// point of view — the write always succeeds. If watcher-status.js can't tell
// live from queued from offline, that silent failure mode is back.
//
// Usage: node doctor.js
// Exit code 0 = every check passed. Non-zero = read the FAIL lines above it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shells-doctor-'));

// Every direct require in THIS process, and every spawned hook, must agree on
// where state lives — point both at the throwaway directory before anything else
// runs. kernel/lib/paths.js reads this env var live on every call, not once at
// require time, so setting it here is enough for the whole run.
process.env.SHELLS_STATE_DIR = TMP;

const { readJson, atomicWrite } = require('./kernel/lib/atomic');
const { activityFile, inboxDir, watcherFile } = require('./kernel/lib/paths');
const { computeStatus } = require('./kernel/lib/activity');
const { watcherStatus } = require('./kernel/lib/watcher-status');
const store = require('./store/store');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: Boolean(cond), detail: detail || '' });
  if (!cond) process.stderr.write(`FAIL: ${name}${detail ? ` — ${detail}` : ''}\n`);
}

// Invoke through the shells.js dispatcher — the SAME entrypoint the live session's
// .claude/settings.json uses. Testing the dispatcher path (not the internal scripts
// directly) is the point: a break in routing would otherwise pass here and only fail
// in a real session.
function runShells(args, stdinObj) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'shells.js'), ...(args || [])], {
    cwd: ROOT,
    env: process.env,
    input: stdinObj !== undefined ? JSON.stringify(stdinObj) : undefined,
    encoding: 'utf8',
    timeout: 10000
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

function activity() { return readJson(activityFile(), {}); }

// --- Kit surface / manifest (lib/manifest.js) -------------------------------
// manifest.js is the single source of truth for what the kit IS: the scaffolder
// vendors exactly `manifest.kit`, and package.json "files" mirrors it. These checks
// are the tripwire that the three never drift — a kit file added but left out of the
// manifest (or the tarball) would otherwise ship a broken install, silently.
//
// DEV-REPO / PACKAGE ONLY: the "files" mirror and kit-surface invariant are about the
// npm tarball, so they only make sense where a package.json is present. A vendored
// .shells/ install now carries lib/manifest.js too (for `shells.js init`), so gate on
// package.json — that is the thing a vendored copy lacks — and skip cleanly there.
if (fs.existsSync(path.join(ROOT, 'package.json')) && fs.existsSync(path.join(ROOT, 'lib', 'manifest.js'))) {
  const manifest = require('./lib/manifest');
  for (const p of manifest.kit) {
    check(`manifest: path exists on disk — ${p}`, fs.existsSync(path.join(ROOT, p)), p);
  }
  const pkg = readJson(path.join(ROOT, 'package.json'), null);
  if (pkg && Array.isArray(pkg.files)) {
    const files = new Set(pkg.files);
    for (const p of manifest.kit) {
      check(`manifest: package.json "files" carries ${p}`, files.has(p), p);
    }
  }
}

// --- Tier 1: activity-hook.js, one event at a time -------------------------

runShells(['hook', 'activity', 'UserPromptSubmit'], { session_id: 'doctor', prompt: '  hello   world  ' });
{
  const a = activity();
  check('UserPromptSubmit sets state=working', a.state === 'working', JSON.stringify(a.state));
  check('UserPromptSubmit stamps the task, tidied', a.task === 'hello world', JSON.stringify(a.task));
  check('UserPromptSubmit resets counters', a.tool_count === 0 && a.subagents === 0, JSON.stringify(a));
  check('UserPromptSubmit records turn_started', typeof a.turn_started === 'string' && a.turn_started.length > 0);
}

runShells(['hook', 'activity', 'PostToolUse'], { tool_name: 'Read' });
{
  const a = activity();
  check('PostToolUse bumps tool_count', a.tool_count === 1, JSON.stringify(a.tool_count));
  check('PostToolUse records last_tool', a.last_tool === 'Read', a.last_tool);
}

runShells(['hook', 'activity', 'PostToolUse'], { tool_name: 'Task', tool_input: { description: 'do the thing' } });
{
  const a = activity();
  check('PostToolUse bumps tool_count again', a.tool_count === 2, JSON.stringify(a.tool_count));
  check('PostToolUse(Task) records subtask', a.subtask === 'do the thing', a.subtask);
}

runShells(['hook', 'activity', 'SubagentStart']);
runShells(['hook', 'activity', 'SubagentStart']);
check('SubagentStart increments twice', activity().subagents === 2, JSON.stringify(activity().subagents));

runShells(['hook', 'activity', 'SubagentStop']);
check('SubagentStop decrements', activity().subagents === 1, JSON.stringify(activity().subagents));

runShells(['hook', 'activity', 'PreCompact'], { trigger: 'auto' });
{
  const a = activity();
  check('PreCompact sets state=compacting', a.state === 'compacting', a.state);
  check('PreCompact remembers the interrupted state', a.state_before_compact === 'working', a.state_before_compact);
  check('PreCompact records the trigger', a.compact_trigger === 'auto', a.compact_trigger);
}

runShells(['hook', 'activity', 'PostCompact']);
{
  const a = activity();
  check('PostCompact resumes the interrupted state', a.state === 'working', a.state);
  check('PostCompact clears the marker', !('state_before_compact' in a), JSON.stringify(a.state_before_compact));
  check('PostCompact records compact_ended', typeof a.compact_ended === 'string');
}

runShells(['hook', 'activity', 'Stop']);
{
  const a = activity();
  check('Stop sets state=idle', a.state === 'idle', a.state);
  check('Stop resets subagents', a.subagents === 0, JSON.stringify(a.subagents));
}

runShells(['hook', 'activity', 'SessionEnd']);
check('SessionEnd sets state=ended (distinct from idle)', activity().state === 'ended', activity().state);

{
  const r = runShells(['hook', 'session-start']);
  check('SessionStart tells the model to arm the watcher',
    /Monitor\(/.test(r.stdout) && /shells\.js watch/.test(r.stdout),
    r.stdout.slice(0, 80));
}

// --- Tier 1: staleness leashes ----------------------------------------------

atomicWrite(activityFile(), JSON.stringify({ state: 'working', last_event: new Date(Date.now() - 200_000).toISOString() }));
check('staleness: working past its 180s leash reports stale', computeStatus(readJson(activityFile(), {})).reported_state === 'stale');

atomicWrite(activityFile(), JSON.stringify({ state: 'working', last_event: new Date().toISOString() }));
check('staleness: fresh working reports working, not stale', computeStatus(readJson(activityFile(), {})).reported_state === 'working');

atomicWrite(activityFile(), JSON.stringify({ state: 'compacting', last_event: new Date(Date.now() - 1000_000).toISOString() }));
check('staleness: compacting has a longer (900s) leash and can still go stale', computeStatus(readJson(activityFile(), {})).reported_state === 'stale');

atomicWrite(activityFile(), JSON.stringify({ state: 'compacting', last_event: new Date(Date.now() - 500_000).toISOString() }));
check('staleness: compacting at 500s is within its longer leash', computeStatus(readJson(activityFile(), {})).reported_state === 'compacting');

// Reset to a live, idle session for everything that follows (inbound delivery
// tests need "session alive" to be true).
atomicWrite(activityFile(), JSON.stringify({ state: 'idle', last_event: new Date().toISOString() }));

// --- Tier 3: the store --------------------------------------------------------

{
  let threw = false;
  try { store.create({ kind: 'decision', title: 'no default' }); } catch { threw = true; }
  check('store: a decision without chosen is rejected', threw);
}

const decisionId = store.create({ kind: 'decision', title: 'cache format', chosen: 'flat file', options: ['flat file', 'sqlite'] });
check('store: create returns an id', typeof decisionId === 'string' && decisionId.length > 0);
check('store: a new decision is open and listed', store.list({}).some(m => m.id === decisionId && m.status === 'open'));

{
  let threw = false;
  try { store.respond(decisionId, { verdict: 'revised' }); } catch { threw = true; }
  check('store: "revised" without a response note is rejected', threw);
}

store.respond(decisionId, { verdict: 'revised', response: 'try sqlite instead' });
check('store: respond() moves a decision to answered', store.get(decisionId).status === 'answered');
check('store: listAwaiting() includes the answered decision', store.listAwaiting().some(m => m.id === decisionId));

store.resolve(decisionId);
check('store: resolve() closes it', store.get(decisionId).status === 'closed');
check('store: closed messages drop out of listAwaiting()', !store.listAwaiting().some(m => m.id === decisionId));
check('store: closed messages are NOT deleted (list all:true still finds it)', store.list({ all: true }).some(m => m.id === decisionId));

store.reopen(decisionId);
check('store: reopen() reverses a close (closing must always be reversible)', store.get(decisionId).status === 'answered');

const taskId = store.create({ kind: 'task', title: 'rotate the log file' });
store.respond(taskId, { verdict: 'done' });
check('store: respond() moves a task to done', store.get(taskId).status === 'done');

const knowledgeId = store.create({ kind: 'knowledge', title: 'why sqlite lost', body: 'native module, cross-platform pain' });
{
  let threw = false;
  try { store.markRead(taskId); } catch { threw = true; }
  check('store: markRead() refuses a two-way kind (task)', threw);
}
store.markRead(knowledgeId);
check('store: markRead() closes a one-way kind', store.get(knowledgeId).status === 'closed');

// --- Tier 1: inbound delivery — loop guard (b), the delivered-set -----------
// decisionId is 'answered' and unresolved, taskId is 'done' and unresolved:
// both are in listAwaiting() right now.

{
  const r1 = runShells(['hook', 'gate', 'prompt']);
  check('gate prompt-mode surfaces awaiting items', r1.stdout.includes(decisionId) && r1.stdout.includes(taskId));
  const r2 = runShells(['hook', 'gate', 'prompt']);
  check('gate prompt-mode is safe to repeat (no guard needed — non-blocking)', r2.stdout.includes(decisionId));
}

{
  const r1 = runShells(['hook', 'gate', 'stop']);
  let parsed = null;
  try { parsed = JSON.parse(r1.stdout); } catch { /* not JSON */ }
  check('gate stop-mode chains the turn on first sight of an awaiting item',
    parsed && parsed.decision === 'block' && parsed.reason.includes(decisionId), r1.stdout.slice(0, 200));

  const r2 = runShells(['hook', 'gate', 'stop']);
  check('gate stop-mode loop guard: does NOT re-block the same unresolved item',
    r2.stdout.trim() === '', JSON.stringify(r2.stdout));
}

store.resolve(decisionId);
store.resolve(taskId);
const taskId2 = store.create({ kind: 'task', title: 'a second, later reply' });
store.respond(taskId2, { verdict: 'done' });
{
  const r = runShells(['hook', 'gate', 'stop']);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* not JSON */ }
  check('gate stop-mode loop guard is pruned on resolve, so a later reply chains again',
    parsed && parsed.decision === 'block' && parsed.reason.includes(taskId2), r.stdout.slice(0, 200));
}
store.resolve(taskId2);

// --- Tier 1: inbound delivery — loop guard (a), self-deleting inbox ---------

fs.mkdirSync(inboxDir(), { recursive: true });
atomicWrite(path.join(inboxDir(), '0001-doctor.json'), JSON.stringify({ id: 'doctor-msg', text: 'hello from the front end' }));
{
  const r = runShells(['hook', 'gate', 'stop']);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* not JSON */ }
  check('gate stop-mode delivers an inbox message', parsed && parsed.decision === 'block' && parsed.reason.includes('hello from the front end'));
  check('gate drains the inbox by deleting the file (self-deleting loop guard)',
    fs.readdirSync(inboxDir()).filter(f => f.endsWith('.json')).length === 0);
}
{
  const r = runShells(['hook', 'gate', 'stop']);
  check('gate stop-mode has nothing left to deliver a second time', r.stdout.trim() === '', JSON.stringify(r.stdout));
}

// --- Tier 1: keep-alive watcher — the unarmed case must be DETECTABLE -------
// This is the specific requirement: an unarmed watcher must not look like an
// armed one. We check every classification the status function can produce.

try { fs.rmSync(watcherFile(), { force: true }); } catch { /* fine if absent */ }
atomicWrite(activityFile(), JSON.stringify({ state: 'idle', last_event: new Date().toISOString() }));
check('watcher: no heartbeat + a live session reports "queued", not "live"', watcherStatus().link === 'queued');

atomicWrite(activityFile(), JSON.stringify({ state: 'ended', last_event: new Date().toISOString() }));
check('watcher: no heartbeat + an ended session reports "offline"', watcherStatus().link === 'offline');

atomicWrite(activityFile(), JSON.stringify({ state: 'idle', last_event: new Date().toISOString() }));
atomicWrite(watcherFile(), JSON.stringify({ pid: 99999, poll_ms: 1000, beat_at: new Date().toISOString() }));
check('watcher: a fresh heartbeat reports "live"', watcherStatus().link === 'live');

atomicWrite(watcherFile(), JSON.stringify({ pid: 99999, poll_ms: 1000, beat_at: new Date(Date.now() - 10_000).toISOString() }));
check('watcher: a stale heartbeat correctly downgrades from "live" back to "queued" '
  + '(the unarmed-watcher case doctor.js must catch)', watcherStatus().link === 'queued');

// --- Tier 1: a REAL watcher process, end to end -----------------------------

try { fs.rmSync(watcherFile(), { force: true }); } catch { /* fine */ }
const child = spawn(process.execPath, [path.join(ROOT, 'shells.js'), 'watch', '100'], {
  cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'ignore']
});
let childOut = '';
child.stdout.on('data', d => { childOut += d.toString(); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function watcherLiveTests() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && watcherStatus().link !== 'live') await sleep(50);
  check('watcher process: a running watcher reports "live" within 3s', watcherStatus().link === 'live');

  atomicWrite(path.join(inboxDir(), '0002-doctor.json'), JSON.stringify({ id: 'doctor-msg-2', text: 'delivered while idle' }));
  const drainDeadline = Date.now() + 3000;
  while (Date.now() < drainDeadline && fs.existsSync(path.join(inboxDir(), '0002-doctor.json'))) await sleep(50);
  check('watcher process: drains an inbox file it sees (self-deleting)',
    !fs.existsSync(path.join(inboxDir(), '0002-doctor.json')));
  check('watcher process: emits a notification line for it', childOut.includes('delivered while idle'), childOut.slice(0, 200));

  // protocol.md §3: the watcher also delivers answered decision/task replies while
  // idle (not just inbox text) — guarded by the same delivered-set as gate.js.
  const replyId = store.create({ kind: 'task', title: 'reply delivered while idle' });
  store.respond(replyId, { verdict: 'done' });
  const awaitDeadline = Date.now() + 3000;
  while (Date.now() < awaitDeadline && !childOut.includes(replyId)) await sleep(50);
  check('watcher process: announces an answered reply while idle', childOut.includes(replyId), childOut.slice(-200));

  child.kill();
}

watcherLiveTests().finally(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort cleanup */ }

  const failed = results.filter(r => !r.pass);
  console.log(`\nshells doctor — ${results.length - failed.length}/${results.length} checks passed\n`);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (failed.length) {
    console.log(`\n${failed.length} FAILED. See details above.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
  process.exit(0);
});
