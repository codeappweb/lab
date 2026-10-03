# codeappweb/lab — Hướng dẫn vận hành cho Mistral

Jekyll site, GitHub Pages, baseurl `/lab`, live: <https://codeappweb.github.io/lab/>.

Mô hình: 3 writer Mistral (phiên đăng nhập hiện có) viết bài song song lên 3 nhánh staging riêng. Một COORDINATOR duy nhất trong GitHub Actions (`production.yml`) gom, QA, xuất bản MỘT commit main mỗi chu kỳ và deploy Pages MỘT lần bằng artifact đã validate (`actions/deploy-pages`). Không dùng MISTRAL_API_KEY hay API sinh bài trả phí. Writer KHÔNG BAO GIỜ push prose lên main.

## Kiến trúc (bắt buộc)

```
COORDINATOR (production.yml, buoc cycle allocate)  →  next-pair --allocate
   →  data/factory-cycle.json + data/writer-assignments.json (cycle_id + base_sha + plan BAT BIEN
      + slice row dữ liệu đầy đủ cho từng writer, 1 commit main, message cycle(allocate))
writer-1 / writer-2 / writer-3  →  next-pair --writer writer-K (đọc đúng slice của mình từ
   data/writer-assignments.json — writer KHÔNG đọc article-manifest.jsonl)
   |            |            |      viết _posts/*.md + factory metadata, push staging/writer-K
staging/writer-1..3  →  COORDINATOR (production.yml, singleton, không cancel):
   chờ đủ output (theo plan, có timeout) → collect → integrate-guard
   → derive MỘT LẦN + 6 gate nhẹ + Jekyll build blocking (hard fail theo build_fail_seconds)
   → MỘT commit main (posts + derived + telemetry + cycle + checkpoint)
   → MỘT Pages deployment (upload artifact _site đã validate → deploy-pages → verify URL live)
   → finalize cycle → reset staging (force-with-lease theo sha đã snapshot)
```

- Mỗi chu kỳ: 3 writer × `writer_chunk_size` (6) bài = 12–18 bài mỗi chu kỳ, MÔT commit xuất bản, MÔT Pages deployment. Coordinator tự allocate chu kỳ tiếp ngay sau khi publish.
- Cycle là bat bien: cả 3 writer trong cùng chu kỳ đọc cùng một `base_sha` (plan commit trên main). Không writer nào tự tính từ HEAD mới.
- Bài sai cycle/base_sha/slice → REVIEW (ghi checkpoint review_queue), không bao giờ lên main.
- Crash-safe: `data/factory-cycle.json` ghi phase (allocated → collecting → guarded → integrating → building → publishing → deploying → resetting → complete). Coordinator resume đúng cycle đang mở, không tạo cycle mới đè lên cycle recoverable. Bài đã tích hợp giống hệt main được skip idempotent.
- Production stop: 2 run coordinator fail liên tiếp (`data/coordinator-state.json`) → factory từ chối chạy cho đến khi đã sửa nguyên nhân và reset ledger.
- Pages: deploy bằng Actions từ artifact đã validate. Yêu cầu Settings → Pages → Source = GitHub Actions (một lần, thủ công). Không dựa vào Pages build tự động từ push main.

## Vòng lặp writer (mỗi chu kỳ)

1. FETCH fresh main. COORDINATOR tự allocate đầu chu kỳ (bước cycle allocate trong `production.yml`): commit `data/factory-cycle.json` + `data/writer-assignments.json` (slice row đầy đủ cho từng writer) lên main, message `cycle(allocate): <cycle_id>`. Writer KHÔNG chạy `--allocate`, KHÔNG đọc `article-manifest.jsonl`.
2. `node scripts/next-pair.mjs --writer writer-K` — in đúng slice của bạn đọc từ `data/writer-assignments.json` + 3 dòng front matter bắt buộc (`factory_writer`, `factory_cycle`, `factory_base_sha`).
3. WRITE bài vào `_posts/YYYY-MM-DD-<slug>.md` theo `docs/SCHEMA-ARTICLE.md`, kèm factory metadata.
4. PUSH NGAY lên `staging/writer-K` (chỉ file bài). Không gom nhiều bài local, không chạy derived/QA thủ công, không đụng manifest/checkpoint/sitemap/scripts.
5. COORDINATOR tự kích hoạt khi writer push staging; nó chờ đủ cả 3 writer (hoặc timeout rồi xử lý partial). Theo dõi run xanh; chu kỳ hoàn tất khi: MÔT commit main, MÔT Pages deploy, URL live trả nội dung mới, staging được reset.
6. Bài lỗi nội dung: không push; ghi lý do REVIEW vào review_queue của checkpoint (hoặc để coordinator tự đưa vào review khi guard từ chối), viết bài khác trong slice.
7. REPAIR bài đã live: sửa đúng file `_posts/` rồi đẩy lại lên `staging/writer-K`; không đổi URL đã live.
8. Hết phiên: ghi checkpoint theo thực tế (không tự tuyên bố published nếu main chưa chứa bài).

