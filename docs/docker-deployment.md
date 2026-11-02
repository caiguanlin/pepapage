# PepaPage 生产部署（Docker Compose / GHCR 镜像）

本文是生产环境的部署与运维规程。配套交付物：

- 仓库根 `compose.yaml`（服务编排）
- `deploy/production.env.example`（配置模板，入库，只含占位符）
- `deploy/production.env`（真实配置，只存在于部署机，**不入库**，已加入 `.gitignore`）

所有 compose 命令统一使用 `--env-file deploy/production.env` 形式，本文全部照此书写。变量名以 `deploy/production.env.example` 为准。

## 1. 服务器要求

已验证的目标环境（供对照）：

| 项 | 值 |
|---|---|
| 系统 | OpenCloudOS 9.6，linux/amd64 |
| CPU | 4 vCPU（AMD EPYC，支持 AVX2）——满足 CPU 版 worker |
| 内存 | 3.6Gi 总量 / 约 1.7Gi 可用 / **无 swap** |
| 磁盘 | 余量约 32Gi |
| Docker | Docker 29.7.2，Docker Compose v5.4.0 |

内存要求与建议：

- compose 默认内存限额（可用 env 覆盖）：

  | 服务 | 默认限额 | 说明 |
  |---|---|---|
  | web | 128m | 固定值 |
  | server | 1g（`SERVER_MEMORY_LIMIT`） | JVM 默认 `-XX:MaxRAMPercentage=70.0` |
  | worker | 3g（`WORKER_MEMORY_LIMIT`），2 CPU（`WORKER_CPUS`） | 大头：OCR + ASR + TTS 同进程加载 |
  | mysql | 1g（`MYSQL_MEMORY_LIMIT`） | InnoDB buffer pool 固定 256M |
  | redis | 256m | `maxmemory 192mb` + `noeviction` |

  合计约 5.4Gi，**整栈建议主机 8Gi 以上**。
- 当前 3.6Gi 的机器跑整栈**不够**：先扩容内存，或先在低峰期实测单个制作任务（PDF 渲染 + OCR + ASR + TTS）的峰值内存、相应调低限额后再上线；临时缓解可加 swap（用性能换稳定，防 OOM 直接杀进程）。
- 内存不足时的替代方案：把 worker 部署到单独主机。该编排变体不在本 compose 内，需要自行处理网络与配置。
- 磁盘：worker 镜像内置模型约 190MB；任务临时文件写在容器 `/tmp`（`TMPDIR=/tmp`，容器可写层，非独立卷），单任务可达数百 MB。建议预留 10Gi 以上，目标机余量足够。
- **不在部署机上构建镜像**：构建统一走 GitHub Actions 推送到 GHCR，部署机只 `pull`。compose.yaml 里的 `build:` 段仅供 CI / 本地构建使用，服务器部署不要用。
- 端口冲突注意：目标机 80 / 8080 / 3306 / 16379 已被既有业务占用。本栈**只有 web 发布端口**，且只绑回环地址 `127.0.0.1:8088`（8080 已占用，故映射到 8088）；server / worker / mysql / redis 全部只在 compose 内网，不发布任何宿主机端口。
- 本栈**自带 mysql 与 redis**，不会自动复用部署机上已有的 mysql、redis 等容器；如要改用外部基础设施，需要另行网络与编排配置，本 compose 不提供该变体。

## 2. 架构与服务

| 服务 | 镜像 | 端口 | 内存 | 说明 |
|---|---|---|---|---|
| web | `${IMAGE_NAMESPACE}/pepapage-web:${IMAGE_TAG}` | 容器 8080 → 主机默认 `127.0.0.1:8088` | 128m | 唯一对外入口：静态前端 + `/api` 反代到 server |
| server | `${IMAGE_NAMESPACE}/pepapage-server:${IMAGE_TAG}` | 8080，仅内网 | 1g | Spring Boot API |
| worker | `${IMAGE_NAMESPACE}/pepapage-worker:${IMAGE_TAG}` | 无 | 3g / 2 CPU | 消费 Redis Stream 的制作管线（CPU 版） |
| mysql | `mysql:8.4` | 仅内网 | 1g | 命名卷 `pepapage_mysql-data`；首次启动用 `pepapage-server/sql/schema.sql` 初始化 |
| redis | `redis:7.4-alpine` | 仅内网 | 256m | 命名卷 `pepapage_redis-data`；AOF（everysec）+ `maxmemory 192mb noeviction` |

