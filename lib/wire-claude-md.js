'use strict';

// Wire the agent contract into the host project's root CLAUDE.md.
//
// The whole contract lives in <vendor>/contract/CLAUDE.fragment.md; we only add a
// one-line @import so Claude Code loads it every session. Single source of truth —
// updating the vendored fragment updates the contract, no copy to keep in sync.
// Idempotent: if the import line is already present, this is a no-op.

const fs = require('fs');
const path = require('path');

function importLine(vendor) {
  return `@${vendor}/contract/CLAUDE.fragment.md`;
}

function freshFile(vendor) {
  return [
    '# Driven by shells',
    '',
    'This project uses shells to report to an external front end instead of the',
    'terminal. The agent operating contract — surface work as messages, not chat —',
    'is imported below from the vendored kit.',
    '',
    importLine(vendor),
    ''
  ].join('\n');
}

function appendBlock(vendor) {
  return [
    '',
    '# shells — operating contract (surface work as messages, not chat)',
    importLine(vendor),
    ''
  ].join('\n');
}

function planClaudeMd(projectRoot, vendor) {
  const file = path.join(projectRoot, 'CLAUDE.md');
  const line = importLine(vendor);
  const existedBefore = fs.existsSync(file);
  const current = existedBefore ? fs.readFileSync(file, 'utf8') : '';
  const alreadyWired = current.includes(line);

  return {
    label: 'CLAUDE.md',
    action: !existedBefore ? 'create' : (alreadyWired ? 'unchanged' : 'update'),
    apply() {
      if (!existedBefore) { fs.writeFileSync(file, freshFile(vendor)); return; }
      if (alreadyWired) return;
      const sep = current.endsWith('\n') ? '' : '\n';
      fs.writeFileSync(file, current + sep + appendBlock(vendor));
    }
  };
}

module.exports = { planClaudeMd, importLine };
