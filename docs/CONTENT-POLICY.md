# CONTENT POLICY — chuẩn nội dung và điều kiện xuất bản

## Độ dài và phương pháp đếm

- Bài production MỚI: 1.200–2.000 "âm tiết" tiếng Việt — phương pháp đếm có tài liệu hóa: tách theo whitespace, mỗi token chứa ký tự tiếng Việt/số tính 1 (identical trong `scripts/validate-content-quality.mjs`, `seo-score.mjs` và engine `validateDraft`). Front matter không tính.
- Bài legacy (có `manifest_id`) không bị mass-rewrite; chuẩn áp cho bài mới.

## Intent và bằng chứng

- Một bài = MỘT intent hữu ích riêng, không trùng intent với bài/trang danh mục khác (dedupe theo intent-token trong topics.mjs và detect-duplicates).
- Mọi tuyên bố kỹ thuật/pháp lý phải có nguồn: entry tương ứng trong `data/legal-sources.yml` (source_title, source_url, publisher, published_or_effective_date, fact, last_verified, applies_to).
- KHÔNG bịa giá, luật, thông số, nguồn, số liệu. Số pháp lý đối chiếu văn bản hiện hành (ví dụ NĐ 168/2024/NĐ-CP, sửa đổi bởi NĐ 238/2026/NĐ-CP) trước khi xuất bản.

## Review pháp lý/kỹ thuật

- `legal_sensitivity: true` hoặc topic pháp lý: bắt buộc review legal-freshness (`--gate`) trước khi draft được coi eligible; source quá hạn `next_review` chặn publish.

## Tương thích legacy và ID ổn định

- Bài giữ permalink `/:title/`; không đổi URL/ID đã publish. ID ổn định: `id` trong front matter; legacy dùng `manifest_id` (map qua `data/article-taxonomy.yml`), không sửa file legacy chỉ để đổi schema.
- Schema: [SCHEMA-ARTICLE.md](SCHEMA-ARTICLE.md) là tài liệu authoritative.

## Điều kiện xuất bản (publication eligibility)

Job chỉ đạt `ready` khi draft pass: front matter đầy đủ (title, description, id, parent_category, child_category, search_intent), độ dài trong chuẩn, không phải mock (mock bị cấm tuyệt đối ngoài dry-run). Xuất bản thật yêu cầu thêm: toàn bộ gate suite (`validate-deploy.mjs`) xanh với bài đã ở trong `_posts/`, commit tạo ra (`committed_sha`), và xác minh live (`verify --sha`) thành công. Không có đường tắt; không dùng kết quả mock làm bằng chứng.

## Thí nghiệm SEO (giữ nguyên)

Không kết nối Search Console, không thẻ xác minh, không submit sitemap/indexing thủ công, không noindex bài đã publish. Quan sát discovery qua `reports/google-discovery.json` (ghi thủ công).
