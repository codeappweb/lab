# Article Schema (bài mới)

Bài trong `_posts/` dùng front matter dưới đây. Trạng thái dòng manifest tương ứng: `planned → drafting → review → published` (`skip` để bỏ).

```yaml
---
layout: post
title: "..."                    # duy nhất
date: YYYY-MM-DD
description: "..."              # meta description, duy nhất
id: <slug>                      # stable unique id (= post slug)
primary_keyword: "..."
search_intent: "informational | how-to | comparison | ..."
category: sua-chua              # parent slug
subcategory: dong-co            # child slug
parent_category: sua-chua       # compat với layout hiện có
child_category: dong-co
cluster: C05                    # cluster id, see data/cluster-map.json
batch: batch-001
manifest_id: C05-0001           # id dòng trong data/article-manifest.jsonl
# metadata xuất xưởng (cycle plan bất biến — integrate-guard verify)
factory_writer: writer-1        # writer được phân bài trong cycle
factory_cycle: 2026-10-02-01    # cycle_id của data/factory-cycle.json
factory_base_sha: 9ce5c48...    # base_sha của cycle (sha main khi allocate)
entities:
  - "ắc quy"
related_articles:                # list of post slugs
  - doi-nhot-xe-may-dung-ky
created_at: 2026-09-27
updated_at: 2026-09-27
freshness_status: evergreen | seasonal | time-sensitive
legal_sensitivity: false        # true → cần các trường nguồn dưới đây
# chỉ khi legal_sensitivity: true
verified_source: "..."          # nguồn chính thống
last_verified: YYYY-MM-DD
verification_status: verified | needs_legal_review
needs_legal_review: true        # khi chưa kiểm chứng được nguồn chính thống
---
```

## Rules

- Body: không H1 (layout render từ title), ≥2 `##` sections, ≥2 internal links dạng `{{ '...' | relative_url }}`.
- Không ký tự CJK, `undefined`, gạch dưới trong văn xuôi (`scripts/validate-content-quality.mjs`).
- Không bịa số liệu: giá, phạt, luật, thông số, kết quả test. Nội dung pháp lý phải có nguồn kiểm chứng hoặc giữ `needs_legal_review` và trạng thái dòng manifest là `review` (không xuất bản).
- Trùng intent/title/description/slug = reject (`scripts/detect-duplicates.mjs`; similarity là WARNING).
- Mọi số liệu pháp lý đối chiếu `data/legal-sources.yml`.
- `factory_writer` / `factory_cycle` / `factory_base_sha` là trường xuất xưởng bắt buộc với bài viết theo cycle plan: integrate-guard dùng các trường này để verify writer thuộc cycle hiện tại, đúng slice assignment và đúng base_sha. Bài lệch cycle/base_sha hoặc mang assignment của writer khác → rơi vào review_queue (REVIEW), không được tích hợp. Bài theo cơ chế legacy (không có các trường này) khi cycle đang active cũng đi REVIEW.
