# HANDOFF — phiên 2026-09-27 (engine correctness + article UI, tiếp nối engine v2)

## Phiên này (engine correctness repair + premium article UI)

Fix lỗi thật, tái hiện trước khi sửa, thêm regression test cho từng lỗi:

- **Legal verification gate**: `legal-freshness-audit.mjs` fail-closed —
  `verified_source`/`last_verified`/`next_review`/`verification_status: verified`
  nhất quán; ngày tương lai/ngày không hợp lệ/quá hạn/needs-review/mâu thuẫn
  (verified + needs_legal_review) đều CRITICAL; URL khai báo phải khớp registry
  `data/legal-sources.yml` (tự khai URL ≠ bằng chứng kiểm tra nguồn); field
  legacy `legal_source` → MEDIUM yêu cầu migrate. Fixture regression:
  `tests/fixtures/ok/_posts/2026-01-02-bai-phap-ly-da-xac-thuc.md` (pass) và
  `tests/fixtures/bad/_posts/2026-01-03-bai-phap-ly-chua-xac-thuc.md` (fail).
  KHÔNG tự cập nhật ngày verification hay bịa source check.
- **Milestone resume** (`runner.mjs`): M1→M5 như bảng trong ENGINE-RUNBOOK;
  `E_RESUME_AMBIGUOUS`/`E_DUPLICATE_POST` cho ca mơ hồ; pause/stop giữa stage
  (`E_RUN_HALTED`); selftest nhóm 15–20 tái hiện từng điểm gián đoạn.
- **Durable state**: `committed_sha` = content-commit SHA; `verify` dùng
  `gh api compare` + `deployedRevisionOk` (containment, không SHA-equality);
  selftest nhóm 19 (git thật trong root test) và 24 (unit).
- **Concurrency**: lock trước job creation; merge save (pause/jobs union);
  owner-only heartbeat/release; stale recovery theo heartbeat; selftest nhóm
  21–23 ĐA TIẾN TRÌNH THẬT (spawn) + deterministic external lock.
- **Build gates mọi đường publish**: runner + `content-pipeline.yml` đều chạy
  Jekyll build + `validate-built.mjs` trước commit/deploy; `E_BUILD_MISSING`
  xuất hiện trong message để diagnose.
- **Độ dài trung thực**: 1.200–2.000 âm tiết cho bài mới; legacy đóng
  (manifest_id VÀ ≤2026-09-26); allowlist `data/short-article-allowlist.json`
  (8 slug thật đã verify trong manifest); fixture ok có allowlist fixture-scoped.
- **Orphan trung thực**: đối chiếu rendered corpus khi có `_site/`, còn lại
  "source-only estimate".
- **Article UI (không ảnh)**: `assets/css/article.css` (token: 17→19px,
  720px measure, leading 1.78, ol counter, note/tip/warning opt-in, TOC
  containment max-height, 44px tool-btn, table-wrap, reduced-motion);
  `main.js` wrap table + heading permalink; sửa 2 lỗi corruption JS runtime
  (`sheet.class\nList.add`, `document.crea\nteElement`) — các wrap khác
  (`$\n(`, `read\n(`) là legal JS, giữ nguyên; `post.html` updated_at thật;
  head.html load article.css sau cùng. Docs: **ARTICLE-DESIGN.md** (mới).
- **Visual QA: KHÔNG hoàn tất** — môi trường không có browser/screenshot; chỉ
  source-level inspection. Không claim khác.
- Commits phiên này (cũ → mới): `d1e5215` (legal gate + fixtures + schema doc),
  `44e77db` (temp file-dump CI, đã gỡ), `1f1851a` (runner/state/selftest v2),
  `d828236` (selftest brace + content-quality allowlist gate + self-heal
  rendered + parse-check diag), `e95c0fa` (fixture allowlist), `8720914`
  (content-pipeline build gates + article UI), `4b15b99` + `9c86465` (CI
  diagnostics cho engine selftest), `48bbbff` (unit constant fix),
  `2175785` (E_BUILD_MISSING trong message), `ecb8215` (docs).
  CI xanh toàn bộ tại run `36303778295`. PR: https://github.com/codeappweb/lab/pull/1
  (KHÔNG merge).
- 4 comment FILEDUMP cũ trên PR là artifact debug — có thể xóa.

## Các phiên trước (giữ nguyên lịch sử)

