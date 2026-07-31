'use strict';

// registry.js — the hub's project registry (Option A, P0).
//
// The whole point of the shared "hub" server is that ONE process serves MANY
// projects, so it needs to know which projects exist and where each one's state
// lives. That mapping is this file: a small, machine-level JSON list of
// { key, name, root, stateDir } entries. The hub routes /p/<key>/... by looking
// the key up here and running the request against that project's stateDir.
//
// It is deliberately standalone and dependency-free: nothing else in the kit needs
// it (single-project installs never touch it), and it doubles as the registry a
// port-registry (Option B) would use — so it is worth having on its own.
//
// The registry is also the routing ALLOWLIST: only a registered key is routable,
// and keys are slugs ([a-z0-9-]) so a key can never contain a path separator or
// "..", which keeps /p/<key>/ resolution free of path-traversal risk.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Machine-level, not per-project: the hub is one daemon spanning every project, so
// its registry lives in the user's home (override with SHELLS_HOME for tests).
function homeDir() { return process.env.SHELLS_HOME || path.join(os.homedir(), '.shells'); }
function registryFile() { return path.join(homeDir(), 'registry.json'); }

function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
    return Array.isArray(j.projects) ? j.projects : [];
  } catch { return []; }               // absent or unreadable -> empty registry
}

function writeAll(projects) {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = registryFile() + '.tmp';   // temp-file + rename: never a half-written registry
  fs.writeFileSync(tmp, JSON.stringify({ projects }, null, 2) + '\n');
  fs.renameSync(tmp, registryFile());
}

// A routing-safe key: lowercase, [a-z0-9-] only, no leading/trailing/`..` hazards.
function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
}

function list() { return readAll(); }
function get(key) { return readAll().find(p => p.key === key) || null; }

// The hub's hot path: key -> that project's state dir (null if the key is unknown,
// which the router treats as "reject").
function resolveStateDir(key) {
  const p = get(key);
  return p ? p.stateDir : null;
}

// Register (or refresh) the project rooted at `root`. A project is identified by its
// root, so re-registering the same root updates the entry in place and keeps its
// existing key — the embed <script src> that carries the key never goes stale.
function register({ root, name, key, stateDir } = {}) {
  if (!root) throw new Error('register: a project root is required');
  root = path.resolve(root);
  // The CLI passes the install's OWN stateDir() — correct for a scaffolded project
  // (<root>/.shells/state) AND the source repo (<root>/state) AND a SHELLS_STATE_DIR
  // override. Fall back to the common scaffolded layout when a caller omits it.
  stateDir = stateDir ? path.resolve(stateDir) : path.join(root, '.shells', 'state');
  const projects = readAll();
  const existing = projects.find(p => path.resolve(p.root) === root);

  let k = slug(key || (existing && existing.key) || name || path.basename(root));
  if (!(key || (existing && existing.key))) {
    // Derive a fresh key, disambiguating collisions with OTHER projects.
    const base = k; let n = 2;
    while (projects.some(p => p.key === k && path.resolve(p.root) !== root)) k = `${base}-${n++}`;
  }

  const entry = {
    key: k,
    name: name || (existing && existing.name) || path.basename(root),
    root,
    stateDir,
    registered_at: (existing && existing.registered_at) || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  writeAll(projects.filter(p => path.resolve(p.root) !== root).concat(entry));
  return entry;
}

// Remove by key OR by root path. Returns how many entries were dropped.
function unregister(keyOrRoot) {
  if (!keyOrRoot) return 0;
  const projects = readAll();
  const asRoot = path.resolve(keyOrRoot);
  const next = projects.filter(p => p.key !== keyOrRoot && path.resolve(p.root) !== asRoot);
  if (next.length !== projects.length) writeAll(next);
  return projects.length - next.length;
}

module.exports = { list, get, resolveStateDir, register, unregister, slug, registryFile };
