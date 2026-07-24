'use strict';

// init.js — the scaffold algorithm. Copies the kit into <project>/.shells/ and wires
// the three integration points (settings.json, CLAUDE.md, .gitignore). Everything it
// does is expressed as a list of steps, each of which can describe itself (for
// --dry-run) and apply itself — so "print the plan" and "do the plan" run the exact
// same code path, and the dry-run can never lie about what a real run would do.
//
// Two entry points share the wiring code:
//   • init()   — a fresh scaffold: copy the kit, wire, stamp the version.
//   • rewire() — an in-place re-wire of an already-vendored install, used by
//                `shells.js init`. No copy, no stamp; just re-assert the wiring.
//
// Zero dependencies: Node built-ins only (fs.cpSync for the recursive copy).

const fs = require('fs');
const path = require('path');
const manifest = require('./manifest');
const { planSettings } = require('./wire-settings');
const { planClaudeMd } = require('./wire-claude-md');
const { planGitignore } = require('./wire-gitignore');

// Where the kit SOURCE lives — the package root (lib/ -> ..). In the dev repo and in
// the published create-shells tarball alike, shells.js/kernel/… sit here.
const PKG_ROOT = path.resolve(__dirname, '..');
const VENDOR = '.shells';

function safeReadJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// Copy one manifest path (file or dir) into <project>/.shells/. Idempotent by
// default: an existing destination is left alone unless --force re-copies it.
function planCopy(projectRoot, relPath, force) {
  const src = path.join(PKG_ROOT, relPath);
  const dest = path.join(projectRoot, VENDOR, relPath);
  const exists = fs.existsSync(dest);
  return {
    label: `${VENDOR}/${relPath}`,
    action: exists ? (force ? 'overwrite' : 'skip') : 'copy',
    apply() {
      if (exists && !force) return;
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    }
  };
}

function planStateDir(projectRoot, vendor) {
  const dir = path.join(projectRoot, vendor, 'state');
  const exists = fs.existsSync(dir);
  return {
    label: `${vendor}/state/`,
    action: exists ? 'unchanged' : 'create',
    apply() { fs.mkdirSync(dir, { recursive: true }); }
  };
}

// Records which kit version was vendored and when, so `shells.js version` can report
// it and a future `update` can detect drift. Written at scaffold time (the source
// package.json is present); an in-place rewire leaves it alone.
function planVersionStamp(projectRoot, vendor) {
  const pkg = safeReadJson(path.join(PKG_ROOT, 'package.json')) || {};
  const file = path.join(projectRoot, vendor, '.shells-version');
  const existed = fs.existsSync(file);
  const stamp = JSON.stringify({ version: pkg.version || '0.0.0', installed_at: new Date().toISOString() }, null, 2) + '\n';
  return {
    label: `${vendor}/.shells-version`,
    action: existed ? 'update' : 'create',
    apply() { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, stamp); }
  };
}

// The three integration points + the state dir — shared by a fresh scaffold and an
// in-place re-wire.
function wiringSteps(projectRoot, vendor) {
  return [
    planSettings(projectRoot, vendor),
    planClaudeMd(projectRoot, vendor),
    planGitignore(projectRoot, vendor),
    planStateDir(projectRoot, vendor)
  ];
}

function init(opts) {
  const projectRoot = opts.targetDir;
  const dryRun = Boolean(opts.dryRun);

  if (projectRoot === PKG_ROOT) {
    throw new Error('refusing to scaffold shells into its own source tree');
  }

  // Greenfield: create the target directory up front (real runs only).
  if (opts.greenfield && !fs.existsSync(projectRoot) && !dryRun) {
    fs.mkdirSync(projectRoot, { recursive: true });
  }

  const steps = [];

  // 1. vendor the kit (+ the demo front end, only on --with-demo)
  const toCopy = [...manifest.kit, ...(opts.withDemo ? manifest.demo : [])];
  for (const rel of toCopy) steps.push(planCopy(projectRoot, rel, opts.force));

  // 2. the three integration points + a home for runtime state
  steps.push(...wiringSteps(projectRoot, VENDOR));

  // 3. stamp the vendored version
  steps.push(planVersionStamp(projectRoot, VENDOR));

  if (!dryRun) for (const s of steps) s.apply();

  return { projectRoot, vendor: VENDOR, dryRun, withDemo: Boolean(opts.withDemo), steps };
}

// Re-apply just the wiring against an already-vendored install (`shells.js init`).
// The kit is already present, so this neither copies nor re-stamps — it just makes
// the settings.json / CLAUDE.md / .gitignore wiring match the current kit again,
// handy if a project's config drifted or was hand-edited.
function rewire(opts) {
  const projectRoot = opts.projectRoot;
  const vendor = opts.vendor || VENDOR;
  const dryRun = Boolean(opts.dryRun);
  const steps = wiringSteps(projectRoot, vendor);
  if (!dryRun) for (const s of steps) s.apply();
  return { projectRoot, vendor, dryRun, steps };
}

module.exports = { init, rewire, PKG_ROOT, VENDOR };
