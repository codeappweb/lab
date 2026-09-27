# ENGINE (legacy pointer)

Tài liệu vận hành engine đã chuyển sang [ENGINE-RUNBOOK.md](ENGINE-RUNBOOK.md).

Lưu ý quan trọng so với bản cũ của tài liệu này:

- Cờ `verify <slug> --live` đã bị XÓA: `verify` giờ kiểm tra thật (URL live 200 + đúng nội dung + revision Pages khớp `--sha`) và từ chối ghi `verified_live` khi thiếu bằng chứng.
- Provider `mistral_vibe_local` là manual draft ingestion (không phải automated writing); cần `drafts/<slug>.md` + `drafts/<slug>.meta.json` với `sources[]` và `outline[]`.
- `retry` giờ phải kèm `run --resume` để retry thực sự chạy.
- Provider `mistral_api` báo BLOCKED cho đến khi có adapter thật và người dùng cấp quyền gọi API trả phí.