## Trạng thái manifest

`planned → drafting → review → published`. `skip` để bỏ một bài. Không dùng trạng thái khác. Bài đã live giữ nguyên URL (`permalink: /:title/`).

## QA nhẹ — chặn publish (chạy MỘT LẦN mỗi chu kỳ trong coordinator, không theo từng writer)

1. Front matter hợp lệ, đủ trường theo `docs/SCHEMA-ARTICLE.md` (+ factory metadata đúng cycle).
2. Không trùng slug/manifest_id; không ghi đè bài đã đăng.
3. Link nội bộ trỏ tới URL tồn tại (`scripts/check-links.mjs`).
4. Jekyll build thành công trong ngưỡng `build_fail_seconds`; URL xuất bản tồn tại trong `_site` + sitemap (`scripts/validate-built.mjs`).
5. `_site` không vượt `site_size_fail_mb`.
6. Không commit secrets, cache, file test, dữ liệu ngoài phạm vi.

Gate: `validate-content.mjs`, `validate-content-quality.mjs`, `detect-duplicates.mjs`, `check-links.mjs`, `validate-sitemap.mjs`, `sync-manifest.mjs --dry-run`. Hot path của một chu kỳ KHÔNG chạy full-site audit, không build Jekyll ba lần, không regenerate sitemap ba lần. Regression tests engine (`node --test scripts/*.test.mjs`) chỉ chạy khi `scripts/**` hoặc `.github/workflows/**` đổi. Full audit sâu chỉ qua workflow_dispatch của `ci.yml`.

## WARNING — không chặn publish

Similarity token giữa topic, title gần giống, cannibalization, số từ/H2/FAQ/internal links, SEO score, orphan/cluster. Các cảnh báo này chỉ để audit sau.

## Tự động bổ sung queue (auto-refill allocator)

`scripts/queue-refill.mjs` chạy trong coordinator (production.yml, bước 0c — sau reconcile, trước check-stop; và trong maintenance job), nơi đã là singleton queue toàn cục nên luôn chỉ MỘT process refill tại một thời điểm (không race). Khi số planned rows trong `data/article-manifest.jsonl` giảm dưới `queue_refill.low_threshold` (mặc định 100, cấu hình tại `data/factory-config.json`), allocator append planned rows từ ngân hàng đề mục đã duyệt `data/queue-templates.json` (tuân Master Matrix/cluster-map, đúng taxonomy, budget từng cluster) cho đến khoảng `queue_refill.target` (mặc định 300).

Mỗi ứng viên được dedup chống TOÀN BỘ manifest trước khi nhận: trùng id/slug, trùng topic (chuẩn hóa + Jaccard >= 0.6), trùng cặp entities + intent + cluster (chống cannibalization), vượt budget cluster. Phép append là transactional: verify mọi dòng parse được, prefix lịch sử byte-identical, không trùng id/slug, status hợp lệ — lỗi bất kỳ thì KHÔNG ghi manifest (fail-closed). Writer KHÔNG bao giờ tự sinh manifest row — chỉ allocator tạo planned rows.

Log mỗi lần chạy: `reports/queue-refill-latest.json` (chi tiết kèm danh sách row mới) và `data/queue-refill-log.jsonl` (một dòng tóm tắt mỗi run: before/threshold/target/candidates/rejected/appended/after/result). Cơ chế cấp phát thủ công cũ (`diagnostics/allocate-rows.json`) vẫn dùng được như công cụ quản trị tùy chọn, không còn bắt buộc.

