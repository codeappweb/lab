# STAGED 3-WRITER PRODUCTION — tài liệu vận hành

Nguồn chuẩn của production cho codeappweb/lab. Mô hình: 3 writer song song viết bài lên nhánh staging riêng, một coordinator duy nhất trong Actions gom, kiểm QA, và xuất bản MỘT commit main mỗi chu kỳ. Tất định, không AI, không cron, không force-push main.

## Kiến trúc

```
writer-1  writer-2  writer-3   (slice deterministic, không chồng lấn)
   |         |         |
staging/writer-1..3            (writer chỉ đẩy _posts/*.md lên nhánh riêng)
   \         |         /
    single COORDINATOR (production.yml, singleton queue toàn cục)
         collect -> guard -> scoped QA
         integrate -> derive MỘT LẦN
         -> validation toàn cục (6 gate + Jekyll build blocking)
         -> MỘT commit main (posts + derived + telemetry)
         -> reset staging (force-with-lease)
         -> MỘT Pages deploy
```

Writer KHÔNG bao giờ đẩy prose trực tiếp lên main. Prose chưa qua QA không tồn tại trên main.

## Cấu hình

Data file `data/factory-config.json`:

- `writers` (3), `writer_chunk_size` (2): mỗi writer viết tối đa 2 bài mỗi chu kỳ.
- `integration_max_new_posts` (6): giới hạn tổng bài mới mỗi chu kỳ tích hợp.
- `hard_max_new_posts_per_push` (50): hard invariant của publish transaction.
- `scale_checkpoints`: mốc 100/500/1000/2500/5000/10000/15000/20000 bài — telemetry đo build time và kích thước site khi published count vượt mỗi mốc.
- `telemetry`: ngưỡng cảnh báo — site trên 700MB cảnh báo, trên 900MB từ chối xuất bản; build trên 2400s cảnh báo; quá 12 commit main/giờ cảnh báo tần suất deploy.

## Vòng lặp (bắt buộc)

```
FETCH FRESH MAIN
→ NEXT-PAIR: node scripts/next-pair.mjs --writer writer-K   (slice i % 3 == K-1)
→ WRITE 2 bài vào _posts/2026-10-02-<slug>.md theo docs/SCHEMA-ARTICLE.md
→ PUSH NGAY lên staging/writer-K (chỉ file bài)
→ COORDINATOR tự kích hoạt (singleton, xếp hàng, không hủy chạy trước):
   settle 30s → collect-staging (snapshot 3 nhánh + shas)
   → integrate-guard (chỉ nhận _posts/*.md, ≤2 bài/writer, ≤6 bài/chu kỳ,
     không trùng slug giữa writer, không reassign slug đã published;
     bài đã tích hợp y hệt được bỏ qua — idempotent)
   → apply-staging → derive repository truth MỘT LẦN → 6 gate nhẹ
   → Jekyll build blocking + validate-built → telemetry (đo thực tế)
   → MỘT commit main: posts + derived allowlist + production-telemetry
   → reset staging về main (force-with-lease theo sha đã snapshot)
   → MỘT Pages deploy
→ FETCH FRESH MAIN → 2 bài kế trong slice → REPEAT
```

## Writer contract

1. Luôn FETCH FRESH MAIN trước khi viết.
2. Exact IDs: `node scripts/next-pair.mjs --writer writer-K` — repository truth, slice định sẵn, không hard-code ID.
3. Writer CHỈ tạo/sửa file `_posts/YYYY-MM-DD-<slug>.md`. KHÔNG bao giờ cham: manifest, progress, checkpoint, sitemap, index, telemetry, state production.
4. Push nhánh `staging/writer-K` (không phải main). Không gom nhiều chu kỳ trong một push local.
5. Không force-push staging sau khi coordinator đã reset (fetch lại trước khi viết tiếp).
6. Bài lỗi nội dung: không push; ghi lý do vào review_queue của checkpoint; chuyển sang bài kế trong slice.
7. REPAIR bài đã live: sửa đúng file `_posts/` rồi đẩy lại lên `staging/writer-K` — guard phân loại NEW/REPAIR, coordinator derive + gate lại; KHÔNG đổi URL đã live.

