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
const entry = registry.register({ root: PROJ, name: 'routing test' });
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
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SHELLS_HOME: HOME, SHELLS_STATE_DIR: DEFAULT_STATE },
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
