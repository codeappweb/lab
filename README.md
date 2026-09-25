# Xe & Di Chuyển Content Hub

Content hub ~3.000 bài về xe, giao thông, du lịch bằng xe và hệ sinh thái di chuyển. Lõi là Hà Nội, mở rộng hợp lý sang các chủ đề liên quan trực tiếp đến xe và di chuyển.

Tài liệu này là nguồn điều hành chính. Mọi phiên AI làm việc với repo này PHẢI đọc `README.md` + `data/progress.json` + `data/article-manifest.jsonl` trước khi làm bất cứ việc gì.

## 1. Kiến trúc repo

Framework: Jekyll, GitHub Pages project site. Base URL: https://codeappweb.github.io/lab/ — `_config.yml` đặt `baseurl: "/lab"`, mọi internal link trong nội dung dùng prefix `/lab/`. Bài viết là Markdown trong `_posts/`, permalink `/:title/`. Hub pages trong `hub/`. Danh mục cha/con trong `danh-muc/`.

```
├── README.md                  # tài liệu điều hành (file này)
├── _config.yml                # cấu hình Jekyll
├── _layouts/                  # default, post, hub, parent-category, child-category, category-index
├── _includes/                 # head, header, footer, nav-drawer, topic-sheet, quick-actions, assistant...
├── _posts/                    # bài viết (một file = một bài, tên: YYYY-MM-DD-slug.md)
├── hub/                       # hub biên tập c01.md..c12.md, URL /hub/cNN/
├── danh-muc/                  # trang danh mục cha/con, URL /danh-muc/...
├── gioi-thieu.md ... dieu-khoan.md  # 6 trang tĩnh menu
├── data/
│   ├── article-manifest.jsonl # manifest toàn bộ bài (mỗi dòng 1 record) — biên tập
│   ├── progress.json          # trạng thái tổng thể + batch history
│   ├── entities.json          # entity chính và tần suất sử dụng
│   ├── sources.json           # nguồn chính thống bắt buộc cho nhóm pháp lý
│   ├── cluster-map.json       # định nghĩa 12 cluster + budget — biên tập
│   ├── taxonomy.yml           # taxonomy cha/con hiển thị (P01-P12) — tổ chức site
│   ├── navigation.yml         # menu trung tâm duy nhất (header/footer/drawer)
│   └── article-taxonomy.yml    # mapping slug bài -> parent/child (fallback cho bài cũ)
├── scripts/                   # validate-content, detect-duplicates, check-links, build-sitemap
├── index.md
├── robots.txt
└── Gemfile
```

## 2. Cluster map (biên tập nội dung, KHÔNG phải chỉ tiêu bắt buộc)

| ID | Chủ đề | Budget |
|----|--------|--------|
| C01 | Thuê xe: khu vực, thời lượng, nhu cầu | 240 |
| C02 | Xe máy xăng: xe số, xe ga, 50cc, review/so sánh | 260 |
| C03 | Xe máy điện, scooter điện | 300 |
| C04 | Xe đạp, xe đạp điện, commuter, touring | 260 |
| C05 | Sửa chữa, chẩn đoán lỗi, bảo dưỡng | 300 |
| C06 | Phụ tùng: lốp, nhớt, phanh, ắc quy, phụ kiện | 220 |
| C07 | Pháp lý: GPLX, đăng ký, biển số, bảo hiểm, thuế phí, quy định | 240 |
| C08 | Du lịch Hà Nội: điểm đến, cách đi, gửi xe, route, itinerary | 420 |
| C09 | Phượt từ Hà Nội ra miền Bắc | 260 |
| C10 | An toàn, thời tiết, sự cố, kỹ năng lái | 180 |
| C11 | Mua xe, xe cũ, chi phí sở hữu/vận hành | 170 |
| C12 | Pin, sạc, trạm sạc, BMS, công nghệ EV, hạ tầng | 150 |

Tổng budget: ~3.000 — mức trần hợp lý, KHÔNG phải mục tiêu phải đạt. Hai chủ đề cùng intent thì MERGE; chủ đề không đủ giá trị thì SKIP. Chi tiết: `data/cluster-map.json`.

