---
layout: post
title: "Bài pháp lý chưa xác thực bị chặn"
date: 2026-01-03 00:00:00 +0700
description: "Fixture lỗi: URL và ngày tương lai không lập được trạng thái đã xác thực — cổng pháp lý phải chặn."
id: FX-B003
cluster: C01
search_intent: informational
legal_sensitivity: true
legal_source: https://example.invalid/unverified
next_review: 2099-01-01
verification_status: needs_legal_review
needs_legal_review: true
---
## Nội dung

Bài này phải bị legal-freshness-audit chặn bất chấp việc khai báo một đường dẫn và ngày tái kiểm tra xa trong tương lai: trạng thái xác thực là cần kiểm tra pháp lý, cờ cần kiểm tra vẫn treo, không có ngày kiểm tra nguồn, và đường dẫn không được đăng ký trong sổ nguồn đã kiểm chứng. Một lời khai báo URL không phải bằng chứng đã kiểm tra nguồn. Bài này cũng thiếu các trường bắt buộc của bản ghi pháp lý nên mọi đường tắt đều phải đóng.
