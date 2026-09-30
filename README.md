# codeappweb/lab — Hướng dẫn vận hành cho Mistral

Jekyll site, GitHub Pages, baseurl `/lab`, live: <https://codeappweb.github.io/lab/>.

Mô hình: Mistral (phiên đăng nhập hiện có) là người viết nội dung. GitHub Actions chỉ kiểm tra/build và xử lý dữ liệu tất định. GitHub Pages deploy từ nhánh main — một đường deploy duy nhất. Không dùng MISTRAL_API_KEY hay API sinh bài trả phí. Một writer Mistral hoạt động tại một thời điểm. Không cron tự gọi Mistral.

## Vòng lặp micro (MICRO CONTINUOUS LOOP — mặc định 1 bài mỗi lượt)

Cấu hình: `data/factory-config.json` — `chunk_size: 1` (mặc định), có thể đặt thành 2. Batch chỉ là đơn vị tổ chức matrix, KHÔNG phải điều kiện phải hoàn thành đủ số lượng mới được publish.

```
FETCH main → RESUME bài đang dở → WRITE 1 → PR (chỉ file bài) →
publish.yml derive + gates → CI xanh của đúng HEAD → MERGE →
VERIFY Pages deploy + URL live → CHECKPOINT → NEXT 1 → REPEAT
```

1. Fetch main. Đọc `data/article-manifest.jsonl`, chọn dòng `status: planned` đầu tiên theo thứ tự matrix. KHÔNG claim lại bài `published`, KHÔNG sinh lại matrix.
2. Viết bài theo `docs/SCHEMA-ARTICLE.md`, lưu file ngay sau từng phần hợp lý (không giữ bài chỉ trong hội thoại).
3. Push nhánh `article/<id>` chứa MỘT commit chỉ gồm file bài `_posts/YYYY-MM-DD-<slug>.md` (+ `data/writer-checkpoint.json`). Mở PR vào main.
4. Workflow `publish.yml` (chỉ với nhánh `article/**`) chạy `scripts/publish-loop.mjs`: derive scope từ TOÀN BỘ phạm vi commit của PR, từ chối file ngoài phạm vi, sinh lại sitemap shards + đồng bộ manifest/progress, chạy gate nhẹ, rồi commit ĐÚNG các file dẫn xuất theo allowlist vào nhánh PR. Thất bại gate thì KHÔNG commit, KHÔNG push — bài lỗi không bao giờ tới main.
5. Chờ CI (`ci.yml`) xanh của đúng HEAD PR. Merge. KHÔNG force-push.
6. Pages deploy từ main. Chỉ báo "đã đăng live" khi URL live thực sự trả nội dung mới. Phân biệt rõ: đã lưu local / đã push / đã deploy.
7. Cập nhật `data/writer-checkpoint.json`, báo MỘT dòng: ID | tiêu đề | commit | URL live | trạng thái | bài tiếp theo.
8. Một bài hoàn thành là CHECKPOINT, không phải kết thúc nhiệm vụ. Lặp lại ngay bài kế khi phiên còn hoạt động.

Bài lỗi hoặc chưa kiểm chứng được số liệu pháp lý/an toàn: bỏ khỏi PR, ghi rõ lý do REVIEW, chuyển sang dòng `planned` kế tiếp. Một bài REVIEW không chặn hàng đợi.

## Resume / checkpoint

- `data/writer-checkpoint.json` là checkpoint vận hành: `article_id`, file, bước hiện tại, commit đã push, trạng thái deploy.
- Phiên mới: fetch main, đọc checkpoint + manifest, xác minh remote, tiếp tục đúng bước còn thiếu. KHÔNG viết lại bài đã `published`.
- Manifest là source of truth khi mâu thuẫn với checkpoint.
- Lỗi connector/mạng tạm thời: retry có giới hạn; hết số lần thì ghi checkpoint và dừng rõ lý do. KHÔNG đánh dấu đã publish khi chưa xác minh remote.
- Không đăng bài thử lên site; dùng fixture (`scripts/publish-loop.test.mjs`) khi cần thử gate.

## Trạng thái manifest

`planned → drafting → review → published`. `skip` để bỏ một bài. Không dùng trạng thái khác. Bài đã live giữ nguyên URL (`permalink: /:title/`). Việc chuyển `published` do `scripts/sync-manifest.mjs` derive từ repository truth trong publish transaction — writer không tự sửa manifest.

## QA nhẹ — chặn publish

1. Front matter hợp lệ, đủ trường theo `docs/SCHEMA-ARTICLE.md`.
2. Không trùng slug/permalink/ID; không ghi đè bài đã đăng; sao chép nguyên bài bị chặn.
3. Không bài rỗng/placeholder, không Liquid/YAML hỏng, không nội dung cắt rõ ràng.
4. Link nội bộ trỏ tới URL tồn tại (`scripts/check-links.mjs`).
5. Jekyll build thành công; URL xuất bản tồn tại trong `_site` + sitemap (`scripts/validate-built.mjs`).
6. Không secrets hoặc file ngoài phạm vi commit (publish workflow từ chối mọi path ngoài `_posts/**` và allowlist dẫn xuất).

Gate: `validate-content.mjs`, `validate-content-quality.mjs`, `detect-duplicates.mjs`, `check-links.mjs`, `validate-sitemap.mjs`, `validate-built.mjs`, `sync-manifest.mjs --dry-run`. Không dùng `|| true` để che lỗi validator; WARNING biên tập in rõ khác FAIL.

## WARNING — không chặn publish

Similarity token giữa topic, title gần giống, cannibalization, số từ/H2/FAQ/internal links, SEO score, orphan/cluster. Các cảnh báo này chỉ để audit sau. Không hạ tiêu chuẩn bằng cách bịa nguồn, luật, giá, thông số. Full audit sâu (legal freshness) chỉ chạy thủ công qua workflow_dispatch; CI lưu báo cáo bằng artifacts, không commit vào repo. Không chạy full-site SEO audit/soak test cho từng bài; audit sâu chạy thủ công hoặc khi hoàn thành kế hoạch.

## Nội quy

- Không bịa giá, thông số kỹ thuật, luật, trải nghiệm, nguồn dẫn. Bài có khẳng định pháp lý/an toàn chưa kiểm chứng giữ `review` hoặc bỏ khẳng định.
- Không yêu cầu viết dài để đủ quota. Không tự tạo hàng nghìn đề tài trùng để đạt chỉ tiêu 20.000 bài; hết row hợp lệ thì báo số đã đăng, số còn thiếu và checkpoint.
- Menu/taxonomy/hub/danh-mục/giao diện/baseurl giữ nguyên. Số liệu pháp lý đối chiếu `data/legal-sources.yml`.
- Actions KHÔNG tự ghi main: `publish.yml` chỉ commit dữ liệu dẫn xuất (allowlist: manifest, progress, sitemap) vào nhánh PR; main chỉ nhận qua merge sau khi CI xanh.

## Lệnh chính cho lượt viết tiếp theo

```bash
# 1. Đọc manifest (lọc status=planned), chọn dòng đầu tiên theo thứ tự matrix
# 2. Viết bài vào _posts/YYYY-MM-DD-<slug>.md
# 3. Push nhánh article/<id> (chỉ file bài + checkpoint), mở PR
# 4. publish.yml derive + gates; CI xanh thì merge
# 5. Xác minh URL live, cập nhật checkpoint, lặp lại bài kế.
```
