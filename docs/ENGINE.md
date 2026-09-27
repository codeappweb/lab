# ENGINE — Quy trình 20K bài (operations manual)

Trạng thái: đã cài đặt, generation TẮT mặc định. Pilot 3–5 bài chỉ chạy khi được yêu cầu rõ ràng sau review.

## Kiến trúc

```
scripts/engine/
  config.mjs    — cấu hình bền vững (data/engine-config.json)
  state.mjs     — trạng thái bền vững (data/engine-state.json): jobs, locks,
                  checkpoint, emergency_stop, pause; transition hợp lệ được kiểm tra
  provider.mjs  — preflight + mock/local/API adapters; không commit credentials
  topics.mjs    — mở rộng ứng viên từ taxonomy, dedupe slug + intent
  runner.mjs    — CLI thực thi chuỗi: planned → researching → drafting →
                  validating → ready → publishing → published | blocked | failed
```

Ba sự kiện deploy được ghi tách biệt: `file_written` (tệp tồn tại), `committed_sha` (đã commit), `verified_live` (đã xác minh trên site). Không bao giờ suy diễn cái này từ cái kia.

## Lệnh

```bash
node scripts/engine/runner.mjs status          # số liệu thực: posts, queue, jobs, lock
node scripts/engine/runner.mjs preflight      # kiểm tra writer: mock / local / api
node scripts/engine/runner.mjs plan            # sinh data/topic-candidates.json (chưa duyệt)
node scripts/engine/runner.mjs run --topics topics.json --dry-run   # dry-run, KHÔNG ghi _posts
node scripts/engine/runner.mjs pause
node scripts/engine/runner.mjs resume
node scripts/engine/runner.mjs stop           # emergency stop (exit 1)
node scripts/engine/runner.mjs retry JOB-000001
node scripts/engine/runner.mjs verify <slug> --sha <sha> --live
```

## Cửa an toàn

1. `generation_enabled: false` trong `data/engine-config.json` — `run` không dry-run sẽ REFUSE.
2. Emergency stop + pause là cờ bền vững trong state, sống sót qua restart runner.
3. Lock + TTL: hai run không chạy chồng; lock quá hạn được thu hồi và ghi `recovered_from`.
4. Idempotency theo slug: chạy lại không tạo bài trùng; job đã có thì resume từ checkpoint.
5. `per_run_article_limit`, `per_run_seconds_limit`, `max_retries` + backoff tuyến tính.
6. Hard stop tại `target_total = 20000` tính cả bài hiện có.
7. Bài `blocked` không thể publish: transition sang publishing bị từ chối; phải qua `ready` sau khi toàn bộ gate (`validate-deploy.mjs`) xanh.

## Writer

- `mock`: chỉ để kiểm thử orchestration, KHÔNG BAO GIỜ được báo cáo là writer thật.
- `mistral_vibe_local` (khuyến nghị): phiên Vibe/Mistral local soạn draft vào `drafts/<slug>.md`; runner nhận, validate, publish. Writer thật, human-in-the-loop.
- `mistral_api`: adapter tồn tại nhưng không có credentials trong repo; subscription chat trả phí KHÔNG tương đương truy cập API. Không có paid calls trong tác vụ này.

## Pilot 3–5 bài (chỉ chạy khi được yêu cầu)

```bash
# 1. Chọn 3–5 topic đã duyệt từ manifest (status=planned) → topics.json
# 2. Dry-run:
node scripts/engine/runner.mjs run --topics topics.json --dry-run
# 3. Soạn draft thật trong phiên local (mistral_vibe_local) vào drafts/<slug>.md
#    (mỗi bài 1.200–2.000 âm tiết tiếng Việt, thân bài, không tính front matter)
# 4. Sau review: đặt dry_run=false và generation_enabled=true trong data/engine-config.json
# 5. Chạy:
node scripts/engine/runner.mjs run --topics topics.json
# 6. Gate:
node scripts/validate-deploy.mjs
# 7. Commit, push, chờ Pages build, rồi ghi nhận:
node scripts/engine/runner.mjs verify <slug> --sha <commit-sha> --live
# 8. TẮT LẠI: generation_enabled=false, dry_run=true, commit config.
```