## 3. Hai hệ phân loại song song

- Cluster (C01–C12): hệ biên tập/planning nội dung — dùng trong manifest, hub, workflow batch.
- Taxonomy (P01–P12): hệ tổ chức hiển thị cho người dùng — menu "Danh mục", breadcrumb, trang danh mục.

Cả hai cùng tồn tại; mỗi parent taxonomy có trường `cluster` liên kết sang hub biên tập tương ứng. KHÔNG phá hệ cluster.

### 3.1 Menu trung tâm

`data/navigation.yml` là nguồn DUY NHẤT cho menu chính: header desktop, footer và nav drawer mobile cùng render từ một data này. 7 mục cố định: Trang chủ, Giới thiệu, Liên hệ, Câu hỏi, Dịch vụ, Bảo mật, Điều khoản. URL tương đối (`/gioi-thieu/`...), render bằng `| relative_url` — tự thêm `/lab/`, không bao giờ `/lab/lab/`. Không hardcode menu riêng ở bất kỳ template nào.

### 3.2 Taxonomy cha/con

`data/taxonomy.yml`: 12 parent (id, name, slug, icon, cluster, description, children) + 98 child (id, name, slug, description).

- URL parent: `/danh-muc/<parent>/` — ví dụ `/danh-muc/xe-dien/`.
- URL child: `/danh-muc/<parent>/<child>/` — ví dụ `/danh-muc/xe-dien/pin-xe-dien/`.
- Trang danh mục là stub front matter (layout parent-category / child-category + pslug/cslug); title, description, canonical, breadcrumb, số bài đều sinh trong layout từ dữ liệu thật.
- P09 Pháp lý đánh dấu `needs_official_source: true`; layout hiển thị cảnh báo nguồn chính thống.
- Hub cũ `/hub/cNN/` được giữ nguyên URL và được liên kết từ trang parent tương ứng (trường cluster).

### 3.3 Front matter bài viết

Bài mới bắt buộc thêm 2 trường (slug phải khớp taxonomy.yml):

```yaml
parent_category: xe-dien
child_category: pin-xe-dien
```

8 bài C05 hiện có KHÔNG sửa file; chúng map qua `data/article-taxonomy.yml` (fallback). Layout ưu tiên front matter, chỉ fallback sang file mapping khi thiếu.

### 3.4 Scale 2.000+ bài

- Parent hiển thị tối đa 12 bài, child tối đa 24 bài + ghi chú phần còn lại — không nhồi hàng nghìn link vào một trang.
- Discovery chính: tìm kiếm Ctrl K (index metadata) và Trợ lý AI (core index nhẹ + full-text shard lazy-load theo cluster).
- Content index giữ kiến trúc sharding: `content-index.json` (metadata mọi bài + trang danh mục) + `content-index-cNN.json` (full text, chỉ tải khi cần).
- Thêm danh mục mới: thêm entry vào `taxonomy.yml` + stub trang theo mẫu có sẵn.

## 4. Manifest schema

Mỗi dòng trong `data/article-manifest.jsonl`:

```json
{
  "id": "C08-0001",
  "cluster": "C08",
  "status": "planned",
  "primary_topic": "",
  "search_intent": "",
  "title": "",
  "slug": "",
  "parent_hub": "",
  "entities": [],
  "freshness": "low|medium|high",
  "needs_official_source": false,
  "similarity_group": "",
  "source_plan": [],
  "internal_links": [],
  "published_url": null
}
```

Status hợp lệ: `planned, researching, drafted, qa, published, merge, skip, update_needed`.

- `needs_official_source: true` (C07, bài có giá/lệ phí/mức phạt): bắt buộc dẫn nguồn chính thống trong `sources.json` trước khi chuyển `qa`.
- Bài viết nằm trong `_posts/` với tên `YYYY-MM-DD-<slug>.md`, front matter có `cluster`, `manifest_id`, `parent_category`, `child_category`.

## 5. Workflow mỗi batch (bắt buộc theo thứ tự)

Batch mặc định 10–20 bài, tối đa 25 bài.

