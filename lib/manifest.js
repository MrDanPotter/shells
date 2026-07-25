'use strict';

// The single source of truth for WHAT the shells kit is.
//
// Three consumers read this one list, so they can never drift apart:
//   1. the scaffolder (Phase 2) vendors exactly `kit` into a host project's .shells/;
//   2. package.json "files" mirrors `kit`, so the npm tarball carries exactly it;
//   3. doctor.js asserts every path here exists on disk and is covered by "files".
//
// A path may be a file or a directory (directories vendor/pack recursively). Paths
// are repo-root-relative and forward-slashed — the scaffolder resolves them per-OS.
//
// What is deliberately NOT in `kit`: the scaffolder's own code (bin/, lib/), the
// docs, README/LICENSE, package.json, and the reference front end. The reference is
// a throwaway example a real consumer replaces with their own UI, so it ships only
// on explicit opt-in — that is what `demo` is for (Phase 5's --with-demo).

module.exports = {
  // Vendored into .shells/ — the runtime kit AND the included UI. The UI ships by
  // default on purpose: a barebones install with no front end leaves the user with
  // no idea what to do, so the included web UI IS part of the product, not a demo.
  kit: [
    'shells.js',      // the one public entrypoint (the dispatcher)
    'kernel',         // hooks + lib (heartbeat, gate, session-start, atomic, paths, …)
    'watcher',        // the keep-alive inbox watcher
    'store',          // the message store: interface, json backend, cli, seed
    'contract',       // CLAUDE.fragment.md — the agent contract to import
    'protocol.md',    // the front-end contract (build your own UI from this)
    'doctor.js',      // so an installed copy can self-check: shells.js doctor
    'lib',            // init/wire-* + this manifest, so an install can re-wire itself: shells.js init
    'reference'       // the included web UI (server + page) — see `ui` below
  ],

  // The included front end — a SUBSET of `kit`. Vendored by default; `--no-ui` skips
  // it for a user who is bringing their own front end (built against protocol.md).
  ui: [
    'reference'
  ]
};
