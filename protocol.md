# protocol

Everything a front end needs to talk to a `shells`-driven Claude Code session,
without reading a line of `kernel/`. Two independent data flows:

- **Outbound** — the agent tells you things (decisions, tasks, knowledge,
  notifications) by writing files under `state/messages/`. You read and reply to
  them.
- **Inbound** — you tell the agent things by writing files under `state/inbox/`
  (free text) or by replying to a message (structured). The agent picks these up
  through its lifecycle hooks — see "How inbound delivery actually works" below,
  it is the one part of this contract worth understanding rather than skimming.

Everything here is plain JSON files, written with temp-file-plus-rename so you
will never read a half-written one. `reference/server.js` is the included web UI and
one working implementation of the HTTP shape described below, built ONLY from this
contract — it ships by default so an install has a working interface, and it's also
the thing to diff your own front end against if you replace it (`--no-ui`).

---

## 1. The message

One file per message: `state/messages/<id>.json`.

```json
{
  "id": "m-lz3k2p-a1b2c3",
  "kind": "decision",
  "title": "Use SQLite for local cache instead of a flat file",
  "body": "Longer explanation / rationale goes here.",
  "project": "",
  "issue_ref": "",
  "options": ["SQLite", "flat JSON file", "in-memory only"],
  "chosen": "flat JSON file",
  "rationale": "Zero deps, no native module to build cross-platform.",
  "status": "open",
  "response": "",
  "verdict": "",
  "responded_at": "",
  "created_at": "2026-07-22T14:03:11.000Z",
  "updated_at": "2026-07-22T14:03:11.000Z"
}
```

| Field | Meaning |
|---|---|
| `kind` | `decision` \| `task` \| `knowledge` \| `notification` — see routing rules in `contract/CLAUDE.fragment.md` |
| `title` / `body` | what to show |
| `project` / `issue_ref` | free-text tags, yours to use for grouping/filtering — the kit never interprets them |
| `options` / `chosen` / `rationale` | **decisions only.** `chosen` is always present — it's the conservative default the agent already took, never a blank waiting on you |
| `status` | see the state machine below |
| `response` / `verdict` / `responded_at` | your reply, once you've given one |

### Status machine

```
decision / task:   open ──respond──▶ answered/done ──resolve──▶ closed
                      ▲                                            │
                      └──────────────────reopen────────────────────┘

knowledge / notification:   open ──markRead──▶ closed
                               ▲                  │
                               └──────reopen───────┘
```

- `open` — nothing has happened yet.
- `answered` (decision) / `done` (task) — **you** replied; the agent hasn't
  applied/closed it yet. This is the set the agent's inbound hooks watch (§3).
- `closed` — resolved. **Never deleted.** `GET` with `all=1`/`--all` still returns
  it. Closing is reversible everywhere in this kit (see `reopen`, below) precisely
  because a decision can be closed by an accidental click or a redraw before
  anyone actually read the answer — see §5.

A decision that comes back `approved` with no note closes itself immediately —
the default stood, there's nothing to apply, so there's no round trip.

---

## 2. Operations

You can do all of this two ways: call the JSON-file store directly (no HTTP
required — see §2a) or through an HTTP server that wraps it (§2b, what
`reference/server.js` does). Pick whichever fits your front end; they are the same
contract.

### 2a. Directly, as files (no server required)

Read `state/messages/*.json` yourself for listing. To reply, do a **read-modify-
write** with the following fields (do not touch anything else in the file):

```jsonc
// decision:
{ "verdict": "approved" | "revised", "response": "…", "responded_at": "<now, ISO>", "status": "answered" }
// (verdict "revised" REQUIRES a non-empty response — that's the "what's wrong" note)

// task:
{ "verdict": "done", "response": "…"?, "responded_at": "<now, ISO>", "status": "done" }

// knowledge / notification:
{ "status": "closed" }
```

Write via temp-file-plus-rename in your own process too, for the same reason the
kit does: a poll from your UI reading the file mid-write must never see a torn
JSON blob.

Or, simpler: use the bundled CLI, `store/cli.js` (see its own `--help`-equivalent
usage banner) — it does the read-modify-write correctly and is a fine thing to
shell out to from any language.

### 2b. Through the reference HTTP server

