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
// without the host project changing a line.
//
// Runtime hooks are pure indirection — each subcommand calls the same module that
// used to be its own script, which still runs standalone too (each keeps a
// `require.main` guard). The install-management subcommands operate on the project
// this vendored copy sits in.
//
//   node shells.js hook activity <Event>      lifecycle heartbeat   (kernel/hooks/activity-hook.js)
//   node shells.js hook gate <prompt|stop>    inbound delivery      (kernel/hooks/gate.js)
//   node shells.js hook session-start         startup instructions  (kernel/hooks/session-start.js)
//   node shells.js watch [pollMs]             keep-alive watcher     (watcher/watch-inbox.js)
//   node shells.js store <cmd> [args]         agent CLI over the store (store/cli.js)
//   node shells.js dev                        start the web UI + launch Claude Code
//   node shells.js doctor                     self-check this install
//   node shells.js version                    print the vendored kit version
//   node shells.js init                       re-apply the wiring for this install
//   node shells.js update                     how to pull a newer kit

const path = require('path');
const [area, ...rest] = process.argv.slice(2);

function fail(msg) { process.stderr.write(msg + '\n'); process.exit(1); }

const USAGE = [
  'usage: node shells.js <area> ...',
  '  hook activity <Event>        e.g. UserPromptSubmit, PostToolUse, Stop, SessionEnd',
  '  hook gate <prompt|stop>      inbound delivery hook',
  '  hook session-start           startup instructions',
  '  watch [pollMs]               keep-alive inbox watcher',
  '  store <cmd> [args]           new|list|get|respond|read|resolve|reopen',
  '  dev                          start the web UI + launch Claude Code',
  '  doctor                       self-check this install',
  '  version                      print the vendored kit version',
  '  init                         re-apply this install\'s wiring',
  '  update                       how to pull a newer kit'
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

  case 'dev': {
    // One command to bring up the whole loop: start the web UI in the background,
    // then launch Claude Code in the foreground, and tear the UI down on exit. This
    // is a convenience launcher, not part of the core mechanism — it needs the
    // included UI (skip it and you scaffolded with --no-ui) and `claude` on PATH.
    //
    // Crucially, it PRIMES the session to arm the watcher on its very first turn.
    // Without that, a user who only ever touches the web UI never gives the model a
    // turn — so it never arms the watcher and web-UI messages are never delivered.
    // The arm is a model tool call (Monitor), so only the model can do it; this
    // launcher can only make sure the model gets a first turn in which to do it. That
    // same first turn also drains any inbox message already waiting (gate prompt).
    const fs = require('fs');
    const { spawn } = require('child_process');
    const server = path.join(__dirname, 'reference', 'server.js');
    if (!fs.existsSync(server)) {
      fail('shells dev: the web UI is not installed here (scaffolded with --no-ui?). '
        + 'Run your own front end and launch `claude` yourself.');
    }
    const port = process.env.PORT || 4420;
    const srv = spawn(process.execPath, [server], { stdio: 'ignore' });
    srv.on('error', e => process.stderr.write(`shells dev: UI failed to start: ${e.message}\n`));
    const stop = () => { try { srv.kill(); } catch { /* already gone */ } };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    // This prompt IS visible in the Claude UI, so it's written as up-front, readable
    // "initialization instructions": it names the web UI, tells the model the terminal
    // is not read by the user (push everything to the web UI), has it arm the watcher,
    // and then report completion as a web-UI notification rather than terminal chat.
    const armPrompt = `shells initialization instructions\n\n`
      + `The shells web UI is running at http://127.0.0.1:${port} — that is the interface for this `
      + `session. Treat this terminal as something the user will NOT read: push everything the user `
      + `should see to the web UI as messages through the store, never as terminal chat.\n\n`
      + `Now:\n`
      + `1. Start the keep-alive inbox watcher exactly as the SessionStart hook instructed (the Monitor tool call).\n`
      + `2. Once it is armed, push a notification to the web UI reporting that shells is initialized and you are standing by.`;
    const claudeArgs = [...rest, armPrompt];

    process.stdout.write(`shells UI:  http://127.0.0.1:${port}   (launching Claude Code — it arms the watcher on start)\n`);

    const onExit = child => child.on('exit', code => { stop(); process.exit(code == null ? 0 : code); });
    // claude is claude.exe here: spawn without a shell so array args (a multi-word
    // prompt) pass cleanly. Some installs ship claude.cmd, which Node refuses to
    // spawn without a shell (EINVAL) — fall back to a shell, quoting the args.
    const claude = spawn('claude', claudeArgs, { stdio: 'inherit' });
    claude.on('error', e => {
      if (e.code === 'EINVAL' || e.code === 'ENOENT') {
        const quoted = claudeArgs.map(a => `"${String(a).replace(/"/g, '\\"')}"`).join(' ');
        const viaShell = spawn(`claude ${quoted}`, { stdio: 'inherit', shell: true });
        viaShell.on('error', e2 => { stop(); fail(`shells dev: could not launch claude (${e2.message}). Is the Claude Code CLI on your PATH?`); });
        onExit(viaShell);
        return;
      }
      stop();
      fail(`shells dev: could not launch claude (${e.message}). Is the Claude Code CLI on your PATH?`);
    });
    onExit(claude);
    break;
  }

  case 'doctor':
    // doctor.js runs on require and exits with its own code.
    require('./doctor.js');
    break;

  case 'version': {
    const fs = require('fs');
    let line;
    const stamp = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '.shells-version'), 'utf8')); } catch { return null; } })();
    if (stamp) line = `shells kit ${stamp.version} (installed ${stamp.installed_at})`;
    else { try { line = `shells kit ${require('./package.json').version} (source tree)`; } catch { line = 'shells kit (version unknown)'; } }
    process.stdout.write(line + '\n');
    break;
  }

  case 'init': {
    // Re-apply the wiring for the project this vendored copy lives in. The vendor
    // prefix is however this dir is named relative to the project root (cwd) —
    // usually ".shells" — so a custom install dir still wires correctly.
    const projectRoot = process.cwd();
    const vendor = path.relative(projectRoot, __dirname) || '.';
    const res = require('./lib/init').rewire({ projectRoot, vendor, dryRun: rest.includes('--dry-run') });
    process.stdout.write(`re-wiring ${vendor} in ${projectRoot}${res.dryRun ? ' (dry run)' : ''}:\n`);
    for (const s of res.steps) process.stdout.write(`  ${s.action.padEnd(9)} ${s.label}\n`);
    break;
  }

  case 'update': {
    const fs = require('fs');
    let cur = '';
    try { const s = JSON.parse(fs.readFileSync(path.join(__dirname, '.shells-version'), 'utf8')); cur = ` (this install is ${s.version})`; } catch { /* no stamp */ }
    process.stdout.write([
      `Update the vendored kit${cur} by re-running the scaffolder from the project root:`,
      '',
      '  npx create-shells . --force',
      '',
      'That re-copies the kit here from the latest published version — your',
      '.claude/settings.json, CLAUDE.md, and .shells/state/ are left untouched',
      '(state and wiring are not part of the copied kit).'
    ].join('\n') + '\n');
    break;
  }

  default:
    fail(USAGE);
}
