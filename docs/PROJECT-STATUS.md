# PROJECT STATUS — snapshot 2026-09-27

- Baseline audit: main @ `3ee557c0`, audited repair commit `ed79277` (branch `repair/engine-v2`, PR #1).
- Phiên làm việc này tiếp tục từ HEAD nhánh `repair/engine-v2` (sau `150316b`), không merge PR, không đổi cài đặt publish.

## Implemented (có bằng chứng trong repo)

- Bộ kiểm định đầy đủ: content-quality, check-links (markdown + Liquid + href thô + fragment + whitespace/%0A), detect-duplicates (LSH banding), self-heal-audit, legal-freshness (--gate), seo-score, sync-manifest, validate-sitemap, validate-built (HTML render), selftest fixtures ok/bad. Xem [VALIDATION.md](VALIDATION.md).
- Engine v2 (session 2026-09-27): pipeline thật approved → researching (evidence bắt buộc) → drafting (drafts/, không đụng `_posts/`) → validating (draft-level check thật; mock bị cấm publish) → ready → publishing (chạy lại toàn bộ gate suite, chép vào `_posts/`, commit) → `verify` live thật (URL 200 + đúng nội dung + revision Pages không khớp `--sha` thì KHÔNG ghi `verified_live`).
- State bền vững: ghi atomic (tmp + fsync + rename), lock file O_EXCL với stale-detection theo HEARTBEAT, job identity ổn định theo slug (kể cả failed/blocked không cho tạo job trùng), reload state mỗi vòng lặp (pause/stop từ tiến trình khác được thấy), corrupt state phải `recover` tường minh (archive, không tự reset im lặng), retry re-plan và `run --resume` thực sự làm lại công việc.
- Offline engine selftest (`scripts/engine-selftest.mjs`): 14 nhóm kiểm thử state/lock/retry/blocking trên root tạm cách ly; chạy trong CI.
- Docs: README (entry point), AGENTS.md, ARCHITECTURE-20K, ENGINE-RUNBOOK, CONTENT-POLICY, VALIDATION, DEPLOYMENT, SCALING, HANDOFF.

## Verified

- Script selftest + engine selftest pass trong CI trên nhánh này (xem run cuối; URL trong [HANDOFF.md](HANDOFF.md)).
- Cổng kiểm định nội dung + duplicate đã pass ở các run trước trên nhánh (audit ed79277); phần check-links/build/sitemap được CI xác nhận lại ở run sau thay đổi này.

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
