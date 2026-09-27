# ARCHITECTURE 20K (v3)

Mục tiêu: 20.000 bài đã xuất bản (tính cả bài hiện có), sản xuất có kiểm soát, đo được, không tự sinh hàng loạt. Trạng thái chi tiết: [PROJECT-STATUS.md](PROJECT-STATUS.md).

## Luồng xuất bản (engine v2, thực thi thật)

```
topic đã duyệt (data/article-manifest.jsonl, status=planned)
  → job planned
  → researching: evidence (mistral_vibe_local: drafts/<slug>.meta.json sources[] bắt buộc)
  → drafting: draft vào drafts/<slug>.md — KHÔNG đụng _posts/
  → validating: draft-level check thật; (publish thật: cả gate suite)
  → ready: đủ điều kiện xuất bản
  → publishing: gate suite trước + sau khi chép vào _posts/; commit (committed_sha)
  → verify <slug> --sha <sha>: URL live 200 + đúng nội dung + revision Pages khớp sha
  → published (verified_live chỉ ghi khi cả ba điều kiện trên đúng)
  | blocked | failed tại mọi giai đoạn
```

Ba sự kiện deploy là ba sự kiện riêng: `file_written` (tệp tồn tại), `committed_sha` (đã commit), `verified_live` (đã xác minh trên site). Không bao giờ suy diễn cái này từ cái kia.

## Ranh giới trách nhiệm

- Local (máy tác giả / phiên Mistral-Vibe): duyệt topic vào manifest, soạn draft + evidence (writer thật, human-in-the-loop), dry-run, controlled publishing (gates + commit), verify.
- GitHub Actions: KHÔNG viết bài. `validate.yml` = kiểm định + build Jekyll thật + validate-built. `content-pipeline.yml` = audit + regen artifacts + request Pages build + verify deployed revision; job `writer-preflight` dispatch-only chỉ check cấu hình/năng lực provider.
- Writer: `mock` = test only (từ chối publish tuyệt đối); `mistral_vibe_local` = manual draft ingestion (không phải automated writing); `mistral_api` = BLOCKED (không adapter, không credentials; subscription chat không phải API access).

## Thành phần

- Engine: `scripts/engine/{config,state,provider,topics,runner}.mjs` + selftest `scripts/engine-selftest.mjs`. State machine + idempotency theo slug + lock O_EXCL theo heartbeat + atomic writes + explicit recover.
- Validators (shared lib `scripts/lib/lab.mjs`): xem [VALIDATION.md](VALIDATION.md).
- Sitemap: `sitemap.xml` (index) → `sitemaps/articles-NNN.xml` (sinh từ `_posts` thật), `categories.xml`, `static.xml`; `validate-sitemap.mjs` exact membership; `validate-built.mjs` kiểm lại trên HTML render.
- Site scale: related-posts precomputed (max 3, cả fallback path), archive pagination `danh-muc/<parent>/trang-NN` (48/trang, crawlable), search index chunk theo cluster.

## Lưu trữ state & cơ chế deploy

- `data/engine-state.json` (commit) — jobs/runs/checkpoint/pause/stop; `data/engine-config.json` (commit) — cấu hình + safety defaults; `data/engine-lock.json` (runtime, gitignore) — lock; `data/engine-state.corrupt-*.json` (archive khi recover).
- Deploy: Pages branch build; token push không kích hoạt build nên pipeline POST `/pages/builds` rồi `verify-deployment.mjs` đối chiếu revision + URL đại diện. Chi tiết + rollback: [DEPLOYMENT.md](DEPLOYMENT.md).

## Giả định scaling & giới hạn đã biết

- Bản đo và ngoại suy (ghi nhãn rõ) nằm ở [SCALING.md](SCALING.md); không dùng số mock làm bằng chứng.
- Giới hạn: GitHub Pages ~1 GB published site; build time tăng theo số bài; search index chunk hóa nhưng vẫn cần theo dõi kích thước.

## Phụ thuộc ngoài repo

- `https://codeappweb.github.io/robots.txt` 404 — cần user-site repo (ngoài phạm vi).
- Writer tự động qua API: chưa có (xem PROJECT-STATUS Blocked).
