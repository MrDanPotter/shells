'use strict';

// Temp-file-plus-rename atomic writes. A concurrent reader (the main thread and a
// subagent can fire hook events at the same instant) must never see a half-written
// file — a plain writeFileSync is not atomic and a torn read crashes every consumer.
//
// rename() is atomic on every filesystem this kit targets (POSIX rename, and NTFS
// via Node's implementation on Windows), so "readers only ever see a complete file
// or the previous complete file" holds without any locking.

const fs = require('fs');
const path = require('path');

function atomicWrite(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

module.exports = { atomicWrite, readJson };
