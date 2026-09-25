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
## Category SEO audit (2026-09-25)

- 12 trang cha `danh-muc/<slug>.md`: nội dung editorial ~1.500–1.800 từ, mỗi trang một intent chính riêng, title + meta description duy nhất (không pattern "X | Blog"), internal link cha→con + sang parent liên quan.
- `danh-muc/index.md`: ~700 từ, vai trò site-wide category discovery, không cạnh tranh trang cha.
- 92/98 con chưa có bài: `noindex: true` + `sitemap: false` (giữ taxonomy & URL, không filler). 6 con sua-chua có bài thật giữ index với title SEO riêng; chan-doan-loi có nội dung Tier A ~1.000 từ.
- Cannibalization hub vs taxonomy: 12 hub C01–C12 (biên tập nội bộ) được `noindex` + khỏi sitemap + ghi chú mục đích; taxonomy page là landing SEO công khai duy nhất cho từng intent.
- Nội dung category nằm trong file .md (không nhét vào taxonomy.yml); taxonomy.yml giữ nguyên vai trò dữ liệu cấu trúc.
- Pháp lý: chỉ dẫn số liệu đã kiểm chứng (vd. khung phạt mũ bảo hiểm theo NĐ 168/2024/NĐ-CP); mọi bài pháp lý phải đối chiếu văn bản hiện hành trước khi xuất bản.

## Content hardening (2026-09-25)

Ngày 25/09/2026, toàn site qua đợt hardening SEO/nội dung trước khi sản xuất bài mới.

### Cổng an toàn triển khai (bắt buộc)

Trước MỌI lần push nội dung mới:

1. Chạy `node scripts/validate-content-quality.mjs` (validator chất lượng nội dung).
2. Nếu validator trả về lỗi (exit 1): KHÔNG push. Sửa lỗi trước.
3. Validator phát hiện: ký tự CJK trong nội dung tiếng Việt, artifact "undefined" trong tên file/nội dung, front matter hỏng, permalink trùng, thiếu title, thiếu description ở trang indexable, nhiều H1, artifact gạch dưới trong văn xuôi, trang danh mục indexable trống/nhỏ hơn 200 từ, template search vẫn chứa hub hoặc thiếu filter noindex. Từ kỹ thuật tiếng Anh hợp lệ (BMS, GPS, LFP, Lithium, Smartkey, CVT...) KHÔNG bị cấm.

### Quy tắc đưa chuyên mục con vào trạng thái indexable

Chuyên mục con CHỈ được index khi đồng thời thỏa cả bốn điều kiện:

1. Có tối thiểu 3 bài viết thực sự liên quan đã xuất bản.
2. Có nội dung giới thiệu chuyên mục duy nhất, có giá trị standalone.
3. Có search intent riêng, không trùng intent với trang cha hoặc anh em.
4. Không cannibalization với trang cha/sibling.

Số lượng bài KHÔNG phải tiêu chí duy nhất. Hiện trạng sau hardening: chỉ sua-chua/chan-doan-loi đạt chuẩn indexable (3 bài + nội dung Tier A). Năm con còn lại của sua-chua (dong-co, khoi-dong, truyen-dong, phanh-xe, lop-xe) chỉ có 1 bài mỗi con nên bị hạ về noindex + khỏi sitemap; 92 con trống giữ noindex từ đợt trước.

### Trạng thái taxonomy

Mỗi child trong data/taxonomy.yml có trường `status`:
- `active`: có nội dung standalone + đủ bài, indexable (hiện chỉ chan-doan-loi).
- `in-progress`: có bài thật nhưng chưa đủ chuẩn indexable (5 con sua-chua còn lại).
- `planned`: chưa có nội dung, noindex, chờ kích hoạt sau.

### Lọc search / AI retrieval

assets/search.json và assets/data/content-index.json chỉ xuất: bài viết, 12 trang danh mục cha, và chuyên mục con KHÔNG noindex. Hub C01–C12 và mọi trang có `noindex: true` bị loại khỏi kết quả tìm kiếm và AI retrieval.

### Nguồn pháp lý

Mọi con số pháp lý (mức phạt, thuế phí, đăng ký, bảo hiểm) phải có mục nguồn tương ứng trong data/legal-sources.yml (source_title, source_url, publisher, published_or_effective_date, fact, last_verified, applies_to). Không ghi "đã kiểm chứng" nếu chưa ghi nguồn. Cập nhật theo Nghị định 238/2026/NĐ-CP (sửa đổi NĐ 168/2024, hiệu lực 15/08/2026, không thay đổi khung phạt tiền).

### Đồng bộ manifest

data/progress.json phải khớp trạng thái thực tế: 8 bài C05 đã live, kiểm tra render/canonical/title/meta/link → chuyển `qa` thành `published`. Trang đã live không được giữ trạng thái `qa`.

### Sửa lỗi hạ tầng phát hiện trong đợt này

- Bug Liquid `cco\nunt` trong _layouts/parent-category.html làm mất đếm bài của card chuyên mục con — đã sửa.
- Hai khối child hỏng trong data/taxonomy.yml (su-dung-xe thiếu thụt lề description, nuoi-xe sai thụt lề slug) — đã sửa.
- 229 link markdown ghi đường dẫn gốc `/danh-muc/...` bị 404 trên live (baseurl /lab/ không được tự thêm) — đã chuyển toàn bộ sang dạng `{{ '...' | relative_url }}` trong 12 trang cha, chan-doan-loi và danh-muc/index.md.
