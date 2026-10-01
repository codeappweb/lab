# AGENTS.md — Hợp đồng thực thi cho AI agent (codeappweb/lab)

Ràng buộc bắt buộc với mọi AI agent làm việc trên repo này. Xung đột: repository truth thắng tài liệu; README.md là chuẩn vận hành; chi tiết vòng lặp ở `docs/MICRO-LOOP.md`.

## Nguyên tắc bất biến

- REPOSITORY TRUTH > MEMORY. Đọc repo trước khi làm; không tin trí nhớ hội thoại thay file.
- Không restart factory, không reset/sinh lại matrix khi đã có tiến độ.
- Không viết lại bài PUBLISHED, không claim lại row PUBLISHED.
- Không force-push. Không bypass branch protection.
- Không weaken QA, không tắt test, không `|| true` để lấy kết quả xanh.
- Test không bao giờ mutate production state (fixture dùng `LAB_ROOT` trỏ thư mục tạm).
- Actions không AI, không API key, không cron; chỉ dữ liệu tất định. Actions CHỈ được commit derived allowlist trong publish transaction sau khi mọi gate xanh — không bao giờ viết prose, không bao giờ commit file bài.
- Một writer duy nhất mutate nội dung tại một thời điểm.

## Vòng lặp pair production (bắt buộc mỗi phiên)

FETCH main → `node scripts/next-pair.mjs` (exact 2 ID từ manifest + review_queue) → WRITE ĐÚNG 2 bài theo `docs/SCHEMA-ARTICLE.md` → PUSH NGAY lên main (chỉ file bài) → FACTORY (`production.yml`) tự: select exact IDs từ push → claim → derive → QA scoped → publish transactional (commit derived allowlist + push; không force-push) → `ci.yml` build (light verify) → VERIFY Pages deploy + URL live → CHECKPOINT (`data/writer-checkpoint.json`) → FETCH main → NEXT 2 → REPEAT.

- Một cặp publish thành công là checkpoint, không phải điểm dừng. Không hỏi lại sau mỗi cặp.
- Không gom nhiều bài local; không chạy derived/QA thủ công khi factory đã làm tất định.
- Bài lỗi nội dung: ghi REVIEW lý do vào review_queue, chuyển cặp kế; không chặn hàng đợi.
- Lỗi hạ tầng (build/deploy/repo) ảnh hưởng mọi bài: dừng để sửa.
- Dừng khi: người dùng yêu cầu; hết row planned hợp lệ; runtime/quota buộc dừng; mất mạng kéo dài sau retry; lỗi hạ tầng không xử lý an toàn được.
- Khi dừng: ghi checkpoint (article_id, file, bước, commit đã push, trạng thái deploy) và bước cần resume. Phiên mới: fetch fresh main → `next-pair` → tiếp tục; không dựa state workspace cũ.

## Phân vai

- Writer (Mistral session): viết prose đúng exact IDs, push _posts lên main, xác minh deploy live, cập nhật checkpoint.
- Actions `production.yml`: push-driven factory — claim exact IDs từ push, derive, gate scoped, publish transactional (commit CHỈ derived allowlist). Idempotent, không AI, không cron.
- Actions `ci.yml`: gate + build mọi push main; regression tests engine chỉ khi `scripts/**` hoặc `.github/workflows/**` đổi; full audit sâu chỉ qua workflow_dispatch (artifact, không commit).
- Actions `publish.yml`: check-only cho PR từ nhánh `article/**` (luồng repair lớn) — không commit.
- Pages: deploy duy nhất từ main.

## Verify

- Content-only (một cặp): scoped QA trong `production.yml` + light build trong `ci.yml` của đúng HEAD main; check-links targets/ID/slug vẫn đối chiếu dữ liệu toàn repo chống trùng; không chạy full-site audit/soak/regression tests cho từng cặp.
- Engine/workflow change: full gates — `node --check` mọi script, `node --test scripts/*.test.mjs`, các gate nhẹ, Jekyll build, fixture `scripts/publish-loop.test.mjs`.
- Chỉ báo "đã đăng live" khi CI xanh VÀ URL live trả nội dung mới. Push thành công không đồng nghĩa đã live.