- `scripts/engine/state.mjs`: atomic save (tmp+rename), state hỏng → `E_STATE_CORRUPT` + lệnh `recover` (lưu archive, không reset im lặng), lock O_EXCL + phát hiện stale theo HEARTBEAT, job identity theo slug cho MỌI trạng thái (failed/blocked giữ slug), `reload()` để thấy pause/stop từ tiến trình khác.
- `scripts/engine/provider.mjs`: preflight trung thực (`test-only` / `manual-draft-ingestion` / `blocked` + lý do cụ thể); evidence (bắt buộc `sources[]`) + outline + draft là các bước thật; `mistral_api` = BLOCKED (biến môi trường không phải bằng chứng adapter chạy được).
- `scripts/engine/runner.mjs` (viết lại): pipeline thật planned → researching (evidence) → drafting (`drafts/`, không đụng `_posts/`) → validating (check thật cấp draft; mock bị cấm ngoài dry-run) → ready → publishing (chạy lại toàn bộ gate, ghi vào `_posts/`, commit) → published CHỈ khi `verify --sha` xác nhận URL live + nội dung + revision Pages khớp. Từ chối topic chưa duyệt; retry re-plan rồi `run --resume` làm lại công việc; reload state mỗi vòng; không còn cờ `--live`.
- `scripts/engine-selftest.mjs` (mới): 14 nhóm test offline trên root tạm (mkdtemp) — mock không tới `_posts/`, unapproved bị từ chối, corrupt → recover, lock stale heartbeat, identity ổn định, retry thật, verify không ghi `verified_live` thiếu bằng chứng.
- `.github/workflows/validate.yml`: thêm engine selftest; job `manifest-reconcile` (idempotent, chỉ chạy `scripts/sync-manifest.mjs` và commit data khi lệch — không tạo nội dung); bước đăng chẩn đoán lên PR khi fail (không nới gate nào); gate nội dung luôn ghi `reports/content-quality.json`.
- `scripts/validate-content-quality.mjs`: luôn ghi `reports/content-quality.json`; sửa thông báo lỗi manifest.
- `scripts/lib/lab.mjs`: loại `AGENTS.md` khỏi tập nội dung site (giống README.md).
- `scripts/engine/state.mjs`: constructor ghi `data/engine-state.json` ngay từ lần gọi đầu (cả lệnh bị từ chối vẫn để lại state đọc được).
- `scripts/engine/runner.mjs`: `preflight` stdout thuần JSON (NOTE chuyển stderr).
- `scripts/engine-selftest.mjs`: sửa check archive recover (prefix lặp).
- `.github/workflows/content-pipeline.yml`: đổi tên job `generation` → `writer-preflight` (dispatch-only, không viết bài) — tên phản ánh đúng trách nhiệm.
- `_config.yml`: exclude `drafts/`, `_tmpchunks/`, `AGENTS.md`.
- `.gitignore`: `data/engine-lock.json`, `data/engine-state.corrupt-*.json`, `data/topic-candidates.json`.
- Docs: README (entry point mới), AGENTS.md (mới), docs/PROJECT-STATUS.md, ENGINE-RUNBOOK.md, VALIDATION.md, DEPLOYMENT.md, SCALING.md, CONTENT-POLICY.md, ARCHITECTURE-20K.md, HANDOFF.md (mới), ENGINE.md (chuyển thành pointer).

Commit của phiên này trên nhánh `repair/engine-v2` (mới nhất trước, lịch sử đầy đủ: git log):
- `6faa74e`, `9460204` — bot CI reconcile: manifest + progress đồng bộ 8 bài đã xuất bản (job `manifest-reconcile`; idempotent từ đây).
- `771c095` — docs/HANDOFF cập nhật.
- `86e7a08` — docs/PROJECT-STATUS: run `36301349863` toàn bộ xanh (selftest + reconcile no-op + gates).
- `9fdc4fb` — lab.mjs loại AGENTS.md; validate-content-quality ghi report; workflow thêm job manifest-reconcile.
- `3e03e39` — content-quality ghi `reports/content-quality.json`; CI đăng report lên PR.
- `a3d596d` — sửa check archive trong engine-selftest.
- `a90d670` — CI annotate đúng dòng BAD của engine selftest.
- `a88b773` — state.mjs: persist state file lần đầu.
- `aff2d99` — runner preflight stdout thuần JSON.
- Các commit trước đó của phiên: `191c4b6`, `c663c06`, `516ce5f`, `3913273`, `3b46129`, `712dc8d`, `5479cba`, `55be001`, `37094f6`, `01f0d3e`, `f8a7925`, `b80700f`.

## Lệnh đã chạy / kết quả

- Reproduce check-links cục bộ trên 7 file danh mục từng hỏng: KHÔNG còn newline/`%0A` trong link target (phiên trước đã sửa ở `f0d4a6f`); các "broken link" cục bộ là do dùng sitemap shard cũ làm URL set — CI regen shard trước validate là nguồn chuẩn.
- Engine logic được kiểm thử qua bộ selftest offline; CI chạy lại selftest trong validate.yml. Không chạy pilot, không tạo bài, không paid calls.

## Nhánh / PR / phụ thuộc

- Nhánh: `repair/engine-v2`, PR #1 mở, chưa merge.
- Phụ thuộc ngoài: writer tự động (không có; pilot cần phiên local Mistral/Vibe soạn draft vào `drafts/`), Pages build source setting (cần xác nhận trên giao diện GitHub), robots.txt host-root (cần user-site repo).

## Bước tiếp theo an toàn cho phiên sau

0. Lưu ý: commit đẩy lên từ job CI bằng `GITHUB_TOKEN` KHÔNG kích hoạt workflow mới (chống đệ quy của GitHub). Sau một lần reconcile, cần một commit đẩy từ ngoài (như commit docs này) để CI chạy lại trên trạng thái đã đồng bộ.
1. Kiểm tra CI run mới nhất trên nhánh (validate + engine selftest). Nếu fail: đọc comment chẩn đoán trên PR #1, sửa nguyên nhân trong repo — KHÔNG nới gate.
2. Chạy kiểm tra không tạo nội dung: `node scripts/engine-selftest.mjs && node scripts/validate-deploy.mjs && bundle exec jekyll build && node scripts/validate-built.mjs --site _site`.
3. Không merge PR, không bật generation, không chạy pilot nếu chưa được yêu cầu rõ ràng.
