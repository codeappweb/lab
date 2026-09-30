# AGENTS.md — Hợp đồng thực thi cho AI agent (codeappweb/lab)

Ràng buộc bắt buộc với mọi AI agent làm việc trên repo này. Xung đột: repository truth thắng tài liệu; README.md là chuẩn vận hành; chi tiết vòng lặp ở `docs/MICRO-LOOP.md`.

## Nguyên tắc bất biến

- REPOSITORY TRUTH > MEMORY. Đọc repo trước khi làm; không tin trí nhớ hội thoại thay file.
- Không restart factory, không reset/sinh lại matrix khi đã có tiến độ.
- Không viết lại bài PUBLISHED, không claim lại row PUBLISHED.
- Không force-push. Không bypass branch protection.
- Không weaken QA, không tắt test, không `|| true` để lấy kết quả xanh.
- Test không bao giờ mutate production state (fixture dùng `LAB_ROOT` trỏ thư mục tạm).
- Actions không AI, không API key, không cron; chỉ QA/build/deploy và dữ liệu tất định.
- Một writer duy nhất mutate nội dung tại một thời điểm.

## Vòng lặp micro (bắt buộc mỗi phiên)

FETCH main → RESUME bài đang dở → WRITE 1 bài (chunk_size mặc định 1, tối đa 2 theo `data/factory-config.json`) → PREPARE (`node scripts/prepare-article.mjs <id>`) → COMMIT/PR: commit bài + derived allowlist + checkpoint trong MỘT commit, push `article/<id>`, mở PR → CI xanh đúng HEAD (publish check-only + gate nhẹ + build) → MERGE → VERIFY Pages deploy + URL live → CHECKPOINT (`data/writer-checkpoint.json`) → NEXT 1 → REPEAT.

- Một bài publish thành công là checkpoint, không phải điểm dừng. Không hỏi lại sau mỗi bài.
- Bài lỗi nội dung: ghi REVIEW lý do, chuyển row kế tiếp; không chặn hàng đợi.
- Lỗi hạ tầng (build/deploy/repo) ảnh hưởng mọi bài: dừng để sửa.
- Dừng khi: người dùng yêu cầu; hết row planned hợp lệ; runtime/quota buộc dừng; mất mạng kéo dài sau retry; lỗi hạ tầng không xử lý an toàn được.
- Khi dừng: ghi checkpoint (article_id, file, bước, commit đã push, trạng thái deploy) và bước cần resume.

## Phân vai

- Writer (Mistral session): viết prose, chạy prepare-article, commit bài + derived + checkpoint trong MỘT commit, mở/merge PR, xác minh deploy.
- Actions: `ci.yml` gate + build mọi PR/main; `publish.yml` chỉ CHECK (--check) cây PR do writer commit — không bao giờ commit/push vào PR hay main, và không cần push checkpoint riêng để kích hoạt CI.
- Actions không phải dịch vụ tự viết bài: workflow không AI, không cron, không tự sinh prose khi phiên Mistral đã đóng.
- Pages: deploy duy nhất từ main.

## Verify

- Content-only (một bài): scoped QA qua gate nhẹ trong CI của đúng HEAD PR; check-links chạy `--only` trên bài mới/sửa nhưng targets/ID/slug vẫn đối chiếu dữ liệu toàn repo chống trùng; không chạy full-site audit/soak cho từng bài. Regression tests engine chỉ chạy khi `scripts/**` hoặc `.github/workflows/**` đổi — áp cả PR và push main.
- Engine/workflow change: full gates — `node --check` mọi script, `node --test scripts/*.test.mjs`, các gate nhẹ, Jekyll build, fixture `scripts/publish-loop.test.mjs`.
- Chỉ báo "đã đăng live" khi CI xanh VÀ URL live trả nội dung mới. Push thành công không đồng nghĩa đã live.
