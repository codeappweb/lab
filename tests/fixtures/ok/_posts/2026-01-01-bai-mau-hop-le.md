---
layout: post
title: "Bài mẫu hợp lệ cho selftest"
date: 2026-01-01 00:00:00 +0700
description: "Mô tả mẫu đủ dài để vượt mọi kiểm tra định dạng cơ bản của validator trong bài kiểm thử tự động."
id: FX-0001
cluster: C01
search_intent: informational
legal_sensitivity: false
freshness_status: evergreen
parent_category: xe-may
child_category: xe-so
---
## Mở đầu

Đây là bài mẫu hợp lệ dùng cho selftest. Thân bài có đủ từ khóa, cấu trúc đề mục và liên kết nội bộ đến danh mục mẫu. Fixture này mô phỏng một bài viết đạt chuẩn tối thiểu của validator: dài hơn ba trăm âm tiết tiếng Việt, có đúng một ý định tìm kiếm, không có tiêu đề cấp một trong thân bài vì layout đã cung cấp, và chỉ chứa các liên kết nội bộ hợp lệ. Mọi câu trong bài đều là dữ liệu giả lập phục vụ kiểm thử tự động.

## Thân bài

Bài này kiểm tra các ràng buộc chính của cổng chất lượng nội dung. Kiểm tra đếm từ áp dụng phương pháp đếm âm tiết tiếng Việt đã được tài liệu hóa: tách theo khoảng trắng, loại bỏ ký tự cú pháp markdown, mỗi token chứa ký tự chữ hoặc số được tính là một âm tiết. Bài phải vượt ngưỡng ba trăm âm tiết để không bị coi là nội dung mỏng, vì validator coi bài ngắn trong thư mục bài viết là dấu hiệu của nội dung rác hoặc bản nháp bị lỗi. Bài cũng phải có mô tả đủ dài trong phần front matter để mô phỏng bài thật. Liên kết đến [danh mục mẫu](/danh-muc/sua-chua/) và về [trang chủ](/) giúp trình kiểm tra liên kết xác nhận đích nội bộ tồn tại trong cây fixture.

Validator còn kiểm tra tiêu đề không chứa các artifact như undefined, NaN hay null, kiểm tra tên tệp không chứa khoảng trắng hay ký tự xuống dòng, kiểm tra tiêu đề không trùng lặp giữa các bài, và kiểm tra bài phải có mã định danh trong front matter. Bài mẫu này khai báo mã định danh hợp lệ, tiêu đề duy nhất, không chứa ký tự CJK, và ngày phát hành trong quá khứ để mọi kiểm tra ngày hiệu lực đều đạt. Thân bài được chia thành ba đề mục cấp hai để có cấu trúc tối thiểu mà trình chấm điểm nội bộ yêu cầu.

## Kết luận

Fixture này phải PASS mọi gate. Nội dung tạp chất không có, mọi liên kết đều hợp lệ, và toàn bộ dữ liệu là giả lập phục vụ duy nhất việc kiểm thử validator. Sau khi bài vượt qua cổng, selftest mới chuyển sang kiểm tra cây fixture xấu để xác nhận mỗi validator đều báo lỗi đúng như thiết kế. Cơ chế kép này đảm bảo bộ validator không bao giờ được phép nới lỏng: cây tốt phải đi qua, cây xấu phải bị chặn. Đây là nguyên tắc nền tảng của pipeline nội dung tự trị.
