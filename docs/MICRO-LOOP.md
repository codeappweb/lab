# STAGED 3-WRITER PRODUCTION — tài liệu vận hành

Nguồn chuẩn của production cho codeappweb/lab. Mô hình: một cycle plan bất biến được commit trên main, 3 writer song song viết bài theo slice của riêng mình lên nhánh staging, một coordinator duy nhất trong Actions gom, kiểm QA, và xuất bản MỘT commit main mỗi chu kỳ + MỘT Pages deploy tường minh. Tất định, không AI, không cron, không force-push main.

## Kiến trúc

```
COORDINATOR: next-pair --allocate → data/factory-cycle.json (cycle_id, base_sha, assignments)
   → commit MỘT LẦN trên main (plan bất biến cho cả chu kỳ)
writer-1  writer-2  writer-3   (cùng đọc MỘT plan tại base_sha)
   |         |         |
staging/writer-1..3            (writer chỉ đẩy _posts/*.md lên nhánh riêng)
   \         |         /
    single COORDINATOR (production.yml, singleton queue toàn cục)
         collect (--wait-for: chờ đủ 3 writer hoặc timeout 10 phút)
         → integrate-guard (cycle verify: factory_writer/factory_cycle/factory_base_sha,
           manifest_id đúng slice, không trùng slug/ID; lệch cycle → REVIEW)
         → apply-staging → scoped QA per-writer
         → derive MỘT LẦN + validation toàn cục (6 gate + Jekyll build blocking)
         → MỘT commit main (posts + derived + telemetry + cycle + checkpoint)
         → upload _site artifact → actions/deploy-pages (MỘT deploy)
         → verify live URL → cycle-phase --complete (finalize commit)
         → reset staging (force-with-lease)
```

Writer KHÔNG bao giờ đẩy prose trực tiếp lên main. Prose chưa qua QA không tồn tại trên main.

## Cycle bất biến (immutable assignment)

- Coordinator chạy `node scripts/next-pair.mjs --allocate` tạo `data/factory-cycle.json`: `cycle_id`, `base_sha` (sha main khi allocate), `assignments` cho từng writer. File được commit lên main MỘT LẦN mỗi chu kỳ.
- Cả 3 writer dùng đúng plan đó: `node scripts/next-pair.mjs --writer writer-K` đọc assignment từ cycle hiện tại (không tự dời HEAD). `--base-sha` để đối chiếu thêm.
- KHÔNG allocate cycle mới khi cycle trước chưa `complete` (phase `allocated/collecting/.../failed` đều là active → coordinator phải `--resume` hoặc xử lý xong).
- Writer lệch cycle/plan: integrate-guard đẩy bài vào `review_queue` (REVIEW), không tích hợp.

## Cấu hình

Data file `data/factory-config.json`:

- `writers` (3), `writer_chunk_size` (2): mỗi writer viết tối đa 2 bài mỗi chu kỳ.
- `integration_max_new_posts` (6): giới hạn tổng bài mới mỗi chu kỳ tích hợp.
- `hard_max_new_posts_per_push` (50): hard invariant của publish transaction.
- `writer_wait_timeout_minutes` (10): coordinator chờ đủ 3 writer tối đa 10 phút, sau đó proceeds với partial-success + cảnh báo.
- `staging_age_warn_minutes` (30): staging cũ hơn 30 phút → cảnh báo.
- `telemetry`: `site_size_warn_mb` 700 / `site_size_fail_mb` 900; `build_warn_seconds` 360 / `build_fail_seconds` 540 (Jekyll build quá 540 giây → refuse xuất bản); `deploy_frequency_warn_per_hour` 8; `consecutive_failure_stop` 2 (2 lần coordinator fail liên tiếp → stop continuous production, cần can thiệp thủ công).
- `scale_checkpoints`: mốc 100/500/1000/2500/5000/10000/15000/20000 bài — telemetry đo build time và kích thước site khi published count vượt mỗi mốc. Build p95 tới gần 6 phút → tạm dừng scale-up và tối ưu trước khi tiếp tục.

## Vòng lặp (bắt buộc)

