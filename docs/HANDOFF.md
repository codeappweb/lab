# HANDOFF — phiên 2026-09-27 (engine v2 hoàn thiện + repo tự mô tả)

## Đã thay đổi trong phiên này

- `scripts/engine/state.mjs`: atomic save (tmp+rename), state hỏng → `E_STATE_CORRUPT` + lệnh `recover` (lưu archive, không reset im lặng), lock O_EXCL + phát hiện stale theo HEARTBEAT, job identity theo slug cho MỌI trạng thái (failed/blocked giữ slug), `reload()` để thấy pause/stop từ tiến trình khác.
- `scripts/engine/provider.mjs`: preflight trung thực (`test-only` / `manual-draft-ingestion` / `blocked` + lý do cụ thể); evidence (bắt buộc `sources[]`) + outline + draft là các bước thật; `mistral_api` = BLOCKED (biến môi trường không phải bằng chứng adapter chạy được).
- `scripts/engine/runner.mjs` (viết lại): pipeline thật planned → researching (evidence) → drafting (`drafts/`, không đụng `_posts/`) → validating (check thật cấp draft; mock bị cấm ngoài dry-run) → ready → publishing (chạy lại toàn bộ gate, ghi vào `_posts/`, commit) → published CHỈ khi `verify --sha` xác nhận URL live + nội dung + revision Pages khớp. Từ chối topic chưa duyệt; retry re-plan rồi `run --resume` làm lại công việc; reload state mỗi vòng; không còn cờ `--live`.
- `scripts/engine-selftest.mjs` (mới): 14 nhóm test offline trên root tạm (mkdtemp) — mock không tới `_posts/`, unapproved bị từ chối, corrupt → recover, lock stale heartbeat, identity ổn định, retry thật, verify không ghi `verified_live` thiếu bằng chứng.
- `.github/workflows/validate.yml`: thêm engine selftest; thêm bước đăng chẩn đoán lên PR khi fail (không nới gate nào).
- `.github/workflows/content-pipeline.yml`: đổi tên job `generation` → `writer-preflight` (dispatch-only, không viết bài) — tên phản ánh đúng trách nhiệm.
- `_config.yml`: exclude `drafts/`, `_tmpchunks/`, `AGENTS.md`.
- `.gitignore`: `data/engine-lock.json`, `data/engine-state.corrupt-*.json`, `data/topic-candidates.json`.
- Docs: README (entry point mới), AGENTS.md (mới), docs/PROJECT-STATUS.md, ENGINE-RUNBOOK.md, VALIDATION.md, DEPLOYMENT.md, SCALING.md, CONTENT-POLICY.md, ARCHITECTURE-20K.md, HANDOFF.md (mới), ENGINE.md (chuyển thành pointer).

Commit của phiên này trên nhánh `repair/engine-v2`:
- `191c4b6` — runner.mjs viết lại.
- `c663c06` — engine selftest offline.
- `516ce5f` — workflows + `_config.yml` + `.gitignore`.
- `3913273` — README + AGENTS.md + toàn bộ docs.

## Lệnh đã chạy / kết quả

- Reproduce check-links cục bộ trên 7 file danh mục từng hỏng: KHÔNG còn newline/`%0A` trong link target (phiên trước đã sửa ở `f0d4a6f`); các "broken link" cục bộ là do dùng sitemap shard cũ làm URL set — CI regen shard trước validate là nguồn chuẩn.
- Engine logic được kiểm thử qua bộ selftest offline; CI chạy lại selftest trong validate.yml. Không chạy pilot, không tạo bài, không paid calls.

## Nhánh / PR / phụ thuộc

- Nhánh: `repair/engine-v2`, PR #1 mở, chưa merge.
- Phụ thuộc ngoài: writer tự động (không có; pilot cần phiên local Mistral/Vibe soạn draft vào `drafts/`), Pages build source setting (cần xác nhận trên giao diện GitHub), robots.txt host-root (cần user-site repo).

## Bước tiếp theo an toàn cho phiên sau

1. Kiểm tra CI run mới nhất trên nhánh (validate + engine selftest). Nếu fail: đọc comment chẩn đoán trên PR #1, sửa nguyên nhân trong repo — KHÔNG nới gate.
2. Chạy kiểm tra không tạo nội dung: `node scripts/engine-selftest.mjs && node scripts/validate-deploy.mjs && bundle exec jekyll build && node scripts/validate-built.mjs --site _site`.
3. Không merge PR, không bật generation, không chạy pilot nếu chưa được yêu cầu rõ ràng.
