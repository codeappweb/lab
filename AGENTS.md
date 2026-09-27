# AGENTS.md — instructions for coding agents working in this repository

This file describes the implemented project as it exists. It does not override user instructions or platform rules.

## Before touching anything

1. Read `README.md`, then `docs/PROJECT-STATUS.md` and `docs/HANDOFF.md`. They carry the current, evidence-based status — not aspirations.
2. Fetch and inspect HEAD, active branches and open PRs before changing files. Another session may have newer work. Never reset, force-push over, or overwrite uncommitted or newer changes.
3. Check the latest CI run for the branch you continue. Reproduce failures before fixing them; do not fix reports, fix causes.

## Source-of-truth rules

- `data/navigation.yml` — the only menu source. `data/taxonomy.yml` — the only public taxonomy (12 parents, 98 children). Never maintain a second hand-written category list.
- `data/article-manifest.jsonl` — the only topic-approval registry. A topic is approved only as a line with `status: "planned"`. The engine rejects slugs that are not approved there.
- `data/engine-config.json` — durable engine configuration. `data/engine-state.json` — durable engine state (committed). `data/engine-lock.json` and `data/engine-state.corrupt-*.json` are runtime artifacts (gitignored).
- `drafts/` holds pre-publication drafts. `_posts/` holds published articles only. Mock/test content may never reach `_posts/` (the runner refuses mock publishing and re-runs gates after copying).
- `docs/` is authoritative documentation; one fact lives in exactly one document, linked elsewhere. Volatile numbers belong in `reports/`, not hardcoded in docs.

## Generated files — how to regenerate

- Sitemap shards: `node scripts/gen-sitemap-shards.mjs` (then `node scripts/validate-sitemap.mjs`). Do not run legacy `scripts/build-sitemap.mjs`.
- Site data / archive pages / search index: `node scripts/gen-site-data.mjs`, `node scripts/gen-archive-pages.mjs`.
- Manifest/progress: `node scripts/sync-manifest.mjs` (dry-run in CI; conflicts are failures).
- Topic candidates (NOT approved): `node scripts/engine/runner.mjs plan`.

## Stable invariants — never break

- Post permalinks stay `/:title/`; category URLs stay `/danh-muc/<parent>/(<child>/)`. Hub URLs stay `/hub/cNN/`. Never rename a published URL or article ID.
- Articles keep `id`, `parent_category`, `child_category`, `search_intent` front matter (see `docs/SCHEMA-ARTICLE.md`).
- No `noindex` on published articles; hubs and stub categories stay noindex by design.

## Required checks by change type

- Any content change: `node scripts/validate-deploy.mjs` must pass before pushing.
- Any engine change: `node scripts/engine-selftest.mjs` and `node scripts/selftest.mjs` must pass.
- Any template/layout change: also `bundle exec jekyll build` then `node scripts/validate-built.mjs --site _site`.
- Never weaken a validator, delete a check, or suppress a failure to make CI green. Never bypass gates.

## Content integrity

- No fabricated prices, laws, sources, specifications, metrics, test results, or completed work. Legal/technical claims need a source in `data/legal-sources.yml`; verify time-sensitive facts instead of guessing.
- New production articles: 1,200–2,000 Vietnamese syllable-tokens (documented method in `scripts/validate-content-quality.mjs`).
- Mock fixtures live under `tests/fixtures/` and temporary roots only. They are excluded from the Jekyll build and can never be published.

## Secrets

- No credentials, tokens, or API keys in the repository, docs, logs, or PR comments. Provider preflight must not assume an environment variable proves a working adapter; a paid chat subscription is not API access.

## Authorization boundaries

- Do not enable generation (`generation_enabled=true`), launch paid runs, run the article pilot, publish, or merge a PR without explicit user authorization for that action.
- The scheduled/deployed pipeline (`content-pipeline.yml`) never writes articles; the dispatch-only `writer-preflight` job only checks configuration.

## Leaving a handoff

End every session by updating `docs/HANDOFF.md`: what changed, exact commands run with outcomes, current branch/PR, external blockers, and the next safe action — factual, no completion claims that evidence does not support. Update `docs/PROJECT-STATUS.md` statuses in the same commit as the code they describe.
