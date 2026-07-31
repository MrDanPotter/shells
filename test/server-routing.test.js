'use strict';

// Integration test for the multiplexed front door (Option A, P2). Spawns the REAL
// reference server against throwaway state + a throwaway registry, then checks:
//   - /p/<key>/... is served against THAT project's state dir;
//   - un-namespaced /... still works, against the default state dir;
//   - the two are isolated (a write under one key is invisible to the default and
//     lands in that project's own .shells/state on disk);
//   - an unregistered key is refused (404);
//   - /p/<key>/overlay.js serves the widget.
//
//   node test/server-routing.test.js        (or: npm test)
//
// Uses global fetch (Node 18+). Always kills the spawned server. Zero deps.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'reference', 'server.js');

let fails = 0;
const ok = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + (extra || '')}`);
  if (!cond) fails++;
};
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const HOME = tmp('shells-rt-home-');
const DEFAULT_STATE = tmp('shells-rt-default-');
const PROJ = tmp('shells-rt-proj-');
const PORT = 4400 + Math.floor(Math.random() * 120);   // avoid the well-known 4420
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Register the project BEFORE the server boots (it reads the registry per request,
// so order isn't strictly required, but this mirrors real use).
process.env.SHELLS_HOME = HOME;
const registry = require('../lib/registry');
// app config uses a harmless, fast-exiting command + an unreachable URL, so the launch
// path is exercised without starting any real dev server.
const entry = registry.register({ root: PROJ, name: 'routing test', app: { cmd: 'node --version', url: 'http://127.0.0.1:1' } });
const KEY = entry.key;

async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${ORIGIN}/api/version`); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 120));
  }
  return false;
}

