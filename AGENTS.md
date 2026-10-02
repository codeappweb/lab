# AGENTS.md — Hợp đồng thực thi cho AI agent (codeappweb/lab)

Ràng buộc bắt buộc với mọi AI agent làm việc trên repo này. Xung đột: repository truth thắng tài liệu; README.md là chuẩn vận hành; chi tiết vòng lặp ở `docs/MICRO-LOOP.md`.

## Nguyên tắc bất biến

- REPOSITORY TRUTH > MEMORY. Đọc repo trước khi làm; không tin trí nhớ hội thoại thay file.
- Không restart factory, không reset/sinh lại matrix khi đã có tiến độ.
- Không viết lại bài PUBLISHED, không claim lại row PUBLISHED.
- Không force-push. KHÔNG force-push main. Không bypass branch protection. Reset staging chỉ qua coordinator (force-with-lease theo sha đã snapshot).
- Writer KHÔNG BAO GIỜ push prose lên main. Mọi bài đi qua staging/writer-K và coordinator.
- Không weaken QA, không tắt test, không `|| true` để lấy kết quả xanh (trừ các bước ledger best-effort được ghi chú rõ trong workflow).
- Test không bao giờ mutate production state (fixture dùng `LAB_ROOT` trỏ thư mục tạm).
- Actions không AI, không API sinh bài, không cron; chỉ dữ liệu tất định. Actions CHỈ commit derived allowlist + cycle/checkpoint state trong publish transaction sau khi mọi gate xanh.
- MỘT commit xuất bản + MÔT Pages deployment mỗi chu kỳ; deploy từ artifact `_site` đã validate (`actions/deploy-pages`), không dựa Pages build tự động từ push main.

## Vòng lặp 3-writer staged coordinator (bắt buộc mỗi phiên)

FETCH fresh main → (đầu chu kỳ) `node scripts/next-pair.mjs --allocate` + commit `data/factory-cycle.json` lên main (MỘT lần mỗi chu kỳ) → mỗi writer `node scripts/next-pair.mjs --writer writer-K` (đọc đúng plan bat bien: cycle_id + base_sha) → WRITE bài kèm `factory_writer`/`factory_cycle`/`factory_base_sha` theo `docs/SCHEMA-ARTICLE.md` → PUSH NGAY lên `staging/writer-K` (chỉ file bài) → COORDINATOR (`production.yml`, singleton): chờ đủ output theo plan (timeout rõ ràng, partial-safe) → collect → integrate-guard (cycle/slug/manifest_id/slice; sai origin → REVIEW) → apply → derive + 6 gate + Jekyll build blocking (hard fail) → MÔT commit main → MÔT deploy-pages + verify URL live → finalize cycle → reset staging force-with-lease.

- Một chu kỳ xanh là checkpoint, không phải điểm dừng. Không hỏi lại sau mỗi chu kỳ.
- Không gom nhiều bài local; không chạy derived/QA thủ công khi factory đã làm tất định.
- Không tạo cycle mới khi còn cycle chưa complete/failed (allocate tự từ chối).
- Bài sai cycle/base_sha/slice hoặc thiếu factory metadata: coordinator đưa vào review_queue — không push lại y hệt; sửa bài hoặc đợi cycle đúng.
- Bài lỗi nội dung: ghi REVIEW lý do vào review_queue, chuyển bài kế trong slice; không chặn hàng đợi.
- Lỗi hạ tầng (build/deploy/repo) ảnh hưởng mọi bài: dừng để sửa. 2 run coordinator fail liên tiếp → factory tự STOP (`data/coordinator-state.json`); sửa nguyên nhân xong mới reset ledger.
- Khi dừng: ghi checkpoint (cycle_id, bài, bước, commit đã push, trạng thái deploy) và bước cần resume. Phiên mới: fetch fresh main → `cycle-phase --resume`/`next-pair --writer` → tiếp tục; không dựa state workspace cũ.

## Phân vai

- Writer (Mistral session ×3): viết prose đúng slice của cycle, push `_posts/*.md` lên staging/writer-K, không đụng state chia sẻ (manifest, checkpoint, sitemap, scripts, workflows).
- Actions `production.yml`: coordinator — collect, guard, QA, MÔT commit xuất bản, MÔT deploy-pages, verify live, finalize cycle, reset staging. Idempotent, crash-safe, không AI, không cron.
- Actions `ci.yml`: gate + build khi PR hoặc push main đổi engine/workflow (scripts/**, .github/workflows/**, Gemfile, config, taxonomy, factory-config); regression tests engine; full audit sâu chỉ qua workflow_dispatch.
- Pages: deploy duy nhất qua `deploy-pages` từ artifact đã validate (Settings → Pages → Source = GitHub Actions).

## Verify

- Content-only (một chu kỳ): scoped QA trong `production.yml` trên đúng HEAD main; check-links đối chiếu dữ liệu toàn repo chống trùng; không chạy full-site audit/soak/regression tests cho từng chu kỳ.
- Engine/workflow change: full gates — `node --check` mọi script, `node --test scripts/*.test.mjs`, các gate nhẹ, Jekyll build, fixture `scripts/publish-loop.test.mjs`.
- Chỉ báo "đã đăng live" khi deploy-pages xanh VÀ URL live trả nội dung mới. Push thành công không đồng nghĩa đã live.
- Smoke test sau mọi thay đổi engine: NO-OP → 1×1 → 3×1 → 3×2; soak 5 chu kỳ 3×2 liên tiếp xanh trước khi chạy liên tục không giám sát.
