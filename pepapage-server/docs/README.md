# PepaPage 绘本源复刻

| 目录 | 技术栈 | 端口 |
|---|---|---|
| `pepapage-server` | Spring Boot 3.4 + JDK 21 + MyBatis-Plus + MySQL + Redis + 阿里 OSS | 8080 |
| `pepapage-web` | React 19 + Vite + TypeScript + Tailwind 4 + React Router 7 | 5173 |
| `pepapage-worker` | Python 3.10，消费 Redis Stream 执行制作管线 | - |

## 启动步骤

1. 初始化数据库：在 MySQL 中执行 `pepapage-server/sql/schema.sql`。
2. 复制 `pepapage-server/src/main/resources/application-local.yml.example` 为 `application-local.yml`，填 MySQL 密码、Redis 密码、OSS 配置。
3. 启动后端：`cd pepapage-server` 后执行 `mvn spring-boot:run`。
4. 启动前端：`cd pepapage-web` 后执行 `npm run dev`，访问 http://localhost:5173 。
5. 启动 worker：`cd pepapage-worker`，执行 `pip install -r requirements.txt`，复制 `.env.example` 为 `.env`，再执行 `python -m worker.main`。

## 阿里 OSS 设置

- Bucket 读写权限设为 **私有**，下载一律走后端签发的签名 URL。
- 用 RAM 子账号的 AccessKey，只授予该 Bucket 的读写权限，不要用主账号 AccessKey。
- Bucket → 数据安全 → 跨域设置，新增规则：来源 `http://localhost:5173`，方法 `GET, POST, PUT, HEAD`，允许 Headers `*`，暴露 Headers `ETag`。

## 创建项目流程

```
POST /api/book-projects                      创建记录（status=uploading）
POST /api/book-projects/{id}/upload-policy   为每个文件签发 PostPolicy
浏览器直传 OSS
POST /api/book-projects/{id}/submit          校验文件已上传 → status=processing → 写 process_task → XADD Redis Stream
worker 消费 → POST /internal/tasks/{taskId}/progress 回写阶段进度和结果
前端有制作中项目时每 3 秒刷新列表
```

OSS key 规则：`users/{userId}/book-projects/{projectId}/book.pdf`、`book-audio.<ext>`、`audio/<uuid>.<ext>`。

## 当前骨架完成度

- 已实现：注册/登录/退出（JWT + Redis 会话）、文件夹增删改移、绘本项目列表/搜索/排序/多选删除/移动/重试、三种模式创建表单和 OSS 直传、任务投递和 worker 回调接口、动画源和工具箱占位页。
- 未实现：图片合成 PDF、真实处理管线（worker 目前会让任务以「尚未实现」失败，不伪造成功）、OCR 校对、辅码编辑器、阅读器、课件导入导出。
