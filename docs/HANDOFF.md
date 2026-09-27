# HANDOFF — session 2026-09-27 (engine v2 hoàn thiện + self-documenting repo)

## Đã thay đổi trong phiên này

- `scripts/engine/state.mjs`: atomic save (tmp+fsync+rename), corrupt state → E_STATE_CORRUPT + lệnh `recover` (archive, không reset im lặng), lock O_EXCL + stale theo HEARTBEAT, job identity theo slug cho MỌI trạng thái (failed/blocked giữ slug), `reload()` để thấy pause/stop từ tiến trình khác.
- `scripts/engine/provider.mjs`: preflight trung thực (`test-only` / `manual-draft-ingestion` / `blocked` + reason); evidence (sources[] bắt buộc) + outline + draft là các bước thật; mistral_api = BLOCKED (env var không phải bằng chứng adapter chạy được).
- `scripts/engine/runner.mjs`: pipeline thật planned→researching(evidence)→drafting(drafts/)→validating(draft-level check thật; mock bị cấm ngoài dry-run)→ready→publishing(gates chạy lại + commit)→published(chỉ qua `verify --sha` kiểm URL live + nội dung + revision Pages). Từ chối topic chưa duyệt; retry re-plan + `run --resume` làm lại công việc; reload state mỗi vòng; KHÔNG còn cờ `--live`.
- `scripts/engine-selftest.mjs` (mới): 14 nhóm test offline trên root tạm — mock không tới _posts, unapproved bị từ chối, corrupt→recover, lock stale heartbeat, identity ổn định, retry thật, verify không ghi verified_live thiếu bằng chứng.
- `.github/workflows/validate.yml`: thêm engine selftest; thêm bước post chẩn đoán lên PR khi fail (không nới gate nào).
- `.github/workflows/content-pipeline.yml`: đổi tên job `generation` → `writer-preflight` (dispatch-only, không viết bài) — tên phản ánh đúng trách nhiệm.
- `_config.yml`: exclude `drafts/`, `_tmpchunks/`, `AGENTS.md`.
- `.gitignore`: engine-lock.json, state corrupt archives, topic-candidates.json.
- Docs: README (entry point mới), AGENTS.md (mới), docs/PROJECT-STATUS.md, ENGINE-RUNBOOK.md, VALIDATION.md, DEPLOYMENT.md, SCALING.md, CONTENT-POLICY.md, HANDOFF.md (mới), ARCHITECTURE-20K.md (v3), ENGINE.md (chuyển thành pointer).

## Lệnh đã chạy / kết quả

- Reproduce check-links cục bộ trên 7 file danh mục từng hỏng: KHÔNG còn newline/%0A trong link target (phiên trước đã sửa ở `f0d4a6f`); các "broken link" cục bộ là do dùng sitemap shard cũ làm URL set — CI regen shard trước validate là nguồn chuẩn.
- Engine logic được kiểm thử qua bộ selftest offline (CI chạy lại trong validate.yml). Không chạy pilot, không tạo bài, không paid calls.

## Nhánh / PR / phụ thuộc

- Nhánh: `repair/engine-v2` (PR #1 mở, chưa merge). Commit của phiên này: xem `git log -1` trên nhánh — thông tin này nằm trong commit message "engine v2: executable pipeline + selftest + docs".
- Phụ thuộc ngoài: writer tự động (không có; pilot cần phiên local Mistral/Vibe soạn draft), Pages build source setting (cần xác nhận trên giao diện), robots.txt host-root (cần user-site repo).

## Bước tiếp theo an toàn cho phiên sau

1. Kiểm tra CI run mới nhất trên nhánh (validate + engine selftest). Nếu fail: đọc comment chẩn đoán trên PR #1, sửa nguyên nhân trong repo — KHÔNG nới gate.
2. Chạy kiểm tra không tạo nội dung: `node scripts/engine-selftest.mjs && node scripts/validate-deploy.mjs && bundle exec jekyll build && node scripts/validate-built.mjs --site _site`.
3. Không merge PR, không bật generation, không chạy pilot nếu chưa được yêu cầu rõ ràng.
