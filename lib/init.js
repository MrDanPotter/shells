'use strict';

// init.js — the scaffold algorithm. Copies the kit into <project>/.shells/ and wires
// the three integration points (settings.json, CLAUDE.md, .gitignore). Everything it
// does is expressed as a list of steps, each of which can describe itself (for
// --dry-run) and apply itself — so "print the plan" and "do the plan" run the exact
// same code path, and the dry-run can never lie about what a real run would do.
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

function planStateDir(projectRoot) {
  const dir = path.join(projectRoot, VENDOR, 'state');
  const exists = fs.existsSync(dir);
  return {
    label: `${VENDOR}/state/`,
    action: exists ? 'unchanged' : 'create',
    apply() { fs.mkdirSync(dir, { recursive: true }); }
  };
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

  // 2. the three integration points
  steps.push(planSettings(projectRoot, VENDOR));
  steps.push(planClaudeMd(projectRoot, VENDOR));
  steps.push(planGitignore(projectRoot, VENDOR));

  // 3. somewhere for runtime state to land on first write
  steps.push(planStateDir(projectRoot));

  if (!dryRun) for (const s of steps) s.apply();

  return { projectRoot, vendor: VENDOR, dryRun, withDemo: Boolean(opts.withDemo), steps };
}

module.exports = { init, PKG_ROOT, VENDOR };
