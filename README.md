# codeappweb/lab — Hướng dẫn vận hành cho Mistral

Jekyll site, GitHub Pages, baseurl `/lab`, live: <https://codeappweb.github.io/lab/>.

Mô hình: Mistral (phiên đăng nhập hiện có) là người viết nội dung. GitHub Actions chỉ kiểm tra/build. GitHub Pages deploy từ nhánh main — một đường deploy duy nhất. Không dùng MISTRAL_API_KEY hay API sinh bài trả phí. Một writer Mistral hoạt động tại một thời điểm.

## Vòng lặp batch (mỗi phiên)

1. Đọc `data/article-manifest.jsonl` và chọn các dòng `status: planned`. Tối đa 20 bài/batch (giới hạn trên, không bắt buộc; hết phiên thì đăng phần đã xong).
2. Đặt các dòng đã chọn thành `drafting`. Commit trạng thái này (checkpoint).
3. Viết draft vào `_drafts/batch-YYYY-MM-DD/<slug>.md` theo `docs/SCHEMA-ARTICLE.md`.
4. Bài lỗi hoặc chưa chắc chắn về số liệu pháp lý/an toàn: giữ `review`, KHÔNG bịa nguồn, KHÔNG gắn verified giả. Một bài lỗi không chặn bài đạt khác.
5. Xuất bản phần đạt: chuyển file sang `_posts/YYYY-MM-DD-<slug>.md`, đặt dòng manifest `status: published` kèm `published_url`.
6. Chuẩn bị + QA nhẹ: `node scripts/validate-deploy.mjs` (sinh lại sitemap shards, đồng bộ manifest, chạy toàn bộ gate nhẹ). Gate nào FAIL thì sửa trước khi push.
7. Commit + push lên main. Không force-push. Push bị từ chối: pull/rebase, chạy lại `validate-deploy.mjs`, push lại.
8. Chờ CI trên main đạt. Pages deploy từ main — chỉ báo "site live đã cập nhật" khi CI đạt VÀ URL live thực sự trả nội dung mới. Deploy lỗi thì KHÔNG báo đã cập nhật.
9. Báo cáo cuối: số bài đăng, số bài còn (drafting/review), URL live đã kiểm tra, WARNING biên tập còn tồn.

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

Gate: `validate-content.mjs`, `validate-content-quality.mjs`, `detect-duplicates.mjs`, `check-links.mjs`, `validate-sitemap.mjs`, `validate-built.mjs`, `sync-manifest.mjs --dry-run`. Không dùng `|| true` để che lỗi validator; WARNING biên tập in rõ khác FAIL.

## WARNING — không chặn publish

Similarity token giữa topic, title gần giống, cannibalization, số từ/H2/FAQ/internal links, SEO score, orphan/cluster. Các cảnh báo này chỉ để tôi audit sau. Full audit sâu (legal freshness) chỉ chạy thủ công qua workflow_dispatch; CI lưu báo cáo bằng artifacts, không commit vào repo.

## Nội quy

- Không bịa giá, thông số kỹ thuật, luật, trải nghiệm, nguồn dẫn. Bài có khẳng định pháp lý/an toàn chưa kiểm chứng giữ `review` hoặc bỏ khẳng định.
- Không yêu cầu viết dài để đủ quota.
- Menu/taxonomy/hub/danh-mục/giao diện/baseurl giữ nguyên. Số liệu pháp lý đối chiếu `data/legal-sources.yml`.

## Lệnh chính để bắt đầu batch tiếp theo

```bash
# 1. Chọn bài (đọc manifest, lọc status=planned)
# 2. Viết draft vào _drafts/batch-YYYY-MM-DD/
# 3. Xuất bản phần đạt rồi chạy:
node scripts/validate-deploy.mjs
# 4. Commit + push main, chờ CI đạt, kiểm tra URL live.
```
