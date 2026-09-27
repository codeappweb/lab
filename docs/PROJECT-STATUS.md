# PROJECT STATUS — snapshot 2026-09-27

- Baseline audit: main @ `3ee557c0`, audited repair commit `ed79277` (branch `repair/engine-v2`, PR #1).
- Phiên làm việc này tiếp tục từ HEAD nhánh `repair/engine-v2`, không merge PR, không đổi cài đặt publish.

## Session 2026-09-27 (engine correctness + article UI)

- Cổng xác minh pháp lý fail-closed (`legal-freshness-audit.mjs`): `verified_source` + `last_verified` (không tương lai) + `next_review` (hợp lệ, chưa quá hạn) + `verification_status: verified` NHẮNG; URL + ngày tương lai KHÔNG cấu thành verification; URL khai báo phải khớp registry `data/legal-sources.yml`; field legacy `legal_source` bị gắn MEDIUM yêu cầu migrate; fixture regression ok/bad trong `tests/fixtures/`.
- Milestone resume cho `publishing` (M1 file_write_planned → M2 file_written → M3 gates+build → M4 content commit → M5 push → verified_live): `run --resume` suy luận bước tiếp theo từ bằng chứng bền vững; file khác draft → `E_RESUME_AMBIGUOUS`; file `_posts/` không milestone → `E_DUPLICATE_POST`; SHA không tồn tại → `E_RESUME_AMBIGUOUS`; pause/stop kiểm tra lại giữa các stage và trước mọi bước không đảo ngược (`E_RUN_HALTED`, job giữ resumable).
- Durable state: `committed_sha` là SHA của CONTENT COMMIT (chỉ `_posts/<file>.md`), tách khỏi state/report commits; `verify` dùng `gh api compare` + `deployedRevisionOk` (identical/ahead pass, behind/diverged/unknown fail closed) — không còn SHA-equality giả định.
- Build gates trên MỌI đường publish: runner chạy gate suite + gen-site-data + `bundle exec jekyll build` + `validate-built.mjs --site _site` trước khi commit; `content-pipeline.yml` chạy Jekyll build + rendered validation TRƯỚC khi commit artifacts và request Pages build (build/render fail → không deploy).
- Concurrency: lock được TRƯỚC khi tạo job; save merge (pause/stop ngoài không bị clobber, jobs union theo id); heartbeat/releaseLock chỉ bởi owner; stale recovery theo heartbeat freshness; tmp file theo pid; retry đúng `max_retries`. Kiểm thử đa tiến trình THẬT (spawn) trong engine-selftest.
- Độ dài bài: chuẩn 1.200–2.000 âm tiết cho bài mới; legacy đóng (manifest_id VÀ ≤ 2026-09-26); allowlist tường minh `data/short-article-allowlist.json` (8 slug batch-001, JSON hỏng = fail closed); fixture ok có allowlist riêng (positive regression).
- Orphan: đối chiếu corpus rendered khi có `_site/`; không có thì ghi nhãn "possible orphan (source-only estimate)".
- Article UI (không ảnh): `assets/css/article.css` (token typography 17→19px, measure 720px, counter ol, note/tip/warning opt-in, TOC containment, 44px toolbar, table scroll, reduced-motion); `main.js` thêm `.table-wrap` + heading permalinks; sửa 2 lỗi corruption JS thật (`sheet.class\nList.add` — topic sheet; `document.crea\nteElement` — copy-link fallback); `post.html` hiển thị "Cập nhật" chỉ khi `updated_at` thật khác ngày publish; related ≤ 3 cả 2 đường. Thiết kế tài liệu hóa trong [ARTICLE-DESIGN.md](ARTICLE-DESIGN.md).
- Visual QA: KHÔNG hoàn tất — không có browser tooling trong môi trường này; chỉ inspect source (Liquid/CSS/JS). Không claim visual QA từ source inspection.

## Verified

- CI run `36303778295` (2026-09-27, commit `3d4d17e`-era head of `repair/engine-v2`): TOÀN BỘ XANH — "Script + engine selftest" (75 checks gồm 24 nhóm: resume milestone, concurrency đa tiến trình thật, durable state, deployedRevisionOk), "Manifest reconcile" (no-op), và "Content + sitemap + build gates" (content-quality với allowlist, duplicates, check-links, sitemap, self-heal + legal gate, manifest dry-run, engine preflight, Jekyll build THẬT với article.css/post.html mới, validate-built) đều pass. Xem run trên [PR #1](https://github.com/codeappweb/lab/pull/1).
- Gate content-quality ghi `reports/content-quality.json` và CI đăng report lên PR khi fail.
- `AGENTS.md` đã bị loại khỏi tập nội dung site (như README.md) — không còn lỗi "page missing title".
- Cổng check-links/build/sitemap được CI xác nhận lại ở run trên commit `771c095a` trở đi.

## Blocked (external, không tự ý xử lý)

- Writer tự động: KHÔNG có. `mock` = test only; `mistral_vibe_local` = manual draft ingestion (không phải viết tự động); `mistral_api` = BLOCKED (không adapter, không credentials, không giả định subscription = API).
- `https://codeappweb.github.io/robots.txt` 404 — cần repo user-site `codeappweb/codeappweb.github.io`, ngoài phạm vi repo này. `/lab/robots.txt` hợp lệ.
- Deploy branch-based của Pages chỉ được bảo vệ khi `content-pipeline.yml` chạy trên nhánh deploy; workflow validate riêng KHÔNG tự bảo vệ Pages setting. Kiểm tra Pages build source trong repo Settings nếu pipeline deploy báo sai nguồn.

## Not implemented (có chủ đích)

- Pilot 3–5 bài thật: chưa chạy (cần yêu cầu rõ ràng + review draft).
- Scheduled article generation: không có; generation dispatch-only + double-gate.
- API writer: không có adapter, không paid calls.

## Known defects / theo dõi

- Sitemap shard trong repo có thể cũ hơn nội dung giữa các lần CI regen — CI luôn regen trước khi validate; không sửa tay.
- `_tmpchunks/` chứa log chẩn đoán cũ của phiên trước (không thuộc build) — có thể dọn trong commit riêng.

## Next concrete actions

1. Xác nhận CI trên commit mới của nhánh `repair/engine-v2` (validate + engine selftest) xanh toàn bộ.
2. Khi được yêu cầu pilot: chọn 3–5 topic planned từ manifest → dry-run → soạn draft thật trong phiên local → review → bật tạm `generation_enabled` → chạy có kiểm soát theo [ENGINE-RUNBOOK.md](ENGINE-RUNBOOK.md) → tắt lại.
3. Giải quyết blocker robots.txt (user-site repo) nếu cần SEO host-root.
