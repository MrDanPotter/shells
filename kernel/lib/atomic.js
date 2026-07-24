'use strict';

// Temp-file-plus-rename atomic writes. A concurrent reader (the main thread and a
// subagent can fire hook events at the same instant) must never see a half-written
// file — a plain writeFileSync is not atomic and a torn read crashes every consumer.
//
// rename() replaces atomically on POSIX even while a reader holds the destination.
// Windows does NOT: renameSync over an existing file throws EPERM/EACCES whenever
// something else has the dest open for the instant of the call — another process's
// read, an antivirus scan, the search indexer. That is not a rare race; on this kit
// the reference server polls watcher.json every couple seconds, so the heartbeat
// writer hits it regularly, and an unhandled EPERM kills the whole watcher (exactly
// the "silent loss of idle delivery" failure this kit is built to avoid). The temp+
// rename stays — we just retry the rename through the transient Windows lock window,
// which is typically sub-millisecond, before giving up.

const fs = require('fs');
const path = require('path');

// Synchronous sleep with no busy-spin — these writers are sync hook/watcher code.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows lock codes that a retry can clear; a real error (ENOSPC, ENOENT, …) still throws.
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

function atomicWrite(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tmp, data);
    let delay = 2;
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, file); break; }
      catch (e) {
        if (!RETRYABLE.has(e.code) || attempt >= 5) throw e;
        sleepSync(delay);   // 2,4,8,16,32ms — ride out a reader/AV holding the dest
        delay *= 2;
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

module.exports = { atomicWrite, readJson };
