# DEPLOYMENT — nguồn publish, quyền, xác minh revision, rollback

## Cơ chế thật

- GitHub Pages, build từ branch (source = branch deploy). Live: https://codeappweb.github.io/lab/
- `content-pipeline.yml` chạy ĐẦY ĐỦ chuỗi gate trên MỌI đường deploy của nó:
  content checks → deterministic regen → **Jekyll build thật (bundle install +
  `bundle exec jekyll build`, không `|| true`) → `validate-built.mjs --site _site`
  (link/rendered + sitemap membership) → self-heal-audit trên corpus rendered** —
  TẤT CẢ trước khi commit artifacts và request Pages build. Build/render fail
  → job fail → KHÔNG commit, KHÔNG deploy.
- Workflow `validate.yml` (pull_request) KHÔNG tự bảo vệ branch-based Pages
  deployment — dependency này chỉ được enforce vì pipeline deploy tự chạy lại
  các build gate đó (xem Batch "Gates first" + build steps trong
  `content-pipeline.yml`).
- GITHUB_TOKEN push KHÔNG kích hoạt branch build của Pages → pipeline gọi
  `POST /repos/codeappweb/lab/pages/builds` sau khi commit artifacts, rồi
  `verify-deployment.mjs` chờ status `built` và kiểm tra các URL đại diện
  (home, sitemap index, 3 post mới nhất, 3 trang danh mục).

## Phụ thuộc và quyền

- `content-pipeline.yml` cần `contents: write` (commit artifacts) và `pages: write` (POST build).
- Phụ thuộc cài đặt repo (ngoài phạm vi code): Pages build source phải trỏ đúng branch deploy. Workflow validate riêng KHÔNG bảo vệ cài đặt này — nếu pipeline deploy verify fail với sai revision, kiểm tra Pages setting trong repo Settings. Đây là blocker cần xác nhận trên giao diện GitHub, không sửa được từ trong repo.
- `https://codeappweb.github.io/robots.txt` 404: cần user-site repo `codeappweb/codeappweb.github.io` (chưa tồn tại).

## Xác minh revision (không tin cờ)

- `verify-deployment.mjs` ghi `reports/deployment-verification.json`: `expected_sha`, `pages_build_reached_built`, trạng thái từng URL.
- Engine `verify <slug> --sha <sha>` (một bài): URL bài phải 200 và chứa đúng nội dung; Pages status phải `built`; build cuối cùng phải có `commit == sha`. Thiếu một điều kiện → `verified_live` KHÔNG được ghi, exit 1.

## Rollback

1. Xác định commit tốt cuối: log deploy gần nhất trong `reports/deployment-verification.json` + `git log`.
2. `git revert <bad-commit>` (giữ lịch sử; không force-push branch deploy), push.
3. Pipeline (hoặc `gh api --method POST /repos/codeappweb/lab/pages/builds`) build lại; chạy `node scripts/verify-deployment.mjs` xác minh revision mới.
4. Nếu bài engine đã publish: chuyển job về `blocked` chỉ khi xác minh lại fail — không tự ý đổi trạng thái job khi chưa có bằng chứng mới.

## Cài đặt còn thiếu

- Xác nhận Pages build source (repo Settings → Pages) trỏ branch mà `content-pipeline.yml` chạy. Không thay đổi cài đặt publish trong tác vụ này.
