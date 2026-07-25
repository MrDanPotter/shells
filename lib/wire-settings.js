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

// The events + commands shells owns. The command uses an ABSOLUTE, quoted path to
// shells.js — NOT a relative one — because a hook must resolve no matter what the
// session's working directory is. Claude Code does not guarantee hooks run from the
// project root (the model can `cd` mid-session, and its shell cwd persists), so a
// relative `node .shells/shells.js` breaks the instant cwd drifts into .shells,
// resolving to .shells/.shells/shells.js. The absolute path is cwd-proof. (Trade-off:
// the path is machine-specific; `shells.js init` regenerates it if the project moves.)
function shellsHooks(shellsJs) {
  const cmd = tail => `node "${shellsJs}" ${tail}`;
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

function mergeHooks(existing, vendor, shellsJs) {
  const ours = shellsHooks(shellsJs);
  const merged = { ...(existing || {}) };
  for (const [event, groups] of Object.entries(ours)) {
    const foreign = Array.isArray(merged[event]) ? merged[event].filter(g => !isShellsGroup(g, vendor)) : [];
    merged[event] = [...foreign, ...groups];
  }
  return merged;
}

function planSettings(projectRoot, vendor) {
  const file = path.join(projectRoot, '.claude', 'settings.json');
  // Absolute, forward-slashed path to the vendored shells.js (node accepts forward
  // slashes on Windows; quoting in the command survives spaces).
  const shellsJs = path.join(projectRoot, vendor, 'shells.js').split(path.sep).join('/');
  const existedBefore = fs.existsSync(file);

  let existing = {};
  if (existedBefore) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { existing = {}; }
  }

  const beforeHooks = JSON.stringify(existing.hooks || {});
  const settings = { ...existing, hooks: mergeHooks(existing.hooks, vendor, shellsJs) };
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
