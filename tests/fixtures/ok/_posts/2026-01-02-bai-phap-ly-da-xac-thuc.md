---
layout: post
title: "Bài pháp lý đã xác thực cho selftest"
date: 2026-01-02 00:00:00 +0700
description: "Fixture hợp lệ: bản ghi pháp lý đầy đủ và nhất quán — nguồn đã kiểm tra, ngày kiểm tra, ngày tái kiểm tra, trạng thái xác thực."
id: FX-0002
cluster: C01
search_intent: informational
legal_sensitivity: true
freshness_status: evergreen
parent_category: phap-ly
child_category: muc-phat
verified_source: "https://vanban.chinhphu.vn/nghi-dinh-mau.html"
last_verified: 2025-12-01
next_review: 2027-01-01
verification_status: verified
---
## Mở đầu

Đây là fixture pháp lý hợp lệ dùng cho selftest của cổng xác minh pháp lý. Bài khai báo đủ bốn trường bắt buộc: nguồn đã kiểm tra, ngày kiểm tra nguồn, ngày phải tái kiểm tra, và trạng thái xác thực bằng verified. Mọi giá trị trong fixture là dữ liệu giả lập phục vụ kiểm thử tự động, không phải nội dung thật và không bao giờ được build ra site.

## Thân bài

Cổng xác minh đọc các trường đã khai báo và kiểm tra tính nhất quán: ngày kiểm tra nguồn phải là ngày lịch hợp lệ trong quá khứ, ngày tái kiểm tra phải là ngày lịch hợp lệ sau ngày kiểm tra và chưa quá hạn, trạng thái xác thực phải là verified, và không được tồn tại cờ cần kiểm tra pháp lý còn treo. Bài này thỏa toàn bộ các điều kiện đó nên cổng phải cho đi qua. Phương thức đếm từ của validator áp dụng cho thân bài: mỗi token chứa ký tự chữ hoặc số tính một âm tiết, và thân phải vượt ngưỡng ba trăm âm tiết để không bị coi là nội dung mỏng. Bài có liên kết nội bộ hợp lệ tới [danh mục mẫu](/danh-muc/sua-chu/) và [trang chủ](/) để trình kiểm tra liên kết xác nhận đích tồn tại trong cây fixture.

Fixture này bảo vệ hồi quy tính đúng đắn của cổng: một bản ghi pháp lý đầy đủ, nhất quán và đã kiểm tra nguồn phải được chấp nhận; mọi biến thể thiếu trường, mâu thuẫn hoặc chưa xác thực phải bị chặn ở cây xấu. Không có trường hợp nào được phép đi qua vì cổng bị nới lỏng.

## Kết luận

Fixture hợp lệ này phải vượt toàn bộ cổng trong cây ok. Nó tồn tại để chứng minh cổng phân biệt được giữa một bản ghi pháp lý thực sự đã kiểm tra nguồn và một lời khai báo đường dẫn suông, giữa ngày hợp lệ và ngày bịa trong tương lai, giữa trạng thái đã xác thực và trạng thái cần kiểm tra pháp lý.
