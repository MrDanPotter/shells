'use strict';

// The store INTERFACE. This file is the whole contract — swap json-store.js for a
// beads adapter, sqlite, whatever, and everything else in this kit (hooks, the
// reference server, doctor.js) keeps working unmodified as long as the replacement
// exports these seven functions with these signatures. That's the point of keeping
// it this narrow: a backend swap is a one-line require() change, not a rewrite.
//
//   create(input) -> id
//     input: {kind, title, body?, project?, issue_ref?, options?, chosen?, rationale?}
//     kind must be one of decision | task | knowledge | notification.
//     A decision REQUIRES chosen — the conservative default already taken (see
//     contract/CLAUDE.fragment.md). Throws if missing.
//
//   list({kind, all}) -> [message]
//     Open messages by default; all:true includes closed ones. Never deletes.
//
//   get(id) -> message | null
//
//   listAwaiting() -> [message]
//     answered/done messages the agent hasn't resolve()d yet. This is what inbound
//     delivery (kernel/hooks/gate.js) chains the turn on.
//
//   respond(id, {verdict, response}) -> message
//     The USER's reply. decision: verdict 'approved'|'revised'. task: verdict 'done'.
//     Moves status to 'answered' (decision) or 'done' (task) — never closes except
//     the "approved with nothing to say" shortcut (see json-store.js).
//
//   markRead(id) -> message
//     Closes a one-way message (knowledge/notification). Throws on decision/task.
//
//   resolve(id) -> message
//     The AGENT confirms it applied an answered/done message and closes it. Throws
//     if the message was never answered/done.
//
//   reopen(id) -> message
//     Undo a close. Closing must always be reversible — see protocol.md.
//
// Message shape and status machine are documented at the top of json-store.js.

module.exports = require('./json-store');
