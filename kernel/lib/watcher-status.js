'use strict';

// Is the keep-alive watcher (watcher/watch-inbox.js) actually armed right now?
//
// This is the single most important thing for a front end to surface honestly.
// The inbox accepts a POST identically whether or not anything is listening — the
// failure mode is completely silent otherwise. Three genuinely different situations:
//
//   live     a watcher's heartbeat is fresh. An inbox message reaches the session
//            even while it sits idle, via a harness Monitor notification.
//   queued   no watcher, but hook-driven delivery still works: the message sits in
//            state/inbox/ until the session's next UserPromptSubmit or Stop event
//            drains it. Delivery is real, just not immediate.
//   offline  nothing is listening AND no session is running the hooks either.
//            The message is written to disk and stays there until someone starts
//            a session and it takes its next turn.
//
// doctor.js asserts this function classifies all three correctly — that is the
// "detect the unarmed-watcher case" requirement: the pattern is silently broken
// exactly when nobody notices the watcher isn't running.

const { readJson } = require('./atomic');
const { watcherFile } = require('./paths');
const { readActivity, computeStatus } = require('./activity');

function watcherStatus() {
  const w = readJson(watcherFile(), null);
  const beatAge = w && w.beat_at ? (Date.now() - Date.parse(w.beat_at)) / 1000 : null;
  // Three missed ticks before calling it gone — one slow tick under load isn't a
  // disconnect. Mirrors the leash pattern in activity.js.
  const beatLimit = Math.max(5, ((w && w.poll_ms) || 1000) * 3 / 1000);
  const live = beatAge !== null && beatAge <= beatLimit;

  const status = computeStatus(readActivity());
  // A session is "alive" (capable of draining the inbox on its own next turn) if it
  // hasn't explicitly ended and isn't stuck stale. An idle session with no recent
  // event at all is still assumed alive for up to 12h — idle is a legitimate rest
  // state, not evidence the process exited.
  const sessionAlive = status.state !== 'ended'
    && (status.reported_state === 'stale' ? false
      : (status.seconds_since_event === null || status.seconds_since_event <= 12 * 3600));

  return {
    link: live ? 'live' : (sessionAlive ? 'queued' : 'offline'),
    link_age_seconds: beatAge === null ? null : Math.round(beatAge),
    watcher_pid: w ? w.pid : null,
    session_alive: sessionAlive
  };
}

module.exports = { watcherStatus };