`node reference/server.js` (default `http://127.0.0.1:4420`, override with
`PORT=`). Binds to `127.0.0.1` only — **never expose this off the machine it runs
on.** It has no auth and shells out to nothing but the local file store, which is
exactly the trust boundary of "one user, one machine."

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/messages?all=1` | — | list messages (open only by default) |
| POST | `/api/messages/:id/respond` | `{verdict, response?}` | decision reply or task-done |
| POST | `/api/messages/:id/read` | — | close a knowledge/notification |
| POST | `/api/messages/:id/reopen` | — | undo a close (any kind) |
| GET | `/api/inbox` | — | last ~50 inbox sends, for a chat-style transcript view |
| POST | `/api/inbox` | `{text}` | queue a free-text message for the agent (§3) |
| GET | `/api/activity` | — | is the agent working right now, and on what (§4) |
| GET | `/api/watcher` | — | is inbound delivery-while-idle actually armed (§3) |
| GET | `/api/version` | — | `{server_stale}` — has the running process drifted from the code on disk |

All responses are `application/json` except `GET /` (the web UI page).
Errors are `{"error": "…"}` with a 4xx/5xx status. There is no batch endpoint —
one call per action, on purpose; this is a kit meant to be read in full, and a
batch endpoint is exactly the kind of surface area that isn't worth the read.

**What creates a message is deliberately NOT an HTTP endpoint.** Only the agent
(or something acting for it) should be creating decisions/tasks/knowledge — that's
`store/cli.js new <kind>`, run from inside the session or a script it invokes, not
a route a front end calls. Keeping "create" off the HTTP surface is what makes it
safe for this server to have zero auth: the worst a network peer on localhost can
do is reply to things or send chat text, never fabricate a decision as if the
agent made it.

---

## 3. How inbound delivery actually works

There is no socket, no long-poll, nothing listening inside a Claude Code session
that an outside process can call into. The **only** channel back into a running
session is what a lifecycle hook returns. Two hooks, used together, are the whole
mechanism:

```
                 SESSION ACTIVELY WORKING              SESSION IDLE
                 ────────────────────────              ────────────
you write a           Stop hook fires when          nothing fires — no hook
file to                the current turn is           runs while idle, by
state/inbox/           about to end. It sees          definition.
   │                   your file, drains it,               │
   │                   and returns                          │
   │                   {"decision":"block",                 │
   │                    "reason":"..."}.                    │
   │                   The harness does NOT                 │
   │                   end the turn — it feeds               │
   │                   `reason` back in as new                │
   │                   input and the assistant                │
   │                   keeps going.                            │
   ▼                                                          ▼
DELIVERED WITHIN SECONDS                    WAITS until either:
                                             (a) the human's next terminal prompt
                                                 fires UserPromptSubmit, which
                                                 drains and injects it, or
                                             (b) a keep-alive watcher is armed
                                                 (see below), which notices it
                                                 within one poll interval even
                                                 with nobody typing anything.
