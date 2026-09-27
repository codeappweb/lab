# Article Schema (new articles)

New articles in `_posts/` use this front matter. Legacy C05 articles (22 posts,
2026-09-25) are exempt from the length standard and flagged `legacy`; the 8
short batch-001 posts are listed in `data/short-article-allowlist.json`
(see [CONTENT-POLICY.md](CONTENT-POLICY.md)).

```yaml
---
layout: post
title: "..."                    # 30–70 chars, unique
date: YYYY-MM-DD
description: "..."              # 90–165 chars, unique, meta description
id: <slug>                      # stable unique id (= post slug)
primary_keyword: "..."
search_intent: "informational | how-to | comparison | ..."
category: sua-chua              # parent slug
subcategory: dong-co             # child slug
parent_category: sua-chua       # compat with existing layouts
child_category: dong-co
cluster: C05                    # cluster id, see data/cluster-map.json
batch: batch-001                # publishing batch
entities:                        # list of key entities
  - "ắc quy"
  - "xe tay ga"
related_articles:                # list of post slugs (max 3 rendered)
  - doi-nhot-xe-may-dung-ky
created_at: 2026-09-27
updated_at: 2026-09-27           # only when the article actually changed
freshness_status: evergreen | seasonal | time-sensitive
legal_sensitivity: false         # true → verified legal record required below
# only when legal_sensitivity: true — ALL fields are REQUIRED and must be
# CONSISTENT (scripts/legal-freshness-audit.mjs --gate blocks otherwise):
verified_source: "..."          # source URL that was ACTUALLY checked;
                                # must be registered in data/legal-sources.yml
last_verified: YYYY-MM-DD       # when it was checked; never in the future
next_review: YYYY-MM-DD         # re-check deadline; after last_verified
verification_status: verified   # the ONLY passing status
---
```

## Legal verification rules (enforced by `scripts/legal-freshness-audit.mjs --gate`)

- `verification_status` must be exactly `verified`. `needs_legal_review`,
  `unverified`, missing or any other value blocks publication.
- `needs_legal_review: true` blocks publication, including when it contradicts
  `verification_status: verified`.
- `last_verified` is mandatory, must be a valid calendar date and cannot lie in
  the future — a future verification date is a fabricated check.
- `next_review` is mandatory, must be a valid calendar date, later than
  `last_verified`, and not already past (overdue review blocks).
- A URL plus a future date establish NOTHING. The declared source must be a
  registered, checked entry in `data/legal-sources.yml` (source_title,
  publisher, fact, last_verified) — author declarations are not evidence.
- Legacy `legal_source` is still read but reported for explicit migration to
  `verified_source`; migration never weakens the checks above.
- The gate never updates dates and never fabricates a source check; it only
  verifies declared evidence and fails closed.

## Rules

- Body: no H1 (layout renders the title), ≥2 `##` sections, ≥400 words, ≥2
  internal links using `{{ '...' | relative_url }}`.
- No CJK characters, no `undefined`, no underscores in prose
  (enforced by `scripts/validate-content-quality.mjs`).
- No fabricated specifics: no invented prices, fines, laws, dates or test
  results. Legal content must cite verifiable, registered sources or stay
  unpublished.
- `seo_score` is computed by `scripts/seo-score.mjs` into
  `reports/seo-scores.json` — never placed in front matter.
- `content_hash` is computed by `scripts/compute-content-hashes.mjs` into
  `reports/content-hashes.json`.
- Duplicate intent/title/description = reject (enforced by
  `scripts/detect-duplicates.mjs` + `scripts/self-heal-audit.mjs`).
- No images. Article pages are text-only by design; see
  [ARTICLE-DESIGN.md](ARTICLE-DESIGN.md).
