# VALIDATION — cổng kiểm định và ý nghĩa thật của từng cổng

Nguyên tắc: mỗi cổng phải FAIL khi nội dung sai; không cổng nào được nới lỏng để CI xanh. Báo cáo nằm trong `reports/` (không hardcode số liệu vào docs).

## Cổng và ý nghĩa

| Script | Kiểm tra gì | Khi fail |
|---|---|---|
| `validate-content-quality.mjs` | Front matter, title/description, CJK artifact, H1 trùng, permalink chuẩn, id bắt buộc, bài mỏng <300 từ, trang indexable <40 từ, manifest trùng slug; độ dài bài MỚI (schema mới) phải 1.200–2.000 âm tiết — dưới 1.200 là ERROR trừ khi slug nằm trong `data/short-article-allowlist.json` (allowlist JSON hỏng = fail closed), trên 2.000 là warning; legacy = có `manifest_id` VÀ ngày file ≤ 2026-09-26 (miễn loại đóng, không mở rộng cho bài tương lai) | exit 1, chặn mọi đường |
| `detect-duplicates.mjs` | Gần trùng (LSH banding) giữa các bài | exit 1 |
| `check-links.mjs` | Link nội bộ markdown + Liquid `relative_url` + `href` thô; fragment; whitespace/`%0A` trong target; đối chiếu FULL URL set (indexable + noindex + hub) | exit 1 + `reports/link-errors.json` |
| `gen-sitemap-shards.mjs` + `validate-sitemap.mjs` | Sinh shard từ URL canonical thật; exact membership (permalink override, `published:false`, future date, `noindex`, `sitemap:false` bị loại) | exit 1 |
| `self-heal-audit.mjs` | Orphan/noindex/mismatch cấu trúc (CRITICAL/HIGH/MEDIUM/LOW). Cảnh báo orphan đối chiếu corpus RENDERED: bài chỉ bị báo orphan khi KHÔNG có link nguồn VÀ rendered chả về nó (đã loại index.html của chính bài). Không có `_site/` → ghi nhãn "possible orphan (source-only estimate)" — không được coi là orphan xác nhận | exit 1 khi có lỗi nghiêm trọng |
| `legal-freshness-audit.mjs --gate` | Cổng xác minh pháp lý fail-closed: bài legal-sensitive PHẢI có `verified_source` (URL đã kiểm tra; field legacy `legal_source` vẫn bị đánh dấu MEDIUM yêu cầu migrate), `last_verified` (ngày lịch sử hợp lệ, không tương lai), `next_review` (ngày hợp lệ, chưa quá hạn, không sớm hơn last_verified), và `verification_status: verified` NHẮNG; thiếu/needs-review/expired/mâu thuẫn (verified + needs_legal_review) đều CRITICAL. URL + ngày tương lai KHÔNG là verification; URL khai báo phải khớp entry trong `data/legal-sources.yml` (bằng chứng kiểm tra nguồn thật). Gate KHÔNG bao giờ tự cập nhật ngày hoặc bịa source check | exit 1 |
| `seo-score.mjs` | Điểm SEO; đếm âm tiết tiếng Việt (phương pháp có tài liệu hóa) | report |
| `sync-manifest.mjs` | Đối chiếu `_posts` ↔ manifest ↔ progress; conflict là lỗi | exit 1 |
| `measure-output.mjs` | Dung lượng `_site` hoàn chỉnh (hoặc estimate nguồn, ghi nhãn) | report `reports/capacity.json` |
| `validate-deploy.mjs` | Orchestrator chạy tuần tự các gate trên | fail-fast |
| Jekyll build (CI) | Build thật với gem github-pages; KHÔNG `|| true` | job fail |
| `validate-built.mjs --site _site` | Mọi href HTML render phải trỏ tới file build; URL sitemap phải tồn tại trong build; href chứa newline/whitespace là lỗi | exit 1 |
| `engine-selftest.mjs` | Orchestration engine offline (root mkdtemp, ~100 checks): state atomic + concurrent-writer merge save, corrupt→recover, lock O_EXCL + heartbeat + stale recovery + non-owner release, identity theo slug, retry đúng max_retries, mock không tới production, verify không ghi verified_live nếu thiếu bằng chứng, MILESTONE RESUME (resume giữa các giai đoạn publishing không trùng bài/commit, ambiguous → blocked không ghi đè), concurrency ĐA TIẾN TRÌNH thật (spawn), deployedRevisionOk (containment, không SHA-equality), PERSISTENCE (nhóm 25–30: publish offline đầy đủ với git repo thật + bare remote — content commit tách state commit, file staged của phiên khác không bị kéo theo, push interruption + recovery, fresh-clone resume không trùng, artifact nằm trong state commit, root không-git là no-op) | exit 1 |
| `validate-navigation.mjs` | MỘT nguồn dữ liệu điều hướng: `data/navigation.yml` (main+utility) + `data/menu-cats.yml` (primary+more) + `data/taxonomy.yml` là registry duy nhất. Source-level: label/url duy nhất, menu-cats ⊆ taxonomy, chuỗi group mega menu trong header phủ ĐÚNG tập primary+more. Chế độ `--site _site` (rendered): CÙNG một URL phải mang CÙNG một nhãn visible trên mọi surface (header .main-nav/.mega, footer, nav drawer, topic sheet, bottom nav; ngoại lệ hợp lệ: dạng đầy đủ "Tất cả <label>"), và mọi URL điều hướng phải resolve tới file đã build | exit 1 + `reports/navigation-inventory.json` (item → label → URL → surfaces) |
| `scripts/tests/article-runtime.test.mjs` | Runtime test trong môi trường DOM thật (không chỉ syntax): article.js với 0/1/nhiều bảng (wrap đúng một lần, region có nhãn), 0/1/nhiều heading permalink (không trùng, bỏ heading không id), init lặp idempotent, clipboard THẬT — trạng thái "copied" chỉ hiện khi copy thành công thật (API resolve hoặc execCommand true), không bao giờ báo copied khi copy fail | exit 1 |
| `selftest.mjs` | Fixture `tests/fixtures/ok` phải pass, `bad` phải fail từng gate | exit 1 |

## Fixture và kiểm thử

- `tests/fixtures/ok`, `tests/fixtures/bad` — cây site tổng hợp, không bao giờ là nội dung thật, loại khỏi build Jekyll.
- `scripts/engine-selftest.mjs` dùng root tạm (mkdtemp) cho mọi ca: không đụng job production.

## Hành vi khi fail

- Fail = exit khác 0 = KHÔNG push, KHÔNG deploy. Trong CI, bước fail chặn các bước sau; validate.yml upload `reports/` kể cả khi fail và post comment chẩn đoán lên PR.
- Không bao giờ: nới ngưỡng, bắt gate "warn", bỏ bước, hoặc sửa report thay vì sửa nội dung.
