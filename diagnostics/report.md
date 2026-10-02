# Coordinator repro report
Fri Oct  2 14:12:42 UTC 2026
## sha
4c6e2150b29baa1e3b702a5023deb0db2a6be449
4c6e2150b29baa1e3b702a5023deb0db2a6be449
origin/staging/writer-1 = 47d24de3a6ae6d222e44422a837a7920c0c6bce2
origin/staging/writer-2 = 9265be841b140793249c129844649877cb867c31
origin/staging/writer-3 = 591699249b9371832c51ffd2525ce3b12434e880
## step sync-manifest dry-run
sync-manifest: 0 row(s) marked published, 0 staged row(s) held (not verified on origin/main), 0 post(s) reconciled from front matter, 0 stale slug(s) fixed, 241 total rows
sync-manifest dry-run: manifest and progress already in sync.
EXIT_SYNC=0
## step cycle-phase check-stop
::error::PRODUCTION STOP: 2 coordinator run fail lien tiep (>= consecutive_failure_stop=2). Dung sinh state moi; kiem tra nguyen goc (workflow log, cycle null, staging) roi reset data/coordinator-state.json.consecutive_failures = 0 sau khi da sua.
EXIT_STOP=1
## step cycle-phase resume
cycle-phase: khong co cycle dang mo (phase=idle) — bat dau chu ky moi bang next-pair.mjs --allocate.
EXIT_RESUME=0
## step collect-staging
::error::staging contamination tren staging/writer-1: file ngoai _posts/*.md khac main (.github/workflows/production.yml, .github/workflows/staging-signal.yml, data/.coordinator-trigger, data/article-manifest.jsonl, data/progress.json, docs/MICRO-LOOP.md, scripts/collect-staging.mjs, scripts/next-pair.mjs, scripts/publish-loop.mjs) — writer KHONG DUOC sua .github/scripts/data/sitemap; reset nhanh ve main HEAD truoc khi day bai.
EXIT_COLLECT=1
## step integrate-guard
node:fs:448
    return binding.readFileUtf8(path, stringToFlags(options.flag));
                   ^

Error: ENOENT: no such file or directory, open '/tmp/scope.json'
    at readFileSync (node:fs:448:20)
    at file:///home/runner/work/lab/lab/scripts/integrate-guard.mjs:57:26
    at ModuleJob.run (node:internal/modules/esm/module_job:325:25)
    at async ModuleLoader.import (node:internal/modules/esm/loader:606:24)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5) {
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '/tmp/scope.json'
}

Node.js v20.20.2
EXIT_GUARD=1
## diff checks
### writer-1 three-dot vs main
.github/workflows/production.yml
.github/workflows/staging-signal.yml
data/.coordinator-trigger
data/article-manifest.jsonl
data/progress.json
docs/MICRO-LOOP.md
scripts/collect-staging.mjs
scripts/next-pair.mjs
scripts/publish-loop.mjs
### writer-1 two-dot vs main
.github/workflows/diagnostics.yml
data/.coordinator-trigger
data/coordinator-state.json
data/factory-cycle.json
data/writer-checkpoint.json
diagnostics/README.md
### writer-2 three-dot vs main
.github/workflows/production.yml
.github/workflows/staging-signal.yml
data/.coordinator-trigger
data/article-manifest.jsonl
data/progress.json
docs/MICRO-LOOP.md
scripts/collect-staging.mjs
scripts/next-pair.mjs
scripts/publish-loop.mjs
### writer-2 two-dot vs main
.github/workflows/diagnostics.yml
data/.coordinator-trigger
data/coordinator-state.json
data/factory-cycle.json
data/writer-checkpoint.json
diagnostics/README.md
### writer-3 three-dot vs main
.github/workflows/production.yml
.github/workflows/staging-signal.yml
data/.coordinator-trigger
data/article-manifest.jsonl
data/progress.json
docs/MICRO-LOOP.md
scripts/collect-staging.mjs
scripts/next-pair.mjs
scripts/publish-loop.mjs
### writer-3 two-dot vs main
.github/workflows/diagnostics.yml
data/.coordinator-trigger
data/coordinator-state.json
data/factory-cycle.json
data/writer-checkpoint.json
diagnostics/README.md
## git status
?? diagnostics/report.md
