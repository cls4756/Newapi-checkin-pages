# 公开前端仓库规则

- 本仓库仅包含配置网页、浏览器 JavaScript、加密库和白名单发布工具。
- 禁止复制原私有仓库的 `.git`、签到程序、真实账号配置或真实凭证。
- 禁止读取、搜索、展示、索引或间接获取真实 `.env`、`.env.*`、备份及符号链接目标。
- 禁止上传 `.env`、PAT 或账号令牌；用户凭证只能由用户主动操作界面处理。
- 不得为了测试读取真实环境文件或使用真实凭证访问、写入 GitHub 仓库。
- Pages 只能通过 `scripts/build_pages.py` 打包白名单，不能发布整个仓库。
- 完成用户要求的代码修改和验证后可以提交、推送；不要自动创建分支。
- 本仓库 `cls4756/Newapi-checkin-pages` 是线上前端的维护和 Pages 部署位置，本地为 `D:\Proj\Newapi-checkin-pages`。
- 私有后端和配置位于 `cls4756/Newapi-checkin`（`D:\Proj\Newapi-checkin`），不要将后端旧版页面覆盖到本仓库，也不要在私有仓库部署 Pages。
