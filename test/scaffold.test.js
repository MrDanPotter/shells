'use strict';

// End-to-end test for the create-shells scaffolder. Runs the REAL bin against
// throwaway project directories (never touching this repo's own state), the same
// discipline doctor.js uses. Covers: dry-run inertness, the vendored kit surface,
// settings.json/CLAUDE.md/.gitignore merge, idempotency, the vendored dispatcher
// subcommands, --with-demo, and greenfield creation.
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

// --- a fake EXISTING project (to exercise the merge paths) ---
const proj = tmp('shells-proj-');
fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
fs.writeFileSync(path.join(proj, '.claude', 'settings.json'),
  JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node my-own-hook.js' }] }] } }, null, 2));
fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# My app\n\nSome existing instructions.\n');
fs.writeFileSync(path.join(proj, '.gitignore'), 'node_modules/\n');

// 1. dry run writes nothing
run(['--dry-run'], proj);
ok('dry-run does not create .shells/', !exists(path.join(proj, '.shells')));
ok('dry-run does not touch CLAUDE.md', read(path.join(proj, 'CLAUDE.md')) === '# My app\n\nSome existing instructions.\n');

// 2. real run — vendored kit surface
run([], proj);
const V = path.join(proj, '.shells');
ok('.shells/shells.js vendored', exists(path.join(V, 'shells.js')));
ok('.shells/kernel/hooks/gate.js vendored', exists(path.join(V, 'kernel', 'hooks', 'gate.js')));
ok('.shells/store/seed.js vendored', exists(path.join(V, 'store', 'seed.js')));
ok('.shells/doctor.js vendored', exists(path.join(V, 'doctor.js')));
ok('.shells/lib/init.js vendored (enables shells.js init)', exists(path.join(V, 'lib', 'init.js')));
ok('.shells/contract fragment vendored', exists(path.join(V, 'contract', 'CLAUDE.fragment.md')));
ok('.shells/protocol.md vendored', exists(path.join(V, 'protocol.md')));
ok('reference/ NOT vendored (no --with-demo)', !exists(path.join(V, 'reference')));
ok('bin/ NOT vendored (scaffolder-only)', !exists(path.join(V, 'bin')));
ok('.shells/state/ created', exists(path.join(V, 'state')));
ok('.shells-version stamp written', exists(path.join(V, '.shells-version')));

// 2b. wiring merge
const settings = JSON.parse(read(path.join(proj, '.claude', 'settings.json')));
const ups = JSON.stringify(settings.hooks.UserPromptSubmit);
ok('settings: foreign hook preserved', ups.includes('node my-own-hook.js'));
ok('settings: shells hook added with .shells/ prefix', ups.includes('node .shells/shells.js hook activity UserPromptSubmit'));
ok('settings: gate hook present', ups.includes('node .shells/shells.js hook gate prompt'));
ok('settings: Stop has activity+gate', JSON.stringify(settings.hooks.Stop).includes('hook gate stop'));
ok('settings: SessionEnd wired', JSON.stringify(settings.hooks.SessionEnd).includes('hook activity SessionEnd'));
const claude = read(path.join(proj, 'CLAUDE.md'));
ok('CLAUDE.md keeps existing content', claude.includes('Some existing instructions.'));
ok('CLAUDE.md gets the import', claude.includes('@.shells/contract/CLAUDE.fragment.md'));
const gi = read(path.join(proj, '.gitignore'));
ok('.gitignore keeps existing', gi.includes('node_modules/'));
ok('.gitignore ignores .shells/state/', gi.includes('.shells/state/'));

// 3. idempotency — re-run yields no duplicates
run([], proj);
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

// 5. --with-demo vendors the reference front end
const proj2 = tmp('shells-demo-');
run(['--with-demo'], proj2);
ok('--with-demo vendors reference/server.js', exists(path.join(proj2, '.shells', 'reference', 'server.js')));

// 6. greenfield — create-shells <newdir>
const parent = tmp('shells-green-');
run(['fresh-app'], parent);
const green = path.join(parent, 'fresh-app');
ok('greenfield creates the target directory', exists(green));
ok('greenfield vendors the kit', exists(path.join(green, '.shells', 'shells.js')));
ok('greenfield writes fresh settings.json', exists(path.join(green, '.claude', 'settings.json')));
ok('greenfield creates a CLAUDE.md with the import', read(path.join(green, 'CLAUDE.md')).includes('@.shells/contract/CLAUDE.fragment.md'));
let greenDoctor = '';
try { greenDoctor = execFileSync(process.execPath, [path.join(green, '.shells', 'shells.js'), 'doctor'], { cwd: green, encoding: 'utf8' }); }
catch (e) { greenDoctor = (e.stdout || '') + (e.stderr || ''); }
ok('greenfield install passes its own doctor', /All checks passed/.test(greenDoctor), greenDoctor.slice(-120));

// cleanup
for (const d of [proj, proj2, parent]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

console.log(`\nscaffolder test — ${fails === 0 ? 'ALL PASS' : fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
