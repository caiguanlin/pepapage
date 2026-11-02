# Docker 验证记录

验证日期：2026-11-02。平台：本地 Docker Desktop，Linux amd64。

## 已通过

- 前端 `npm ci`、TypeScript 检查、Vite 生产构建；Nginx `-t`。
- 后端 Maven 构建内执行 **42 个测试**全部通过；运行镜像非 root，使用 `prod` profile；镜像 JAR 未包含 `application-local.yml`。
- worker Linux 安装生产依赖成功，构建内 **103 个测试**全部通过；最终运行镜像 UID/GID 为 `10001:10001`，不包含 `.env`、`tests/`、pytest 或 torch。
- 两组模型固定 revision、文件大小及 SHA-256 校验成功；镜像保留模型来源、许可证及 Whisper 原始版权声明。
- worker 使用 `--network none` 执行真实 smoke：现场生成 PDF → OCR → KittenTTS → Whisper ASR → MP3 编码/解码，全部通过。测试句子 “The green book lies on the table.” 的合成语音被正确识别，WAV 为 24 kHz / 16 bit / 单声道；一次本地运行耗时约 5 秒（不代表生产整本书耗时）。
- 使用独立 Compose 项目与随机测试凭据，启动 MySQL、Redis、server、web、worker；数据库初始化成功，worker 校验模型后正常监听队列。
- 经 Nginx 验证 SPA 深链接、入口缓存策略、`/api/health`、`/internal` 与 `/internal/tasks/1` 返回 404。
- 注册、登录、查询当前用户、注销及注销后拒绝旧 token 全部通过，覆盖 MySQL 和 Redis 会话。
- Compose 完整配置校验成功，缺少必填配置时按预期拒绝启动；Actions 通过 actionlint 校验。

## 验证边界

- 目标服务器仅做 SSH 只读检查，没有安装软件、部署应用或改变既有服务。
- 本次使用测试 OSS 占位配置，没有调用生产 OSS、处理用户生产绘本或执行公网 HTTPS 验收。正式上线仍须配置 OSS 凭据、bucket CORS、域名和证书，并完成一次真实上传制作验证。
- 本地镜像验证不代表 GHCR 已发布；以 GitHub Actions 成功记录及 publish job 输出的 digest 为准。
- 目标机实测约 4 GiB 总内存，已有多个服务，仅约 1.7 GiB 可用；整栈建议至少 8 GiB，实际峰值依 PDF 页数、图像大小、音频长度和并发变化。

操作步骤见 [Docker 部署说明](docker-deployment.md)。