1. Đọc README này.
2. Đọc `data/progress.json`.
3. Đọc `data/article-manifest.jsonl`.
4. Kiểm tra `_posts/`, `hub/`, `danh-muc/`.
5. Chọn topic `planned`, ưu tiên theo mục 7.
6. Chạy `node scripts/detect-duplicates.mjs` — trùng intent: MERGE/SKIP.
7. Research (bài pháp lý: nguồn chính thống, ghi vào `source_plan`).
8. Viết bài vào `_posts/` (front matter: layout, title, date, description, cluster, manifest_id, parent_category, child_category).
9. QA: `node scripts/validate-content.mjs` (không có Node thì chạy logic tương đương, ghi vào progress).
10. Internal linking: mỗi bài link lên danh mục cha/con + 2–3 bài liên quan.
11. Build/test: `bundle exec jekyll build` hoặc kiểm tra GitHub Pages build.
12. Sitemap: jekyll-sitemap plugin sinh tự động khi build; KHÔNG chạy lại `scripts/build-sitemap.mjs` (bản cũ theo manifest, đã lỗi thời).
13. Cập nhật manifest (status, title, slug, published_url, internal_links).
14. Cập nhật `data/progress.json`.
15. DỪNG và trả BATCH REPORT theo mẫu mục 8.

KHÔNG tự viết batch tiếp khi chưa có lệnh.

## 6. Quy tắc chất lượng

Cấm: keyword stuffing, spin content, template chỉ đổi tên; fake review/kinh nghiệm/tác giả/quote/rating; bịa địa chỉ, giá, thông số, luật, mức phạt, giờ mở cửa, đường; nhét brand name vào tiêu đề.

Mỗi bài: H1 duy nhất, title/slug/manifest_id duy nhất, intro trả lời đúng intent, H2/H3 hợp lý, internal links, nguồn khi có dữ liệu dễ thay đổi, canonical (layout default đã render). SEO danh mục: mỗi trang cha/con có title + description duy nhất, đúng một H1, breadcrumb, intro hữu ích — không doorway page.

## 7. Thứ tự ưu tiên viết bài

1. Hub pages 12 cluster — ĐÃ XONG.
2. C05, C03, C02.
3. C08, C09.
4. C07, C12 — chỉ viết khi có nguồn chính thống.
5. C01, C04, C06, C10, C11 bổ sung.

## 8. Batch report (bắt buộc sau mỗi batch)

```
BATCH REPORT
- Batch ID:
- Cluster:
- Articles created:
- Articles updated:
- Articles merged:
- Articles skipped:
- Files changed:
- New URLs:
- Duplicate checks:
- Broken links:
- Build/test result:
- Facts requiring human verification:
- Suggested next batch:
```

## 9. Trạng thái hiện tại (2026-09-25)

- Batch 001: 12 hub + 8 bài C05 (qa trong manifest).
- ui-redesign-001, smart-blog-001, nav-taxonomy-001 đã deploy: UI app, quick actions, trợ lý AI cục bộ, chỉ mục nội dung, menu trung tâm, taxonomy 12 cha + 98 con, 6 trang tĩnh, drawer, breadcrumb danh mục.
- Next: batch-002 theo `data/progress.json > next_actions`.

## 10. Smart Blog App (frontend + discovery)

- Content index: `assets/data/content-index.json` (core, metadata + parent/child) + 12 shard full-text lazy-load. Sinh bởi Liquid lúc build, không crawler, không dữ liệu nội bộ.
- Trợ lý AI: `assets/js/assistant/{retrieval,providers,assistant}.js`. Provider mặc định local (không API key). Adapter LLM tương lai: serverless endpoint giữ key phía server, đổi `active` sang remote trong providers.js. KHÔNG BAO GIỜ để API key trong repo.
- Quick Actions: `data/site-actions.yml` — action không cấu hình tự ẩn.
- PWA-lite: manifest + theme-color; không service worker (rủi ro stale cache HTML).

## Về repo

Repo `lab` mô tả: "AI-powered web experiments, tools & automation." Hiện dùng làm host cho content hub này ở root.