```
FETCH FRESH MAIN
→ (coordinator) ALLOCATE: next-pair --allocate → commit plan lên main
→ (mỗi writer) FETCH FRESH MAIN
→ NEXT-PAIR theo plan: node scripts/next-pair.mjs --writer writer-K
→ WRITE ≤2 bài vào _posts/2026-10-02-<slug>.md theo docs/SCHEMA-ARTICLE.md
   (front matter thêm factory_writer, factory_cycle, factory_base_sha)
→ PUSH NGAY lên staging/writer-K (chỉ file bài)
→ COORDINATOR (push _posts lên staging / workflow_dispatch, singleton, xếp hàng):
   check-stop (consecutive_failures ≥2 → dừng)
   → cycle-phase --resume (phase từ cycle file, không tạo cycle mới khi đang dở)
   → collect-staging --wait-for writer-1,writer-2,writer-3 --timeout 600
   → integrate-guard (cycle verify + contamination + duplicate slug/ID)
   → scoped QA per-writer → apply-staging → derive MỘT LẦN → 6 gate nhẹ
   → Jekyll build blocking (quá build_fail_seconds → fail closed)
   → MỘT commit main: posts + derived allowlist + telemetry + cycle + checkpoint
   → actions/configure-pages → upload-pages-artifact (_site đã validate)
   → actions/deploy-pages (MỘT deploy cho MỘT publication)
   → verify live URL → cycle-phase --complete → reset staging (force-with-lease)
→ FETCH FRESH MAIN → chu kỳ kế → REPEAT
```

Chính sách chờ: coordinator kết thúc collect khi đủ output của tất cả writer được phân trong cycle, HOẶC hết `writer_wait_timeout_minutes`. Writer fail/timeout: bài hợp lệ của writer khác vẫn được tích hợp theo chính sách partial-success; assignment thiếu → REVIEW/RETRY ở chu kỳ sau, không tự tạo assignment trùng.

## Writer contract

1. Luôn FETCH FRESH MAIN trước khi viết. ID lấy từ cycle plan hiện tại, không tự tính modulo theo HEAD.
2. Exact IDs: `node scripts/next-pair.mjs --writer writer-K` — repository truth, slice định sẵn trong plan, không hard-code ID.
3. Writer CHỈ tạo/sửa file `_posts/YYYY-MM-DD-<slug>.md`. KHÔNG bao giờ cham: manifest, progress, checkpoint, sitemap, index, telemetry, cycle, state production.
4. Push nhánh `staging/writer-K` (không phải main). Không gom nhiều chu kỳ trong một push local.
5. Không force-push staging sau khi coordinator đã reset (fetch lại trước khi viết tiếp).
6. Bài lỗi nội dung: không push; ghi lý do vào review_queue của checkpoint; chuyển sang bài kế trong slice.
7. REPAIR bài đã live: sửa đúng file `_posts/` rồi đẩy lại lên `staging/writer-K` — guard phân loại NEW/REPAIR, coordinator derive + gate lại; KHÔNG đổi URL đã live.

## Coordinator (production.yml)

- Trigger: push vào `staging/writer-*` CHỈ KHI có file `_posts/**` thay đổi (paths filter — push đồng bộ engine/docs lên staging KHÔNG kích hoạt chu kỳ publication), và workflow_dispatch (kèm input `maintenance`, xem Runbook maintenance).
- Concurrency `production-coordinator`, không cancel-in-progress: mọi chạy xếp hàng tuần tự, không bao giờ hai transaction tích hợp song song.
- Permissions: `contents: write`, `pages: write`, `id-token: write`. Timeout 45 phút.
- KHÔNG dùng `environment:` ở job level: environment `github-pages` (tạo bởi Pages branch mode) có branch protection chỉ cho phép main — mọi run từ staging/writer-* bị từ chối ngay cả khi noop. `deploy-pages` tự quản lý deployment.
- Guard từ chối (fail closed, không commit gì): file ngoài `_posts/*.md`; quá `writer_chunk_size` bài trên một writer; quá `integration_max_new_posts` bài một chu kỳ; trùng slug giữa các writer; trùng manifest_id; slug đã published mà nội dung khác (bài y hệt trên main được bỏ qua idempotent); bài lệch cycle (writer/cycle/base_sha không khớp, manifest_id ngoài slice) → REVIEW không tích hợp; trùng manifest_id giữa các file staged → REFUSE.
- Transaction: derive → 6 gate nhẹ → Jekyll build blocking + validate-built → đo telemetry → `git add` TƯỜNG MINH (posts + derived allowlist + telemetry + cycle/checkpoint/coordinator-state) → MỘT commit (publication commit) → cycle-phase --publishing (chỉ ghi khi sha đã có trên origin/main) → push rebase + revalidate (không force-push main).
- Pages deploy tường minh: deploy đúng artifact `_site` đã validate, đúng MỘT lần cho một publication. KHÔNG dựa vào Pages workflow tự kích hoạt sau push main.
- Finalize: sau deploy + verify live URL, MỘT commit nhỏ ghi cycle `complete` + deployment id + live_verified (bookkeeping, không chạm content). Hai commit này là MỘT publication transaction về nội dung.
- Reset staging: `git push --force-with-lease` với sha đã snapshot — chỉ tác động nhánh staging, không bao giờ đè push mới của writer (lease fail = dừng, chu kỳ sau xử lý idempotent).
- Chu kỳ rỗng (staging không có bài mới): noop, exit 0, không commit, không deploy.
- Crash recovery: mọi phase idempotent (`scripts/cycle-phase.mjs --resume`). Crash trước commit main → chạy lại, guard áp phần còn thiếu. Crash sau commit trước deploy → chạy lại, deploy artifact của publication SHA đã có. Crash sau deploy trước finalize/reset → chạy lại, complete + reset idempotent. Không bao giờ tạo cycle mới khi cycle trước chưa hoàn tất.

