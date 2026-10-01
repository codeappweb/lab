# PAIR PRODUCTION — Vòng lặp push-driven (tài liệu vận hành)

Nguồn chuẩn của production cho codeappweb/lab. Port ý tưởng /vanchinh cho cấu trúc repo này: PUSH-DRIVEN, EXACT PAIR, FACTORY TỰ HOÀN TẤT, HOT PATH NHẸ. Một vòng = MỘT CẶP 2 bài = một push = một transaction = một SAFE CHECKPOINT. Thay cho mô hình cũ (writer tự prepare + PR từng bài): giờ writer chỉ viết và push; factory trong Actions tự claim/QA/publish phần còn lại, tất định.

## Cấu hình

`data/factory-config.json`:

- `chunk_size` (2): số bài writer viết mỗi lượt — một cặp.
- `chunk_size_max` (2): giới hạn trên số bài NEW mỗi push; vượt là REFUSE.
- `hard_max_new_posts_per_push` (50): hard invariant của publish transaction.
- Batch chỉ để tổ chức matrix, không phải điều kiện publish.

## Vòng lặp (bắt buộc)

```
FETCH FRESH MAIN
→ NEXT-PAIR: node scripts/next-pair.mjs   (exact IDs từ manifest + review_queue)
→ WRITE 2 bài vào _posts/YYYY-MM-DD-<slug>.md theo docs/SCHEMA-ARTICLE.md
→ PUSH NGAY lên main (chỉ 2 file bài — KHÔNG gom nhiều bài local)
→ FACTORY (.github/workflows/production.yml, tự kích hoạt):
   select EXACT IDs từ chính push → claim → derive repository truth
   → QA scoped (6 gate nhẹ) → publish transactional (commit CHỈ derived
   allowlist khi mọi gate xanh, push lại main; rebase + revalidate, không
   force-push) → LIGHT VERIFY
→ FETCH FRESH MAIN → NEXT 2 → REPEAT
```

Mỗi cặp push xong + factory xanh = một SAFE CHECKPOINT. Phiên bị reset/mất kết nối: fetch fresh main, chạy `next-pair`, tiếp tục — không phụ thuộc state trong workspace.

## Writer contract (cực giản)

1. Luôn FETCH FRESH MAIN trước khi viết.
2. Exact next IDs: `node scripts/next-pair.mjs` — repository truth (manifest theo thứ tự dòng, trừ review_queue). KHÔNG hard-code ID bắt đầu, KHÔNG tin state cũ trong workspace.
3. Viết đúng `chunk_size` (2) bài; tạo research/evidence theo `docs/SCHEMA-ARTICLE.md`.
4. PUSH NGAY lên main. KHÔNG chạy derived/QA thủ công — factory tự làm (idempotent).
5. Chờ `production.yml` (publish transaction) + `ci.yml` (light build verify) xanh.
6. VERIFY live: GET URL trả nội dung mới mới báo đã live (ba tầng: local / pushed / deployed).
7. FETCH FRESH MAIN → 2 bài kế → REPEAT.
8. Bài lỗi nội dung: không push, ghi lý do vào `review_queue` của checkpoint, chuyển cặp kế — không chặn hàng đợi. Lỗi hạ tầng ảnh hưởng mọi bài: dừng để sửa.
9. REPAIR bài đã live: sửa đúng file `_posts/` tương ứng rồi push riêng — factory derive + gate lại; KHÔNG đổi URL đã live.

## NEW và REPAIR tách rõ

- NEW = file mới trong `_posts/` (phải khớp row manifest planned). Factory flip row → published.
- REPAIR = file `_posts/` đã tồn tại bị sửa. Factory derive + gate lại toàn bộ; row giữ published.
- production.yml log rõ scope `NEW=[...] REPAIR=[...]`; publish-loop từ chối mọi thứ ngoài `_posts/**` + derived allowlist.

## Factory trong Actions (tất định)

- Trigger: push main, paths `_posts/**`. Singleton concurrency (`production-pair`, không cancel) — hai push xếp hàng xử lý tuần tự, không tranh claim.
- Claim: publish-loop từ chối slug đã published mà thiếu file, file ngoài `_posts/`, vượt hard max, manifest hỏng.
- Transaction: derive (sitemap shards + manifest/progress sync) → 6 gate nhẹ → `git add` TƯỜNG MINH từng derived path → commit → push (rebase + re-gate + retry đúng MỘT lần, không force-push).
- Idempotent: chạy lại khi không có gì mới → không diff, exit 0. Mất kết nối giữa chừng → lần chạy kế hoàn tất đúng phần còn thiếu, không trùng.
- Actions KHÔNG AI, KHÔNG cron, KHÔNG viết prose; CHỈ commit derived allowlist sau khi mọi gate xanh.

## Hot path vs deep audit

Normal pair KHÔNG chạy: full-site audit, regression tests toàn repo (`node --test scripts/*.test.mjs`), soak, legal-freshness audit, full SEO crawl. Các kiểm tra nặng chuyển sang:

- Engine/workflow change (`scripts/**`, `.github/workflows/**` đổi): ci.yml mới chạy syntax check + regression tests — áp cả PR và push main.
- Full audit sâu (legal freshness, artifacts): ci.yml `workflow_dispatch` thủ công.
- PR repair lớn: publish.yml vẫn check-only cho nhánh `article/**`.

## Checkpoint

`data/writer-checkpoint.json` ghi `chunk_size`, `active_article`, `last_published`, `review_queue`. Sau mỗi cặp đã deploy: fetch fresh main, cập nhật checkpoint theo thực tế remote/live. Manifest > checkpoint khi xung đột. Khi hết phiên/hàng đợi: `current_step: "idle/awaiting-user-command"`, `active_article: null`. KHÔNG bao giờ ghi `deploy_verified` khi chưa GET URL live.

## Fixture

`scripts/publish-loop.test.mjs` kiểm chứng (không đổi): 1 bài đạt publish độc lập; bài lỗi không công khai, không chặn bài hợp lệ kế; restart không trùng; mất kết nối sau push không push/publish trùng; claim trùng/out-of-scope bị từ chối; gate lỗi không exit 0; transaction chỉ ghi derived allowlist; `--check` đỏ khi derived chưa commit; hai lượt liên tiếp + resume. Tests chạy qua fixture `LAB_ROOT`, chỉ chạy trong CI khi engine/workflow đổi.
