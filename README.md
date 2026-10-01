# codeappweb/lab — Hướng dẫn vận hành cho Mistral

Jekyll site, GitHub Pages, baseurl `/lab`, live: <https://codeappweb.github.io/lab/>.

Mô hình: Mistral (phiên đăng nhập hiện có) là người viết nội dung. GitHub Actions là factory tất định: claim, QA scoped, publish transactional, build. GitHub Pages deploy từ nhánh main — một đường deploy duy nhất. Không dùng MISTRAL_API_KEY hay API sinh bài trả phí. Một writer Mistral hoạt động tại một thời điểm.

Vòng vận hành mặc định (PUSH-DRIVEN PAIR PRODUCTION, port ý tưởng /vanchinh): FETCH → NEXT-PAIR (exact 2 ID) → WRITE 2 → PUSH NGAY → FACTORY tự select exact IDs → claim → QA scoped → publish transactional → light verify → CHECKPOINT → NEXT 2 (chi tiết: `AGENTS.md`, `docs/MICRO-LOOP.md`). Writer chỉ viết và push file bài; Actions tự hoàn tất derived state, chỉ commit derived allowlist khi mọi gate xanh. Không chờ đủ batch; bài đạt QA tối thiểu thì đăng ngay.

## Vòng lặp vận hành (mỗi cặp 2 bài)

1. FETCH fresh main; nếu phiên mới/reset: chạy `node scripts/next-pair.mjs` — exact IDs từ manifest + review_queue (không hard-code, không tin state workspace cũ).
2. WRITE 2 bài vào `_posts/YYYY-MM-DD-<slug>.md` theo `docs/SCHEMA-ARTICLE.md`.
3. PUSH NGAY lên main — chỉ 2 file bài. Không gom nhiều bài local, không chạy derived/QA thủ công.
4. FACTORY (`production.yml`): select exact NEW/REPAIR từ push → claim (từ chối slug đã published, file ngoài `_posts/`, vượt hard max) → derive manifest/progress/sitemap → 6 gate nhẹ → commit CHỈ derived allowlist → push lại main (rebase + revalidate, không force-push).
5. `ci.yml` build (light verify) trên main. VERIFY Pages deploy: chỉ báo live khi URL trả nội dung mới.
6. CHECKPOINT: cập nhật `data/writer-checkpoint.json` theo thực tế remote/live; hết phiên → `idle/awaiting-user-command`.
7. Bài lỗi hoặc chưa chắc chắn về số liệu pháp lý/an toàn: không push; ghi lý do REVIEW cụ thể vào review_queue, KHÔNG bịa nguồn, KHÔNG gắn verified giả.
8. REPAIR bài đã live: sửa đúng file `_posts/` rồi push riêng; không đổi URL đã live.
9. Báo cáo cuối: số cặp đăng, URL live đã kiểm tra, bài giữ lại + lý do, trạng thái CI/deploy.

## Resume / checkpoint

- `data/writer-checkpoint.json` + manifest là checkpoint; mỗi cặp push + factory xanh = safe checkpoint.
- Phiên mới: fetch fresh main → `next-pair` → viết cặp kế; không viết lại bài đã `published`.
- Không đăng bài thử lên site; dùng fixture khi cần thử gate.

## Trạng thái manifest

`planned → drafting → review → published`. `skip` để bỏ một bài. Không dùng trạng thái khác. Bài đã live giữ nguyên URL (`permalink: /:title/`).

## QA nhẹ — chặn publish

1. Front matter hợp lệ, đủ trường theo `docs/SCHEMA-ARTICLE.md`.
2. Không trùng slug/permalink/ID; không ghi đè bài đã đăng; sao chép nguyên bài bị chặn.
3. Không bài rỗng/placeholder, không Liquid/YAML hỏng, không nội dung cắt rõ ràng.
4. Link nội bộ trỏ tới URL tồn tại (`scripts/check-links.mjs`).
5. Jekyll build thành công; URL xuất bản tồn tại trong `_site` + sitemap (`scripts/validate-built.mjs`).
6. Không commit secrets, cache, file test, dữ liệu ngoài phạm vi.

Gate: `validate-content.mjs`, `validate-content-quality.mjs`, `detect-duplicates.mjs`, `check-links.mjs`, `validate-sitemap.mjs`, `sync-manifest.mjs --dry-run`. Hot path của một cặp KHÔNG chạy full-site audit, regression tests toàn repo, soak hay legal freshness. Regression tests engine (`node --test scripts/*.test.mjs`) chỉ chạy khi `scripts/**` hoặc `.github/workflows/**` đổi — áp cho cả PR và push main. Full audit sâu chỉ chạy thủ công qua workflow_dispatch; CI lưu báo cáo bằng artifacts, không commit vào repo.

## WARNING — không chặn publish

Similarity token giữa topic, title gần giống, cannibalization, số từ/H2/FAQ/internal links, SEO score, orphan/cluster. Các cảnh báo này chỉ để audit sau.

## Nội quy

- Không bịa giá, thông số kỹ thuật, luật, trải nghiệm, nguồn dẫn. Bài có khẳng định pháp lý/an toàn chưa kiểm chứng giữ `review` hoặc bỏ khẳng định.
- Không yêu cầu viết dài để đủ quota.
- Menu/taxonomy/hub/danh-mục/giao diện/baseurl giữ nguyên. Số liệu pháp lý đối chiếu `data/legal-sources.yml`.

## Lệnh chính cho mỗi cặp

```bash
git fetch origin && git reset --hard origin/main   # fetch fresh main
node scripts/next-pair.mjs                          # exact 2 ID kế tiếp
# WRITE 2 bài vào _posts/YYYY-MM-DD-<slug>.md
git add _posts/... && git commit -m "write(pair): <2 id>" && git push origin main
# production.yml tự claim → QA scoped → publish transactional; chờ xanh rồi lặp lại.
```
