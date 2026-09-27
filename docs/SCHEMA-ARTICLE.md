# Article Schema (new articles)

New articles in `_posts/` use this front matter. Legacy C05 articles (22 posts,
2026-09-25) are exempt and flagged `legacy`.

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
subcategory: dong-co            # child slug
parent_category: sua-chua       # compat with existing layouts
child_category: dong-co
cluster: C05                    # cluster id, see data/cluster-map.json
batch: batch-001                # publishing batch
entities:                        # list of key entities
  - "ắc quy"
  - "xe tay ga"
related_articles:                # list of post slugs
  - doi-nhot-xe-may-dung-ky
created_at: 2026-09-27
updated_at: 2026-09-27
freshness_status: evergreen | seasonal | time-sensitive
legal_sensitivity: false         # true → legal fields required below
# only when legal_sensitivity: true
verified_source: "..."          # authoritative source URL/name
last_verified: YYYY-MM-DD
next_review: YYYY-MM-DD
verification_status: verified | needs_legal_review
needs_legal_review: true        # when authoritative verification unavailable
---
```

## Rules

- Body: no H1 (layout renders the title), ≥2 `##` sections, ≥400 words, ≥2
  internal links using `{{ '...' | relative_url }}`.
- No CJK characters, no `undefined`, no underscores in prose
  (enforced by `scripts/validate-content-quality.mjs`).
- No fabricated specifics: no invented prices, fines, laws, dates or test
  results. Legal content must cite verifiable sources or be flagged
  `needs_legal_review`.
- `seo_score` is computed by `scripts/seo-score.mjs` into
  `reports/seo-scores.json` — never placed in front matter.
- `content_hash` is computed by `scripts/compute-content-hashes.mjs` into
  `reports/content-hashes.json`.
- Duplicate intent/title/description = reject (enforced by
  `scripts/detect-duplicates.mjs` + `scripts/self-heal-audit.mjs`).