compose 项目名 `pepapage`。`IMAGE_NAMESPACE=ghcr.io/caiguanlin`，`IMAGE_TAG=sha-<完整 40 位 commit sha>`（以 commit SHA 命名的版本 tag，便于定位与回滚，禁止 `latest` 等可漂移 tag；tag 本身不保证内容不可变，需要内容级固定可改用 digest `镜像@sha256:<digest>`）。日志统一 json-file，单文件 10m × 3 份轮转。

启动顺序由健康检查驱动：web 依赖 server 健康，server 依赖 mysql / redis 健康，worker 依赖 server / redis 健康；`up -d` 会按序拉起，mysql 健康检查会实际查询 `process_task` 表。

网络拓扑与边界：

```
浏览器 --HTTPS(主机反代)--> 127.0.0.1:8088 web
                                |--内网--> server:8080 (/api)
                                             |--内网--> mysql / redis
                                             |--> 阿里 OSS（签名 URL、PostPolicy、小文件读写）
worker --内网--> redis（消费任务流 pepapage:tasks）
worker --内网--> server:8080（回调 /internal/tasks、/internal/exports）
worker |--> 阿里 OSS（用同一套 AK 直读直写项目文件）
```

硬性规则：

- 只有 web 对外。server 的 `/internal/**` 仅供 worker 回调（`X-Worker-Token` 鉴权），**任何一层反代都不得把 `/internal` 暴露到公网**。
- web 容器内反向代理 `/api` 到 server（同源部署，server 不配 CORS）；web 的反代规则里不允许出现 `/internal`。
- OSS 桶保持私有，下载一律走后端签发的签名 URL。
- 数据库与 Redis 数据分别落在命名卷 `pepapage_mysql-data`、`pepapage_redis-data`。

### 2.1 主机反代（HTTPS）：域名、证书与 Nginx 配置示例

对外 HTTPS 由**宿主机上的网关**承担：目标机 80 端口已有服务监听，把下面的 server 块加入现有 Nginx（或既有网关），并在启用 HTTPS 前确认 443 端口及防火墙规则。不要另起一个抢占 80 端口的 Nginx。准备事项：

1. 域名：申请一个解析到本服务器的域名（A/AAAA 记录），下例用 `pepapage.example.com`。
2. 证书：用 certbot 签发 Let's Encrypt 并配置自动续期（例如 `certbot certonly --webroot -w <现有站点根> -d pepapage.example.com`），或使用已有商业证书，落到固定路径。

Nginx server 块示例：

```nginx
server {
    listen 443 ssl;
    http2 on;                       # Nginx < 1.25 用旧写法：listen 443 ssl http2;
    server_name pepapage.example.com;

    ssl_certificate     /etc/letsencrypt/live/pepapage.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pepapage.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8088;   # web 容器只绑回环地址，外网无法绕过 HTTPS 直连
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        # 必须大于 server 端 50MB 的 multipart 上限（课件导入），否则大文件在 Nginx 就被 413 拦下
        client_max_body_size 60m;
    }
}

server {
    listen 80;
    server_name pepapage.example.com;
    return 301 https://$host$request_uri;
}
```

要点：只反代到 `127.0.0.1:8088`；不存在单独放行 `/internal` 的路径（web 容器也不代理它）；`client_max_body_size` 必须调大；第 9 节 OSS CORS 的来源要与此域名一致。

## 3. 首次部署（下载与初始化）

### 3.1 镜像拉取与 GHCR 登录（如为私有）

镜像托管在 `ghcr.io/caiguanlin/pepapage-*`，包的可见性以 GHCR 实际设置为准。**如为私有**，部署机需要先登录：使用 classic Personal Access Token（勾选 **`read:packages`**，不要复用能写包或管仓库的高权限 token）：

```bash
docker login ghcr.io -u <GitHub用户名>
# 提示输入 token（不是账号密码）。凭据会保存在部署机的 ~/.docker/config.json
```

若包为公开，可跳过登录直接 pull。

### 3.2 准备配置

在部署机上准备仓库工作区（至少 `compose.yaml`、`deploy/`、`pepapage-server/sql/schema.sql` 三样），然后：

