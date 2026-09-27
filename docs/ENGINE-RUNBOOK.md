# ENGINE RUNBOOK — vận hành engine 20K

Trạng thái engine: đã cài đặt; `generation_enabled=false`, `dry_run=true`, `provider=mock` (data/engine-config.json). Không có writer tự động; pilot chỉ chạy khi được yêu cầu rõ ràng sau review.

## Chuỗi trạng thái (thực thi thật, không phải nhãn)

```
planned → researching (evidence bắt buộc) → drafting (drafts/) → validating
→ ready (chỉ khi validation pass) → publishing (gates + chép _posts/ + commit)
→ published (chỉ khi verify live thành công)
| blocked | failed
```

- `researching` thu thập evidence: với `mistral_vibe_local`, cần `drafts/<slug>.meta.json` chứa `sources[]` (bắt buộc) và `outline[]`; thiếu → job BLOCKED với lý do cụ thể (`E_NO_EVIDENCE`/`E_NO_OUTLINE`).
- `validating` chạy thật: kiểm tra draft-level (front matter, id, parent/child, search_intent, độ dài 1.200–2.000 âm tiết với bài thật, cấm mock ngoài dry-run). Khi publish thật, toàn bộ gate suite (`scripts/validate-deploy.mjs`) chạy TRƯỚC và SAU khi chép vào `_posts/`; gate fail → hoàn tác file, job failed.
- `ready` = đủ điều kiện xuất bản, chưa xuất bản.
- `publishing` = file trong `_posts/` + gates xanh + đã commit (ghi `committed_sha`). Không push trừ khi `--push`.
- `published` chỉ khi `verify` thành công.

## Lệnh chính xác

```bash
node scripts/engine/runner.mjs status
node scripts/engine/runner.mjs preflight
node scripts/engine/runner.mjs plan [--limit N]
node scripts/engine/runner.mjs run --topics topics.json --dry-run
node scripts/engine/runner.mjs run --resume --dry-run
node scripts/engine/runner.mjs pause
node scripts/engine/runner.mjs resume
node scripts/engine/runner.mjs stop            # emergency stop, exit 1
node scripts/engine/runner.mjs retry JOB-000001
node scripts/engine/runner.mjs recover
node scripts/engine/runner.mjs verify <slug> --sha <commit-sha>
```

Mọi lệnh hỗ trợ `--root <dir>` (root cách ly cho kiểm thử).

## Pause / resume / stop

- `pause`/`stop` ghi cờ vào `data/engine-state.json` (bền vững). Run loop reload state từ đĩa mỗi vòng lặp, nên lệnh từ tiến trình khác được nhận biết trong cùng một lần chạy.
- `resume` bỏ cả `paused` lẫn `emergency_stop`.

## Retry

- `retry JOB-ID` chỉ nhận job `failed`/`blocked`, reset `retries`, chuyển về `planned`. Retry CHỈ có tác dụng khi một run xử lý nó: chạy `run --resume` ngay sau đó.

## Crash recovery / lock recovery

- State hỏng (không đọc được JSON): mọi lệnh fail kèm chỉ dẫn; chạy `recover` — file hỏng được lưu thành `data/engine-state.corrupt-<ts>.json` (không bị ghi đè), state mới được ghi kèm record `recovery`. Không bao giờ tự reset im lặng.
- Lock (`data/engine-lock.json`) lấy bằng `open(..., 'wx')` — atomic giữa các tiến trình; job CHỈ được tạo sau khi giữ lock. Lock cũ được thu hồi khi HEARTBEAT cũ hơn `lock_ttl_seconds` (mặc định 1800s), kèm record `recovered_from`; thu hồi dựa trên heartbeat freshness nên không giành nhầm lock đang sống.
- Heartbeat/releaseLock chỉ tác động khi tiến trình giữ lock (`run_id` khớp); tiến trình khác không refresh/unlink được lock của ai khác.
- Run bị gián đoạn: `run --resume` tiếp tục các job planned/researching/drafting/validating/ready VÀ `publishing` từ state bền vững; identity theo slug đảm bảo không làm trùng.

## Milestone resume (phục hồi gián đoạn trong lúc publishing)

Job `publishing` ghi milestone tuần tự vào state; `--resume` suy luận hành động
đúng từ bằng chứng đã lưu + trạng thái repo, KHÔNG lặp lại bước đã xong:

