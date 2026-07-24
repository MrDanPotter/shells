#!/usr/bin/env node
'use strict';

// create-shells — the one-shot scaffolder (run via `npx create-shells`, not kept).
//
//   npx create-shells                 add shells to the CURRENT project
//   npx create-shells my-app          scaffold a new project directory
//
// Flags:
//   --dry-run     print exactly what would happen; write nothing
//   --with-demo   also vendor the reference front end (reference/)
//   --force       re-copy .shells/ even where it already exists
//   --help        this message
//
// It writes .shells/ (the vendored kit) plus three thin integration points into the
// host project — see lib/init.js. Zero dependencies: Node built-ins only.

const path = require('path');
const { init, VENDOR } = require('../lib/init');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const positional = argv.filter(a => !a.startsWith('--'));

const USAGE = [
  'create-shells — scaffold shells into a project',
  '',
  '  npx create-shells [dir] [--dry-run] [--with-demo] [--force]',
  '',
  '  (no dir)      add shells to the current directory',
  '  dir           scaffold into (and create) that directory',
  '  --dry-run     show the plan, write nothing',
  '  --with-demo   also vendor the reference front end',
  '  --force       re-copy .shells/ even if present'
].join('\n');

if (flags.has('--help')) { process.stdout.write(USAGE + '\n'); process.exit(0); }

const unknown = [...flags].filter(f => !['--dry-run', '--with-demo', '--force', '--help'].includes(f));
if (unknown.length) { process.stderr.write(`create-shells: unknown flag(s): ${unknown.join(', ')}\n\n${USAGE}\n`); process.exit(1); }

const opts = {
  targetDir: positional[0] ? path.resolve(positional[0]) : process.cwd(),
  greenfield: Boolean(positional[0]),
  dryRun: flags.has('--dry-run'),
  withDemo: flags.has('--with-demo'),
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

  process.stdout.write([
    '',
    result.dryRun ? 'Re-run without --dry-run to apply.' : 'Next steps:',
    result.dryRun ? '' : `  1. Open a Claude Code session in this project and arm the watcher when`,
    result.dryRun ? '' : `     ${VENDOR}/shells.js's session-start hook prints the Monitor(...) call.`,
    result.dryRun ? '' : `  2. Build a front end against ${VENDOR}/protocol.md (or run the reference`,
    result.dryRun ? '' : `     server with --with-demo). Verify with: node ${VENDOR}/doctor.js`,
    ''
  ].filter(l => l !== '').join('\n') + '\n');
} catch (e) {
  process.stderr.write('create-shells: ' + ((e && e.message) || e) + '\n');
  process.exit(1);
}
