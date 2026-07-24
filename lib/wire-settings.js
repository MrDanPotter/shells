'use strict';

// Wire shells' lifecycle hooks into a host project's .claude/settings.json.
//
// Every command goes through `<vendor>/shells.js` (the dispatcher), never an
// internal path — that indirection is what lets the vendored kit move without the
// host's settings.json changing. The merge is idempotent AND self-updating: any
// group we previously wrote (identified by a command that references
// `<vendor>/shells.js`) is stripped and rewritten, while foreign hooks the project
// added itself are preserved untouched. So re-running the scaffolder never
// duplicates our hooks and always refreshes them to the current shape.

const fs = require('fs');
const path = require('path');

// The events + commands shells owns, parameterized by the vendor dir (e.g. ".shells").
function shellsHooks(vendor) {
  const cmd = tail => `node ${vendor}/shells.js ${tail}`;
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: cmd('hook session-start') }] }],
    UserPromptSubmit: [{ hooks: [
      { type: 'command', command: cmd('hook activity UserPromptSubmit') },
      { type: 'command', command: cmd('hook gate prompt') }
    ] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: cmd('hook activity PostToolUse'), async: true }] }],
    SubagentStart: [{ hooks: [{ type: 'command', command: cmd('hook activity SubagentStart'), async: true }] }],
    SubagentStop: [{ hooks: [{ type: 'command', command: cmd('hook activity SubagentStop'), async: true }] }],
    Stop: [{ hooks: [
      { type: 'command', command: cmd('hook activity Stop') },
      { type: 'command', command: cmd('hook gate stop') }
    ] }],
    PreCompact: [{ hooks: [{ type: 'command', command: cmd('hook activity PreCompact') }] }],
    PostCompact: [{ hooks: [{ type: 'command', command: cmd('hook activity PostCompact') }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: cmd('hook activity SessionEnd') }] }]
  };
}

// A hook group is "ours" if any command in it targets <vendor>/shells.js.
function isShellsGroup(group, vendor) {
  return group && Array.isArray(group.hooks)
    && group.hooks.some(h => typeof h.command === 'string' && h.command.includes(`${vendor}/shells.js`));
}

function mergeHooks(existing, vendor) {
  const ours = shellsHooks(vendor);
  const merged = { ...(existing || {}) };
  for (const [event, groups] of Object.entries(ours)) {
    const foreign = Array.isArray(merged[event]) ? merged[event].filter(g => !isShellsGroup(g, vendor)) : [];
    merged[event] = [...foreign, ...groups];
  }
  return merged;
}

function planSettings(projectRoot, vendor) {
  const file = path.join(projectRoot, '.claude', 'settings.json');
  const existedBefore = fs.existsSync(file);

  let existing = {};
  if (existedBefore) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { existing = {}; }
  }

  const beforeHooks = JSON.stringify(existing.hooks || {});
  const settings = { ...existing, hooks: mergeHooks(existing.hooks, vendor) };
  const changed = JSON.stringify(settings.hooks) !== beforeHooks;

  return {
    label: '.claude/settings.json',
    action: !existedBefore ? 'create' : (changed ? 'update' : 'unchanged'),
    apply() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    }
  };
}

module.exports = { planSettings, shellsHooks, mergeHooks };
