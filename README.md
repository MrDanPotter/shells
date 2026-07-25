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

Add shells to a project with one command (a directory name is required):

```bash
npx create-shells my-app      # scaffold a new project with shells wired in
cd my-app
node .shells/shells.js dev    # start the web UI + launch Claude Code, connected
```

`create-shells` vendors the kit **and the web UI** into `my-app/.shells/` and wires the
three integration points it needs — nothing else. `dev` serves the web UI at
`http://127.0.0.1:4420` and launches a Claude session already connected to it, so you
drive the work from the browser. Flags (`--no-ui`, `--dry-run`, `--force`), post-install
commands, and how it all wires up: [Adding shells to a project](#adding-shells-to-a-project).

## Working on shells itself

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
  | node shells.js store new decision
```

Reply to it from `http://127.0.0.1:4420/`, and — if the session is mid-turn — the
reply reaches it within seconds via the Stop-hook trick described in
`kernel/hooks/gate.js`. If it's idle, the reply is waiting on its next turn, or
delivered immediately if the watcher is armed.

## Layout

```
shells.js                 TIER 1 — the ONE entrypoint: hook | watch | store subcommands
CLAUDE.md                 dogfoods the contract on this repo (imports the fragment)
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
  server.js               TIER 4 — the included one-file web UI (ships by default)
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
4. **Protocol + UI** (`protocol.md`, `reference/server.js`) — the front-end
   deliverable. `reference/server.js` is the **included web UI**: it ships by default
   so a fresh install has a working interface, and `shells.js dev` launches it. It's
   also a complete, single-file worked example of `protocol.md` (safe escaping, not
   clobbering unsaved input, honest staleness), so you can read that file alone and
   replace the UI with your own front end (`--no-ui`) in any stack.

## Adding shells to a project

Run the scaffolder with a **target directory** (required — it never scaffolds into
your current directory by accident):

```bash
npx create-shells my-app     # create + initialize my-app/
```

It creates the directory if needed (or augments an existing one), vendors the kit
**and the web UI** into `.shells/`, and wires exactly three thin touch-points —
nothing else:

```
.shells/                     all of shells' code, the web UI, and runtime state
.claude/settings.json        hooks block merged in (yours preserved), each -> .shells/shells.js
CLAUDE.md                    one line appended: @.shells/contract/CLAUDE.fragment.md
.gitignore                   one line appended: .shells/state/
```

Then start everything with one command:

```bash
cd my-app
node .shells/shells.js dev    # starts the web UI (http://127.0.0.1:4420) + launches Claude Code
```

Every hook command goes through the single `.shells/shells.js` entrypoint rather
than naming an internal file, so the internals can be updated or relocated without
touching your `settings.json`. Re-running is idempotent. Flags: `--dry-run` to
preview, `--no-ui` if you're bringing your own front end (built against
`.shells/protocol.md`), `--force` to re-copy.

Other install commands:

```bash
node .shells/shells.js doctor    # verify the wiring fires correctly
node .shells/shells.js version   # what kit version is vendored
node .shells/shells.js init      # re-apply the wiring if it drifts
npx create-shells --force        # pull a newer kit (state + wiring untouched)
```

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
registry, no ports registry, nothing Windows-specific in any code path. Those are
all a *different* concern — orchestrating a fleet of apps and their own work
trackers — layered on top of a kit like this one, not part of it. (`shells.js dev`
is the one small exception to "no process launching": a convenience that starts the
included UI and Claude Code together — a single-project dev loop, not fleet
management.) If you're building that fleet layer, carry forward the process-
management bruises noted at the bottom of `protocol.md`, but they don't belong here.
