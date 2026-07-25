'use strict';

// End-to-end test for the create-shells scaffolder. Runs the REAL bin against
// throwaway directories (never touching this repo's own state), the same discipline
// doctor.js uses. Covers: the required directory arg, dry-run inertness, the vendored
// kit surface (UI included by default), settings.json/CLAUDE.md/.gitignore merge,
// idempotency, the vendored dispatcher subcommands, --no-ui, and the dev guard.
//
//   node test/scaffold.test.js        (or: npm test)
//
// Zero dependencies — Node built-ins only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const BIN = path.join(REPO, 'bin', 'create-shells.js');

let fails = 0;
const ok = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + (extra || '')}`);
  if (!cond) fails++;
};
const run = (args, cwd) => execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
const read = p => fs.readFileSync(p, 'utf8');
const exists = p => fs.existsSync(p);
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const parent = tmp('shells-parent-');

// 0. a bare directory arg is REQUIRED — no scaffolding into the cwd by accident
let reqErr = '';
try { run([], parent); } catch (e) { reqErr = (e.stderr || '') + (e.stdout || ''); }
ok('no directory arg errors', /target directory is required/.test(reqErr), reqErr.slice(0, 80));

// a fake EXISTING project at a named path (to exercise the merge paths)
const proj = path.join(parent, 'app');
fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
fs.writeFileSync(path.join(proj, '.claude', 'settings.json'),
  JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node my-own-hook.js' }] }] } }, null, 2));
fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# My app\n\nSome existing instructions.\n');
fs.writeFileSync(path.join(proj, '.gitignore'), 'node_modules/\n');

// 1. dry run writes nothing
run([proj, '--dry-run'], parent);
ok('dry-run does not create .shells/', !exists(path.join(proj, '.shells')));
ok('dry-run does not touch CLAUDE.md', read(path.join(proj, 'CLAUDE.md')) === '# My app\n\nSome existing instructions.\n');

// 2. real run — vendored kit surface, UI included by DEFAULT
run([proj], parent);
const V = path.join(proj, '.shells');
ok('.shells/shells.js vendored', exists(path.join(V, 'shells.js')));
ok('.shells/kernel/hooks/gate.js vendored', exists(path.join(V, 'kernel', 'hooks', 'gate.js')));
ok('.shells/store/seed.js vendored', exists(path.join(V, 'store', 'seed.js')));
ok('.shells/doctor.js vendored', exists(path.join(V, 'doctor.js')));
ok('.shells/lib/init.js vendored', exists(path.join(V, 'lib', 'init.js')));
ok('.shells/contract fragment vendored', exists(path.join(V, 'contract', 'CLAUDE.fragment.md')));
ok('.shells/protocol.md vendored', exists(path.join(V, 'protocol.md')));
ok('UI vendored by default: .shells/reference/server.js', exists(path.join(V, 'reference', 'server.js')));
ok('bin/ NOT vendored (scaffolder-only)', !exists(path.join(V, 'bin')));
ok('.shells/state/ created', exists(path.join(V, 'state')));
ok('.shells-version stamp written', exists(path.join(V, '.shells-version')));

// 2b. wiring merge
const settings = JSON.parse(read(path.join(proj, '.claude', 'settings.json')));
const ups = JSON.stringify(settings.hooks.UserPromptSubmit);
ok('settings: foreign hook preserved', ups.includes('node my-own-hook.js'));
ok('settings: shells hook targets the vendored shells.js', ups.includes('.shells/shells.js') && ups.includes('hook activity UserPromptSubmit'));
const upsCmds = settings.hooks.UserPromptSubmit.flatMap(g => (g.hooks || []).map(h => h.command));
const actCmd = upsCmds.find(c => c.includes('hook activity UserPromptSubmit')) || '';
ok('settings: hook path is absolute + quoted (cwd-proof)', /^node "[A-Za-z]:\/[^"]*\.shells\/shells\.js" hook activity UserPromptSubmit$/.test(actCmd), actCmd);
ok('settings: gate hook present', ups.includes('hook gate prompt'));
ok('settings: Stop has activity+gate', JSON.stringify(settings.hooks.Stop).includes('hook gate stop'));
ok('settings: SessionEnd wired', JSON.stringify(settings.hooks.SessionEnd).includes('hook activity SessionEnd'));
const claude = read(path.join(proj, 'CLAUDE.md'));
ok('CLAUDE.md keeps existing content', claude.includes('Some existing instructions.'));
ok('CLAUDE.md gets the import', claude.includes('@.shells/contract/CLAUDE.fragment.md'));
const gi = read(path.join(proj, '.gitignore'));
ok('.gitignore keeps existing', gi.includes('node_modules/'));
ok('.gitignore ignores .shells/state/', gi.includes('.shells/state/'));

// 3. idempotency — re-run yields no duplicates
run([proj], parent);
const settings2 = JSON.parse(read(path.join(proj, '.claude', 'settings.json')));
const shellsGroups = settings2.hooks.UserPromptSubmit.filter(g => JSON.stringify(g).includes('.shells/shells.js'));
ok('idempotent: exactly one shells group in UserPromptSubmit', shellsGroups.length === 1, 'got ' + shellsGroups.length);
ok('idempotent: foreign hook still there', JSON.stringify(settings2.hooks.UserPromptSubmit).includes('my-own-hook.js'));
const importCount = (read(path.join(proj, 'CLAUDE.md')).match(/@\.shells\/contract\/CLAUDE\.fragment\.md/g) || []).length;
ok('idempotent: exactly one CLAUDE.md import', importCount === 1, 'got ' + importCount);
const giCount = (read(path.join(proj, '.gitignore')).match(/\.shells\/state\//g) || []).length;
ok('idempotent: exactly one .gitignore entry', giCount === 1, 'got ' + giCount);

// 4. vendored dispatcher, end to end
const shells = (args, cwd) => { try { return execFileSync(process.execPath, [path.join(V, 'shells.js'), ...args], { cwd, encoding: 'utf8' }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
ok('vendored doctor passes', /All checks passed/.test(shells(['doctor'], proj)));
ok('shells.js version prints the kit version', /shells kit \d+\.\d+\.\d+/.test(shells(['version'], proj)));
ok('shells.js update prints npx guidance', /npx create-shells --force/.test(shells(['update'], proj)));
shells(['init'], proj);
const settings3 = JSON.parse(read(path.join(proj, '.claude', 'settings.json')));
const grp3 = settings3.hooks.UserPromptSubmit.filter(g => JSON.stringify(g).includes('.shells/shells.js'));
ok('shells.js init re-wire stays idempotent (one shells group)', grp3.length === 1, 'got ' + grp3.length);
ok('shells.js init preserves foreign hook', JSON.stringify(settings3.hooks.UserPromptSubmit).includes('my-own-hook.js'));

// 5. --no-ui skips the UI, and `dev` refuses without it
const noui = path.join(parent, 'noui-app');
run([noui, '--no-ui'], parent);
ok('--no-ui skips reference/', !exists(path.join(noui, '.shells', 'reference')));
ok('--no-ui still vendors the kit', exists(path.join(noui, '.shells', 'shells.js')));
let devErr = '';
try { execFileSync(process.execPath, [path.join(noui, '.shells', 'shells.js'), 'dev'], { cwd: noui, encoding: 'utf8' }); }
catch (e) { devErr = (e.stderr || '') + (e.stdout || ''); }
ok('shells.js dev refuses when the UI is absent', /web UI is not installed/.test(devErr), devErr.slice(0, 80));

// 6. greenfield — a brand-new directory is created and passes its own doctor
run([path.join(parent, 'fresh')], parent);
const fresh = path.join(parent, 'fresh');
ok('greenfield creates the target directory', exists(fresh));
ok('greenfield vendors the kit', exists(path.join(fresh, '.shells', 'shells.js')));
ok('greenfield includes the UI by default', exists(path.join(fresh, '.shells', 'reference', 'server.js')));
let greenDoctor = '';
try { greenDoctor = execFileSync(process.execPath, [path.join(fresh, '.shells', 'shells.js'), 'doctor'], { cwd: fresh, encoding: 'utf8' }); }
catch (e) { greenDoctor = (e.stdout || '') + (e.stderr || ''); }
ok('greenfield install passes its own doctor', /All checks passed/.test(greenDoctor), greenDoctor.slice(-120));

// cleanup
try { fs.rmSync(parent, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\nscaffolder test — ${fails === 0 ? 'ALL PASS' : fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