## Coordinator (production.yml)

- Trigger: push vào `staging/writer-*` và workflow_dispatch. Concurrency `production-coordinator`, không cancel-in-progress: mọi chạy xếp hàng tuần tự, không bao giờ hai transaction tích hợp song song.
- Guard từ chối (fail closed, không commit gì): file ngoài `_posts/*.md`; quá `writer_chunk_size` bài trên một writer; quá `integration_max_new_posts` bài một chu kỳ; trùng slug giữa các writer; slug đã published mà nội dung khác (published row không bao giờ bị reassign — bài y hệt trên main được bỏ qua như đã tích hợp).
- Transaction: derive → 6 gate nhẹ → Jekyll build blocking + validate-built → đo telemetry → `git add` TƯỜNG MINH (posts + derived allowlist + telemetry) → MỘT commit → push rebase + revalidate (không force-push main).
- Reset staging: `git push --force-with-lease` với sha đã snapshot — chỉ tác động nhánh staging, không bao giờ đè push mới của writer (lease fail = dừng, chu kỳ sau xử lý idempotent).
- Chu kỳ rỗng (staging không có bài mới): noop, exit 0, không commit, không deploy.

## Telemetry và scale

Mỗi chu kỳ xuất bản ghi MỘT dòng vào `data/production-telemetry.jsonl` (derived allowlist): timestamp, số bài published, kích thước repo, kích thước `_site`, số file sinh ra, số URL sitemap, thời gian QA, thời gian build Jekyll, thời gian production, số commit main giờ vừa qua; `pages_deploy_duration_s` để null khi không đo được. Vượt ngưỡng: cảnh báo qua annotation; site quá `site_size_fail_mb` → từ chối xuất bản (fail closed trước commit). KHÔNG có số liệu bịa — mọi giá trị đọc từ run thực.

## Hot path vs deep audit

Chu kỳ bài: 0 run CI (ci.yml chỉ chạy khi đổi engine/workflow hoặc PR), 1 run coordinator, 1 Pages deploy. Regression tests chỉ chạy khi `scripts/**`/workflow đổi. Full legal/site audit chỉ qua workflow_dispatch thủ công trên ci.yml.

## Khôi phục sau sự cố

Phiên bị reset: fetch fresh main, xem `data/production-telemetry.jsonl` + manifest + staging branches. Trạng thái mỗi row suy ra được: `published` (row manifest), staged (file trên staging chưa có trên main), planned (chưa ai viết), review (review_queue checkpoint). Crash trước commit main: staging còn nguyên, chạy coordinator lại (push hoặc dispatch) — guard áp lại phần còn thiếu, không trùng. Crash sau commit trước reset: chu kỳ sau guard nhận diện "đã tích hợp y hệt", skip và reset staging. Không bao giờ có hai transaction tích hợp chủ động (singleton).

## Checkpoint

`data/writer-checkpoint.json` là state riêng của phiên writer (active_article, last_published, review_queue). Sau mỗi chu kỳ đã deploy: fetch fresh main, cập nhật theo thực tế remote. Manifest > checkpoint khi xung đột. KHÔNG ghi `deploy_verified` khi chưa GET URL live.

## Fixture

`scripts/publish-loop.test.mjs` kiểm chứng chế độ legacy (T1–T11, không đổi): giao dịch 1 bài, bài lỗi không công khai, restart không trùng, claim trùng/out-of-scope bị từ chối, gate lỗi không exit 0, transaction chỉ ghi derived allowlist, `--check` đỏ khi derived chưa commit, hai lượt liên tiếp + resume. Chế độ `--integrate` là chế độ production mới của coordinator trên main thật.