```bash
mkdir -p deploy
cp deploy/production.env.example deploy/production.env
chmod 600 deploy/production.env
# 编辑 deploy/production.env，按模板注释逐项填写
```

必填项（compose 用 `:?` 强制校验，缺失时启动直接报错，不会静默用默认值）：

| 变量 | 要求 |
|---|---|
| `IMAGE_TAG` | `sha-<完整 40 位 commit sha>`，web/server/worker 三个镜像用同一个 tag |
| `MYSQL_ROOT_PASSWORD` | 高强度随机值：`openssl rand -hex 32` |
| `DB_PASSWORD` | 同上，独立生成 |
| `REDIS_PASSWORD` | 同上，独立生成 |
| `JWT_SECRET` | 至少 32 字节（应用启动强校验），不足直接失败：`openssl rand -hex 32` |
| `WORKER_TOKEN` | 同上生成；server 与 worker 用同一个值（compose 自动注入两端，env 里只填一次） |
| `OSS_ENDPOINT` / `OSS_BUCKET` / `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | 阿里 OSS RAM 子账号 AK，只授予该 bucket 读写，不用主账号 AK |

可选项（有默认值，见 `production.env.example` 注释）：`WEB_BIND_IP` / `WEB_PORT`（默认 `127.0.0.1:8088`）、各内存限额与 `WORKER_CPUS` / `WORKER_THREADS`、`WHISPER_LANGUAGE`（默认空=自动检测语言；纯英文音频建议设 `en`）。

由 compose 固定、不进 env 的值：`DB_USERNAME=pepapage`、`DB_URL` 指向内置 mysql、`TZ=Asia/Shanghai`、`SPRING_PROFILES_ACTIVE=prod`、`CONSUMER_NAME=worker-1`。

注意：

- 密钥值务必用上面的生成命令产生，不要手写弱值；**含 `$` 或 `#` 的值要用单引号包裹**（Compose env 语法，见模板注释）。
- 容器时区已由 compose 固定为 `Asia/Shanghai`（与 JDBC 连接串的 `serverTimezone=Asia/Shanghai` 一致）。

### 3.3 拉镜像并启动

```bash
docker compose --env-file deploy/production.env pull
docker compose --env-file deploy/production.env up -d
docker compose --env-file deploy/production.env ps
```

`ps` 里 mysql → redis → server → web → worker 依次变为 `healthy` / `running` 即正常。

### 3.4 验证

```bash
# 应用级健康检查（经 web 反代到 server）。只证明 HTTP 正常，不探测 DB/Redis/OSS
curl -s http://127.0.0.1:8088/api/health

# 确认 schema 已初始化（应列出 sys_user / book_folder / book_project / process_task / book_export 五张表）
docker compose --env-file deploy/production.env exec mysql \
  sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "SHOW TABLES" pepapage'

# 首次任务前看一遍日志确认无报错
docker compose --env-file deploy/production.env logs --tail=100 server worker
```

补充：

- 生产环境**没有预置账号**，首次通过登录页的注册入口注册自己的账号（`admin@qq.com` 只是本地开发环境的约定，生产不存在该账号）。
- 创建一个测试绘本项目跑通「上传 → 制作 → 阅读」全链路，即完成首次配置。

## 4. Schema 初始化（仅首次）

- 新建数据库的初始化由 compose 完成：`./pepapage-server/sql/schema.sql` 只读挂载到 MySQL 镜像的 `/docker-entrypoint-initdb.d/01-schema.sql`。**该脚本只在数据卷 `pepapage_mysql-data` 为空的首次启动时执行一次**，之后重启、升级都不会重跑。
- 库 `pepapage`（utf8mb4_unicode_ci）与应用账号 `pepapage` 由 mysql 镜像按 `MYSQL_DATABASE` / `MYSQL_USER` / `MYSQL_PASSWORD` 自动创建。
- 项目没有 Flyway/Liquibase 等迁移机制，`schema.sql` 是唯一 schema 来源（幂等 `CREATE TABLE IF NOT EXISTS`）。**版本升级若涉及表结构变更，需要人工在库上执行增量 SQL**——升级前先按第 6 节备份。
- mysql 健康检查会查询 `process_task` 表：如果卡在 mysql 一直 `starting`/`unhealthy`，通常是 schema 未初始化，用 3.4 的 `SHOW TABLES` 排查。
- 需要完全重置只能删除 `pepapage_mysql-data` 卷（**等于删除全部数据，生产禁用**），然后重新 `up -d` 触发一次初始化。