| Milestone | Nghĩa | Resume khi đã đạt |
|---|---|---|
| `M1 file_write_planned` | sắp chép draft vào `_posts/` | kiểm tra file trước khi chép |
| `M2 file_written` | file `_posts/<...>.md` đã chép (đối chiếu nội dung với draft) | file giống draft → không chép lại; KHÁC draft → `E_RESUME_AMBIGUOUS` (blocked, không ghi đè) |
| `M3 gates_passed` | gate suite + Jekyll build + validate-built đã xanh | không chạy lại trước commit; thiếu toolchain (bundle/jekyll) → `E_BUILD_MISSING`, KHÔNG bỏ qua |
| `M4 committed` | content commit đã tạo (`committed_sha` qua `git cat-file -e`) | không commit lại; SHA không tồn tại trong repo → `E_RESUME_AMBIGUOUS` |
| `M5 pushed` | content commit đã push | không push lại |
| `verified_live` | deploy đã xác minh (xem dưới) | không lặp verify |

- File `_posts/` đã tồn tại NHƯNG KHÔNG có milestone M1/M2 → `E_DUPLICATE_POST`
  (blocked): file trùng tên chưa từng do job này tạo — yêu cầu con người xử lý.
- Pause/stop được kiểm tra lại TRƯỚC mỗi bước không thể đảo ngược (chép file,
  commit, push) và giữa các stage (`E_RUN_HALTED`, job giữ nguyên để resume).
- Retry trong run loop: đúng `max_retries` lần gate attempts (1 + max_retries),
  backoff `backoff_ms × n`; hết lượt → `failed`.

## Durable state: phân biệt content commit và state commit

- `committed_sha` là SHA của COMMIT NỘI DUNG (chỉ `_posts/<file>.md`), KHÔNG
  phải commit state/report. State (`data/engine-state.json`), sitemap shards,
  reports có thể tạo các commit SAU content commit — so sánh SHA bằng đẳng
  thức sẽ sai; `verify` dùng `gh api compare` (content_commit...deployed_head):
  `identical` hoặc `ahead` (deployed chứa content commit) → pass; `behind`/
  `diverged`/unknown → fail closed (`deployedRevisionOk` trong state.mjs).
- Job lưu `content_commit` (revision bài đã publish) tách biệt với state commits;
  các milestone được persist qua restart/checkout mới vì state file được commit.
- Một file tồn tại trong `_posts/` KHÔNG đồng nghĩa bài đã publish: `published`
  chỉ được ghi sau `verify` thành công với bằng chứng live thật.

## Xử lý lỗi

- `E_NO_EVIDENCE`/`E_NO_DRAFT`/`E_NO_OUTLINE`/`E_PROVIDER_UNAVAILABLE`/`E_GATE_MISSING` → job `blocked` (cần tác nhân ngoài: soạn draft/evidence, hoặc cấu hình writer).
- Lỗi khác (network, IO tạm thời) → retry tối đa `max_retries` với backoff `backoff_ms × n`, hết lượt → `failed`.
- Validation fail (`E_DRAFT_INVALID`, `E_GATES_FAILED`) → không blind-retry; sửa nguyên nhân.

## Pilot có kiểm soát (chưa chạy — chỉ khi được yêu cầu)

1. Chọn 3–5 topic đã duyệt (manifest `status=planned`) → `topics.json`.
2. `node scripts/engine/runner.mjs run --topics topics.json --dry-run` — orchestration phải xanh, không ghi gì.
3. Soạn draft thật trong phiên Mistral/Vibe local: `drafts/<slug>.md` (1.200–2.000 âm tiết, schema theo docs/SCHEMA-ARTICLE.md) + `drafts/<slug>.meta.json` (`sources[]` thật, `outline[]`).
4. Review draft. Chỉ khi duyệt: đặt tạm `dry_run=false` và `generation_enabled=true` trong `data/engine-config.json` (provider `mistral_vibe_local`).
5. `node scripts/engine/runner.mjs run --topics topics.json` — tự chạy gates, chép vào `_posts/`, commit. Không `--push` lần đầu.
6. Push, chờ Pages build, rồi: `node scripts/engine/runner.mjs verify <slug> --sha <sha>`.
7. TẮT LẠI: `generation_enabled=false`, `dry_run=true`, commit config.

## Bền vững state (documented strategy)

- `data/engine-state.json` là nguồn duy nhất, được commit vào repo; mỗi `save()` là tmp+fsync+rename (atomic). Nhà xuất bản commit state cùng bài publish. Runner chạy local ghi state trên đĩa; state trong git cập nhật khi commit tiếp theo (publish hoặc manual). Lock file và bản state hỏng được lưu thì bị gitignore.
