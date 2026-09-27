// Durable engine state. Single source of truth: data/engine-state.json in the
// repository (committed), never an ephemeral runner-local file.
//
// Durability model:
//   - every save() is atomic: write to engine-state.json.tmp, fsync, rename.
//     A crash can never leave a half-written state file.
//   - a CORRUPT state file is NEVER silently reset. load() throws
//     E_STATE_CORRUPT; the runner prints an explicit recovery instruction and
//     `runner.mjs recover` archives the corrupt file to
//     data/engine-state.corrupt-<ts>.json and writes a fresh state with a
//     recovery record, so nothing is lost and nothing is hidden.
//   - locks use a separate lock file acquired with O_EXCL (atomic across
//     processes), and staleness is judged by the recorded HEARTBEAT, not by
//     acquisition time.
// States: planned -> researching -> drafting -> validating -> ready ->
//         publishing -> published | blocked | failed
import fs from 'node:fs';
import path from 'node:path';

const VALID = new Set(['planned','researching','drafting','validating','ready','publishing','published','blocked','failed']);
const TRANSITIONS = {
  planned: ['researching','blocked'],
  researching: ['drafting','blocked','failed'],
  drafting: ['validating','blocked','failed'],
  validating: ['ready','blocked','failed'],
  ready: ['publishing','blocked'],
  publishing: ['published','failed'],
  published: [],
  blocked: ['planned','failed'],
  failed: ['planned','blocked']
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

export class StateStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'data', 'engine-state.json');
    this.lockFile = path.join(root, 'data', 'engine-lock.json');
    this.data = this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
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
    return this.data;
  }

  save() {
    this.data.updated_at = new Date().toISOString();
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify(this.data, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, this.file); // atomic on POSIX
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

  heartbeat(runId) {
    const payload = { run_id: runId, heartbeat_at: new Date().toISOString() };
    try {
      fs.writeFileSync(this.lockFile, JSON.stringify(payload) + '\n');
    } catch { /* lock file may be gone if recovered; ignore */ }
    if (this.data.lock && this.data.lock.holder === runId) {
      this.data.lock.heartbeat_at = payload.heartbeat_at;
      this.save();
    }
  }

  releaseLock(runId) {
    try { fs.unlinkSync(this.lockFile); } catch { /* already gone */ }
    if (this.data.lock && this.data.lock.holder === runId) {
      this.data.lock = null;
      this.save();
    }
  }

  activeJobs() {
    return this.data.jobs.filter(j => !['published','failed','blocked'].includes(j.state));
  }

  isStopped() { return this.data.emergency_stop === true; }
}
