// Durable engine state. Single source of truth: data/engine-state.json in the
// repository (committed), never an ephemeral runner-local file.
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

export class StateStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'data', 'engine-state.json');
    this.data = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const d = JSON.parse(raw);
      if (d && typeof d === 'object' && Array.isArray(d.jobs)) return d;
    } catch { /* fresh state */ }
    return {
      schema: 1,
      emergency_stop: false,
      paused: false,
      checkpoint: null,
      lock: null,
      jobs: [],
      runs: []
    };
  }

  save() {
    this.data.updated_at = new Date().toISOString();
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n');
  }

  jobById(id) { return this.data.jobs.find(j => j.id === id); }
  jobBySlug(slug) { return this.data.jobs.find(j => j.slug === slug && j.state !== 'failed' && j.state !== 'blocked'); }

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
      const e = new Error('duplicate job for slug ' + slug);
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

  // File existence vs committed vs verified-live are distinct facts.
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

  acquireLock(runId, cfg) {
    const now = Date.now();
    if (this.data.lock) {
      const age = (now - Date.parse(this.data.lock.acquired_at)) / 1000;
      if (age < cfg.lock_ttl_seconds) return false;
      this.data.lock.recovered_from = this.data.lock.holder;
    }
    this.data.lock = { holder: runId, acquired_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), run_id: runId };
    this.save();
    return true;
  }

  heartbeat(runId) {
    if (this.data.lock && this.data.lock.run_id === runId) {
      this.data.lock.heartbeat_at = new Date().toISOString();
      this.save();
    }
  }

  releaseLock(runId) {
    if (this.data.lock && this.data.lock.run_id === runId) {
      this.data.lock = null;
      this.save();
    }
  }

  activeJobs() {
    return this.data.jobs.filter(j => !['published','failed','blocked'].includes(j.state));
  }

  isStopped() { return this.data.emergency_stop === true; }
}
