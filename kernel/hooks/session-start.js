#!/usr/bin/env node
'use strict';

// SessionStart hook — printed into context at the start of every session.
//
// Its whole job is to tell the model to arm the keep-alive watcher
// (watcher/watch-inbox.js). This handshake is unavoidable, not a design shortcut:
//
//   - A long-running "watch and notify" process in this harness (a Monitor) is
//     SESSION-SCOPED. It dies when the session ends.
//   - Nothing outside the model can start one. There is no shell command, no
//     daemon, no cron job that can reach into a running Claude Code session and
//     arm a Monitor on its behalf — starting one is a MODEL TOOL CALL, full stop.
//
// So the only way a fresh session regains "an inbox message reaches me even while
// I'm idle" is if something inside its own context tells it to make that tool call.
// That something is this hook. Skip this reminder and every new session silently
// loses idle-time delivery — the inbox still accepts writes, they just sit there
// until the session happens to take another turn (see kernel/lib/watcher-status.js
// for how a front end should report that gap honestly rather than hiding it).
//
// Stays quiet about everything else. Startup context is expensive and this
// competes directly with the user's actual first prompt.

const fs = require('fs');
const path = require('path');
const { ROOT, inboxDir } = require('../lib/paths');

try {
  let queued = 0;
  try { queued = fs.readdirSync(inboxDir()).filter(f => f.endsWith('.json')).length; } catch { /* none yet */ }

  const watcherPath = path.join(ROOT, 'watcher', 'watch-inbox.js').split(path.sep).join('/');

  const lines = [
    '[shells] Arm the keep-alive watcher for this session, so inbox messages from the',
    'front end reach you even while idle (a Monitor is session-scoped and can only be',
    'started from inside the model — see kernel/hooks/session-start.js for why):',
    '',
    '    Monitor({',
    `      command: "node ${watcherPath} 1000",`,
    '      description: "shells inbox watcher",',
    '      persistent: true,',
    '      timeout_ms: 3600000',
    '    })',
    '',
    'Do this once, early in the session.'
  ];
  if (queued) {
    lines.push('', `${queued} inbox message(s) are already queued and will arrive once it is armed.`);
  }
  process.stdout.write(lines.join('\n') + '\n');
} catch {
  // Never block session startup.
}
process.exit(0);