## Chỉ mục nội dung SQLite (content-index.sqlite) — QA không quét lại bài cũ

`data/content-index.sqlite` là DERIVED CACHE ONLY (gitignored, KHÔNG commit; persist qua actions/cache của coordinator) — source of truth vẫn là `data/article-manifest.jsonl` + file nội dung (`_posts/**`, `danh-muc/**`, `hub/**`, trang tĩnh gốc). Mỗi row: id, slug, path, kind, tiêu đề chuẩn hóa, intent, entities, cluster, content_hash (sha256), size, permalink, cờ eligible, qa_status (pending/passed), qa_at, published_at. Yêu cầu Node >= 23.4 (node:sqlite).

- CHỈ COORDINATOR được ghi/rebuild SQLite (`--build`, `--update`, `--qa-pass`). Mỗi chu kỳ coordinator restore cache (actions/cache) rồi chạy `--update` incremental: chỉ đọc file mới/thay đổi theo git status; hash không đổi → giữ qa_status; DB thiếu/hỏng/schema lệch → REBUILD an toàn từ manifest + content (mọi row pending → chu kỳ đó chạy FULL QA, fail-closed). Sau khi TẤT CẢ gate + Jekyll build xanh: `--qa-pass` đánh dấu pending → passed.
- 3 WRITER READ-ONLY với cache: các gate scoped đọc qua `scripts/content-index-lib.mjs` (mở SQLite `readOnly`, writer KHÔNG THỂ mutate). Bốn gate (`validate-content`, `validate-content-quality`, `check-links`, `validate-sitemap`) chạy scoped `--only`: deep-check đúng bài mới/sửa; bài cũ chỉ được tin khi index row qa_status=passed — writer/QA KHÔNG đọc lại hàng nghìn bài cũ mỗi chu kỳ.
- Duplicate/cannibalization vẫn đối chiếu toàn bộ qua manifest in-memory (`detect-duplicates.mjs`, `queue-refill.mjs` — vốn đã nhẹ, không đọc file bài). check-links/validate-sitemap lấy slug/permalink/eligible từ index thay vì đọc front matter mọi bài.
- Full audit (đọc lại toàn bộ) vẫn chạy khi: cache bị rebuild (cold), có row pending ngoài scope, mỗi `content_index.full_audit_every_published` bài published mới (mặc định 500) — và qua CI/workflow_dispatch như cũ.
- File cũ bị sửa được phát hiện qua git status/content_hash → chỉ đúng file đó được QA lại. Scoped mà cache thiếu row/hỏng → gate LỖI (fail-closed), không suy đoán.
## Nội quy

- Không bịa giá, thông số kỹ thuật, luật, trải nghiệm, nguồn dẫn. Bài có khẳng định pháp lý/an toàn chưa kiểm chứng giữ `review` hoặc bỏ khẳng định.
- Không yêu cầu viết dài để đủ quota. Không scale batch để chạy quota: giữ `writer_chunk_size = 6` (12–18 bài mỗi chu kỳ là thiết kế cố định).
- Menu/taxonomy/hub/danh-mục/giao diện/baseurl giữ nguyên. Số liệu pháp lý đối chiếu `data/legal-sources.yml`.
- Soak test: trước khi chạy liên tục không giám sát, yêu cầu 5 chu kỳ 3×6 liên tiếp xanh, không sửa tay.

## Lệnh chính mỗi chu kỳ (writer-K)

```bash
git fetch origin && git reset --hard origin/main
# đầu chu kỳ: COORDINATOR (production.yml) tự allocate + commit
#   data/factory-cycle.json + data/writer-assignments.json lên main — writer KHÔNG chạy --allocate.
# mỗi writer (chỉ đọc slice của mình từ data/writer-assignments.json, KHÔNG đọc manifest):
node scripts/next-pair.mjs --writer writer-K
# WRITE bài (kèm factory_writer/factory_cycle/factory_base_sha) rồi:
git push origin HEAD:staging/writer-K
# coordinator (production.yml) tự hoàn tất: QA → 1 commit main → 1 Pages deploy → reset staging.
```