```

**A message the user answered on a decision/task** (not free inbox text) works
the same way but is never deleted — the agent has to `resolve` it once applied.
So case (a)/(b) above chains the Stop hook **at most once per reply**, tracked in
`state/delivered.json`; an item already chained but not yet resolved falls back to
the (harmless, repeatable) `UserPromptSubmit` injection instead of re-blocking
forever. The moment it's resolved, its entry is pruned, so answering it again
later chains cleanly.

### The keep-alive watcher

`watcher/watch-inbox.js` is a small long-running poller. Something inside the
harness (a "Monitor"-style tool) has to be told to run it — **and that can only be
done from inside the model**, because starting one is a model tool call, not a
shell command an outside process can trigger. `kernel/hooks/session-start.js`
prints the instruction to arm it at the start of every session for exactly this
reason: skip that reminder and a fresh session has no idle-time delivery at all,
silently, because the inbox looks identical whether or not anything is listening.

**Report this state honestly in any front end you build.** `GET /api/watcher`
(or `kernel/lib/watcher-status.js` directly) gives you one of:

| `link` | Meaning | What to tell the user |
|---|---|---|
| `live` | watcher heartbeat is fresh | "delivered within ~1s" |
| `queued` | no watcher, but the session is alive | "delivered on its next turn" — could be seconds, could be a while |
| `offline` | no watcher AND no live session | "sitting on disk until someone starts a session" |

Do not collapse these into a single "sent ✓" — that was the exact failure mode
this kit's design notes call out: an inbox accepts a write identically in all
three cases, so the honesty has to come from you, the front end, not from the
write succeeding.

---

## 4. Activity / staleness

`GET /api/activity` (or `kernel/lib/activity.js` `computeStatus(readActivity())`):

```json
{
  "state": "working",
  "reported_state": "working",
  "stale": false,
  "task": "investigate the flaky upload test",
  "subtask": "",
  "tool_count": 4,
  "last_tool": "Read",
  "subagents": 0,
  "turn_started": "2026-07-22T14:00:00.000Z",
  "seconds_since_event": 3,
  "leash_seconds": 180
}
```

`state` is the raw last-reported lifecycle state: `working`, `idle`, `compacting`,
`ended`. **`reported_state` is what you should actually display** — it downgrades
`working`/`compacting` to `stale` once no event has arrived for longer than that
state's leash (180s / 900s respectively). A hook-driven flag can go stale
silently: the process can be killed before its `Stop` hook ever runs, and a
spinner that never stops is a worse lie than an honest "no signal in N seconds."
`compacting` gets a much longer leash on purpose — it legitimately emits nothing
else for minutes on a large context, and a shorter leash would flag a healthy
compaction as dead.

`ended` (from `SessionEnd`) is distinct from `idle` and matters for the same
reason as §3's watcher states: an idle session still drains its inbox on its next
turn; an ended one never will again. Collapsing them loses exactly the
information a front end needs to tell "will arrive eventually" from "gone."

---

## 5. Bruises — build these into your front end too

These cost real debugging time against the system this kit is distilled from.
They are not kernel concerns; they are yours if you build a UI.

- **Escape before you format.** If your message bodies pass through any markdown
  or HTML renderer, escape user- and agent-supplied text first, format second.
  Doing it in the other order lets a stray `<` or `*` in a title corrupt the page
  or, worse, inject markup. `reference/server.js`'s `esc()` is the whole pattern.
- **Never re-render over unsaved input.** If your UI polls for updates and
  rebuilds a view wholesale, a poll firing mid-keystroke (a reply box, a note
  field) will silently discard what someone was typing. Hold the redraw while a
  field differs from what the server last sent, and catch up the instant it's
  clean again.
- **Never reflow a list under the pointer.** A poll-driven redraw that resizes or
  reorders a list while someone is about to click a specific row can put a
  *different* row under that click a moment later — "dismiss" lands on whatever
  slid into the dismissed item's old position. Freeze redraws for a short window
  after any pointer/keyboard activity in a list, and schedule a catch-up render
  for right after.
- **Closing must be reversible.** An answer, once marked read/resolved, can be
  destroyed before anyone actually finished reading it — a mis-click, a redraw
  race (the point above), a keyboard slip. `reopen` exists for exactly this and
  costs you nothing to wire up: a visible "undo" for a few seconds after any
  close is cheap insurance against a UI mistake becoming a lost answer.
- **Two different staleness signals, two different fixes.** `GET /api/version`
  reports `server_stale` deliberately separately from any "the UI changed"
  signal you build for your own front end's static assets. A UI change is fixed
  by reloading the page. A stale server process is NOT fixed by reloading —
  you're still talking to the old code; it needs an actual restart. Conflating
  the two teaches people that reloading always works, until the one time it's
  the server that's stale and nothing they do in the browser will show it.
- **Never build a message body through a shell.** If your front end shells out to
  anything (this kit's own `store/cli.js` included) to create or reply to a
  message, pass the text on **stdin as JSON**, never interpolated into a command
  string. Backtick / `$()` substitution in ordinary user text has silently eaten
  message content before — the fix is structural (stdin), not "escape harder."
- **Zero dependencies is a feature, not an oversight.** If you extend the
  reference server, resist reaching for a framework or a templating engine. The
  entire value of a kit like this is that someone can read every file in an
  afternoon; a dependency tree defeats that as surely as a bug would.

## Explicitly out of scope here

Process lifecycle (starting/stopping other apps' dev servers), a fleet/registry
of managed apps, a durable work-tracker integration (beads or otherwise), and any
"approval gate then auto-merge" workflow are a **different, separate concern**
layered on top of a kit like this one — not part of the inbound/outbound message
protocol described above. If you build that layer, the bruises about resolving a
process by port (never a recorded PID) and never killing children under a
file-watching dev-server belong there, not here — this kit does not launch or
manage any process other than its own watcher.