(async () => {
  const srv = spawn(process.execPath, [SERVER], {
    // SHELLS_TERMINAL_LAUNCHER makes "Launch session" spawn this harmless command
    // instead of opening a real terminal window during the test.
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SHELLS_HOME: HOME, SHELLS_STATE_DIR: DEFAULT_STATE, SHELLS_TERMINAL_LAUNCHER: 'node --version' },
    stdio: 'ignore'
  });

  try {
    ok('server came up', await waitReady(8000));

    // a namespaced write goes to the PROJECT's state
    const postR = await fetch(`${ORIGIN}/p/${KEY}/api/inbox`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello project' })
    });
    ok('POST /p/<key>/api/inbox ok', postR.ok, 'status ' + postR.status);

    const nsChat = await (await fetch(`${ORIGIN}/p/${KEY}/api/inbox`)).json();
    ok('namespaced chat has the message', Array.isArray(nsChat) && nsChat.some(r => r.text === 'hello project'),
      JSON.stringify((nsChat || []).map(r => r.text)));

    // it landed in the project's OWN .shells/state on disk
    ok('write persisted under <project>/.shells/state',
      fs.existsSync(path.join(PROJ, '.shells', 'state', 'chat-log.json')));

    // the DEFAULT state (un-namespaced) is isolated — it never saw that message
    const defChat = await (await fetch(`${ORIGIN}/api/inbox`)).json();
    ok('default chat is isolated from the project', Array.isArray(defChat) && !defChat.some(r => r.text === 'hello project'),
      JSON.stringify((defChat || []).map(r => r.text)));

    // un-namespaced API still works at all
    const defMsgs = await fetch(`${ORIGIN}/api/messages`);
    ok('un-namespaced /api/messages still works', defMsgs.ok && Array.isArray(await defMsgs.json()));

    // an unregistered key is refused
    const bogus = await fetch(`${ORIGIN}/p/no-such-key/api/messages`);
    ok('unknown project key -> 404', bogus.status === 404, 'status ' + bogus.status);

    // the overlay is served under the namespace
    const ov = await fetch(`${ORIGIN}/p/${KEY}/overlay.js`);
    const ovText = ov.ok ? await ov.text() : '';
    ok('/p/<key>/overlay.js serves the widget', ov.ok && /shells overlay/.test(ovText), 'status ' + ov.status);

    // the full page is served under the namespace too
    const page = await fetch(`${ORIGIN}/p/${KEY}/`);
    ok('/p/<key>/ serves the page', page.ok && /text\/html/.test(page.headers.get('content-type') || ''), 'status ' + page.status);

    // `shells.js hub` against an already-running server is a singleton no-op that
    // detects it and lists the registered project rather than starting a second.
    let hubOut = '';
    try {
      hubOut = require('child_process').execFileSync(process.execPath, [path.join(REPO, 'shells.js'), 'hub'],
        { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SHELLS_HOME: HOME }, encoding: 'utf8', timeout: 8000 });
    } catch (e) { hubOut = (e.stdout || '') + (e.stderr || ''); }
    ok('shells.js hub detects the running server', /already running/.test(hubOut), hubOut.slice(0, 80));
    ok('shells.js hub lists the registered project', hubOut.includes('/p/' + KEY + '/'), hubOut.slice(0, 200));

    // the fleet view aggregates every registered project's state
    const fleet = await (await fetch(`${ORIGIN}/hub/api/projects`)).json();
    ok('/hub/api/projects returns the project', Array.isArray(fleet) && fleet.some(p => p.key === KEY),
      JSON.stringify((fleet || []).map(p => p.key)));
    const mine = (fleet || []).find(p => p.key === KEY) || {};
    ok('fleet entry carries counts + last chat', mine.counts && mine.last && mine.last.text === 'hello project',
      JSON.stringify(mine.last));
    const hubPage = await fetch(`${ORIGIN}/hub`);
    ok('/hub serves the dashboard page', hubPage.ok && /text\/html/.test(hubPage.headers.get('content-type') || ''), 'status ' + hubPage.status);

    // app launch: a configured project reports its app and can be launched. The command
    // is a safe no-op (node --version); the URL is unreachable so launch spawns it.
    const appStat = await (await fetch(`${ORIGIN}/p/${KEY}/api/app`)).json();
    ok('GET /p/<key>/api/app reports the configured app',
      appStat.configured === true && appStat.url === 'http://127.0.0.1:1' && appStat.running === false, JSON.stringify(appStat));
    const launch = await fetch(`${ORIGIN}/p/${KEY}/api/app/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const launchBody = await launch.json();
    ok('POST /p/<key>/api/app/launch spawns the configured command', launch.ok && launchBody.launched === true, JSON.stringify(launchBody));

    // a project with no app configured reports configured:false and refuses to launch
    const noapp = registry.register({ root: PROJ + '-noapp', name: 'noapp' });
    const na = await (await fetch(`${ORIGIN}/p/${noapp.key}/api/app`)).json();
    ok('unconfigured project reports configured:false', na.configured === false, JSON.stringify(na));
    const naLaunch = await fetch(`${ORIGIN}/p/${noapp.key}/api/app/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    ok('launch with no app configured -> 400', naLaunch.status === 400, 'status ' + naLaunch.status);
    registry.unregister(noapp.key);

    // session launch: opens a terminal running the project's session command (default
    // claude). The real terminal open is stubbed via SHELLS_TERMINAL_LAUNCHER above.
    const sess = await fetch(`${ORIGIN}/p/${KEY}/api/session/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const sessBody = await sess.json();
    ok('POST /p/<key>/api/session/launch launches (default cmd = claude)',
      sess.ok && sessBody.launched === true && sessBody.cmd === 'claude', JSON.stringify(sessBody));

    // the hub is the PRIMARY page: with a project registered, the ROOT serves the fleet.
    // Discriminate on markers unique to each page: the hub's grid vs the client's send
    // form (both pages reference /hub/api/projects, so that string can't tell them apart).
    const rootHub = await (await fetch(`${ORIGIN}/`)).text();
    ok('/ serves the hub when a project is registered',
      /id="grid"/.test(rootHub) && !/id="sendform"/.test(rootHub), rootHub.slice(0, 80));

    // ...and falls back to the single-project client when the registry is empty
    // (backward compat for the standalone demo + solo installs). Done last — it drops
    // the registration the KEY-dependent checks above relied on.
    registry.unregister(KEY);
    const rootSolo = await (await fetch(`${ORIGIN}/`)).text();
    ok('/ falls back to the single-project client when registry is empty',
      /id="sendform"/.test(rootSolo) && !/id="grid"/.test(rootSolo), rootSolo.slice(0, 80));
  } finally {
    // Wait for the child to fully exit BEFORE we leave — killing it and calling
    // process.exit() in the same tick trips a libuv handle-teardown assertion on
    // Windows. Awaiting its 'exit' lets that handle close cleanly first.
    await new Promise(res => {
      if (srv.exitCode !== null || srv.signalCode !== null) return res();
      srv.once('exit', res); srv.once('error', res);
      try { srv.kill(); } catch { res(); }
    });
    for (const d of [HOME, DEFAULT_STATE, PROJ]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  console.log(`\nserver-routing test — ${fails === 0 ? 'ALL PASS' : fails + ' FAILED'}`);
  process.exitCode = fails === 0 ? 0 : 1;   // let the loop drain instead of a hard exit
})();