## Runbook maintenance (derived drift)

Dispatch thủ công MỘT LẦN khi manifest/progress/sitemap bị drift so với repository truth (ví dụ: bài đã live nhưng manifest row vẫn `planned`, CI gate "Manifest đồng bộ repo" đỏ):

1. Actions → Production (coordinator) → Run workflow → chọn branch `main`, tick `maintenance` = true → Run.
2. Job `maintenance` chạy `node scripts/publish-loop.mjs --integrate --added "" --repaired ""`: sync-manifest (write, planned→published theo post trên main), gen-sitemap, 6 gate, Jekyll build blocking, telemetry, ledger reset — commit CHI derived allowlist (manifest, progress, sitemap shards, telemetry, checkpoint/coordinator-state), MỘT commit lên main.
3. KHÔNG publish bài mới, KHÔNG deploy Pages, KHÔNG chạm cycle/staging.
4. Sau maintenance commit: CI gate manifest dry-run sẽ xanh ở lần CI kế tiếp đổi engine. Data files không nằm trong paths trigger của ci.yml nên maintenance commit tự nó không chạy CI.

## Telemetry và scale

Mỗi chu kỳ xuất bản ghi MỘT dòng vào `data/production-telemetry.jsonl` (derived allowlist): timestamp, số bài published, kích thước repo, kích thước `_site`, số file sinh ra, số URL sitemap, thời gian QA, thời gian build Jekyll (đo thực tế), thời gian production, số commit main giờ vừa qua, `pages_deploy_duration_s` (null khi không đo được). Vượt ngưỡng: cảnh báo qua annotation; site quá `site_size_fail_mb` → từ chối xuất bản (fail closed trước commit). KHÔNG có số liệu bịa — mọi giá trị đọc từ run thực.

Duplicate work đã loại khỏi hot path: mỗi writer chỉ chạy article structure/front matter/ID/slug/link-format check cục bộ; duplicate ID/slug scan, contamination, integration guard, derive, sitemap, internal link validation, Jekyll build và Pages artifact chạy MỘT LẦN per coordinator publication. KHÔNG ba lần build Jekyll cho ba writer.

## Hot path vs deep audit

Chu kỳ bài: 0 run CI (ci.yml chỉ chạy khi đổi engine/workflow hoặc PR), 1 run coordinator, 1 Pages deploy. Regression tests chỉ chạy khi `scripts/**`/workflow đổi. Full legal/site audit chỉ qua workflow_dispatch thủ công trên ci.yml.

## Khôi phục sau sự cố

Phiên bị reset: fetch fresh main, xem `data/production-telemetry.jsonl` + manifest + `data/factory-cycle.json` + staging branches. Trạng thái mỗi row suy ra được: `published` (row manifest), staged, planned, review (review_queue checkpoint). Coordinator fail ghi `consecutive_failures` vào `data/coordinator-state.json`; 2 lần liên tiếp → production stop (check-stop exit 1) cho tới khi sửa nguyên nhân và reset ledger thủ công qua commit publication kế tiếp. Không bao giờ có hai transaction tích hợp chủ động (singleton).

## Checkpoint

`data/writer-checkpoint.json` (schema_version 2, loop `staged-3-writer-coordinator`) mô tả đúng kiến trúc 3 writer: `cycle_id`, `base_sha`, trạng thái, staging snapshot từng writer, `last_publication` (main_sha, ids, pages_deployment_id, live_verified) và `review_queue`. Giá trị được DERIVE từ repository thật trong commit publication — KHÔNG bao giờ thủ công claim `live_verified` khi chưa GET URL live, KHÔNG claim published khi main chưa chứa bài. Manifest > checkpoint khi xung đột.

## Fixture

`scripts/publish-loop.test.mjs` kiểm chứng chế độ legacy (T1–T11, không đổi): giao dịch 1 bài, bài lỗi không công khai, restart không trùng, claim trùng/out-of-scope bị từ chối, gate lỗi không exit 0, transaction chỉ ghi derived allowlist, `--check` đỏ khi derived chưa commit, hai lượt liên tiếp + resume. Chế độ `--integrate` là chế độ production của coordinator trên main thật.

## Yêu cầu cấu hình Pages (một lần, thủ công)

Pages phải chuyển sang Source = GitHub Actions: Settings → Pages → Build and deployment → Source → GitHub Actions. Khi còn ở chế độ branch, `actions/deploy-pages` sẽ fail → failure ledger tăng; 2 lần liên tiếp = production stop. Không dispatch chu kỳ publication thật trước khi flip.