## 5. 日常运维

```bash
# 查看状态 / 日志
docker compose --env-file deploy/production.env ps
docker compose --env-file deploy/production.env logs -f server
docker compose --env-file deploy/production.env logs -f worker

# 停止 / 启动（命名卷数据保留）
docker compose --env-file deploy/production.env down
docker compose --env-file deploy/production.env up -d
```

- `down` **不删**命名卷；`down -v` 会连 `pepapage_mysql-data`、`pepapage_redis-data` 一起删除（数据库、Redis 全部清空），生产环境禁止使用。
- 日志有轮转上限（单容器 10m × 3），不会撑爆磁盘；排查问题优先看 `logs`。
- Redis 已开启 AOF（`appendfsync everysec`）：正常重启会保留用户会话与队列中已投递的任务消息；但 everysec 语义下，进程崩溃/断电最多回退约 1 秒的写入，**不能视为绝对零丢失**。全量丢失只发生在**删除/丢失 `pepapage_redis-data` 卷**时：用户需重新登录，进行中任务中断（对应项目卡在「制作中」，需人工处理后重试）。OSS 与数据库中的正式数据不受影响。
- worker 收到 SIGTERM 会把当前任务处理完再退出（`stop_grace_period: 30m`），`down` 时请耐心等待。

### 5.1 Redis Stream 容量备注（已知问题，本期不重构，只监控不清理）

- 任务流 `pepapage:tasks` 只 `XADD` / `XACK`、**从不裁剪**，长期运行会持续增长；AOF 也随之增长。
- redis 按 `maxmemory 192mb` + `noeviction` 运行：**写满后新写入直接报错**——server 投递任务失败、登录（写会话）失败，都不会自动淘汰旧数据。
- 本期不做自动清理，也**不提供手动裁剪指令**：未投递（lag）与已投递未确认（pending）的消息可能位于流的任意历史区间，「当前没有任务在跑」不代表没有 pending/lag，盲目按长度裁剪会删掉尚未处理的任务。容量逼近上限时必须：先按第 6 节做完整 Redis 备份 → 核对**所有消费组**的 pending/lag（下方命令）→ 另行设计并确认安全的清理方案后才动手。本期靠监控兜底。

```bash
# 监控：内存占用与淘汰策略
docker compose --env-file deploy/production.env exec redis \
  sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli info memory | grep -E "used_memory_human|maxmemory_human|maxmemory_policy"'
# 监控：任务流长度
docker compose --env-file deploy/production.env exec redis \
  sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli xlen pepapage:tasks'
# 监控：消费组 pending 与 lag（任何清理动作前必须核对此处；lag 为 -1 表示 Redis 无法估算，需再用 xpending 细查）
docker compose --env-file deploy/production.env exec redis \
  sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli xinfo groups pepapage:tasks'
docker compose --env-file deploy/production.env exec redis \
  sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli xpending pepapage:tasks book-workers'
```

redis-data 卷靠 AOF 保数据；队列里未完成任务的消息是有价值的状态，可靠的 Redis 备份方法见第 6 节维护窗口流程。容量监控是必须项。

## 6. 备份与恢复

需要备份的数据：MySQL 数据卷里的业务数据、Redis 里的会话与任务队列（**含未完成任务的投递记录**）、OSS 上的项目文件（compose 不管 OSS，按阿里云侧方案备份）。

日常 MySQL 备份（建议 cron 定时）：

```bash
docker compose --env-file deploy/production.env exec -T mysql \
  sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --single-transaction pepapage' > pepapage-$(date +%F).sql
```

全量一致备份（维护窗口内执行）：`--single-transaction` 只保证 dump 自身一致，不覆盖与 Redis 队列状态的一致性。要得到「数据库 + 队列」一致快照，先停所有写入方，再分别备份：

