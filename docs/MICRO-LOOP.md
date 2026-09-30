# MICRO-LOOP — Vòng lặp 1 bài (tài liệu vận hành)

Nguồn chuẩn của vòng lặp writer cho codeappweb/lab, mô hình MICRO CONTINUOUS LOOP học từ thuexemayhanoi/vanchinh, nhưng mặc định `chunk_size = 1` (Lab) thay vì 2. Một vòng = một bài = một PR = một checkpoint.

## Cấu hình

`data/factory-config.json`:

- `chunk_size` (mặc định 1): số bài writer viết mỗi lượt.
- `chunk_size_max` (2): giới hạn trên nếu cấu hình thành 2.
- `hard_max_new_posts_per_push` (50): hard invariant của publish workflow — một push nhiều hơn bị REFUSE.
- Batch không còn là điều kiện publish; matrix chỉ là hàng đợi deterministic theo thứ tự dòng.

## Vòng lặp (bắt buộc)

```
FETCH FRESH MAIN
→ RESUME (đọc writer-checkpoint + manifest; bài đang dở hoàn tất TRƯỚC khi claim bài mới)
→ WRITE 1 (file _posts/YYYY-MM-DD-<slug>.md theo docs/SCHEMA-ARTICLE.md)
→ PREPARE: node scripts/prepare-article.mjs <manifest-id>
   → verify row + slug/URL, derive shards + manifest/progress, 6 gate nhẹ,
   → in ĐÚNG danh sách file phải commit (bài + derived + checkpoint)
→ COMMIT/PR: MỘT commit chứa toàn bộ danh sách, push nhánh article/<manifest-id>, mở PR
→ CI: publish.yml chỉ CHECK (publish-loop --check — cây phải clean sau derive;
   Actions KHÔNG bao giờ commit vào PR) + ci.yml gate scoped + build của đúng HEAD
→ MERGE (không force-push; push bị từ chối thì fetch/rebase/re-gate/retry)
→ VERIFY: Pages deploy xong, URL live trả nội dung mới
→ CHECKPOINT: cập nhật data/writer-checkpoint.json
→ BÁO 1 DÒNG: ID | tiêu đề | commit | URL live | trạng thái | bài tiếp theo
→ NEXT 1 → REPEAT
```

## Bảo đảm an toàn

- Bài lỗi (gate đỏ): publish-loop KHÔNG commit, KHÔNG push; PR đỏ; bài không tới main nên không có URL công khai. Writer ghi REVIEW và chuyển row planned kế tiếp — không chặn hàng đợi.
- Idempotent: chạy lại publish-loop khi không có gì mới → không diff, exit 0. Restart không tạo bài trùng.
- Writer commit MỘT LẦN: bài + derived allowlist + checkpoint cùng một commit TRƯỚC khi mở PR (prepare-article in danh sách). publish-loop --check yêu cầu git status clean sau derive — CI không bao giờ commit lại vào PR, và không cần push checkpoint riêng để kích hoạt CI.
- Claim trùng bị từ chối: slug đã published mà file không tồn tại trên nhánh = REFUSE.
- Scope: publish check từ chối mọi file ngoài `_posts/**` và allowlist dẫn xuất (`data/article-manifest.jsonl`, `data/progress.json`, `data/sitemap-shards.json`, `sitemap.xml`, `sitemaps/**`, `data/writer-checkpoint.json`). Danh sách rỗng không bao giờ trở thành stage toàn repo (chỉ `git add` tường minh từng path).
- Push bị từ chối: fetch, rebase, chạy lại gate dry-run + validate-sitemap, retry đúng MỘT lần; vẫn lỗi thì dừng và lưu diagnostics artifact. Không force-push.
- Actions không ghi gì: publish.yml chỉ CHECK cây do writer commit (contents: read, không bot commit). main chỉ nhận qua merge sau khi CI xanh. Mọi SHA trên main đều in-sync (không có cửa sổ CI đỏ).

## Trạng thái ba tầng (không nhầm lẫn)

1. Đã lưu local (file trong workspace writer).
2. Đã push (commit trên remote).
3. Đã deploy (Pages render URL live — chỉ tin sau khi GET URL trả nội dung mới).

## Checkpoint

`data/writer-checkpoint.json` ghi: `active_article` (đang làm), `last_published` (id, slug, commit, live_url, deploy_verified), `current_step`, `last_pushed_commit`. Sau mỗi bài đã deploy: fetch fresh main, cập nhật checkpoint, mới viết bài kế. Manifest > checkpoint khi xung đột. Khi hết phiên/hết hàng đợi hợp lệ: `current_step: "idle/awaiting-user-command"`, `active_article: null`. KHÔNG bao giờ ghi `deploy_verified`, commit SHA hay trạng thái CI khi chưa kiểm chứng URL live.

## Fixture

`scripts/publish-loop.test.mjs` kiểm chứng: 1 bài đạt publish độc lập; bài lỗi không công khai và không chặn bài hợp lệ kế; restart không trùng; mất kết nối sau push không push/publish trùng; claim trùng/out-of-scope bị từ chối; gate lỗi không bao giờ exit 0; transaction chỉ ghi file allowlist; T9 `--check` đỏ khi derived chưa được writer commit; T10 xanh khi writer commit đủ; T11 hai lượt liên tiếp + resume. `scripts/prepare-article.test.mjs` kiểm chứng lệnh chuẩn bị: P1 id lạ / file không có row bị từ chối; P2 row hợp lệ → xanh + in commit list + idempotent; P3 row published thiếu file không được claim lại. Tests chạy qua fixture `LAB_ROOT`, không bao giờ tạo bài thử trên site, và chỉ được chạy trong CI khi engine/workflow đổi.
