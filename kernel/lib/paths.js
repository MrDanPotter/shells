'use strict';

// Where everything lives. One place so every hook, the store, the watcher, and
// doctor.js agree on it.
//
// SHELLS_STATE_DIR lets doctor.js (and anyone else) point the whole kit at a
// throwaway directory for a test run without touching real runtime state.
// Cross-platform: path.join + os.tmpdir only, no hardcoded separators.

const path = require('path');
const { currentStateDir } = require('./context');

// kernel/lib -> kernel -> repo root
const ROOT = path.resolve(__dirname, '..', '..');

// Resolution order, most specific first:
//   1. a per-request state dir set by the shared hub (context.js AsyncLocalStorage) —
//      this is what lets ONE process serve MANY projects, one per request;
//   2. SHELLS_STATE_DIR — the process-wide override doctor.js and tests use;
//   3. the built-in default alongside the kit.
// Single-process callers never set (1), so their behaviour is unchanged.
function stateDir() {
  return currentStateDir() || process.env.SHELLS_STATE_DIR || path.join(ROOT, 'state');
}

module.exports = {
  ROOT,
  stateDir,
  messagesDir: () => path.join(stateDir(), 'messages'),
  inboxDir: () => path.join(stateDir(), 'inbox'),
  activityFile: () => path.join(stateDir(), 'activity.json'),
  deliveredFile: () => path.join(stateDir(), 'delivered.json'),
  watcherFile: () => path.join(stateDir(), 'watcher.json'),
  // The chat transcript. With no argument it's the MAIN stream; with an issue id it's
  // that issue's own stream (state/issue-chat/<id>.json) — this is how per-issue chat
  // reuses the whole chat model instead of forking it.
  chatLogFile: (issue) => issue
    ? path.join(stateDir(), 'issue-chat', String(issue) + '.json')
    : path.join(stateDir(), 'chat-log.json'),
  issuesDir: () => path.join(stateDir(), 'issues')
};
