'use strict';

// Tests for the shared-hub foundation (Option A):
//   P0 — lib/registry.js: the machine-level project registry that maps a routing
//        key to a project's state dir (register/get/resolve/list/unregister, dedupe
//        by root, key-collision disambiguation, routing-safe slugs).
//   P1 — kernel/lib/context.js + paths.js: per-request state-dir context. The crux
//        is that ONE process can serve MANY state dirs concurrently and that a caller
//        who never sets a context is unaffected (single-project behaviour preserved).
//
//   node test/hub.test.js        (or: npm test)
//
// Zero dependencies — Node built-ins only. Uses SHELLS_HOME + throwaway dirs so it
// never touches the real registry or this repo's state.

const fs = require('fs');
const os = require('os');
const path = require('path');

let fails = 0;
const ok = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + (extra || '')}`);
  if (!cond) fails++;
};
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Point the registry at a throwaway home BEFORE requiring the module.
const HOME = tmp('shells-home-');
process.env.SHELLS_HOME = HOME;

const registry = require('../lib/registry');

// ---- P0: registry -----------------------------------------------------------

const rootA = tmp('shells-projA-');
const rootB = tmp('shells-projB-');

const a = registry.register({ root: rootA, name: 'Proj A' });
ok('register returns a routing-safe slug key', /^[a-z0-9-]+$/.test(a.key), a.key);
ok('register maps key -> <root>/.shells/state', a.stateDir === path.join(rootA, '.shells', 'state'), a.stateDir);
ok('registry file lives under SHELLS_HOME', registry.registryFile() === path.join(HOME, 'registry.json'));
ok('get returns the entry', (registry.get(a.key) || {}).root === rootA);
ok('resolveStateDir returns the state dir', registry.resolveStateDir(a.key) === a.stateDir);
ok('resolveStateDir(unknown) is null (router rejects it)', registry.resolveStateDir('no-such-key') === null);

// re-registering the SAME root is idempotent and keeps the key (embed src stays valid)
const a2 = registry.register({ root: rootA, name: 'Proj A renamed' });
ok('re-register same root keeps the key', a2.key === a.key, a2.key);
ok('re-register same root does not duplicate', registry.list().length === 1, 'len=' + registry.list().length);

// a DIFFERENT root whose name slugs to the same key gets disambiguated
const b = registry.register({ root: rootB, name: 'Proj A' });
ok('colliding key on a different root is disambiguated', b.key !== a.key, `${a.key} vs ${b.key}`);
ok('two distinct projects now registered', registry.list().length === 2, 'len=' + registry.list().length);

// unregister by key, then by root
ok('unregister by key drops one', registry.unregister(a.key) === 1);
ok('unregister by root drops one', registry.unregister(rootB) === 1);
ok('registry now empty', registry.list().length === 0);
ok('unregister(unknown) drops nothing', registry.unregister('nope') === 0);

// slug safety — no path separators or traversal can survive into a key
ok('slug strips separators/traversal', registry.slug('../../etc/passwd') === 'etc-passwd', registry.slug('../../etc/passwd'));
ok('slug of empty falls back', registry.slug('') === 'project');

// register records an EXPLICIT state dir when given — the CLI passes the install's own
// stateDir(), which is right for a scaffolded project AND the source repo.
const rootC = tmp('shells-projC-');
const customState = tmp('shells-stateC-');
const c = registry.register({ root: rootC, stateDir: customState });
ok('register honors an explicit stateDir', c.stateDir === path.resolve(customState), c.stateDir);
registry.unregister(rootC);

// ---- P1: per-request state context -----------------------------------------

const { runWithStateDir, currentStateDir } = require('../kernel/lib/context');
const paths = require('../kernel/lib/paths');
const store = require('../store/store');

ok('no context set -> currentStateDir() is null', currentStateDir() === null);

// With no context and no env, paths.stateDir() must fall back to the built-in default
// (single-project behaviour unchanged). Guard the env in case the runner set it.
const savedEnv = process.env.SHELLS_STATE_DIR;
delete process.env.SHELLS_STATE_DIR;
ok('no context, no env -> default state dir', paths.stateDir() === path.join(paths.ROOT, 'state'));

// context wins over the env override
process.env.SHELLS_STATE_DIR = tmp('shells-env-');
const ctxDir = tmp('shells-ctx-');
ok('context dir overrides SHELLS_STATE_DIR', runWithStateDir(ctxDir, () => paths.stateDir()) === ctxDir);
ok('env still applies OUTSIDE any context', paths.stateDir() === process.env.SHELLS_STATE_DIR);
if (savedEnv === undefined) delete process.env.SHELLS_STATE_DIR; else process.env.SHELLS_STATE_DIR = savedEnv;

// The real point: the store honours the ambient dir, so ONE process writes two
// projects' state into two separate dirs with no cross-talk.
const dir1 = tmp('shells-s1-');
const dir2 = tmp('shells-s2-');
const id1 = runWithStateDir(dir1, () => store.create({ kind: 'task', title: 'in project 1' }));
const id2 = runWithStateDir(dir2, () => store.create({ kind: 'task', title: 'in project 2' }));

const list1 = runWithStateDir(dir1, () => store.list({ all: true }));
const list2 = runWithStateDir(dir2, () => store.list({ all: true }));
ok('project 1 sees only its own message', list1.length === 1 && list1[0].title === 'in project 1', JSON.stringify(list1.map(m => m.title)));
ok('project 2 sees only its own message', list2.length === 1 && list2[0].title === 'in project 2', JSON.stringify(list2.map(m => m.title)));
ok('the two ids differ', id1 !== id2);
ok('project 1 cannot see project 2\'s message', !runWithStateDir(dir1, () => store.get(id2)));

// context survives across an await (the hub handler is async)
(async () => {
  const seen = await runWithStateDir(dir1, async () => {
    await Promise.resolve();
    return store.list({ all: true }).map(m => m.title);
  });
  ok('context propagates across await', seen.length === 1 && seen[0] === 'in project 1', JSON.stringify(seen));

  // cleanup
  for (const d of [HOME, rootA, rootB, rootC, customState, ctxDir, dir1, dir2]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(`\nhub test — ${fails === 0 ? 'ALL PASS' : fails + ' FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})();
