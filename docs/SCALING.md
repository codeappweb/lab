# SCALING — số đo, phương pháp, ngoại suy

Số liệu sống trong `reports/capacity.json` (sinh bởi `scripts/measure-output.mjs`, đo TOÀN BỘ output build — HTML, index, assets — không chỉ thân bài). Docs không hardcode số liệu biến động.

## Đã đo (xem report mới nhất trong CI)

- Số bài hiện tại, tổng bytes build, bytes/bài trung bình, số file — chạy trên `_site` thật sau `jekyll build` trong validate.yml.
- Khi `_site` không có (chạy local không build), report ghi rõ `source_estimate` — ƯỚC TÍNH, không phải số đo.

## Ngoại suy (ghi nhãn: ESTIMATE)

- `projected_20k_bytes` = tổng đo + (bytes/bài) × (20000 − số bài hiện tại), LINEAR EXTRAPOLATION từ trung bình đã đo. Chỉ hợp lệ nếu kích thước bài giữ nguyên phân bố (giả định cần đo lại theo mốc: 1K, 5K, 20K bài).
- Giới hạn hosting: GitHub Pages ~1 GB published site. So sánh với tổng output đo, không so với body text.

## Điều kiện trước khi tuyên bố đủ sức 20K

1. Đo trên build thật tại các mốc 1.000 / 5.000 / 20.000 bài; ngoại suy tuyến tính phải được xác nhận tại mốc tiếp theo.
2. Thời gian build Jekyll đo được tại các mốc và còn trong hạn mức runner (6h/job).
3. Search index + sitemap shards sinh trong thời gian bounded (đo bằng CI logs).
4. Kết quả từ mock/fixtures KHÔNG bao giờ được dùng làm bằng chứng.
5. Chỉ khi cả bốn điều kiện trên có số đo: cập nhật `PROJECT-STATUS.md` mục Verified. Hiện tại: 20K CAPACITY CHƯA được xác minh — chỉ có ước tính được ghi nhãn.
