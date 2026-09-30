# codeappweb/lab — Hướng dẫn vận hành cho Mistral

Jekyll site, GitHub Pages, baseurl `/lab`, live: <https://codeappweb.github.io/lab/>.

Mô hình: Mistral (phiên đăng nhập hiện có) là người viết nội dung. GitHub Actions chỉ kiểm tra/build. GitHub Pages deploy từ nhánh main — một đường deploy duy nhất. Không dùng MISTRAL_API_KEY hay API sinh bài trả phí. Một writer Mistral hoạt động tại một thời điểm.

Vòng vận hành mặc định: FETCH → RESUME → WRITE 1 → PREPARE → COMMIT/PR → CI → MERGE → VERIFY LIVE → CHECKPOINT → NEXT (chi tiết: `AGENTS.md`, `docs/MICRO-LOOP.md`). Writer commit bài + dữ liệu dẫn xuất + checkpoint trong MỘT commit trước khi mở PR; Actions chỉ kiểm tra, không bao giờ commit lại vào PR. Không chờ đủ batch; bài đạt QA tối thiểu thì đăng ngay.

Chế độ phiên hiện tại (2026-09-30): chỉ publish các bài đã viết sẵn (batch-2026-09-27) và sửa hạ tầng. Không viết bài mới, không bật lịch sinh bài, không mở rộng matrix cho tới khi có lệnh rõ ràng "Bắt đầu viết bài".

## Vòng lặp vận hành (mỗi bài)

1. FETCH main; RESUME từ `data/writer-checkpoint.json` + manifest (bài đang dở hoàn tất trước khi claim bài mới).
2. WRITE 1 bài vào `_posts/YYYY-MM-DD-<slug>.md` theo `docs/SCHEMA-ARTICLE.md`. Không tự viết bài kế cho tới khi có lệnh.
3. PREPARE — MỘT lệnh chuẩn bị: `node scripts/prepare-article.mjs <manifest-id | _posts/YYYY-MM-DD-slug.md>`: xác minh row manifest + slug/URL, sinh lại sitemap shards + manifest/progress, chạy 6 gate nhẹ, in ĐÚNG danh sách file phải commit.
4. COMMIT/PR: commit đúng danh sách in ra (file bài + derived allowlist + `data/writer-checkpoint.json`) trong MỘT commit, push nhánh `article/<id>`, mở PR vào main. CI không commit lại vào PR.
5. CI: publish check (`publish-loop --check` — cây phải clean sau derive) + gate nhẹ + Jekyll build của đúng HEAD PR.
6. MERGE khi CI xanh. VERIFY Pages deploy: chỉ báo live khi URL trả nội dung mới.
7. CHECKPOINT: cập nhật `data/writer-checkpoint.json` theo thực tế remote/live; hết phiên → `idle/awaiting-user-command`.
8. Bài lỗi hoặc chưa chắc chắn về số liệu pháp lý/an toàn: giữ lại, ghi lý do REVIEW cụ thể, KHÔNG bịa nguồn, KHÔNG gắn verified giả.
9. Báo cáo cuối: số bài đăng, URL live đã kiểm tra, bài giữ lại + lý do, trạng thái CI/deploy.

## Resume / checkpoint

- `_drafts/batch-YYYY-MM-DD/` là checkpoint của phiên; manifest ghi trạng thái.
- Phiên mới: đọc manifest + `_drafts`, tiếp tục bài đang dở, KHÔNG viết lại bài đã `published`.
- Không đăng bài thử lên site; dùng fixture khi cần thử gate.

## Trạng thái manifest

`planned → drafting → review → published`. `skip` để bỏ một bài. Không dùng trạng thái khác. Bài đã live giữ nguyên URL (`permalink: /:title/`).

## QA nhẹ — chặn publish

1. Front matter hợp lệ, đủ trường theo `docs/SCHEMA-ARTICLE.md`.
2. Không trùng slug/permalink/ID; không ghi đè bài đã đăng; sao chép nguyên bài bị chặn.
3. Không bài rỗng/placeholder, không Liquid/YAML hỏng, không nội dung cắt rõ ràng.
4. Link nội bộ trỏ tới URL tồn tại (`scripts/check-links.mjs`).
5. Jekyll build thành công; URL xuất bản tồn tại trong `_site` + sitemap (`scripts/validate-built.mjs`).
6. Không commit secrets, cache, file test, dữ liệu ngoài phạm vi.

Gate: `validate-content.mjs`, `validate-content-quality.mjs`, `detect-duplicates.mjs`, `check-links.mjs`, `validate-sitemap.mjs`, `validate-built.mjs`, `sync-manifest.mjs --dry-run`. PR content-only: check-links chạy `--only` trên đúng các bài mới/sửa (targets vẫn build từ toàn repo, ID/slug vẫn đối chiếu repo-wide chống trùng). Regression tests engine (`node --test scripts/*.test.mjs`) chỉ chạy khi `scripts/**` hoặc `.github/workflows/**` đổi — áp cho cả PR và push main. QA và build luôn kiểm cùng cây commit cuối của PR. Không dùng `|| true` để che lỗi validator; WARNING biên tập in rõ khác FAIL.

## WARNING — không chặn publish

Similarity token giữa topic, title gần giống, cannibalization, số từ/H2/FAQ/internal links, SEO score, orphan/cluster. Các cảnh báo này chỉ để tôi audit sau. Full audit sâu (legal freshness) chỉ chạy thủ công qua workflow_dispatch; CI lưu báo cáo bằng artifacts, không commit vào repo.

## Nội quy

- Không bịa giá, thông số kỹ thuật, luật, trải nghiệm, nguồn dẫn. Bài có khẳng định pháp lý/an toàn chưa kiểm chứng giữ `review` hoặc bỏ khẳng định.
- Không yêu cầu viết dài để đủ quota.
- Menu/taxonomy/hub/danh-mục/giao diện/baseurl giữ nguyên. Số liệu pháp lý đối chiếu `data/legal-sources.yml`.

## Lệnh chính cho mỗi bài

```bash
# WRITE 1 bài vào _posts/YYYY-MM-DD-<slug>.md rồi chạy MỘT lệnh chuẩn bị:
node scripts/prepare-article.mjs <manifest-id | _posts/YYYY-MM-DD-slug.md>
# → verify row/URL + derive manifest/progress/sitemap + 6 gate + in danh sách commit.
# Commit ĐÚNG danh sách (bài + derived + checkpoint) trong MỘT commit,
# push article/<id>, mở PR. CI chỉ kiểm tra; merge khi xanh; verify URL live.
```
