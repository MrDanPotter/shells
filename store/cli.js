#!/usr/bin/env node
'use strict';

// The AGENT side of the message queue — a thin CLI over store.js.
//
// Every argument that carries free text arrives via stdin JSON, never as a shell
// argument. Backtick / $() substitution in a title or body has silently eaten
// message content before; piping JSON on stdin sidesteps the shell entirely.
//
// Invoked through the shells.js dispatcher (`shells.js store <cmd>`), but still
// runnable standalone via the guard at the bottom:
//
//   echo '<json>' | node shells.js store new decision      {title, chosen, body?, options?, rationale?, project?, issue_ref?}
//   echo '<json>' | node shells.js store new task          {title, body?, project?, issue_ref?}
//   echo '<json>' | node shells.js store new knowledge     {title, body, project?, issue_ref?}
//   echo '<json>' | node shells.js store new notification  {title, body?, project?}
//   echo '<json>' | node shells.js store say               {text, links?} — a chat-stream reply, links = message ids
//   echo '<json>' | node shells.js store extern            {text, links?, source?} — a chat message from an EXTERNAL agent system
//   node shells.js store list [kind] [--all]                open messages as JSON
//   node shells.js store get <id>
//   node shells.js store resolve <id>                       agent closes an answered/done message
//   echo '<json>' | node shells.js store respond <id>       {verdict, response?} — simulates a front end
//   node shells.js store read <id>                          close a one-way message
//   node shells.js store reopen <id>                        undo a close
//
// `respond` and `read` exist here mainly so a front end can be built without ever
// shelling out to `bd` (or anything) — everything the store can do, this CLI can
// do, one file, zero dependencies.

const fs = require('fs');
const store = require('./store');
const chat = require('./chat');

function die(msg) { console.error(msg); process.exit(1); }

function readStdinJson() {
  if (process.stdin.isTTY) die("pipe a JSON object on stdin, e.g. echo '{...}' | node shells.js store new decision");
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); }
  catch { die('stdin must be a single JSON object'); }
}

// argv is everything after `store` (e.g. ['new','decision'] or ['list','--all']).
function run(argv) {
  const [cmd, arg, ...rest] = argv;

  try {
    if (cmd === 'new') {
      const input = readStdinJson();
      const id = store.create({ ...input, kind: arg });
      console.log(id);
      process.exit(0);
    }

    // Post a short reply into the chat stream (NOT a queued message). `links` are
    // ids of store messages you just created; the front end makes them click-to-open.
    if (cmd === 'say') {
      const input = readStdinJson();
      const rec = chat.say(input);
      console.log(rec.id);
      process.exit(0);
    }

    // A chat message from an agent system OUTSIDE this bidirectional loop.
    if (cmd === 'extern') {
      const input = readStdinJson();
      const rec = chat.external(input);
      console.log(rec.id);
      process.exit(0);
    }

    if (cmd === 'list') {
      const kind = store.KINDS.has(arg) ? arg : undefined;
      const all = rest.includes('--all') || arg === '--all';
      process.stdout.write(JSON.stringify(store.list({ kind, all }), null, 2) + '\n');
      process.exit(0);
    }

    if (cmd === 'get') {
      if (!arg) die('get: needs <id>');
      const msg = store.get(arg);
      if (!msg) die(`get: ${arg} not found`);
      process.stdout.write(JSON.stringify(msg, null, 2) + '\n');
      process.exit(0);
    }

    if (cmd === 'respond') {
      if (!arg) die('respond: needs <id>');
      const input = readStdinJson();
      console.log(JSON.stringify(store.respond(arg, input)));
      process.exit(0);
    }

    if (cmd === 'read') {
      if (!arg) die('read: needs <id>');
      console.log(JSON.stringify(store.markRead(arg)));
      process.exit(0);
    }

    if (cmd === 'resolve') {
      if (!arg) die('resolve: needs <id>');
      console.log(JSON.stringify(store.resolve(arg)));
      process.exit(0);
    }

    if (cmd === 'reopen') {
      if (!arg) die('reopen: needs <id>');
      console.log(JSON.stringify(store.reopen(arg)));
      process.exit(0);
    }
  } catch (e) {
    die(String((e && e.message) || e));
  }

  die(`usage:
  echo '<json>' | node shells.js store new decision      {title, chosen, body?, options?, rationale?, project?, issue_ref?}
  echo '<json>' | node shells.js store new task          {title, body?, project?, issue_ref?}
  echo '<json>' | node shells.js store new knowledge     {title, body, project?, issue_ref?}
  echo '<json>' | node shells.js store new notification  {title, body?, project?}
  echo '<json>' | node shells.js store say               {text, links?}
  echo '<json>' | node shells.js store extern            {text, links?, source?}
  node shells.js store list [kind] [--all]
  node shells.js store get <id>
  echo '<json>' | node shells.js store respond <id>      {verdict, response?}
  node shells.js store read <id>
  node shells.js store resolve <id>
  node shells.js store reopen <id>`);
}

module.exports = { run };
if (require.main === module) run(process.argv.slice(2));
