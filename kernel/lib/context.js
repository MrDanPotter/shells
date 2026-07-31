'use strict';

// context.js — per-request state-dir context (Option A, P1).
//
// The whole store resolves where state lives through ONE function, paths.js
// stateDir(). Normally that is a process-global choice (SHELLS_STATE_DIR, else a
// default), which is exactly right for the single-project case: one process, one
// project, one state dir for its whole life.
//
// The shared hub breaks that assumption — ONE process serves MANY projects, and
// which project a call belongs to is decided PER REQUEST, not per process. This
// module carries that per-request choice using Node's built-in AsyncLocalStorage
// (zero dependencies): the hub wraps each request in runWithStateDir(dir, ...), and
// stateDir() reads the ambient dir back out — surviving across every await in the
// handler, without threading a dir argument through the store's whole API.
//
// Single-process callers (the hooks, the watcher, the single-project server) never
// call runWithStateDir, so currentStateDir() returns null and stateDir() falls back
// to the env/default exactly as before. This is what makes P1 non-breaking.

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// Run `fn` with `dir` as the ambient state dir for the whole async call tree it
// spawns. Returns whatever `fn` returns (sync or a promise).
function runWithStateDir(dir, fn) {
  return als.run({ stateDir: dir }, fn);
}

// The ambient state dir if one is set for the current async context, else null.
function currentStateDir() {
  const store = als.getStore();
  return store ? store.stateDir : null;
}

module.exports = { runWithStateDir, currentStateDir };
