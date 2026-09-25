# Xe &amp; Di Chuyển (codeappweb/lab)

Jekyll site, GitHub Pages, baseurl `/lab/`, live tại <https://codeappweb.github.io/lab/>.

## Kiến trúc điều hướng

- `data/navigation.yml` — nguồn DUY NHẤT của menu trang: 7 mục tĩnh (Trang chủ, Giới thiệu, Liên hệ, Câu hỏi, Dịch vụ, Bảo mật, Điều khoản) dùng chung cho header, drawer và footer.
- `data/taxonomy.yml` — nguồn DUY NHẤT của taxonomy công khai: 12 danh mục cha + 98 chuyên mục con. Mọi nơi hiển thị danh mục (homepage explorer, /danh-muc/, trang cha, drawer, mega menu, footer, search index) đều render từ file này — không duy trì danh sách danh mục thứ hai bằng tay.
- Trang tĩnh và taxonomy tách bạch: menu chính không chứa danh mục bài viết; danh mục bắt đầu sau divider "Danh mục".

## Thứ tự danh mục cha (theo hành trình người dùng, KHÔNG alphabet)

1. Xe máy (P01) ~230 bài
2. Xe điện (P02) ~210
3. Xe đạp (P03) ~140
4. Thuê xe (P06) ~140
5. Sửa chữa (P04) ~220
6. Phụ tùng (P05) ~150
7. Du lịch (P07) ~260
8. Phượt xe (P08) ~170
9. Pháp lý (P09) ~130 (needs_official_source: true)
10. An toàn (P10) ~110
11. Chi phí (P12) ~140
12. Công nghệ (P11) ~100

Tổng quy hoạch ~2.000 bài. Trường `planned_capacity` ở cấp cha và con là chỉ tiêu biên tập, KHÔNG hiển thị cho người dùng, không tự sinh bài filler. Không con nào chiếm quá ~30–35% sức chứa của cha.

## URL danh mục

- Cha: `/danh-muc/<slug-cha>/`
- Con: `/danh-muc/<slug-cha>/<slug-con>/`
- Breadcrumb chuẩn: Trang chủ → Danh mục → Cha → Con → Bài.
- Bài viết giữ permalink `/:title/` — KHÔNG đổi URL bài khi đổi taxonomy.

## Phân loại bài viết

Mỗi bài MỘT cha + MỘT con chính:

```
parent_category: sua-chua
child_category: chan-doan-loi
```

Chủ đề liên quan dùng tags/entities/related_topics, không gán nhiều danh mục compete. 8 bài C05 hiện có được map qua `data/article-taxonomy.yml` (fallback) vì không sửa file bài; bài mới bắt buộc khai báo front matter.

## Điều hướng

- Mobile drawer: 7 mục trang + divider + 12 accordion cha (chỉ một accordion mở tại một thời điểm, tự mở danh mục hiện tại, Esc/focus do main.js, touch target >= 44px).
- Desktop: header giữ 7 mục + nút "Danh mục" mở mega menu 12 cột cha/con (CSS :hover/:focus-within, ẩn dưới 900px).
- Footer: "Trang" = 7 mục; "Khám phá" = 12 cha; KHÔNG dump con vào footer.
- CSS lớp `assets/css/app4.css` (sau app3), JS bổ sung `assets/js/nav2.js` (accordion, body scroll lock, aria).

## Hai hệ thống cluster vs taxonomy

- Cluster C01–C12 (`/hub/cNN/)` = biên tập nội dung / AI workflow. Giữ nguyên URL.
- Taxonomy cha/con (`/danh-muc/`) = điều hướng công khai / SEO.
- Hai hệ không trộn; trang cha liên kết hub tương ứng qua trường `cluster`.

## Sitemap & SEO

- jekyll-sitemap plugin tự sinh sitemap gồm mọi trang — KHÔNG chạy lại `scripts/build-sitemap.mjs` (bản cũ theo manifest, đã lỗi thời).
- Mỗi trang danh mục có H1/title/description/canonical duy nhất; trang con chưa có nội dung hiển thị trạng thái "Nội dung đang được chuẩn bị" trung thực.
- Tìm kiếm (Ctrl K) và Trợ lý AI hiểu trường parent/child trong `assets/search.json` và `assets/data/content-index.json` (sinh tự động khi build).

## Lưu ý vận hành

- GitHub Pages build có thể kẹt queue vài phút; nếu deploy không cập nhật, retrigger bằng commit nhỏ.
- GitHub App không có quyền Administration; repo là `lab`, base path `/lab/`.
- Không có trình duyệt trong sandbox — kiểm tra tương tác qua HTML/render text.
