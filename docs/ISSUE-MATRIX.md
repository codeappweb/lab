# ISSUE MATRIX — audit HEAD 3ee557c0 → nhánh repair/engine-v2

Severity: CRITICAL / HIGH / MEDIUM / LOW. Evidence = quan sát trực tiếp tại HEAD 3ee557c0 (main) hoặc trang live. Verification = cách kiểm chứng sau khi sửa (chạy CI trên PR).

| # | Vấn đề | Severity | Evidence (HEAD 3ee557c0) | Sửa | Verification |
|---|--------|----------|--------------------------|-----|--------------|
| 1 | `validate-content-quality.mjs` hỏng escape regex, loại `_posts/` khỏi validation | CRITICAL | Đọc tệp tại HEAD | Viết lại: gồm `_posts`, shared lib `scripts/lib/lab.mjs` | CI selftest: fixture bad exit≠0, ok exit=0 |
| 2 | `gen-sitemap-shards.mjs` thừa dấu ngoặc, crash | HIGH | Lỗi cú pháp tại HEAD | Viết lại, deterministic, dọn shard cũ | `node --check` + CI validate-sitemap |
| 3 | `validate-sitemap.mjs` đếm URL tài liệu sitemap as bài viết | MEDIUM | Logic đếm sai tại HEAD | Viết lại: exact membership so với canonicalIndex | CI validate-sitemap exit 0, articles=30 |
| 4 | `self-heal-audit.mjs` dựng path `hub/hub/c01.md`, crash; noindex/orphan sai | HIGH | Path không tồn tại trong repo | Viết lại dùng shared discovery, guarded reads | CI self-heal-audit |
| 5 | `gen-dashboard.mjs` gọi `discovery.filter()` trên object `{articles}` | HIGH | Đọc tệp + reports/google-discovery.json | Sửa thành `discovery.articles` | CI gen-dashboard exit 0 |
| 6 | 8 bài batch-001 thiếu record trong manifest | CRITICAL | _posts=30 vs manifest published=22 | `sync-manifest.mjs` viết lại: đối chiếu slug, tạo record thiếu sau kiểm tra trùng intent, derive progress.json; chạy trong CI (checkout nguyên vẹn) | CI sync-manifest --dry-run xanh; sau lần chạy thật manifest có 30 published |
| 7 | `progress.json` (published=22) mâu thuẫn thực tế (30) | HIGH | Đọc progress.json + đếm _posts | sync-manifest derive counts từ thực tế | Như #6 |
| 8 | Sitemap chứa slug không tồn tại `xe-may-bi-truot-con-de-...` (thực tế: `truot-con`) | CRITICAL | Fetch live sitemaps/articles-001.xml | Sửa link nguồn trong post + regen shard | Live shard sau deploy chứa đúng slug; validate-sitemap exact membership |
| 9 | 18 đích 404 khi crawl live: link hỏng trong `chan-doan-loi.md`, `sua-chua.md`, post áp suất lốp | CRITICAL | Crawl live tại HEAD + đối chiếu link | Sửa 3 tệp markdown (giữ URL đã publish); check-links bắt whitespace/%0A. Lưu ý: tại HEAD `_posts` có đúng 30 tệp, KHÔNG có tệp tên chứa newline; stub `danh-muc/thue-xe/thue-xe-may.md` đã tồn tại (263B) — các URL `%0A` là tàn dư build cũ, tự hết sau rebuild | check-links exit 0; validate-built kiểm HTML render |
| 23 | Link hỏng thêm: `du-lich.md` 7 link + `phuot-xe.md` 1 link dùng `du-lic` (thiếu `h`); `chi-phi.md` link `/danh-muc/chi-phi/mua-xe/` (child thuộc `xe-may`); `cong-nghe.md` link `/danh-muc/cong-nghe/pin-lfp/` (taxonomy là `pin-lithium`) | HIGH | Trích xuất toàn bộ target Liquid từ 30 post + 13 trang danh mục tại HEAD, đối chiếu taxonomy/slug thực | Sửa 4 tệp: `du-lic`→`du-lich`, `chi-phi/mua-xe`→`xe-may/mua-xe`, `pin-lfp`→`pin-lithium` (không đổi URL hợp lệ đã publish) | check-links exit 0; validate-built |
| 10 | `check-links.mjs` bỏ sót trang danh mục và link Liquid | HIGH | Đọc tệp tại HEAD | Viết lại: markdown + Liquid + href thô + fragment + whitespace | CI check-links |
| 11 | Post render 29 related card (quét toàn cluster); hub hiển thị toàn bộ cluster | HIGH | Live: hub C05 29 card | post.html dùng `related-posts.json` precomputed (max 3) + prev/next O(1) + fallback; hub.html `limit: 12` + ghi chú số bài | Sau merge+deploy: hub ≤12 card, post ≤3 related |
| 12 | Danh mục cắt 12/24 bài, không có pagination crawlable | HIGH | Live | `gen-archive-pages.mjs`: `danh-muc/<parent>/trang-NN.md` (48/trang), layout `archive`; URL category cũ giữ nguyên | CI gen-archive-pages + validate-built |
| 13 | CI nuốt lỗi build Jekyll (`|| true`) | CRITICAL | Đọc content-pipeline.yml tại HEAD | Workflow `validate.yml`: build thật, lỗi build = job fail | CI run trên PR |
| 14 | Token commits không kích hoạt Pages build; audit không gate deploy | CRITICAL | Hành vi GitHub + đọc workflow | `content-pipeline.yml`: POST `/pages/builds` (pages:write) sau commit; `verify-deployment.mjs` xác minh revision + URL đại diện | `reports/deployment-verification.json` |
| 15 | Legal freshness không so ngày thật, không chặn trạng thái verify sai | HIGH | Đọc script cũ | `legal-freshness-audit.mjs`: so `next_review` với hôm nay, `--gate` chặn quá hạn/invalid | selftest bad fixture fail; CI `--gate` xanh |
| 16 | Content hashes không phục vụ resumable | MEDIUM | Hash ghi nhưng không dùng | `compute-content-hashes.mjs` + engine checkpoint theo slug | Dry-run 2 lần không tạo job trùng |
| 17 | Workflow không gọi writer nào | HIGH | HEAD không có bước viết bài | Engine runner + provider (mock/local/api) + preflight; generation dispatch-only + double-gate | CI job `engine status`/`preflight`, không sinh nội dung |
| 18 | Bài mới 438–548 âm tiết, dưới chuẩn 1.200–2.000 | MEDIUM | Đếm thân bài 8 bài batch-001 | Chuẩn 1.200–2.000 áp cho bài MỚI (không mass-rewrite bài cũ); seo-score đếm âm tiết VN có tài liệu hóa | reports/seo-scores.json |
| 19 | Search index một file phình theo số bài | MEDIUM | `assets/search.json` liệt kê mọi post | Chunk `assets/search/cNN.json` ×12 + manifest; `main.js` hỗ trợ cả 2 shape | Sau deploy: chunk 200; Ctrl K hoạt động |
| 20 | So trùng all-pairs không scale | MEDIUM | detect-duplicates cũ | LSH/shingle banding: chỉ so band trùng | CI detect-duplicates |
| 21 | `robots.txt` host-root 404 | MEDIUM (ngoài repo) | Fetch `https://codeappweb.github.io/robots.txt` 404 | KHÔNG sửa — cần repo user-site `codeappweb/codeappweb.github.io` (không tồn tại), ngoài phạm vi repo này | Báo cáo dependency; `/lab/robots.txt` hợp lệ |
| 22 | Capacity chưa đo trên output build | MEDIUM | Không có script đo | `measure-output.mjs` đo toàn bộ `_site`; CI ghi `reports/capacity.json` | Report CI sau build |

Số mục đã sửa trên nhánh repair/engine-v2: CRITICAL 6/6, HIGH 9/9 (gồm #23), MEDIUM 6/7 (#21 là phụ thuộc ngoài repo — chỉ báo cáo).
