'use strict';

// Where everything lives. One place so every hook, the store, the watcher, and
// doctor.js agree on it.
//
// SHELLS_STATE_DIR lets doctor.js (and anyone else) point the whole kit at a
// throwaway directory for a test run without touching real runtime state.
// Cross-platform: path.join + os.tmpdir only, no hardcoded separators.

const path = require('path');

// kernel/lib -> kernel -> repo root
const ROOT = path.resolve(__dirname, '..', '..');

function stateDir() {
  return process.env.SHELLS_STATE_DIR || path.join(ROOT, 'state');
}

module.exports = {
  ROOT,
  stateDir,
  messagesDir: () => path.join(stateDir(), 'messages'),
  inboxDir: () => path.join(stateDir(), 'inbox'),
  activityFile: () => path.join(stateDir(), 'activity.json'),
  deliveredFile: () => path.join(stateDir(), 'delivered.json'),
  watcherFile: () => path.join(stateDir(), 'watcher.json'),
  chatLogFile: () => path.join(stateDir(), 'chat-log.json')
};
