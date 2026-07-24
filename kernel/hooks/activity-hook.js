#!/usr/bin/env node
'use strict';

// Activity heartbeat — lets any front end show whether the session is currently
// working, and on what. Wire this to lifecycle events in .claude/settings.json
// (through the shells.js dispatcher: `shells.js hook activity <Event>`); the event
// name is the first argument. See README.md for the full hook wiring.
//
//   UserPromptSubmit -> working    (turn started, counters reset)
//   PostToolUse      -> heartbeat  (records the tool, bumps the count)
//   SubagentStart    -> subagent count up
//   SubagentStop     -> subagent count down
//   PreCompact       -> compacting (context is being summarized)
//   PostCompact      -> resume whatever state PreCompact interrupted
//   Stop             -> idle       (turn finished)
//   SessionEnd       -> ended      (distinct from idle — see below)
//
// Writes state/activity.json via temp-file + rename (kernel/lib/atomic.js), so a
// concurrent reader never sees a half-written file. This matters concretely: a
// dispatched subagent can fire its own PostToolUse at the same instant as the main
// thread's, and two hook processes race to update the same file.
//
// Must be fast and must NEVER fail a prompt or a tool call: every effect is wrapped,
// and this process always exits 0 no matter what happened internally. No network,
// no external process, no dependency — Node built-ins only.

const fs = require('fs');
const { readActivity, writeActivity } = require('../lib/activity');

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

// One line, trimmed — an activity header is a status bar, not a transcript.
function tidy(text, max = 160) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one;
}

// argv[0] is the lifecycle event name. Exported as run() so the shells.js dispatcher
// can call it in-process; the guard at the bottom keeps it runnable standalone too.
function run(argv) {
  const event = argv[0] || 'unknown';
  try {
    const now = new Date().toISOString();
    const WANTS_STDIN = new Set(['UserPromptSubmit', 'PostToolUse', 'PreCompact', 'PostCompact']);
    const input = WANTS_STDIN.has(event) ? readStdin() : {};
    const current = readActivity();
    const patch = { last_event: now, event };
    let clearCompactMarker = false;
    if (input.session_id) patch.session_id = input.session_id;

    switch (event) {
      case 'UserPromptSubmit':
        patch.state = 'working';
        patch.turn_started = now;
        patch.tool_count = 0;
        patch.last_tool = '';
        patch.subagents = 0;
        patch.subtask = '';
        // What the turn is FOR. Only a terminal prompt reaches this hook — inbound
        // inbox messages stamp the task themselves (kernel/hooks/gate.js), because
        // they never fire UserPromptSubmit.
        if (input.prompt) {
          patch.task = tidy(input.prompt);
          patch.task_source = 'prompt';
          patch.task_at = now;
        }
        break;

      case 'PostToolUse':
        patch.state = 'working';
        patch.tool_count = (current.tool_count || 0) + 1;
        if (input.tool_name) patch.last_tool = String(input.tool_name);
        // A dispatched subagent is the most informative thing to show while it runs,
        // and its description is already a human-written summary of the work.
        if (input.tool_name === 'Task' && input.tool_input && input.tool_input.description) {
          patch.subtask = tidy(input.tool_input.description);
        }
        break;

      case 'SubagentStart':
        patch.state = 'working';
        patch.subagents = (current.subagents || 0) + 1;
        break;

      case 'SubagentStop':
        patch.subagents = Math.max(0, (current.subagents || 0) - 1);
        break;

      // Compaction can take minutes and emits no other events while it runs — without
      // this, the front end either sits on a stale "working" or drops to idle and the
      // user assumes the session died.
      case 'PreCompact':
        patch.state_before_compact = current.state || 'idle';
        patch.state = 'compacting';
        patch.compact_started = now;
        // 'manual' (the user ran a compact command) vs 'auto' (context filled up).
        patch.compact_trigger = String(input.trigger || input.matcher || 'unknown');
        break;

      case 'PostCompact':
        // Auto-compact fires mid-turn and the turn continues; a manual compact usually
        // happens at rest. Resume whatever state was interrupted.
        patch.state = current.state_before_compact === 'working' ? 'working' : 'idle';
        patch.compact_ended = now;
        clearCompactMarker = true;
        break;

      case 'Stop':
        patch.state = 'idle';
        patch.turn_ended = now;
        patch.subagents = 0;
        break;

      // Distinct from idle. An idle session still picks up inbound messages on its
      // next turn; an ended one never will. Collapsing the two into "idle" is exactly
      // what makes a front end unable to say whether anything is listening.
      case 'SessionEnd':
        patch.state = 'ended';
        patch.turn_ended = now;
        patch.subagents = 0;
        break;
    }

    const merged = { ...current, ...patch };
    // Only meaningful between PreCompact and PostCompact; PostCompact having resumed
    // whatever it interrupted, the marker would otherwise linger and mislead the next
    // PreCompact into thinking a compaction was already in flight. Written with
    // writeActivity (a full replace), not patchActivity (a merge-with-disk) — a merge
    // would re-read the file and resurrect the very key just deleted here, since a
    // shallow spread can't express "this key must be absent."
    if (clearCompactMarker) delete merged.state_before_compact;
    writeActivity(merged);
  } catch {
    // Never block a prompt or a tool call on heartbeat trouble.
  }
  process.exit(0);
}

module.exports = { run };
if (require.main === module) run(process.argv.slice(2));
