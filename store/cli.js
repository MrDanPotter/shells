#!/usr/bin/env node
'use strict';

// The AGENT side of the message queue — a thin CLI over store.js.
//
// Every argument that carries free text arrives via stdin JSON, never as a shell
// argument. Backtick / $() substitution in a title or body has silently eaten
// message content before; piping JSON on stdin sidesteps the shell entirely.
//
//   echo '<json>' | node store/cli.js new decision      {title, chosen, body?, options?, rationale?, project?, issue_ref?}
//   echo '<json>' | node store/cli.js new task          {title, body?, project?, issue_ref?}
//   echo '<json>' | node store/cli.js new knowledge     {title, body, project?, issue_ref?}
//   echo '<json>' | node store/cli.js new notification  {title, body?, project?}
//   node store/cli.js list [kind] [--all]                open messages as JSON
//   node store/cli.js get <id>
//   node store/cli.js resolve <id>                       agent closes an answered/done message
//   echo '<json>' | node store/cli.js respond <id>       {verdict, response?} — simulates a front end
//   node store/cli.js read <id>                          close a one-way message
//   node store/cli.js reopen <id>                        undo a close
//
// `respond` and `read` exist here mainly so a front end can be built without ever
// shelling out to `bd` (or anything) — everything the store can do, this CLI can
// do, one file, zero dependencies.

const fs = require('fs');
const store = require('./store');

function die(msg) { console.error(msg); process.exit(1); }

function readStdinJson() {
  if (process.stdin.isTTY) die("pipe a JSON object on stdin, e.g. echo '{...}' | node store/cli.js new decision");
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); }
  catch { die('stdin must be a single JSON object'); }
}

const [, , cmd, arg, ...rest] = process.argv;

try {
  if (cmd === 'new') {
    const input = readStdinJson();
    const id = store.create({ ...input, kind: arg });
    console.log(id);
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
  echo '<json>' | node store/cli.js new decision      {title, chosen, body?, options?, rationale?, project?, issue_ref?}
  echo '<json>' | node store/cli.js new task          {title, body?, project?, issue_ref?}
  echo '<json>' | node store/cli.js new knowledge     {title, body, project?, issue_ref?}
  echo '<json>' | node store/cli.js new notification  {title, body?, project?}
  node store/cli.js list [kind] [--all]
  node store/cli.js get <id>
  echo '<json>' | node store/cli.js respond <id>      {verdict, response?}
  node store/cli.js read <id>
  node store/cli.js resolve <id>
  node store/cli.js reopen <id>`);
