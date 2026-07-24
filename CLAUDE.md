# shells — this repo runs on its own contract

`shells` is the kit that teaches a Claude Code session to report to an external front
end instead of the terminal. It dogfoods that rule on itself: every session opened in
this repo operates under the same Tier-2 contract that downstream projects paste into
their own `CLAUDE.md`.

Rather than duplicate it, this file imports the canonical copy from
`contract/CLAUDE.fragment.md` (the standalone artifact other projects reuse), so there
is one source of truth and the two can never drift:

@contract/CLAUDE.fragment.md

Two things every session in this repo does, both echoed by the SessionStart hook so
they hold even before this file is read:

- **Arm the keep-alive watcher** when `kernel/hooks/session-start.js` asks, so inbound
  messages reach the session while it's idle.
- **Follow the message contract above** — the front end is the interface, not this
  chat stream; surface work as messages through `store/cli.js`, and keep chat to a
  one-line pointer.
