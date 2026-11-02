# 浏览器 Secrets 加密依赖

固定使用 npm 官方注册表中的 `libsodium@0.7.15` 和 `libsodium-wrappers@0.7.15`，将其未改动的 UMD 模块与许可证随 Pages 一起部署，不在填写凭证时动态加载第三方 CDN 代码。

| 文件 | SHA-256 |
| --- | --- |
| `libsodium.js` | `8abec6b42fafb418f58bff3fd665005b3e700ee02dae5042ce5704d27e6fcb23` |
| `libsodium-wrappers.js` | `828884732c06fa4443688b33ceb4ab42e6e1b99200e4749be375faa289e94158` |

页面使用 SHA-384 Subresource Integrity 校验这两个文件。升级时重新验证 npm tarball 的完整性，同时更新文件、校验值和回归测试；不要手动编辑压缩后的库。原许可证保留在 `LICENSE.libsodium`。

Secrets 使用 `crypto_box_seal`，与 GitHub 要求的 libsodium sealed box 格式兼容。页面源码、部署文件及浏览器存储中不包含 PAT 或真实令牌。
