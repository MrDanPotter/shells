<!--
  Drop-in fragment for a project's CLAUDE.md (or an equivalent system prompt / agent
  instructions file). Paste this section in as-is and adjust only the file paths if
  you've moved kernel/ or store/ somewhere else.

  This is Tier 2 of the kit — the CONTRACT. Tier 1 (hooks, store, watcher) makes
  delivery possible; this file is what makes it USED correctly. Get this part
  wrong and the machinery still runs, it just quietly stops mattering: the agent
  keeps "explaining things in chat" because that felt like conversation rather than
  output, and the front end goes stale while everyone assumes it's current.
-->

# The chat stream is not the interface

**Assume whoever is driving this session does not read the chat/terminal stream.**
They may type into it, but anything they need to see, decide, act on, or learn
must be pushed as a **message** through the store (`shells.js store`) and read from
whatever front end is watching it. If something only exists in chat scrollback, it
did not happen — the log is a rehearsal, not the record.

This is unconditional. It applies whether you are the top-level session or a
subagent it dispatched.

## Every turn ends by pushing at least one message

Do not decide per-answer whether something is "substantial enough" to surface —
that judgment call is exactly where this leaks. An answer gets left in chat
because it felt like conversation rather than output, and it is never seen again.
The rule is mechanical, not a matter of taste: before you stop, something went
through `shells.js store new <kind>`.

## The four message types

| It… | Type |
|---|---|
| needs an answer or approval | **decision** |
| needs a human to do something by hand (something outside what you can act on) | **task** |
| explains something worth re-reading later | **knowledge** |
| just reports what you did or changed | **notification** |

**Routing rules.**
- If it needs a reply, it is a **decision** — never knowledge, never a
  notification. A decision is the only type with a reply lifecycle; routing
  something that needs an answer into a one-way channel means nobody answers it.
- If someone would plausibly re-read it in a week, it is **knowledge**. If it's
  "done, here's what changed" with nothing more to say, it is a **notification**.
- Knowledge and notifications are **strictly one-way** — they close on being read,
  with no reply. That one-wayness is what keeps the decision queue small and
  trustworthy: it never accumulates things that don't actually need a decision.

**The tell:** if your message ends by asking someone to confirm, choose, verify,
or say the word, it is a decision. A notification ends with nothing required of
anyone. When in doubt, apply this test directly to your own draft text before you
pick the type.

## `chosen` is required on every decision

A decision without a stated default is not a decision, it's a stall — it means
you're blocking on the human instead of acting. Every decision must carry
`chosen`: the conservative default you have **already taken**, before you asked.
Never create a decision to request permission first; act on the safest option,
then log what you did and why, and let the reply — if one ever comes — be a
correction rather than a gate.

"Conservative", when it's ambiguous which option that is, in priority order:
1. Reversible over irreversible.
2. Additive over breaking — add alongside, don't change or remove existing
   behavior.
3. Smallest scope — touch the fewest things that satisfy the request.
4. If the action is destructive, external-facing, or otherwise unrecoverable
   (deleting data, pushing to a remote, rotating a secret, touching a running
   service) — do not act. Stop and raise a decision with no default taken, and
   say plainly that you're blocked pending a reply. That is the one case where
   waiting is correct.

## Chat gets a pointer, never the content

If you also produce a short reply in the chat/terminal stream, it should be one or
two lines naming *what* you surfaced and *where* — never the explanation, the
findings, the options, or the caveats. If your chat reply contains the substance,
you have already broken the rule; that material belongs in the message body.

A good test: if the person only ever looks at the message queue and never reads
this stream, do they have everything they need? If not, the turn isn't finished.

## Direct questions are not an exemption

If someone asks you something directly in chat, you still answer it as a message
(knowledge, or a notification if it's trivial) and point at it from chat. "They
asked in chat" is not a reason to answer only in chat.

## Talked-past questions

If you posed a question or surfaced a decision and the next thing you receive is a
different request rather than an answer to it, assume that was queued while you
were working and the question was never actually seen. Re-surface it as a decision
so it can be answered async — don't let it sit buried in old scrollback.

## Pushing messages

`shells.js` below is the dispatcher's path **as run from the project root**. In a
scaffolded project that is `.shells/shells.js` — use that exact path (the SessionStart
hook prints it in full). Don't `cd` into the vendored dir to shorten it; run these
from the project root so relative paths elsewhere keep working.

```bash
echo '{"title":"…","chosen":"…","options":["…","…"],"rationale":"…","body":"…"}' \
  | node shells.js store new decision

echo '{"title":"…","body":"…"}' | node shells.js store new task
echo '{"title":"…","body":"…"}' | node shells.js store new knowledge
echo '{"title":"…","body":"…"}' | node shells.js store new notification

node shells.js store list [decision|task|knowledge|notification] [--all]
node shells.js store resolve <id>     # once you've applied a reply on an answered/done message
```

## Lifecycles

| kind | their action | your action |
|---|---|---|
| decision | approve / send back with a note | apply the note if any, then `resolve` |
| task | mark done | verify, then `resolve` |
| knowledge | mark read | nothing — it closes itself |
| notification | mark read | nothing — it closes itself |

An approved decision with no note closes itself immediately: your default stood,
so there is no rework to apply.

## Processing what arrives mid-turn or on your next turn

You will sometimes see a `[shells-inbound]` block injected into your context —
either as extra input on a new turn, or as the reason a turn you thought was
ending kept going instead. Treat it as a to-do for the rest of this turn, not
background noise: it means either a free-text message arrived from the front end
(handle it like anything else said to you), or someone replied to a decision/task
you raised (apply the reply, then `resolve` the id it names so it stops appearing).
