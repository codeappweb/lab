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
    staging-signal.yml (_posts/** push → run marker hoàn tất)
         |
    single COORDINATOR (production.yml — workflow_run, LUON chay tren MAIN,
         singleton queue toàn cục)
         reconcile (self-heal derived state, TRUOC moi allocation/noop)
         → check-stop → resume → collect (--wait-for, timeout → partial-success)
         → integrate-guard (cycle verify: factory_writer/factory_cycle/factory_base_sha,
           manifest_id đúng slice, không trùng slug/ID; lệch cycle → REVIEW)
         → apply-staging → derive MỘT LẦN + validation toàn cục (6 gate + Jekyll build blocking)
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
- `writer_wait_timeout_minutes` (10): coordinator chờ đủ 3 writer tối đa 10 phút, sau đó proceeds với partial-success + cảnh báo. Chờ chỉ là tối ưu gom (coalescing), KHÔNG phải điều kiện đúng đắn: output hợp lệ của writer kịp push luôn được publish; assignment thiếu được cấp lại chu kỳ sau, không bao giờ trùng.
- `staging_age_warn_minutes` (30): staging cũ hơn 30 phút → cảnh báo.
- `telemetry`: `site_size_warn_mb` 700 / `site_size_fail_mb` 900; `build_warn_seconds` 360 / `build_fail_seconds` 540 (Jekyll build quá 540 giây → refuse xuất bản); `deploy_frequency_warn_per_hour` 8; `consecutive_failure_stop` 2 (2 lần coordinator fail liên tiếp → stop continuous production, cần can thiệp thủ công).
- `scale_checkpoints`: mốc 100/500/1000/2500/5000/10000/15000/20000 bài — telemetry đo build time và kích thước site khi published count vượt mỗi mốc.

## Vòng lặp (bắt buộc)

```
FETCH FRESH MAIN
→ (coordinator) ALLOCATE: next-pair --allocate (TỪ CHỐI khi manifest/checkpoint
  drift — fail-closed pre-allocation guard) → commit plan lên main
→ (mỗi writer) FETCH FRESH MAIN
→ NEXT-PAIR theo plan: node scripts/next-pair.mjs --writer writer-K
→ WRITE ≤2 bài vào _posts/2026-10-02-<slug>.md theo docs/SCHEMA-ARTICLE.md
   (front matter thêm factory_writer, factory_cycle, factory_base_sha)
→ PUSH NGAY lên staging/writer-K (chỉ file bài)
→ staging-signal.yml (paths _posts/**) hoàn tất run marker
→ COORDINATOR (production.yml — workflow_run, MAIN context, singleton, xếp hàng):
   reconcile (self-heal, xem mục Tự phục hồi)
   → check-stop (consecutive_failures ≥2 → dừng)
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
3. Writer CHỈ tạo/sửa file `_posts/YYYY-MM-DD-<slug>.md`. KHÔNG bao giờ chạm: manifest, progress, checkpoint, sitemap, index, telemetry, cycle, state production.
4. Push nhánh `staging/writer-K` (không phải main). Không gom nhiều chu kỳ trong một push local.
5. Không force-push staging sau khi coordinator đã reset (fetch lại trước khi viết tiếp).
6. Bài lỗi nội dung: không push; ghi lý do vào review_queue của checkpoint; chuyển sang bài kế trong slice.
7. REPAIR bài đã live: sửa đúng file `_posts/` rồi đẩy lại lên `staging/writer-K` — guard phân loại NEW/REPAIR, coordinator derive + gate lại; KHÔNG đổi URL đã live.

## Coordinator (production.yml)

- Trigger (3 đường, tất cả MAIN context):
  1. `workflow_run`: run của `staging-signal.yml` (tên workflow phải khớp chính xác "Staging signal (writer output marker)") hoàn tất trên branch `staging/writer-1..3`, và job integrate CHỈ chạy khi `github.event.workflow_run.conclusion == 'success'` — run signal fail KHÔNG bao giờ kích hoạt publication.
  2. `push` lên main scoped đường dẫn `data/.coordinator-trigger` (file token): push thay đổi file này (nội dung không quan trọng) chạy coordinator NGAY — self-heal + integrate, không cần dispatch API. File này phải luôn đồng bộ nội dung trên cả 4 nhánh (contamination guard).
  3. `workflow_dispatch` (input `maintenance`, ref=main) — công cụ thủ công dự phòng.
- Concurrency `production-coordinator`, không cancel-in-progress: mọi chạy xếp hàng tuần tự, không bao giờ hai transaction tích hợp song song.
- Permissions: `contents: write`, `pages: write`, `id-token: write`. Timeout 45 phút.
- `environment: github-pages` (name + `url: ${{ steps.deployment.outputs.url }}`) ở job integrate: an toàn VÌ coordinator luôn chạy main context — branch protection của environment github-pages (chỉ cho phép main) được thỏa. `staging/writer-*` KHÔNG BAO GIỜ chạy deploy-pages hay vào job này.
- Guard từ chối (fail closed, không commit gì): file ngoài `_posts/*.md`; quá `writer_chunk_size` bài trên một writer; quá `integration_max_new_posts` bài một chu kỳ; trùng slug giữa các writer; trùng manifest_id; slug đã published mà nội dung khác (bài y hệt trên main được bỏ qua idempotent); bài lệch cycle (writer/cycle/base_sha không khớp, manifest_id ngoài slice) → REVIEW không tích hợp.
- Transaction: derive → 6 gate nhẹ → Jekyll build blocking + validate-built → đo telemetry → `git add` TƯỜNG MINH (posts + derived allowlist + telemetry + cycle/checkpoint/coordinator-state) → MỘT commit (publication commit) → cycle-phase --publishing (chỉ ghi khi sha đã có trên origin/main) → push rebase + revalidate (không force-push main).
- Pages deploy tường minh: deploy đúng artifact `_site` đã validate, đúng MỘT lần cho một publication. KHÔNG dựa vào Pages workflow tự kích hoạt sau push main.
- Finalize: sau deploy + verify live URL, MỘT commit nhỏ ghi cycle `complete` + deployment id + live_verified (bookkeeping, không chạm content).
- Reset staging: `git push --force-with-lease` với sha đã snapshot — chỉ tác động nhánh staging, không bao giờ đè push mới của writer (lease fail = dừng, chu kỳ sau xử lý idempotent).
- Chu kỳ rỗng (staging không có bài mới): noop, exit 0, không commit, không deploy.
- Crash recovery: mọi phase idempotent (`scripts/cycle-phase.mjs --resume`).

## Tự phục hồi derived state (self-heal)

KHÔNG còn bước maintenance thủ công bắt buộc. Ở ĐẦU MỌI coordinator run (TRƯỚC check-stop, allocation, và trước cả noop exit), bước "Reconcile derived state" chạy:

```
sync-manifest --dry-run (bằng chứng in-sync)
→ nếu drift: sync-manifest (write, planned→published theo post thật trên main)
  → gen-sitemap-shards → validate-content → validate-content-quality
  → detect-duplicates → validate-sitemap → sync-manifest --dry-run (chứng minh sạch)
→ commit CHỈ derived allowlist (manifest, progress, sitemap, shards) lên main
→ đồng bộ tiếp các file derived đó lên staging/writer-1..3 (commit FF trên tip
  staging, không force — staging chỉ được khác main trong _posts)
```

Fail-closed: drift KHÔNG thể sửa an toàn (manifest row published nhưng thiếu file post, JSONL hỏng, gate đỏ sau derive) → run FAIL, ledger tăng, KHÔNG commit. Không bao giờ tự "sửa" dữ liệu mập mời.

Hệ quả: `next-pair --allocate` không bao giờ kẹt vì drift — coordinator run kế tiếp (kể cả noop) tự heal trước khi allocation được thử lại. CI gate "Manifest đồng bộ repo (dry-run)" xanh ở lần đổi engine kế tiếp sau khi reconcile commit đã land.

Quy tắc YAML bắt buộc khi sửa production.yml: giá trị scalar KHÔNG quoted KHÔNG được chứa ": " (colon+space) — lỗi này từng làm workflow invalid → mọi trigger thành run 0-job fail (root cause của "zero-job phenomenon" các session trước). Dùng block scalar `run: |` cho mọi lệnh echo có colon.

## Telemetry và scale

Mỗi chu kỳ xuất bản ghi MỘT dòng vào `data/production-telemetry.jsonl` (derived allowlist): timestamp, số bài published, kích thước repo, kích thước `_site`, số file sinh ra, số URL sitemap, thời gian QA, thời gian build Jekyll (đo thực tế), thời gian production, số commit main giờ vừa qua, `pages_deploy_duration_s`. Vượt ngưỡng: cảnh báo qua annotation; site quá `site_size_fail_mb` → từ chối xuất bản (fail closed trước commit). KHÔNG có số liệu bịa.

Duplicate work đã loại khỏi hot path: mỗi writer chỉ chạy check cục bộ; duplicate ID/slug scan, contamination, integration guard, derive, sitemap, internal link validation, Jekyll build và Pages artifact chạy MỘT LẦN per coordinator publication.

## Hot path vs deep audit

Chu kỳ bài: 0 run CI (ci.yml chỉ chạy khi đổi engine/workflow hoặc PR), 1 run coordinator, 1 Pages deploy. Regression tests chỉ chạy khi `scripts/**`/workflow đổi. Full legal/site audit chỉ qua workflow_dispatch thủ công trên ci.yml.

## Khôi phục sau sự cố

Phiên bị reset: fetch fresh main, xem `data/production-telemetry.jsonl` + manifest + `data/factory-cycle.json` + staging branches. Trạng thái mỗi row suy ra được: `published` (row manifest), staged, planned, review (review_queue checkpoint). Coordinator fail ghi `consecutive_failures` vào `data/coordinator-state.json`; 2 lần liên tiếp → production stop (check-stop exit 1) cho tới khi sửa nguyên nhân và ledger reset bởi publication commit kế. Không bao giờ có hai transaction tích hợp chủ động (singleton).

## Checkpoint

`data/writer-checkpoint.json` (schema_version 2, loop `staged-3-writer-coordinator`): `cycle_id`, `base_sha`, trạng thái, staging snapshot từng writer, `last_publication` (main_sha, ids, pages_deployment_id, live_verified) và `review_queue`. Giá trị được DERIVE từ repository thật trong commit publication — KHÔNG bao giờ thủ công claim `live_verified` khi chưa GET URL live, KHÔNG claim published khi main chưa chứa bài. Manifest > checkpoint khi xung đột.

## Fixture

`scripts/publish-loop.test.mjs` kiểm chứng chế độ legacy (T1–T11, không đổi). Chế độ `--integrate` là chế độ production của coordinator trên main thật.

## Yêu cầu cấu hình Pages (một lần, thủ công)

Pages phải chuyển sang Source = GitHub Actions: Settings → Pages → Build and deployment → Source → GitHub Actions. Khi còn ở chế độ branch, `actions/deploy-pages` sẽ fail → failure ledger tăng; 2 lần liên tiếp = production stop. Không dispatch chu kỳ publication thật trước khi flip.

## Phân công bị đóng băng khi dữ liệu lệch (fail-closed)

`next-pair.mjs --allocate` TỪ CHỐI (exit 1) khi:
- `sync-manifest --dry-run` exit 1 (manifest/progress drift so với repository truth), hoặc
- checkpoint `last_publication.ids` có ID mà manifest chưa đánh `published` (checkpoint drift).

Mở khóa: KHÔNG cần thao tác thủ công — coordinator run kế tiếp (bất kỳ: signal, trigger token, dispatch) self-heal derived state trước, xong dry-run sạch thì allocation chạy được. Maintenance dispatch (maintenance=true) vẫn còn như công cụ dự phòng nhưng KHÔNG còn bắt buộc.