```bash
# 1) 按顺序停写入方（mysql、redis 先留着跑）。顺序不能合并成一条 stop：
#    先 web 挡住新请求 → 再 worker 并等它把当前任务处理完（最长 stop_grace_period 30 分钟）→ 最后 server，
#    保证 worker 收尾的进度回调能成功；一条 `stop worker server web` 会按依赖反向停，可能先停 server
docker compose --env-file deploy/production.env stop web
docker compose --env-file deploy/production.env stop worker
docker compose --env-file deploy/production.env stop server

# 2) 备份 MySQL
docker compose --env-file deploy/production.env exec -T mysql \
  sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --single-transaction pepapage' > pepapage-$(date +%F).sql

# 3) 停 redis 让 AOF 完整落盘，整目录拷出（含 appendonlydir/）
docker compose --env-file deploy/production.env stop redis
mkdir -p "redis-data-$(date +%F)"
docker compose --env-file deploy/production.env cp redis:/data/. "redis-data-$(date +%F)/"

# 4) 恢复运行（up -d 按依赖与健康检查顺序拉起）
docker compose --env-file deploy/production.env up -d
```

恢复：

```bash
# MySQL：恢复到目标库（库 pepapage 需已存在）
docker compose --env-file deploy/production.env exec -T mysql \
  sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot pepapage' < pepapage-2026-11-02.sql

```

Redis 恢复到备份点属于灾难恢复操作，**按以下概念流程执行，不要把备份直接 cp 进现网正在使用的 `/data`**：现网卷里已有备份点之后新增的 AOF 文件（Redis 7 为 `appendonlydir/` 多文件 + manifest），原地覆盖会残留新文件，混在一起会加载失败或数据错乱。

```text
# 1) 停全部写入方，顺序与备份相同：web → worker（等收尾）→ server → redis
# 2) 在一个全新的空目录/空卷里还原整份备份，并校正属主为 redis 镜像的运行用户（uid 999），例如：
#      docker volume create pepapage-redis-restore
#      docker run --rm \
#        -v pepapage-redis-restore:/target \
#        -v "$PWD/redis-data-2026-11-02":/backup:ro \
#        alpine sh -c 'cp -a /backup/. /target/ && chown -R 999:999 /target'
# 3) 临时用该新卷启动 redis 验证（PING、XLEN pepapage:tasks、抽查数据），确认无误后
#    把 compose 中 redis 服务的数据卷切换为该新卷（改 compose.yaml 或用 override），旧卷保留待查
# 4) up -d 恢复整栈并核对业务
```

命令写法说明（为什么是单引号）：外层单引号由**宿主机 shell** 消费，保证 `$MYSQL_ROOT_PASSWORD` 不在宿主机被展开（值不进宿主机命令行与历史）；引号内的字符串原样传入容器，由容器内 `sh` 用 compose 注入的环境变量展开。密码走 `MYSQL_PWD` 环境变量而不是 `-p` 命令行参数（不进容器进程列表，也无 mysqldump 的 stderr 告警）。走 stdin/stdout 的命令加 `-T` 关闭伪终端，避免 TTY 换行转换破坏流内容。

- 备份后核对文件非空：`ls -lh pepapage-*.sql`；Redis 备份目录里应能看到 `appendonlydir/`。

## 7. 版本更新与回滚

更新（始终人工执行，Actions 不会自动部署，见第 10 节）：

```bash
git pull   # 更新 compose.yaml / deploy 模板 / schema.sql（若有）
# 编辑 deploy/production.env，把 IMAGE_TAG 固定到目标 commit 的 sha-<40位> tag
docker compose --env-file deploy/production.env pull
docker compose --env-file deploy/production.env up -d
```

- 换镜像重启 worker 时，compose 最长等 `stop_grace_period: 30m` 让它跑完当前任务才替换；长任务期间更新命令看似卡住属正常，不要强杀。
- 更新流程不动数据卷；若本版包含表结构变更，先备份并人工执行增量 SQL（第 4 节）。

回滚：

- **只回滚镜像，不回滚数据**。把 `IMAGE_TAG` 改回上一个 `sha-<40位>`，`pull` + `up -d`。
- 数据卷（MySQL）与 OSS 文件不会随镜像回退。回滚一个改过表结构的版本前，必须先备份并人工评估 schema 差异（无迁移机制，见第 4 节）。
- server 与 worker 的接口契约（任务类型、回调字段）必须兼容，**回滚时两服务镜像一起回滚到同一 commit**；web 可跟随一起回，保持三者同 tag 最简单。

## 8. Worker：模型、资源与单实例约束

