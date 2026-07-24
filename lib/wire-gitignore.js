'use strict';

// Keep shells' runtime state out of the host project's git history.
//
// The vendored kit resolves its state dir relative to its own root, so a kit at
// <vendor>/ writes runtime data to <vendor>/state/ — messages, inbox, the activity
// and watcher heartbeats. The vendored CODE is meant to be committed (like any
// vendored dependency); only its runtime STATE is ignored. Idempotent: if the entry
// is already ignored, this is a no-op.

const fs = require('fs');
const path = require('path');

function ignoreEntry(vendor) {
  return `${vendor}/state/`;
}

function block(vendor) {
  return [
    '# shells runtime state (messages, inbox, activity + watcher heartbeats)',
    ignoreEntry(vendor),
    ''
  ].join('\n');
}

// Already ignored if a non-comment line equals the entry, with or without a leading
// slash or trailing slash — enough to avoid a duplicate on re-run.
function alreadyIgnored(current, vendor) {
  const want = `${vendor}/state`;
  return current.split(/\r?\n/).some(raw => {
    const line = raw.trim().replace(/^\//, '').replace(/\/$/, '');
    return line && !line.startsWith('#') && line === want;
  });
}

function planGitignore(projectRoot, vendor) {
  const file = path.join(projectRoot, '.gitignore');
  const existedBefore = fs.existsSync(file);
  const current = existedBefore ? fs.readFileSync(file, 'utf8') : '';
  const wired = existedBefore && alreadyIgnored(current, vendor);

  return {
    label: '.gitignore',
    action: !existedBefore ? 'create' : (wired ? 'unchanged' : 'update'),
    apply() {
      if (wired) return;
      const sep = !current || current.endsWith('\n') ? '' : '\n';
      fs.writeFileSync(file, current + sep + (current ? '\n' : '') + block(vendor));
    }
  };
}

module.exports = { planGitignore, ignoreEntry };
