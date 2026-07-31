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
//   node shells.js register                   add this project to the hub registry (lib/registry.js)
//   node shells.js unregister [dir|key]       remove a project from the hub registry
//   node shells.js hub                        start the shared server for all registered projects
//   node shells.js dev                        start/reuse the hub + launch Claude Code for this project
//   node shells.js doctor                     self-check this install
//   node shells.js version                    print the vendored kit version
//   node shells.js init                       re-apply the wiring for this install
//   node shells.js update                     how to pull a newer kit

const path = require('path');
const [area, ...rest] = process.argv.slice(2);

function fail(msg) { process.stderr.write(msg + '\n'); process.exit(1); }

// Is a shells server already answering on host:port? Used by `hub` (be a singleton)
// and `dev` (reuse an already-running hub instead of starting a second server).
function probePort(host, port) {
  return new Promise(resolve => {
    const req = require('http').get({ host, port, path: '/api/version', timeout: 600 },
      r => { r.resume(); resolve(r.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

const USAGE = [
  'usage: node shells.js <area> ...',
  '  hook activity <Event>        e.g. UserPromptSubmit, PostToolUse, Stop, SessionEnd',
  '  hook gate <prompt|stop>      inbound delivery hook',
  '  hook session-start           startup instructions',
  '  watch [pollMs]               keep-alive inbox watcher',
  '  store <cmd> [args]           new|list|get|respond|read|resolve|reopen',
  '  register [--list]            add this project to the hub registry (or --list it)',
  '  unregister [dir|key]         remove a project from the hub registry',
  '  hub                          start the shared server for all registered projects',
  '  dev                          start/reuse the hub + launch Claude Code for this project',
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
    // One command to bring up the whole loop: ensure the shared web UI (the hub) is
    // running, register THIS project with it, then launch Claude Code in the foreground
    // and tear down anything we started on exit. A convenience launcher, not part of
    // the core mechanism — it needs the included UI (skip it if you scaffolded with
    // --no-ui) and `claude` on PATH.
    //
    // Hub-aware: if a shells server is already answering on the port, we REUSE it
    // instead of starting a second (this is what makes many projects share one hub);
    // otherwise we start one. Either way this project is reachable at /p/<key>/ because
    // the server resolves the machine registry per request.
    //
    // Crucially, it PRIMES the session to arm the watcher on its very first turn.
    // Without that, a user who only ever touches the web UI never gives the model a
    // turn — so it never arms the watcher and web-UI messages are never delivered.
    const fs = require('fs');
    const { spawn } = require('child_process');
    const server = path.join(__dirname, 'reference', 'server.js');
    if (!fs.existsSync(server)) {
      fail('shells dev: the web UI is not installed here (scaffolded with --no-ui?). '
        + 'Run your own front end and launch `claude` yourself.');
    }
    const port = process.env.PORT || 4420;
    const host = process.env.HOST || '127.0.0.1';

    // Register this project so the hub serves it under /p/<key>/, and address the rest
    // of dev at that namespaced URL. Registration is idempotent and keeps the key.
    const entry = require('./lib/registry').register({ root: process.cwd(), stateDir: require('./kernel/lib/paths').stateDir() });
    const key = entry.key;
    const uiUrl = `http://${host}:${port}/p/${key}/`;

    probePort(host, port).then(up => {
      // Reuse a running hub; else start one with --watch (this is the edit-the-shell
      // loop, where the whole UI is a template string baked into server.js at load, so
      // Node's built-in file watcher turns "see my change" into a browser refresh).
      let srv = null;
      if (!up) {
        srv = spawn(process.execPath, ['--watch', server], { stdio: 'ignore', env: process.env });
        srv.on('error', e => process.stderr.write(`shells dev: UI failed to start: ${e.message}\n`));
      }
      const stop = () => { if (srv) { try { srv.kill(); } catch { /* already gone */ } } };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);

      // Visible in the Claude UI as up-front "initialization instructions": names this
      // project's web UI, says the terminal is not read (push to the web UI), and has
      // the model arm the watcher on its first turn.
      const armPrompt = `shells initialization instructions\n\n`
        + `The shells web UI for THIS project is at ${uiUrl} — that is the interface for this `
        + `session. Treat this terminal as something the user will NOT read: push everything the user `
        + `should see to the web UI as messages through the store, never as terminal chat.\n\n`
        + `Now:\n`
        + `1. Start the keep-alive inbox watcher exactly as the SessionStart hook instructed (the Monitor tool call).\n`
        + `2. Once it is armed, push a notification to the web UI reporting that shells is initialized and you are standing by.`;
      const claudeArgs = [...rest, armPrompt];

      process.stdout.write(`shells UI:  ${uiUrl}   (${up ? 'using the running hub' : 'started the hub'} — launching Claude Code)\n`);
      process.stdout.write(`embed:      <script src="http://${host}:${port}/p/${key}/overlay.js"></script>\n`);

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
    });
    break;
  }

  case 'hub': {
    // Start the shared multiplexed server — one process, one port, serving every
    // registered project under /p/<key>/. Singleton: if a shells server is already
    // answering on the port, reuse it and just report. Foreground; ^C stops it. This is
    // the same server.js `dev` starts; `hub` is for running it WITHOUT launching a
    // session (start the hub once, then open sessions in each project).
    const fs = require('fs');
    const server = path.join(__dirname, 'reference', 'server.js');
    if (!fs.existsSync(server)) {
      fail('shells hub: the web UI is not installed here (scaffolded with --no-ui?). '
        + 'Run your own front end against the API instead.');
    }
    const port = process.env.PORT || 4420;
    const host = process.env.HOST || '127.0.0.1';
    const registry = require('./lib/registry');
    const listProjects = () => {
      const all = registry.list();
      if (!all.length) { process.stdout.write('  (no projects registered yet — run `shells.js register` in a project)\n'); return; }
      for (const p of all) process.stdout.write(`  http://${host}:${port}/p/${p.key}/  -> ${p.stateDir}\n`);
    };
    probePort(host, port).then(up => {
      if (up) {
        process.stdout.write(`shells hub already running -> http://${host}:${port}\n`);
        listProjects();
        process.exit(0);
      }
      process.stdout.write(`shells hub -> http://${host}:${port}  (serving all registered projects; ^C to stop)\n`);
      listProjects();
      require(server);   // server.js listens on load, in THIS process (foreground)
    });
    break;
  }

  case 'register': {
    // Add (or refresh) THIS install in the hub's machine-level registry so the shared
    // server can route /p/<key>/ to its state. The state dir comes from this install's
    // own paths.stateDir(), so it's right whether this is a scaffolded project or the
    // source repo. Identified by root, so re-registering keeps the same key. `--list`
    // prints the registry instead of writing.
    const registry = require('./lib/registry');
    if (rest.includes('--list')) {
      const all = registry.list();
      if (!all.length) process.stdout.write('(no projects registered)\n');
      else for (const p of all) process.stdout.write(`  ${p.key.padEnd(24)} ${p.stateDir}\n`);
      break;
    }
    const entry = registry.register({ root: process.cwd(), stateDir: require('./kernel/lib/paths').stateDir() });
    const port = process.env.PORT || 4420;
    process.stdout.write(`registered '${entry.key}' -> ${entry.stateDir}\n`
      + `  embed:    <script src="http://127.0.0.1:${port}/p/${entry.key}/overlay.js"></script>\n`
      + `  full UI:  http://127.0.0.1:${port}/p/${entry.key}/\n`
      + `  registry: ${registry.registryFile()}\n`);
    break;
  }

  case 'unregister': {
    const registry = require('./lib/registry');
    const target = rest.find(a => !a.startsWith('--')) || process.cwd();
    const n = registry.unregister(target);
    process.stdout.write(n
      ? `unregistered ${n} entr${n === 1 ? 'y' : 'ies'} matching ${target}\n`
      : `nothing matched ${target}\n`);
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
