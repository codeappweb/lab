# Xe & Di Chuyển (codeappweb/lab)
Mục tiêu dài hạn: 20.000 bài đã xuất bản (tính cả bài hiện có), sản xuất có kiểm soát, không tự sinh hàng loạt.
Trạng thái chi tiết và bằng chứng: [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md). Bàn giao cho phiên sau: [docs/HANDOFF.md](docs/HANDOFF.md). Hướng dẫn cho agent lập trình: [AGENTS.md](AGENTS.md).
## Trạng thái hiện tại (tóm tắt trung thực)
- 30 bài đã xuất bản trong `_posts/`; mục tiêu 20.000 (target_total trong `data/engine-config.json`).
- Engine đã cài đặt: pipeline approved topic → evidence → outline → draft (drafts/) → validation thật → ready → publishing (gates + commit) → verify live → published.
- Writer tự động KHÔNG có sẵn: provider mặc định là `mock` (chỉ kiểm thử orchestration, không bao giờ xuất bản). Writer thật hiện là manual draft ingestion (`mistral_vibe_local`): phiên Mistral/Vibe local soạn `drafts/<slug>.md` + `drafts/<slug>.meta.json`, runner validate và publish có kiểm soát. Xem [docs/ENGINE-RUNBOOK.md](docs/ENGINE-RUNBOOK.md).
- Generation mặc định TẮT: `generation_enabled=false`, `dry_run=true`.
- KHÔNG có kết nối Search Console, thẻ xác minh, submit sitemap/indexing thủ công, hay noindex trên bài đã publish.
## Kiến trúc & chế độ chạy
- Kiến trúc thành phần và ranh giới trách nhiệm: [docs/ARCHITECTURE-20K.md](docs/ARCHITECTURE-20K.md).
- Cổng kiểm định nào kiểm tra gì: [docs/VALIDATION.md](docs/VALIDATION.md).
- Cơ chế deploy + xác minh revision + rollback: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- Đo dung lượng và điều kiện đủ để tuyên bố 20K: [docs/SCALING.md](docs/SCALING.md).
- Chuẩn nội dung, độ dài, nguồn pháp lý: [docs/CONTENT-POLICY.md](docs/CONTENT-POLICY.md) + [docs/SCHEMA-ARTICLE.md](docs/SCHEMA-ARTICLE.md).
- Thiết kế trang bài (typography, token, TOC, toolbar, a11y, cách format bài mới): [docs/ARTICLE-DESIGN.md](docs/ARTICLE-DESIGN.md).
Hai chế độ vận hành:
1. Local (máy tác giả): soạn draft, dry-run, controlled publishing với commit.
2. GitHub Actions: kiểm định (validate.yml) và regen + deploy đã xác minh (content-pipeline.yml). Actions KHÔNG viết bài.
## Cài đặt & kiểm tra không đổi
```bash
bundle install
node scripts/selftest.mjs            # fixture ok phải pass, fixture bad phải fail
node scripts/tests/article-runtime.test.mjs   # runtime DOM thật: wrap bảng, permalink, clipboard trung thực
node scripts/validate-navigation.mjs          # nhất quán nhãn/URL menu+footer từ một nguồn duy nhất
node scripts/engine-selftest.mjs    # orchestration offline: state, lock, retry, blocking, persistence
node scripts/validate-deploy.mjs    # toàn bộ cổng kiểm định (không build Jekyll)
bundle exec jekyll build            # build thật; lỗi build là lỗi
node scripts/validate-built.mjs --site _site   # link render + membership sitemap
```
Lệnh kiểm định đầy đủ tương đương CI nằm trong `.github/workflows/validate.yml`.
## Lệnh engine
```bash
node scripts/engine/runner.mjs status                          # số liệu thực
node scripts/engine/runner.mjs preflight                      # năng lực writer (trung thực)
node scripts/engine/runner.mjs plan [--limit N]               # ứng viên (CHƯA duyệt)
node scripts/engine/runner.mjs run --topics topics.json --dry-run
node scripts/engine/runner.mjs run --resume --dry-run
node scripts/engine/runner.mjs pause | resume | stop
node scripts/engine/runner.mjs retry JOB-000001               # rồi chạy run --resume
node scripts/engine/runner.mjs recover                        # phục hồi state hỏng
node scripts/engine/runner.mjs verify <slug> --sha <sha>      # xác minh live THẬT
```
Chi tiết từng lệnh, pilot có kiểm soát, crash/lock recovery: [docs/ENGINE-RUNBOOK.md](docs/ENGINE-RUNBOOK.md).
## Dữ liệu sống ở đâu
| Loại | Vị trí |
|---|---|
| Cấu hình engine | `data/engine-config.json` |
| Trạng thái engine (bền vững, được commit) | `data/engine-state.json` |
| Manifest bài (nguồn duyệt topic, status=planned) | `data/article-manifest.jsonl` |
| Draft chưa đủ điều kiện xuất bản | `drafts/` (ngoài `_posts/`, loại khỏi build) |
| Bài xuất bản | `_posts/` |
| Report kiểm định | `reports/` (không hardcode số liệu vào docs) |
| Browser QA (Chromium thật, Playwright pin) | `.github/workflows/visual-qa.yml` + `scripts/tests/browser-qa.mjs`; screenshots: artifact `visual-qa-screenshots` (cần người xem) |
## An toàn mặc định
- `generation_enabled=false`, `dry_run=true`, `provider=mock` trong `data/engine-config.json`.
- `run` không dry-run từ chối khi generation tắt; provider mock từ chối publish trong mọi trường hợp.
- `verify` không tin cờ: kiểm tra URL live (200 + đúng nội dung) VÀ revision Pages khớp `--sha` trước khi ghi `verified_live`.
- Draft mock/test không thể tới production: mock không publish được, gate suite chạy lại sau khi chép vào `_posts/`, fixtures tách khỏi build.
## Bước tiếp theo
Xem "Next concrete actions" trong [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md) và [docs/HANDOFF.md](docs/HANDOFF.md).
