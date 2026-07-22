'use strict';

// Shared activity-state logic: read/write state/activity.json, and compute
// staleness. Used by kernel/hooks/activity-hook.js (the writer), by
// reference/server.js (a reader, for its /api/activity endpoint), and by
// doctor.js (which verifies the leash math directly).
//
// Staleness is a first-class state, not an afterthought. A hook-driven "working"
// flag can go stale silently: the harness process can be killed before its Stop
// hook fires, and a spinner that never stops is a worse lie than an honest "no
// signal in N seconds". So every live state gets its own leash — a timeout after
// which "still working" is downgraded to "stale" instead of trusted forever.

const path = require('path');
const { atomicWrite, readJson } = require('./atomic');
const { activityFile } = require('./paths');

// Seconds. Only states that represent "something should be happening" get a
// leash — idle/ended are rest states and can't go stale.
//
//   working    : a normal turn with no event (tool call, subagent, etc.) for this
//                long probably means the process died mid-turn.
//   compacting : PreCompact..PostCompact emits NOTHING else while it runs, and on
//                a large context that gap is legitimately minutes long — so it
//                gets a much longer leash than "working" or it would be flagged
//                stale while compaction is still healthily in progress.
const LEASHES = { working: 180, compacting: 900 };

function readActivity() {
  return readJson(activityFile(), {});
}

function writeActivity(state) {
  atomicWrite(activityFile(), JSON.stringify(state, null, 2) + '\n');
}

// Merge a patch into the current state and write it back atomically. Every hook
// call is read-modify-write on the same file, so this is the one place that does it.
function patchActivity(patch) {
  const s = { ...readActivity(), ...patch };
  writeActivity(s);
  return s;
}

// Derives the REPORTED state (what a front end should show) from the raw stored
// state plus the clock. This is intentionally separate from the raw `state` field:
// the raw field is what the last hook event said; the reported field additionally
// accounts for "but nothing has happened since, for longer than we'd expect".
function computeStatus(raw) {
  const a = raw || {};
  const lastEvent = a.last_event ? Date.parse(a.last_event) : null;
  const secondsSinceEvent = lastEvent === null || Number.isNaN(lastEvent)
    ? null
    : Math.round((Date.now() - lastEvent) / 1000);

  const leash = LEASHES[a.state];
  const stale = leash != null && secondsSinceEvent != null && secondsSinceEvent > leash;

  return {
    ...a,
    reported_state: stale ? 'stale' : (a.state || 'unknown'),
    stale,
    seconds_since_event: secondsSinceEvent,
    leash_seconds: leash != null ? leash : null
  };
}

module.exports = { LEASHES, readActivity, writeActivity, patchActivity, computeStatus };
