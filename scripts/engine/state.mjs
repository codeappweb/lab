// Durable engine state. Single source of truth: data/engine-state.json in the
// repository (committed), never an ephemeral runner-local file.
//
// Durability model:
//   - every save() is atomic: write to a pid-unique .tmp file, fsync, rename.
//     A crash can never leave a half-written state file, and two processes
//     saving concurrently never collide on the same temporary file.
//   - save() is concurrent-writer safe: if the on-disk state changed since
//     this process last loaded it, the save MERGES instead of overwriting —
//     external pause/emergency_stop are OR-ed back in (an active worker can
//     never silently clear a pause/stop recorded by another process), jobs
//     and run records created by other processes are kept (union by id).
//   - a CORRUPT state file is NEVER silently reset. load() throws
//     E_STATE_CORRUPT; the runner prints an explicit recovery instruction and
//     `runner.mjs recover` archives the corrupt file to
//     data/engine-state.corrupt-<ts>.json and writes a fresh state with a
//     recovery record, so nothing is lost and nothing is hidden.
//   - locks use a separate lock file acquired with O_EXCL (atomic across
//     processes), staleness is judged by the recorded HEARTBEAT, and only the
//     process that OWNS the lock may heartbeat or release it.
// States: planned -> researching -> drafting -> validating -> ready ->
//         publishing -> published | blocked | failed
import fs from 'node:fs';
import path from 'node:path';

const VALID = new Set(['planned', 'researching', 'drafting', 'validating', 'ready', 'publishing', 'published', 'blocked', 'failed']);
const TRANSITIONS = {
  planned: ['researching', 'blocked'],
  researching: ['drafting', 'blocked', 'failed'],
  drafting: ['validating', 'blocked', 'failed'],
  validating: ['ready', 'blocked', 'failed'],
  ready: ['publishing', 'blocked'],
  publishing: ['published', 'blocked', 'failed'],
  published: [],
  blocked: ['planned', 'failed'],
  failed: ['planned', 'blocked']
};

export function freshState() {
  return {
    schema: 1,
    emergency_stop: false,
    paused: false,
    checkpoint: null,
    lock: null,
    jobs: [],
    runs: [],
    recovery: null
  };
}

// Pure helper for durable-publication verification (runner `verify`).
// The content commit and the deployed Pages revision are NOT expected to be
// SHA-equal: state/report commits legitimately follow the content commit.
// GitHub's compare API answers "does the deployed revision CONTAIN the
// expected content commit?" — status semantics:
//   identical  : deployed == expected
//   ahead      : deployed is a descendant of expected -> CONTAINS it (pass)
//   behind     : deployed is an ancestor of expected  -> does NOT contain it
//   diverged   : unrelated histories                  -> does NOT contain it
// Anything else (or missing data) fails closed.
export function deployedRevisionOk(expectedSha, deployedSha, compareStatus) {
  if (!expectedSha || !deployedSha) return { ok: false, reason: 'missing sha' };
  if (expectedSha === deployedSha) return { ok: true, reason: 'identical revision' };
  if (compareStatus === 'ahead' || compareStatus === 'identical') {
    return { ok: true, reason: 'deployed revision contains the content commit (' + compareStatus + ')' };
  }
  return { ok: false, reason: 'deployed revision does not contain the content commit (compare: ' + (compareStatus || 'unknown') + ')' };
}

