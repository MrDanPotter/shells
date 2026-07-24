#!/usr/bin/env node
'use strict';

// shells.js — the single public entrypoint (the "dispatcher").
//
// Everything a host project wires — the lifecycle hooks, the keep-alive watcher,
// the agent's store CLI — goes through this ONE file. That is the whole point: the
// project's .claude/settings.json, its CLAUDE.md, and the printed watcher command
// name `shells.js` and nothing else, never an internal path like
// kernel/hooks/gate.js. Because the integration surface depends only on this stable
// entrypoint, shells' internals can move (into .shells/, a bundle, an npm package)
// without the host project changing a line. See docs/scaffolder-plan.md (Phase 0).
//
// It is pure indirection — each subcommand calls the same module that used to be its
// own script, which still runs standalone too (each keeps a `require.main` guard).
//
//   node shells.js hook activity <Event>      lifecycle heartbeat   (kernel/hooks/activity-hook.js)
//   node shells.js hook gate <prompt|stop>    inbound delivery      (kernel/hooks/gate.js)
//   node shells.js hook session-start         startup instructions  (kernel/hooks/session-start.js)
//   node shells.js watch [pollMs]             keep-alive watcher     (watcher/watch-inbox.js)
//   node shells.js store <cmd> [args]         agent CLI over the store (store/cli.js)

const [area, ...rest] = process.argv.slice(2);

function fail(msg) { process.stderr.write(msg + '\n'); process.exit(1); }

const USAGE = [
  'usage: node shells.js <area> ...',
  '  hook activity <Event>        e.g. UserPromptSubmit, PostToolUse, Stop, SessionEnd',
  '  hook gate <prompt|stop>      inbound delivery hook',
  '  hook session-start           startup instructions',
  '  watch [pollMs]               keep-alive inbox watcher',
  '  store <cmd> [args]           new|list|get|respond|read|resolve|reopen'
].join('\n');

switch (area) {
  case 'hook': {
    const [name, ...args] = rest;
    const hooks = {
      activity: './kernel/hooks/activity-hook',
      gate: './kernel/hooks/gate',
      'session-start': './kernel/hooks/session-start'
    };
    if (!hooks[name]) fail(`shells: unknown hook "${name || ''}". Expected: ${Object.keys(hooks).join(', ')}`);
    require(hooks[name]).run(args);
    break;
  }
  case 'watch':
    require('./watcher/watch-inbox').run(rest);
    break;
  case 'store':
    require('./store/cli').run(rest);
    break;
  default:
    fail(USAGE);
}
