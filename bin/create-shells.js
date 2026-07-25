#!/usr/bin/env node
'use strict';

// create-shells — the one-shot scaffolder (run via `npx create-shells`, not kept).
//
//   npx create-shells my-app          scaffold into (and create) my-app/
//
// A target directory is REQUIRED — create-shells never scaffolds into the bare
// current directory, so you can't wire up your cwd by accident.
//
// Flags:
//   --dry-run     print exactly what would happen; write nothing
//   --no-ui       skip the included web UI (bring your own front end)
//   --force       re-copy .shells/ even where it already exists
//   --help        this message
//
// It writes .shells/ (the vendored kit + UI) plus three thin integration points into
// the target project — see lib/init.js. Zero dependencies: Node built-ins only.

const path = require('path');
const { init, VENDOR } = require('../lib/init');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const positional = argv.filter(a => !a.startsWith('--'));

const USAGE = [
  'create-shells — scaffold shells into a new project directory',
  '',
  '  npx create-shells <dir> [--dry-run] [--no-ui] [--force]',
  '',
  '  <dir>         target directory (REQUIRED; created if missing)',
  '  --dry-run     show the plan, write nothing',
  '  --no-ui       skip the included web UI (bring your own front end)',
  '  --force       re-copy .shells/ even if present'
].join('\n');

if (flags.has('--help')) { process.stdout.write(USAGE + '\n'); process.exit(0); }

const unknown = [...flags].filter(f => !['--dry-run', '--no-ui', '--force', '--help'].includes(f));
if (unknown.length) { process.stderr.write(`create-shells: unknown flag(s): ${unknown.join(', ')}\n\n${USAGE}\n`); process.exit(1); }

if (!positional[0]) {
  process.stderr.write('create-shells: a target directory is required.\n\n' + USAGE + '\n');
  process.exit(1);
}

const opts = {
  targetDir: path.resolve(positional[0]),
  dryRun: flags.has('--dry-run'),
  noUi: flags.has('--no-ui'),
  force: flags.has('--force')
};

const GLYPH = { copy: '+', overwrite: '~', skip: '·', create: '+', update: '~', unchanged: '·' };

try {
  const result = init(opts);

  const head = result.dryRun ? 'Plan (dry run — nothing written):' : 'shells installed:';
  process.stdout.write(`\n${head}\n  into ${result.projectRoot}\n\n`);
  for (const s of result.steps) {
    process.stdout.write(`  ${GLYPH[s.action] || '?'} ${s.action.padEnd(9)} ${s.label}\n`);
  }

  if (result.dryRun) {
    process.stdout.write('\nRe-run without --dry-run to apply.\n');
  } else {
    const steps = [`cd ${positional[0]}`];
    if (result.ui) {
      steps.push(`start the web UI + Claude Code (Claude arms the watcher on launch): node ${VENDOR}/shells.js dev`);
      steps.push(`open http://127.0.0.1:4420 and drive the session from there`);
    } else {
      steps.push(`build/run your own front end against ${VENDOR}/protocol.md, then launch Claude Code`);
      steps.push(`in that session, arm the watcher as its session-start hook prints`);
    }
    steps.push(`verify the wiring anytime with: node ${VENDOR}/shells.js doctor`);
    process.stdout.write('\nNext steps:\n' + steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n') + '\n');
  }
} catch (e) {
  process.stderr.write('create-shells: ' + ((e && e.message) || e) + '\n');
  process.exit(1);
}
