'use strict';

// First-run seed data. A freshly cloned repo has an empty message store, which
// makes the front end look broken — empty tabs, nothing to click, no sense of what
// the tool is for. This module plants the two messages a new user genuinely needs
// on day one: a task that gets their session into auto mode, and a knowledgebase
// entry explaining how the tool works. The Decisions and Notifications tabs start
// empty on purpose — those fill with real traffic from the session, and a demo
// there would just be clutter to dismiss.
//
// Idempotent by title: a seed whose exact title already exists (in ANY status,
// including closed — the store never deletes) is skipped. That means:
//   - the reference server can call seed() on every startup without duplicating;
//   - a user who reads/dismisses an example never has it resurrected on restart;
//   - running `node store/seed.js` by hand is always safe.
//
// These are ordinary messages once created — no special "seed" flag, no different
// lifecycle. They behave exactly like anything the agent pushes, which is the point:
// the examples ARE the documentation.

const store = require('./store');

const SEEDS = [
  {
    kind: 'task',
    title: 'Go to your Claude Code instance and put it in auto mode',
    body: [
      'This is a TASK — something only you can do by hand, at the terminal.',
      '',
      'For messages you send from this webapp to get acted on without you babysitting',
      'the terminal, the Claude Code session needs to be running autonomously — able to',
      'read, edit, and run without stopping to ask permission for each step.',
      '',
      'In your Claude Code terminal, switch the session into its auto-accept / bypass',
      "permissions mode (press Shift+Tab to cycle modes until it reads auto-accept, or",
      'start it that way). Then it can act on what you send from here on its own.',
      '',
      'Mark this done once your session is in auto mode. That is the whole task loop:',
      'a human does the thing, marks it done, and the agent resolves it.'
    ].join('\n'),
    project: 'shells'
  },
  {
    kind: 'knowledge',
    title: 'How to use shells',
    body: [
      'shells connects this webapp to a Claude Code session running on your machine.',
      'This entry is a KNOWLEDGE message — one-way, reference material. Mark it read',
      'when done; nothing is required of you.',
      '',
      'THE TWO DIRECTIONS',
      '  • Chat (top of the page) — free text YOU send to the session. It lands in the',
      "    session's inbox and is delivered when the session next takes a turn, or within",
      '    ~1s if the keep-alive watcher is armed (see the status pills up top).',
      '  • Message tabs (below chat) — structured messages the AGENT sends to YOU. The',
      "    agent is told to surface everything here, not in the terminal, so this webapp",
      '    is the real interface — the terminal is just where the session happens to run.',
      '',
      'THE FOUR MESSAGE TYPES (one tab each)',
      '  • Decisions — need a reply. Each carries a "default taken" the agent already',
      '    acted on, so you are correcting a choice, never blocking one. Approve to keep',
      "    the default, or Send back with a note to change it.",
      '  • Tasks — something a human must do by hand. Mark done when you have done it.',
      '  • Knowledgebase — things worth re-reading (like this). Mark read to file it away.',
      '  • Notifications — "here is what I did." Mark read; nothing else is needed.',
      '',
      'GOOD TO KNOW',
      '  • Closing anything is reversible — flip on "show closed" and Reopen it.',
      '  • The status pills up top are honest: they tell you whether a message you send',
      '    will arrive in ~1s, on the next turn, or not until a session is running.',
      '  • Everything is plain JSON files under state/. There is no database and no',
      '    network dependency — see protocol.md to build your own front end on top.'
    ].join('\n'),
    project: 'shells'
  }
];

// Create any seed whose title is not already present. Returns the ids created.
function seed() {
  const existing = new Set(store.list({ all: true }).map(m => m.title));
  const created = [];
  for (const s of SEEDS) {
    if (existing.has(s.title)) continue;
    created.push(store.create(s));
  }
  return created;
}

module.exports = { seed, SEEDS };

if (require.main === module) {
  const created = seed();
  console.log(created.length
    ? `seeded ${created.length} example message(s): ${created.join(', ')}`
    : 'nothing to seed — the example messages already exist');
}