- 默认 worker 为 **CPU 版**（目标机支持 AVX2），模型**直接内置在镜像 `/models` 目录**：`KITTEN_MODEL_DIR=/models/kitten-tts-micro`、`WHISPER_MODEL=/models/faster-whisper-base`，合计约 **190MB**；`HF_HUB_OFFLINE=1`，运行时不访问 Hugging Face。**默认不挂载任何 models 卷**，更换模型需构建新镜像（改 `/models` 内容与对应 env）。
- 资源：内存限额 `WORKER_MEMORY_LIMIT`（默认 3g）、CPU 限额 `WORKER_CPUS`（默认 2.0）、算子线程数 `WORKER_THREADS`（默认 2，注入 OMP/OpenBLAS）。
- 单实例约束：`CONSUMER_NAME=worker-1` 固定，且**不要 `--scale worker=N` 扩容**。任务流用 Redis Stream 消费组，worker 只处理并 ACK 自己的消息、没有 pending 消息接管机制（无 XAUTOCLAIM）：扩容或改 consumer 名后，旧实例未处理完的消息会永久滞留，对应项目卡在「制作中」。worker 崩溃后用**同名**重启即可自动重放自己未 ACK 的消息（崩溃恢复）。
- 任务临时文件写在容器 `/tmp`（`TMPDIR=/tmp`，容器可写层磁盘，非独立卷），随任务结束清理、随容器重建清空；注意宿主磁盘余量。

## 9. OSS 跨域（CORS）

浏览器直传 OSS（PostPolicy）依赖桶的跨域规则，生产上线前在 OSS 控制台配置：

- 来源：`https://<生产域名>`（开发用的 `http://localhost:5173` 规则不要带到生产）。
- 方法：`GET, POST, PUT, HEAD`。
- 允许 Headers：`*`；暴露 Headers：`ETag`。

桶读写权限保持**私有**；RAM 子账号 AK 只授予该 bucket 读写权限，不用主账号 AK。

## 10. CI/CD：只发镜像，不自动部署

- GitHub Actions 只负责构建 `pepapage-web` / `pepapage-server` / `pepapage-worker` 三个镜像并推送到 GHCR，tag 为 `sha-<完整 40 位 commit sha>`。
- **Actions 不会自动部署到任何服务器**。服务器上的更新永远是人工操作：SSH 登录 → 确认/修改 `deploy/production.env` 里的 `IMAGE_TAG` → `pull` → `up -d`（见第 7 节）。
- 回滚靠 SHA 版本 tag 定位历史版本（tag 指向的内容可被覆盖，严格不可变需 digest 固定，见第 2 节）；任何情况下不使用 `latest` 等可漂移 tag。

## 11. 密钥管理

- 真实配置只存在于部署机的 `deploy/production.env`（权限 600），**不入库**；`production.env.example` 只允许占位符。
- 不要把真实密码/密钥写进文档、issue、聊天记录或日志；本文所有示例均不含真实值。
- 疑似泄露时立即轮换：`JWT_SECRET`（全体用户被登出，属预期行为）、`WORKER_TOKEN`（compose 内两端共用同一 env，改一处同步生效）、`DB_PASSWORD` / `MYSQL_ROOT_PASSWORD` / `REDIS_PASSWORD`（改 env 后需同步改库内账号密码再重启）、OSS AccessKey（控制台轮换后同步改 env 并重启 server/worker）。
- GHCR 的 PAT 只保留 `read:packages`；不再使用的及时吊销。

## 12. 模型出处与许可（随镜像分发，必须保留）

worker 镜像内置以下第三方模型，出处与上游许可信息须随分发保留；对外分发或商用前核对上游仓库的许可条款：

| 模型 | 出处 | 用途 |
|---|---|---|
| KittenTTS 0.8 micro（ONNX） | Hugging Face `KittenML/kitten-tts-micro-0.8`（`config.json`、`kitten_tts_micro_v0_8.onnx`、`voices.npz`） | 英文 TTS（8 声线，24kHz 单声道 WAV） |
| faster-whisper 模型（base） | Hugging Face `Systran/faster-whisper-base`（CTranslate2 转换，源自 OpenAI Whisper） | 语音识别（SRT 字幕 + 词级时间） |

本地校验模型完整性可用 `pepapage-worker/tools/kitten_check.py`。运行时依赖（phonemizer / espeakng_loader 自带 espeak-ng 等）见 `pepapage-worker/requirements.txt` 及其中注释。
