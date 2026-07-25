#!/usr/bin/env node
'use strict';

// SessionStart hook — printed into context at the start of every session.
//
// It does two things, both of which have to happen from inside the model's own
// context or they silently don't happen at all:
//
//   1. Arm the keep-alive watcher, so inbound messages reach an idle session.
//   2. Put the agent on the bidirectional contract from turn one: the FRONT END is
//      the interface, so anything the user needs to see/decide/act on gets pushed as
//      a message through the store — not left in this chat stream. Without this line
//      here, that rule only exists in contract/CLAUDE.fragment.md, which a project
//      may never have pasted into a CLAUDE.md — so a fresh session talks back only in
//      the terminal and the front end stays empty, which is exactly the "you can't
//      send me messages in the webapp" gap this kit exists to close.
//
// Point (1)'s handshake is unavoidable, not a design shortcut:
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
// Everything the session runs — this hook, the watcher, the store CLI — goes through
// the shells.js dispatcher, so the commands printed below name shells.js, never an
// internal path. Startup context is expensive, so this stays tight.

const fs = require('fs');
const path = require('path');
const { ROOT, inboxDir } = require('../lib/paths');

function run() {
  try {
    let queued = 0;
    try { queued = fs.readdirSync(inboxDir()).filter(f => f.endsWith('.json')).length; } catch { /* none yet */ }

    // Absolute path: a Monitor command is not guaranteed to run with the project
    // root as its cwd, so the watcher entrypoint must be fully resolved.
    const shellsPath = path.join(ROOT, 'shells.js').split(path.sep).join('/');

    const lines = [
      '[shells] Arm the keep-alive watcher for this session, so inbox messages from the',
      'front end reach you even while idle (a Monitor is session-scoped and can only be',
      'started from inside the model — see kernel/hooks/session-start.js for why):',
      '',
      '    Monitor({',
      `      command: "node ${shellsPath} watch 1000",`,
      '      description: "shells inbox watcher",',
      '      persistent: true,',
      '      timeout_ms: 3600000',
      '    })',
      '',
      'Do this once, early in the session.',
      '',
      '[shells] The front end — not this chat stream — is the interface. From your first',
      'turn on, surface anything the user needs to see, decide, or act on as a MESSAGE',
      'through the store, and keep chat to a one-line pointer at it:',
      '',
      `    echo '{"title":"…","body":"…"}' | node ${shellsPath} store new notification`,
      '',
      'Four kinds — decision (needs a reply; must include "chosen", the default you',
      'already took), task (a human must do it by hand), knowledge (worth re-reading),',
      'notification (just reporting what you did). End every turn having pushed at least',
      'one. Full routing rules: contract/CLAUDE.fragment.md.'
    ];
    if (queued) {
      lines.push('', `${queued} inbox message(s) are already queued and will arrive once it is armed.`);
    }
    process.stdout.write(lines.join('\n') + '\n');
  } catch {
    // Never block session startup.
  }
  process.exit(0);
}

module.exports = { run };
if (require.main === module) run();
