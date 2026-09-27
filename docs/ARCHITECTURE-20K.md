# Kiến trúc 20K (v2 — sau sửa chữa)

Mục tiêu: 20.000 bài tổng (tính cả bài hiện có), xuất bản có kiểm soát, đo được, không sinh hàng loạt tự động.

## Luồng xuất bản

```
topic (manifest, status=planned, đã duyệt)
  → engine job planned → researching → drafting → validating → ready
  → gate: scripts/validate-deploy.mjs (mọi validator + build Jekyll thật)
  → publishing (ghi file _posts) → commit → Pages build → verify-deployment.mjs
  → published (ghi verified_live trong data/engine-state.json)
```

Mọi giai đoạn có checkpoint bền vững trong `data/engine-state.json`; crash/restart resume không trùng lặp. Xem `docs/ENGINE.md`.

## Thành phần

- **Sitemap**: `sitemap.xml` (index) → `sitemaps/articles-NNN.xml` (~1000 URL/shard, sinh từ `_posts` thật), `sitemaps/categories.xml`, `sitemaps/static.xml`. Sinh từ URL canonical thật; permalink overrides, `published:false`, future dates, `sitemap:false`, `noindex` đều được loại. `validate-sitemap.mjs` kiểm exact membership; `validate-built.mjs` kiểm lại trên HTML build.
- **Validators** (shared lib `scripts/lib/lab.mjs`): content-quality (gồm _posts), check-links (Liquid + markdown + fragment + whitespace/%0A), detect-duplicates (LSH banding), self-heal-audit (CRITICAL/HIGH/MEDIUM/LOW), legal-freshness (`--gate` chặn), seo-score (đếm âm tiết tiếng Việt có tài liệu hóa), sync-manifest (đối chiếu posts↔manifest, derive progress.json), gen-dashboard, measure-output, selftest (fixture ok/bad).
- **Engine**: `scripts/engine/` — state machine + idempotency + lock + emergency stop + hard stop 20000. Generation dispatch-only, tắt mặc định (`data/engine-config.json`).
- **CI**: `.github/workflows/validate.yml` (push/PR: selftest fixture, mọi gate, build Jekyll thật không nuốt lỗi, validate-built, upload reports kể cả fail) và `content-pipeline.yml` (hằng ngày: audit → regen → commit → POST /pages/builds → verify deployed revision; job generation riêng, chỉ workflow_dispatch + double-gate).
- **Site scale**: related-posts.json precomputed (max 3, O(1)/trang), archive pagination `danh-muc/<parent>/trang-NN` (48/trang, HTML tiền tính), search chunk theo cluster (`assets/search/cNN.json` + manifest, `main.js` tương thích cả shape cũ), assistant index đã có shard theo cluster.

## Điều kiện thí nghiệm (giữ nguyên)

Không kết nối Search Console. Không thẻ xác minh Google. Không submit sitemap/indexing thủ công. Không thêm noindex vào bài đã publish. Quan sát discovery trong `reports/google-discovery.json` (ghi thủ công, không ping).

## Giới hạn hosting

GitHub Pages site đã publish ~1 GB. `measure-output.mjs` đo toàn bộ `_site`; CI ghi `reports/capacity.json`. Ngoại suy 20K là ƯỚC TÍNH (ghi rõ nhãn), tách khỏi số đo.

## Phụ thuộc ngoài repo

- `https://codeappweb.github.io/robots.txt` (host root) 404 — cần repo user-site `codeappweb/codeappweb.github.io`; không sửa từ repo này. `/lab/robots.txt` hợp lệ.
- Writer tự động qua API: chưa có credentials; dùng `mistral_vibe_local` (draft trong phiên local, human-in-the-loop).
