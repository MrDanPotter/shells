<div align="center">
  <img src="./assets/banner-beach.png" alt="shells">
</div>

# shells

A barebones skeleton for driving a Claude Code session from an arbitrary
external front end, using nothing but lifecycle hooks and the filesystem.

The pattern this repo demonstrates, in one sentence: **a Claude Code session can
be driven by, and report to, any front end you build, using only hooks and files
as the wire.** No beads, no database, no network dependency, no Windows-only
code. Clone it, read it in an afternoon, build your own front end on top.

<div align="center">
  <img src="./assets/shell-row-1.png" alt="shells">
</div>

## Quick start

```bash
cd shells
node doctor.js          # verifies every hook actually does what this doc claims
```

That's the whole install. Zero npm dependencies — Node built-ins only, so there
is no `npm install` step, ever, by design (see protocol.md's closing note on why).

Then, to see it work end to end:

```bash
node reference/server.js     # -> http://127.0.0.1:4420, a styled, live-polling demo UI
```

Open a Claude Code session in this folder (`.claude/settings.json` is already
wired) and, early in the session, arm the keep-alive watcher exactly as
`kernel/hooks/session-start.js` will ask you to. Then push a message from the
agent side and watch it show up:

```bash
echo '{"title":"pick a cache format","chosen":"flat JSON file","options":["flat JSON file","SQLite"],"rationale":"zero deps"}' \
  | node store/cli.js new decision
```

Reply to it from `http://127.0.0.1:4420/`, and — if the session is mid-turn — the
reply reaches it within seconds via the Stop-hook trick described in
`kernel/hooks/gate.js`. If it's idle, the reply is waiting on its next turn, or
delivered immediately if the watcher is armed.

## Layout

```
.claude/settings.json     hook wiring for THIS repo (dogfoods the kit on itself)
contract/
  CLAUDE.fragment.md      TIER 2 — paste into a project's CLAUDE.md as-is
protocol.md               TIER 4 — build a front end from this file alone
kernel/
  lib/
    paths.js              where every state file lives (SHELLS_STATE_DIR override)
    atomic.js             temp-file + rename writes, used everywhere
    activity.js           activity state + per-state staleness leashes
    watcher-status.js     live / queued / offline classification for the watcher
  hooks/
    activity-hook.js      TIER 1 — the heartbeat (UserPromptSubmit..SessionEnd)
    gate.js                TIER 1 — inbound delivery (the Stop-hook blocking trick)
    session-start.js       TIER 1 — tells the model to arm the keep-alive watcher
watcher/
  watch-inbox.js          TIER 1 — keep-alive: delivers inbox messages while idle
store/
  store.js                TIER 3 — the interface (create/list/respond/resolve/…)
  json-store.js           TIER 3 — the only implementation shipped: plain JSON files
  cli.js                  agent-side CLI over the store (stdin JSON, never shell args)
reference/
  server.js               TIER 4 — one-file, throwaway reference client/front end
doctor.js                 TIER 1 — fires every hook, asserts the effect, checks the watcher
```

## The four tiers, and why they're separate

1. **Kernel** (`kernel/`, `watcher/`) — the mechanism. Hooks that write an
   activity file, and the one trick (`gate.js`) that lets an external write reach
   a running session at all. This is the part that is version-coupled to Claude
   Code's own hook behaviour, which is why `doctor.js` exists and is not optional
   polish — if this silently breaks, nothing else in the repo tells you.
2. **Contract** (`contract/CLAUDE.fragment.md`) — the instructions that make the
   mechanism get *used* correctly: four message types, routing rules, "every turn
   pushes at least one message," `chosen` required on every decision. Paste it
   into your own project's CLAUDE.md unmodified.
3. **Storage** (`store/`) — a narrow five-function interface
   (`create/list/respond/markRead/resolve` + `reopen`), with one JSON-file
   implementation. No beads here on purpose — swap `json-store.js` for a
   different backend later and nothing else in the repo needs to change.
4. **Protocol** (`protocol.md`, `reference/server.js`) — the actual deliverable.
   Someone should be able to build their own front end reading `protocol.md`
   ALONE, without ever opening `kernel/`. The reference server is proof that the
   contract works and a worked example of protocol.md's "bruises" (safe escaping,
   not clobbering unsaved input, honest staleness) — it's styled and live-polling
   so you can actually watch the agent talk back, but it's still a reference to
   diff your own front end against, not a base to build on.

## Wiring hooks into your own project

Copy `.claude/settings.json`'s `hooks` block into your project's own
`.claude/settings.json` (merge if one already exists), and copy `kernel/`,
`watcher/`, and `store/` alongside it. Hook commands here are written as relative
paths (`node kernel/hooks/activity-hook.js ...`) because Claude Code runs hooks
with the project root as the working directory — no absolute paths, no
platform-specific separators, so the same `settings.json` works unmodified on
any OS.

## Running the doctor

```
node doctor.js
```

Runs every hook with a synthetic payload against a throwaway state directory
(never your real `state/`), and asserts the documented effect actually happened:
activity transitions, tool/subagent counters, compaction state, staleness leashes,
both inbound loop guards (self-deleting inbox drain, and the delivered-set for
answered/done messages), and the watcher's live/queued/offline classification —
including the case where nothing is armed at all, which is the actual failure
mode this pattern is exposed to: it fails **silently**, so the doctor has to check
for it explicitly rather than assume it away.

<div align="center">
  <img src="./assets/shell-row-2.png" alt="shells">
</div>

## What this kit deliberately does not do

No beads, no two-tier work tracking, no approval-gate/merge workflow, no fleet
registry, no dev-server launch/stop, no ports registry, nothing Windows-specific
in any code path. Those are all a *different* concern — orchestrating a fleet of
apps and their own work trackers — layered on top of a kit like this one, not
part of it. If you're building that layer, carry forward the process-management
bruises noted at the bottom of `protocol.md`, but they don't belong in this repo.