export class StateStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'data', 'engine-state.json');
    this.lockFile = path.join(root, 'data', 'engine-lock.json');
    this.data = this.load();
    this._loadedRaw = this._lastRaw || null; // concurrency fingerprint, see save()
    // Persist durable state from the very first invocation so every command
    // (including ones that fail validation) leaves a readable state file.
    if (!fs.existsSync(this.file)) this.save();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
      this._lastRaw = raw;
      const d = JSON.parse(raw);
      if (d && typeof d === 'object' && Array.isArray(d.jobs)) return d;
    } catch (e) {
      if (e.code === 'ENOENT') return freshState();
      const err = new Error('engine state unreadable/corrupt at ' + this.file + ' — run `node scripts/engine/runner.mjs recover` to archive it and start a fresh state. Nothing is auto-reset silently.');
      err.code = 'E_STATE_CORRUPT';
      throw err;
    }
    const err = new Error('engine state has an invalid shape (jobs missing) at ' + this.file + ' — run `recover`');
    err.code = 'E_STATE_CORRUPT';
    throw err;
  }

  // Explicit, noisy recovery: archive the corrupt file, never overwrite it.
  recover(reason) {
    const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const archived = path.join(this.root, 'data', 'engine-state.corrupt-' + ts + '.json');
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, archived);
    const d = freshState();
    d.recovery = { at: new Date().toISOString(), reason: reason || 'state corrupt', archived_to: path.basename(archived) };
    this.data = d;
    this.save();
    return { archived_to: archived };
  }

  // Re-read durable state from disk. Called between work items so pause/stop
  // issued by ANOTHER process (or after a crash) is observed promptly.
  reload() {
    this.data = this.load();
    this._loadedRaw = this._lastRaw;
    return this.data;
  }

  // Atomic, concurrent-writer safe save. See the durability model at the top.
  save() {
    let disk = null;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      if (raw !== this._loadedRaw) {
        const d = JSON.parse(raw);
        if (d && typeof d === 'object' && Array.isArray(d.jobs)) disk = d;
      }
    } catch (e) { /* unreadable/absent disk state: full overwrite is correct */ }
    if (disk) {
      // Another process wrote since we loaded: merge, never clobber.
      if (disk.paused === true) this.data.paused = true;
      if (disk.emergency_stop === true) this.data.emergency_stop = true;
      const mine = new Set(this.data.jobs.map(j => j.id));
      for (const j of disk.jobs) if (!mine.has(j.id)) this.data.jobs.push(j);
      const myRuns = new Set((this.data.runs || []).map(r => r.id));
      for (const r of (disk.runs || [])) if (!myRuns.has(r.id)) (this.data.runs = this.data.runs || []).push(r);
    }
    this.data.updated_at = new Date().toISOString();
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify(this.data, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, this.file); // atomic on POSIX
    try { this._loadedRaw = fs.readFileSync(this.file, 'utf8'); } catch { this._loadedRaw = null; }
  }

  jobById(id) { return this.data.jobs.find(j => j.id === id); }

  // Stable identity: ANY job for this slug — including failed/blocked ones —
  // owns the slug forever. A second job for the same slug can never be created.
  jobBySlug(slug) { return this.data.jobs.find(j => j.slug === slug); }

  nextJobId() {
    let max = 0;
    for (const j of this.data.jobs) {
      const m = /^JOB-(\d+)$/.exec(j.id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return 'JOB-' + String(max + 1).padStart(6, '0');
  }

  createJob({ slug, topic }) {
    if (this.jobBySlug(slug)) {
      const existing = this.jobBySlug(slug);
      const e = new Error('duplicate job for slug ' + slug + ' (existing job ' + existing.id + ' in state ' + existing.state + ')');
      e.code = 'E_DUPLICATE_JOB';
      throw e;
    }
    const job = {
      id: this.nextJobId(),
      state: 'planned',
      slug,
      topic,
      retries: 0,
      errors: [],
      history: [{ state: 'planned', at: new Date().toISOString() }],
      checkpoint: null
    };
    this.data.jobs.push(job);
    this.save();
    return job;
  }

  transition(id, to, note) {
    const job = this.jobById(id);
    if (!job) throw new Error('unknown job ' + id);
    if (!VALID.has(to)) throw new Error('invalid state ' + to);
    const allowed = TRANSITIONS[job.state] || [];
    if (!allowed.includes(to)) {
      const e = new Error('invalid transition ' + job.state + ' -> ' + to + ' for ' + id);
      e.code = 'E_BAD_TRANSITION';
      throw e;
    }
    job.state = to;
    job.history.push({ state: to, at: new Date().toISOString(), note: note || null });
    this.data.checkpoint = { run_id: job.id, at: new Date().toISOString(), job: id, state: to };
    this.save();
    return job;
  }

  // File existence vs committed vs verified-live are three distinct facts.
  recordArtifact(id, kind, value) {
    const job = this.jobById(id);
    if (!job) throw new Error('unknown job ' + id);
    job[kind] = value;
    this.save();
  }

  recordError(id, msg) {
    const job = this.jobById(id);
    if (!job) return;
    job.errors.push({ at: new Date().toISOString(), msg: String(msg).slice(0, 500) });
    this.save();
  }

  // ---- lock ---------------------------------------------------------------
  // Acquisition is atomic across processes: O_EXCL create of a lock file.
  // Staleness is judged by the recorded heartbeat, not acquisition time.
  // Stale-recovery races are safe: the stale file is unlinked and re-created
  // with O_EXCL; if another process wins that race, this acquisition fails.
  acquireLock(runId, cfg) {
    fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });
    let fd;
    try {
      fd = fs.openSync(this.lockFile, 'wx'); // fails if the file exists
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Lock exists. Stale if the heartbeat is older than lock_ttl_seconds.
      let lock = null;
      try { lock = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch { /* unreadable lock = stale */ }
      const hb = lock && lock.heartbeat_at ? Date.parse(lock.heartbeat_at) : 0;
      const ageSeconds = (Date.now() - hb) / 1000;
      if (hb && ageSeconds < (cfg && cfg.lock_ttl_seconds || 1800)) return false;
      try { fs.unlinkSync(this.lockFile); } catch { /* raced away */ }
      try { fd = fs.openSync(this.lockFile, 'wx'); } catch { return false; }
      this.data.lock = { holder: runId, recovered_from: lock ? lock.run_id : 'unreadable-lock', heartbeat_at: new Date().toISOString() };
      this.save();
      fs.writeSync(fd, JSON.stringify({ run_id: runId, heartbeat_at: new Date().toISOString(), acquired_at: new Date().toISOString() }) + '\n');
      fs.closeSync(fd);
      return true;
    }
    this.data.lock = { holder: runId, heartbeat_at: new Date().toISOString() };
    this.save();
    fs.writeSync(fd, JSON.stringify({ run_id: runId, heartbeat_at: new Date().toISOString(), acquired_at: new Date().toISOString() }) + '\n');
    fs.closeSync(fd);
    return true;
  }

  // Heartbeat renews THIS run's lease only. A process that lost the lock
  // (stale-recovered by someone else) must never refresh a lock it no longer
  // owns — that would resurrect a dead lease and defeat stale recovery.
  heartbeat(runId) {
    let lock = null;
    try { lock = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch { return; }
    if (!lock || lock.run_id !== runId) return; // not our lock: do not touch it
    const payload = { run_id: runId, heartbeat_at: new Date().toISOString() };
    try {
      fs.writeFileSync(this.lockFile, JSON.stringify(payload) + '\n');
    } catch { /* lock file may be gone; ignore */ }
    if (this.data.lock && this.data.lock.holder === runId) {
      this.data.lock.heartbeat_at = payload.heartbeat_at;
      this.save();
    }
  }

  releaseLock(runId) {
    // Only release if the lock on disk is still OURS: a stale-recovery by
    // another process may have re-issued the lock to a new owner, and
    // unlinking it now would steal THEIR lease.
    let lock = null;
    try { lock = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch { /* gone */ }
    if (lock && lock.run_id === runId) {
      try { fs.unlinkSync(this.lockFile); } catch { /* already gone */ }
    }
    if (this.data.lock && this.data.lock.holder === runId) {
      this.data.lock = null;
      this.save();
    }
  }

  activeJobs() {
    return this.data.jobs.filter(j => !['published', 'failed', 'blocked'].includes(j.state));
  }

  isStopped() { return this.data.emergency_stop === true; }
}
