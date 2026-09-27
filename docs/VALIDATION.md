# VALIDATION — cổng kiểm định và ý nghĩa thật của từng cổng

Nguyên tắc: mỗi cổng phải FAIL khi nội dung sai; không cổng nào được nới lỏng để CI xanh. Báo cáo nằm trong `reports/` (không hardcode số liệu vào docs).

## Cổng và ý nghĩa

| Script | Kiểm tra gì | Khi fail |
|---|---|---|
| `validate-content-quality.mjs` | Front matter, title/description, CJK artifact, H1 trùng, permalink chuẩn, id bắt buộc, bài mỏng <300 từ, trang indexable <40 từ, manifest trùng slug | exit 1, chặn mọi đường |
| `detect-duplicates.mjs` | Gần trùng (LSH banding) giữa các bài | exit 1 |
| `check-links.mjs` | Link nội bộ markdown + Liquid `relative_url` + `href` thô; fragment; whitespace/`%0A` trong target; đối chiếu FULL URL set (indexable + noindex + hub) | exit 1 + `reports/link-errors.json` |
| `gen-sitemap-shards.mjs` + `validate-sitemap.mjs` | Sinh shard từ URL canonical thật; exact membership (permalink override, `published:false`, future date, `noindex`, `sitemap:false` bị loại) | exit 1 |
| `self-heal-audit.mjs` | Orphan/noindex/mismatch cấu trúc (CRITICAL/HIGH/MEDIUM/LOW) | exit 1 khi có lỗi nghiêm trọng |
| `legal-freshness-audit.mjs --gate` | `next_review` quá hạn hoặc source thiếu trong `data/legal-sources.yml` | exit 1 |
| `seo-score.mjs` | Điểm SEO; đếm âm tiết tiếng Việt (phương pháp có tài liệu hóa) | report |
| `sync-manifest.mjs` | Đối chiếu `_posts` ↔ manifest ↔ progress; conflict là lỗi | exit 1 |
| `measure-output.mjs` | Dung lượng `_site` hoàn chỉnh (hoặc estimate nguồn, ghi nhãn) | report `reports/capacity.json` |
| `validate-deploy.mjs` | Orchestrator chạy tuần tự các gate trên | fail-fast |
| Jekyll build (CI) | Build thật với gem github-pages; KHÔNG `|| true` | job fail |
| `validate-built.mjs --site _site` | Mọi href HTML render phải trỏ tới file build; URL sitemap phải tồn tại trong build; href chứa newline/whitespace là lỗi | exit 1 |
| `engine-selftest.mjs` | Orchestration engine offline: state atomic, corrupt→recover, lock O_EXCL + heartbeat, identity theo slug, retry thật, mock không tới production, verify không ghi verified_live nếu thiếu bằng chứng | exit 1 |
| `selftest.mjs` | Fixture `tests/fixtures/ok` phải pass, `bad` phải fail từng gate | exit 1 |

## Fixture và kiểm thử

- `tests/fixtures/ok`, `tests/fixtures/bad` — cây site tổng hợp, không bao giờ là nội dung thật, loại khỏi build Jekyll.
- `scripts/engine-selftest.mjs` dùng root tạm (mkdtemp) cho mọi ca: không đụng job production.

## Hành vi khi fail

- Fail = exit khác 0 = KHÔNG push, KHÔNG deploy. Trong CI, bước fail chặn các bước sau; validate.yml upload `reports/` kể cả khi fail và post comment chẩn đoán lên PR.
- Không bao giờ: nới ngưỡng, bắt gate "warn", bỏ bước, hoặc sửa report thay vì sửa nội dung.
