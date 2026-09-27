// Engine configuration — durable, committed to the repo.
// generation_enabled: false keeps unattended generation OFF by default.
// The pilot must be requested and reviewed; only then is dry_run flipped
// and, after that succeeds, generation_enabled considered.
export const DEFAULTS = {
  target_total: 20000,
  per_run_article_limit: 5,
  per_run_seconds_limit: 3600,
  max_retries: 3,
  backoff_ms: 2000,
  lock_ttl_seconds: 1800,
  generation_enabled: false,
  dry_run: true,
  provider: 'mock',
  words_min: 1200,
  words_max: 2000
};

export function loadConfig(root, fs) {
  const defaults = { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(root + '/data/engine-config.json', 'utf8');
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}
