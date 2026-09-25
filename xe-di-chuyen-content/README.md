# Xe & Di Chuyển Content Hub

Content hub ~3.000 bài về xe, giao thông, du lịch bằng xe và hệ sinh thái di chuyển. Lõi là Hà Nội, mở rộng hợp lý sang các chủ đề liên quan trực tiếp đến xe và di chuyển.

Website tham chiếu về FORMAT nội dung: https://thuexemayhanoi.github.io/blog/ — chỉ tham khảo dạng trình bày. KHÔNG copy nội dung, KHÔNG dùng brand name làm keyword chính.

Tài liệu này là nguồn điều hành chính. Mọi phiên AI làm việc với repo này PHẢI đọc `README.md` + `data/progress.json` + `data/article-manifest.jsonl` trước khi làm bất cứ việc gì.

LƯU Ý TRIỂN KHAI: project hiện nằm trong thư mục con `xe-di-chuyen-content/` của repo `codeappweb/lab`. Muốn deploy GitHub Pages đúng cấu trúc, cần tách repo riêng (root) hoặc cấu hình Pages trỏ đúng thư mục. Cấu trúc bên trong đã là một Jekyll site hoàn chỉnh.

## 1. Kiến trúc repo

Framework: Jekyll, deploy bằng GitHub Pages. Bài viết là Markdown trong `_posts/`, permalink `/:title/`. Hub pages trong `hub/`.

```
├── README.md                  # tài liệu điều hành (file này)
├── _config.yml                # cấu hình Jekyll
├── _layouts/                  # default.html, post.html, hub.html
├── _includes/                 # head.html
├── _posts/                    # bài viết (một file = một bài, tên: YYYY-MM-DD-slug.md)
├── hub/                       # hub page c01.md .. c12.md, URL /hub/cNN/
├── data/
│   ├── article-manifest.jsonl # manifest toàn bộ bài (mỗi dòng 1 record)
│   ├── progress.json          # trạng thái tổng thể + batch history
│   ├── entities.json          # entity chính và tần suất sử dụng
│   ├── sources.json           # nguồn chính thống bắt buộc cho nhóm pháp lý
│   └── cluster-map.json       # định nghĩa 12 cluster + budget
├── scripts/
│   ├── validate-content.mjs  # QA manifest + bài viết
│   ├── detect-duplicates.mjs  # kiểm tra title/slug/intent trùng
│   ├── check-links.mjs        # kiểm tra internal link
│   └── build-sitemap.mjs      # sinh sitemap.xml
├── index.md
├── robots.txt
└── Gemfile
```

## 2. Cluster map (content budget, KHÔNG phải chỉ tiêu bắt buộc)

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

Tổng budget: ~3.000. Đây là mức trần hợp lý, KHÔNG phải mục tiêu phải đạt. Nếu hai chủ đề cùng intent thì MERGE; chủ đề không đủ giá trị thì SKIP.

Chi tiết: `data/cluster-map.json`.

## 3. Manifest schema

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

- `needs_official_source: true` (nhóm pháp lý C07, bài có giá/lệ phí/mức phạt): bắt buộc dẫn nguồn chính thống trong `sources.json` trước khi chuyển `qa`.
- `similarity_group`: các bài cùng group phải kiểm tra cannibalization trước khi viết.
- Bài đã viết nằm trong `_posts/` với tên `YYYY-MM-DD-<slug>.md`, front matter có `cluster` và `manifest_id`.

## 4. Workflow mỗi batch (bắt buộc theo thứ tự)

Batch mặc định 10–20 bài, tối đa 25 bài.

1. Đọc README này.
2. Đọc `data/progress.json`.
3. Đọc `data/article-manifest.jsonl`.
4. Kiểm tra bài hiện có trong `_posts/` và `hub/`.
5. Chọn topic status `planned`, ưu tiên theo chiến lược ở mục 6.
6. Chạy `node scripts/detect-duplicates.mjs` — nếu trùng intent: MERGE hoặc SKIP, cập nhật manifest.
7. Research (bài pháp lý: nguồn chính thống, ghi vào `source_plan`).
8. Viết bài vào `_posts/` (front matter: layout, title, date, description, cluster, manifest_id).
9. QA: chạy `node scripts/validate-content.mjs` (không có Node thì chạy logic kiểm tra tương đương và ghi vào progress).
10. Internal linking: mỗi bài link lên hub + 2–3 bài liên quan; anchor đa dạng.
11. Build/test: `bundle exec jekyll build` (hoặc kiểm tra GitHub Pages build).
12. Cập nhật sitemap nếu có URL mới: `node scripts/build-sitemap.mjs`.
13. Cập nhật manifest (status, title, slug, published_url, internal_links).
14. Cập nhật `data/progress.json` (articles count, batches, next_actions).
15. DỪNG và trả BATCH REPORT theo mẫu ở mục 8.

KHÔNG tự viết batch tiếp khi chưa có lệnh.

## 5. Quy tắc chất lượng

Cấm:
- keyword stuffing, spin content, template chỉ đổi tên địa điểm/tên xe;
- fake review, fake trải nghiệm, fake tác giả, fake quote, fake rating;
- bịa địa chỉ, giá, thông số, luật, mức phạt, giờ mở cửa, tình trạng đường, bãi gửi xe;
- nhét brand name vào tiêu đề để SEO.

Mỗi bài: H1 duy nhất (do layout render từ title), title/slug/manifest_id duy nhất, intro trả lời đúng intent, H2/H3 hợp lý, internal links, ngày cập nhật, nguồn khi có dữ liệu dễ thay đổi, canonical hợp lệ (layout default đã render). Độ dài đúng mức cần thiết cho intent, không quy định số từ.

## 6. Thứ tự ưu tiên viết bài

1. Hub pages 12 cluster — ĐÃ XONG (batch 001).
2. C05, C03, C02 — cluster kỹ thuật, ít phụ thuộc kiểm chứng pháp lý.
3. C08, C09 — du lịch/phượt (cần research kỹ gửi xe, route).
4. C07, C12 — pháp lý/kiểm chứng mạnh, chỉ viết khi có nguồn chính thống.
5. C01, C04, C06, C10, C11 bổ sung.

## 7. Internal linking

- Mỗi bài link lên parent hub `/hub/cNN/`.
- Link 2–3 bài liên quan cùng cluster, 1–2 bài cross-cluster khi hữu ích.
- URL bài: `/<slug>/` (permalink `/:title/`).
- Không dùng cùng một exact-match anchor lặp lại hàng loạt.

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

- Batch 001 hoàn tất: 12 hub page thật + 8 bài C05 (C05-0001..C05-0008) trạng thái qa trong manifest, file bài trong `_posts/2026-09-25-*.md`.
- 193 topic còn lại trạng thái planned.
- Mã nguồn đã được đẩy lên GitHub: repo `codeappweb/lab`, thư mục con `xe-di-chuyen-content/`.
- Next: batch-002 theo `data/progress.json > next_actions` (8 bài C05 bảo dưỡng định kỳ + 5 bài C03).
