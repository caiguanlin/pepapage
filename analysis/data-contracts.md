# PepaPage 2.3.6：数据与集成接口静态分析

分析日期：2026-10-30。目标为本任务安装包中提取的 `app.asar`。本文件仅依据已发布 JavaScript 产物、插件协议文档与 LAN 服务实现；没有执行目标 JavaScript，也没有发出接口请求。**路径、参数、索引是静态确认，不能据此认定服务端实际可用、完整、计费一致或响应一定符合预期。**

范围更新：本期优先绘本源、动画源只占位；本文件仍保留通用协议背景，绘本专项处理管线和字段请先看 `picture-book-data-spec.md`。

## 证据坐标

- `F`：`analysis/asar/dist/assets/index-CpWPkl9w.js`。下文 `F@数字` 为 Python UTF-8 解码后字符串的 **0 起始字符偏移**，不是 UTF-8 文件字节偏移；压缩产物的原始行号也会列出。
- `L`：`analysis/asar/dist-electron/electron/lanServer.js`，按原始行号引用。
- `P`：`analysis/app/resources/plugin/pepapage-helper/PROTOCOL.md`。
- 机器可读的字面量 API 路径与出现位置：`analysis/api-inventory.json`。该清单只是字面量扫描，动态拼接接口需结合本文，不能当作完整服务端路由表。

## 1. 本地数据库

数据库为 Dexie 封装的 IndexedDB，名称 **`NexusDB`**，发布产物中最高 schema 版本 **20**。证据：`F@337981`、`F@346221`，原始第 62 行，可检索 `super("NexusDB")`、`this.version(20).stores`。

版本 20 的全部 store 索引声明如下。**Dexie stores 字符串仅定义主键和索引，并不等于记录的全部字段，也不强制 JSON schema。**

| Store | 主键/索引声明 | 用途 |
|---|---|---|
| `folders` | `id, parentId, userId` | 项目文件夹 |
| `projects` | `id, folderId, userId, subtitleStatus, ocrStatus, processingStatus, processingProgress, currentStepIndex, completed` | 阅读/媒体项目 |
| `lrcLines` | `id, [projectId+userId], startTime, userId` | 行级字幕与词级时间戳 |
| `annotations` | `id, [projectId+userId], pageIndex, userId, lineIndex, sortOrder` | 注解、查词、笔记、AI 结果、测验等 |
| `tasks` | `id, userId, projectId, status` | 异步 AI/处理任务 |
| `taskChunks` | `id, taskId, chunkIndex` | 任务分块 |
| `fonts` | `id, createdAt` | 导入字体 |
| `bookFolders` | `id, parentId, userId` | 绘本文件夹 |
| `books` | `id, folderId, userId, status` | 书籍记录 |
| `bookProjects` | `id, folderId, userId, status, updatedAt` | 绘本课件项目 |

### 重要迁移

- v2 为项目补充 `processingSteps` 与 `currentStepIndex`；步骤含 `ocr`、`audio_conversion`、`subtitle_generation`。
- v3 补 `completed:false`；v4 补 `source:"upload"`。
- v5 将所属项目的 `userId` 补到字幕和注解；无法匹配时使用 `"unknown"`。
- v6 为字幕、注解增加 `[projectId+userId]` 组合索引。复刻查询必须同时考虑用户和项目。
- v7 将旧完成标识补为 `stamps` 记录：`type:"complete"`、当日日期、`x:.85,y:.85,rotation:-5`。
- v8 尝试按项目 `metadata.mappings` 推导旧注解的 `lineIndex`。
- v9 迁移代码会 `annotations.clear()`。**这是历史升级行为，不应在新产品中无意照搬为日常逻辑。**
- v10 为注解补 `sortOrder`；v11 新增任务表。
- v14 将旧四步骤中的 `translation` 移除，重新计算进度和总状态。
- v18 字体；v19 书籍/书籍文件夹；v20 绘本课件。

证据：`F@338071–346221`，原始第 62 行。

### 核心记录的实际非索引字段

以下是创建、更新语句中观察到的字段集，不是完整的类型定义。

**Project**：`id,title,folderId,userId,createdAt,updatedAt,source,sourceType,sourceUrl,duration,pdfPath,audioPath,videoPath,lrcPath,srtPath,coverPath,pageCount,lineCount,subtitleStatus,ocrStatus,processingStatus,processingProgress,processingSteps,currentStepIndex,metadata,subtitleModel,bookShadow`。媒体 URL 字段仍兼容存在，但目前应从路径生成 URL，避免持久化临时 Blob URL。

`metadata` 中确认有 `pagesText`（页文本数组）、`mappings`（字幕行索引→页索引）、`_alignmentShifts`（按行的时间调整）。项目来源类型至少观察到 `pdf_only,pdf_audio,audio_only,video,video_srt_subtitle` 的消费/创建代码；仍需以父报告的运行核对为准。

**LrcLine**：`id,projectId,userId,lineIndex,text,chineseText,startTime,endTime,wordTimestamps,keyframeTime,alignmentShiftMs`。字幕编辑器更新语句见 `F@2879135`；任务处理读取 `_alignmentShifts[lineIndex].startDeltaMs` 见 `F@4180302`。秒/毫秒必须按字段分别处理，`alignmentShiftMs` 明确为毫秒；`startTime/endTime` 消费方式体现秒单位。

**Annotation**：`id,projectId,userId,pageIndex,lineIndex,type,intent,skillParam,contentKind,content,chineseContent,data,tags,mediaUrls,mediaBlobs,mediaTTSPaths,createdAt,sortOrder`。`data` 随类型变化，可包含 `keyword,keywords,masteryLevel,source` 等。`contentKind` 观察到 `mark,note,quiz`；查词 intent 为 `word_lookup`；云词典生成的数据带 `source:"cloud_dictionary"`。同一表也存绘图标记和 AI 测验结果，不宜简单实现为单一纯文本备注表。

证据：Project 创建 `F@3010256、3011519、3013784、3014871、3016074`；注解创建 `F@1799016、1799710、1923477、1951490、2022556`。

## 2. 大媒体文件保存

媒体类型映射：

| 类型 | 默认文件名 | 旧 Blob 字段 | 当前路径字段 |
|---|---|---|---|
| PDF | `document.pdf` | `pdfBlob` | `pdfPath` |
| 音频 | `audio.m4a` | `audioBlob` | `audioPath` |
| 视频 | `video.mp4` | `videoBlob` | `videoPath` |
| LRC | `subtitles.lrc` | `lrcBlob` | `lrcPath` |
| SRT | `subtitles.srt` | `srtBlob` | `srtPath` |
| 封面 | `cover.jpg` | `coverBlob` | `coverPath` |

文件名可依据 MIME 或指定名称变化；默认音频名并不意味着所有输入都强转 M4A。小于等于 **2 MiB** 的文件一次调用 `electronAPI.saveProjectFile(projectId,fileName,arrayBuffer)`；更大的文件以 2 MiB 切片，第一块 save，后续 `appendProjectFile`。媒体 URL 模板为：

```text
http://127.0.0.1:3000/api/project-files/<encodeURIComponent(projectId)>/<encodeURIComponent(fileName)>
```

读取兼容旧 Blob；若只存 Blob 没有路径，会执行迁移并清除已迁移字段。证据：`F@347589–351415`，原始第 62 行，可检索 `const afe={pdf:"document.pdf"`、`o=2*1024*1024`、`function ka`。

## 3. 浏览器持久设置

以下是目标产物中的键名，不包含任何当前用户存储值或密钥值。

| 键/模板 | 内容或行为 | 证据 |
|---|---|---|
| `rememberMe` | 登录记忆选项 | F@1823xxx–1827xxx |
| `PepaPage_session_active`（sessionStorage） | 当前会话标记，值 `"1"`；退出删除 | 同上 |
| `remote_mappings` | 遥控器/输入设备动作映射 | F@1832320、1834750 |
| `font_size_settings` | 默认 `{subtitle:18,translation:16,annotation:16}` | F@1833017 |
| `tts_settings` | 默认 `{speed:.8,voice:"Bella",volume:1}` | F@1833063 |
| `child_profile` | 默认能力级别“启蒙”，`coreWordTags:["phrase"]`、`showPhonetic:true`，RAZ tags 经函数计算 | F@1833103 |
| `pepapage-show-chinese` | 仅字符串 `"false"` 表示关，其余默认开；跨窗口监听 storage 事件 | F@1913685、2050825 |
| `nexus_mounted_dictionary_<userId>` | 当前挂载词典 ID | F@1785616 |
| `cloudDictAutoLoad_<userId>_<projectId>` | 自动加载云词典提醒/已处理标记 | F@1951548、2841605 |
| `quiz_attempts_<projectId>` | 测验历史；新结果置于首部，最多保留 30 条 | F@2023100、3048374 |
| `export_prefs_script_book_v2_<userId>` | 台词本用户默认导出偏好 | F@2684030 |
| `export_prefs_script_book_v2_<userId>_<projectId>` | 项目导出偏好覆盖用户默认 | F@2684077 |
| `labPrefsGlobal` | 实验室全局排版选项 | F@3125390 |
| `auxCode:<projectId>` | 点读辅码配置；课件导入也恢复此配置 | F@3668480、3887264 |
| `auxTuningPanelWidth` | 点读调节面板宽度 | 可全文检索键名 |
| `agnesApiKey` | 用户提供的 Agnes API key 设置；本文未读取值 | F@3191333、3230747 |
| `nexus-update-dismissed-<version>` | 当日关闭更新提示的日期 | F@2936583 |
| `nexus_notice_dismissed_id` | 公告关闭标记 | 可全文检索键名 |
| `nexusos-video-trim-auto-split` | 视频切分设置，默认 `{splitDuration:1,trimStart:0,trimEnd:0}` | F@3933363 |
| `nexusos-audio-batch-trim-v3` | 批量音频裁剪两条线等设置 | F@3956045 |

该表覆盖已定位的业务键；SDK 自己的认证存储、经通用函数计算而未追完的导出键仍有遗漏，不能认定为全量 localStorage 清单。`font_size_settings,tts_settings,child_profile` 会同步至云端 `user_settings`；遥控映射本地写入在已读代码中单独实现，不能由此认定同样云同步。

## 4. 本地 HTTP 接口及请求合同

基础地址由桌面应用提供 `http://127.0.0.1:3000`。下表记录前端实际构造的请求；服务端主体为 `.jsc` 字节码，未反编译，因此参数校验、完整响应、真实错误码和所有隐藏路由仍未知。

### 媒体与字幕流水线

| 方法与路径 | 请求 | 前端期望/用途 |
|---|---|---|
| POST `/api/generate-subtitles` | FormData `file`（文件名 audio.wav）、`projectId` | JSON `taskId` |
| GET `/api/subtitle-status/:taskId` | 路径参数 | 轮询任务状态 |
| POST `/api/process-video` | FormData `file`（video.mp4）、`projectId` | JSON `taskId` |
| POST `/api/media-download` | `{downloadCode,projectId,title}` 或 `{url,projectId,title}` | JSON `taskId` |
| POST `/api/media-info` | `{url,downloadCode}` | 获取媒体详情 |
| GET `/api/media-download-status/:taskId` | 路径参数 | 下载进度/完成文件 |
| POST `/api/extract-audio` | `{projectId}` | 提取项目视频音频 |
| POST `/api/convert-audio` | FormData `file`（audio.wav）、`projectId` | 转换音频 |
| POST `/api/cloud-asr-postprocess` | `{projectId,lrcText,segments,isVideo,videoPath}` | 云识别后的本地整理 |
| POST `/api/translate-subtitles` | `{segments:[{text,start},...]}` | 响应 `translations` 数组；与输入顺序对应 |
| POST `/api/diarize` | `{projectId,fileName,ahcThreshold:.6,segmentationStep:.2}` | 响应 `segments` |
| GET `/api/extension-download` | 无 | 插件二进制下载 |

证据：`F@759300–764900`，原始第 106 行附近；翻译 `F@2690500`；说话人识别 `F@2691881`。翻译的一个调用路径以 **50 行一批**，只翻译有英文且无中文的行。

字幕启动和视频处理 helper 默认最多再试两次，网络或 5xx 失败退避 `1000*(attempt+1)` ms；使用 `credentials:"include"`；若被重定向至 `applet-auth-bridge`，提示会话过期。其他函数不一定共享相同重试。

### 模型管理

| 方法与路径 | 请求 |
|---|---|
| GET `/api/models` | 无 |
| POST `/api/models/select` | `{modelName}` |
| DELETE `/api/models/:encodedModelName` | 路径参数 |
| POST `/api/models/download` | `{modelName}` |
| GET `/api/models/download-status` | 下载状态 |
| GET `/api/whisper/config` | 配置 |

证据 `F@984521–985194`、`F@1846897`。

### 查词、图像与配图

| 方法与路径 | 请求/用途 |
|---|---|
| GET `/api/dictionary/:word` | 单词小写且 trim 后 URL 编码 |
| POST `/api/dictionary/batch` | `{words,tags:[],includeBatchData:boolean}` |
| POST `/api/dictionary/phonetics` | `{words}` |
| POST `/api/dictionary/batch-phonics` | `{words}` |
| POST `/api/dictionary/cloud/batch` | `{dictionary_id,words}`，带授权头，本地转发云词典 |
| GET `/api/pixabay-key` | 图库设置/可用性消费点 |
| GET `/api/image-search?q=...` | 图片搜索 |
| GET `/api/image-download?url=...` | 图片下载 |
| GET `/api/proxy-image?url=...` | 外链图片本地代理 |
| POST `/api/agnes/sticker` | `{apiKey,prompt,imageDataUrl,model,size}`，响应期望 `dataUrl` |
| POST `/api/agnes/generate` | `{apiKey,prompt,model:"agnes-image-2.1-flash",size:"1024x1024",imageDataUrl?}`，参考图可一张或数组 |
| POST `/api/agnes/analyze` | `{apiKey,pages:[{pageIndex,text}],characters:[{name,description,speaker}]}`，响应期望 `plan` |
| POST `/api/agnes/words` | `{apiKey,pages,maxWords:60}`，响应 `words`，消费字段 `word,en,zh,id?` |
| POST `/api/agnes/mindmap` | `{apiKey,pages,title}`，响应消费为树，要求存在非空 children |
| POST `/api/agnes/storygrid` | `{apiKey,title,lines:[{idx,text}]}`，响应 `scenes:[{idx,storyEn}]` |

证据：词典 `F@1634572–1637200`；图库 `F@1788503–1790462`；Agnes `F@3230000–3238000`。词典先尝试直连云 `dictionary-query`，连接失败回退本地中转；缺少登录 token、调用失败时另有本地词典 fallback。九宫格入口要求至少 9 行字幕，返回最多接纳 9 个不同有效 idx，摘要 `storyEn` 截断至 400 字符；不足 5 个有效场景视为失败。批量配图生成并发为 **2**。

### 导出、工具箱与投屏

| 方法与路径 | 请求/用途 |
|---|---|
| GET `/api/project-files/:projectId/:fileName` | 访问本地媒体文件 |
| POST `/api/project-files/:projectId/export-audio` | 无 JSON body，返回 MP3 Blob |
| POST `/api/project-files/:projectId/export-audio-zip` | `{clips,coverAudioBase64?,coverSourceFile?,coverSegments?}`，响应期望 `{success,path}` |
| POST `/api/book-oid-stage` | `application/octet-stream` PDF bytes，响应期望 `{success,path}` |
| POST `/api/video-trim/upload` | FormData `video`，响应消费 `path,duration` |
| POST `/api/video-trim/remux-preview` | `{inputPath}`，响应消费 `url` |
| POST `/api/video-trim/preview` | `{inputPath}`，响应消费 `url` |
| POST `/api/video-trim/split` | `{inputPath,segments:[{start,end}],outputType,format,quality,originalName}`，响应 `outputs` |
| GET `/api/video-trim/download/:fileName` | 单个结果下载 |
| POST `/api/video-trim/download-all` | `{fileNames,baseName}`，打包结果 |
| POST `/api/audio-merge/merge` | `{inputPaths,format,quality,baseName}`，响应消费 `url` |
| POST `/api/dlna/start` | `{projectId,deviceName:"PepaPage 接收端"}` |
| POST `/api/dlna/stop` | `{projectId}` |
| GET `/api/dlna-status/:projectId` | 1 秒一次轮询 |
| `/api/broadcast` | 广播相关入口，方法和完整合同本次未追完 |
| `/api/client-log` | 客户端日志上报至本机，完整合同本次未追完 |

证据：导出 `F@2700986、3270171、3745718、3748108`；工具 `F@3936244–3977050`；DLNA `F@3008800–3009610`。普通视频切分与音频合并请求超时为 1800 秒，批量音频裁剪为单文件 600 秒。它们是前端 AbortController 期限，不证明后端已被取消。

点读包导出消费的 ZIP 内约定：`cover.mp3` 为入口音频，`1/` 文件夹中内容音频使用码值命名（例如 `<code>.mp3`），另包含内容 PDF，图码分离时另含码点 PDF，并生成说明文字。证据 `F@3745000–3748500`。具体 DAB/NOB 编码算法位于受保护主进程产物，本次未恢复。

## 5. 云端依赖合同

使用 Supabase Auth、表查询、RPC、Edge Functions。这里只列业务名称及参数，不记录部署域名、实际公开 key、授权 token 或任何用户数据。

### 已定位 Edge Functions

| 名称 | 调用参数 |
|---|---|
| `captcha` | body `{}`；期望 `success,captcha_id,svg` |
| `register-with-captcha` | `{email,password,captcha_id,captcha_text}` |
| `recharge-points` | `{yuan,payment_type}` |
| `generate-word-explanation` | `{keywords,lineText,level}` |
| `generate-word-explanation-batch` | `{level,items}` |
| `generate-analogy` | `{level,lines}` |
| `generate-annotation-batch` | 已确认由通用取消 helper 调用；含 level/字幕批次等，完整 body 需继续追踪 |
| `generate-annotation-skill` | `{skillId,level,lineText,lineIndex,skillParam}` |
| `authorize-pdf-export` | `{project_id}` 或 `{scene}` 两种调用 |
| `authorize-lab-export` | `{project_id}` |
| `authorize-lab-export-oid` | `{project_id}` |
| `authorize-book-oid-export` | `{project_id}` |
| `verify-share` | `{fileToken,importerId,action,fileHash}` |
| `dictionary-query` | 原生 fetch POST `{dictionary_id,words}`，带授权头 |
| `dictionary-create-order` | 已定位 raw fetch 路径，完整订单合同未追完 |
| `qwen-asr-v2/upload-policy` | GET，query `{model}`；默认 `qwen3-asr-flash-filetrans` |
| `qwen-asr-v2/submit` | `{file_url,public_url,duration_seconds,model}` |
| `qwen-asr-v2/tasks/:taskId` | GET，header `x-task-token` |
| `qwen-asr-v2/tasks/:taskId/refund` | POST，header `x-task-token`，下载转写结果失败后的退款申请路径 |

证据：`F@977027、979890–983125、1802182、1824408–1826200、1864617、1868933、1874318、2021655、2092975–2094988、3542935、4187563`。云转写流程为上传策略→OSS 上传→提交→轮询→下载结果→本地后处理；消费最终 `lrcText,segments,actual_cost,actual_duration_seconds`。

静态代码内有导出报价默认常量 **200**，但同时查询 `feature_pricing` 和云端授权响应的 `cost`，不可把 200 当成当前服务器真实收费。正式复刻应自建授权和计费合同，不能假定本地改显示就能改变原服务行为。

### 已观察云表与 RPC

表：`dictionaries,dictionary_subscriptions,dictionary_orders,dictionary_subscription_usage,user_settings,point_transactions,recharge_orders,feature_pricing,app_settings,app_releases,contact_links,projects,share_tokens,announcements`。

- `user_settings`：以 `id=uid` 读取/更新，字段 `font_size_settings,tts_settings,child_profile,updated_at`。
- `projects` 的云 upsert 在创建路径中只见 `id,title,folderId,user_id,created_at,updated_at`；**不能推断全部本地媒体或全部笔记已云备份。**
- `share_tokens`：`file_token,author_id,allow_reshare,visibility,authorized_users,max_uses,used_count,file_hash,parent_token,created_at`。导出先注册令牌，经 `verify-share` 取得解密授权后由主进程打包；取消/失败删除注册记录，成功更新文件哈希。
- `feature_pricing`：`feature_key,display_name,enabled,client_visible,pricing_type,unit_price,unit_size,max_per_request,free_quota`。
- `app_settings` 用 `key="point_pricing"` 读取积分方案；`app_releases` 查 `is_latest=true` 的 `version,download_url`。

RPC：`deduct_points,get_my_skills,get_skill_market,get_user_balance,install_skill,uninstall_skill`。余额先 RPC，失败才查询并累计 `point_transactions.points`。只发现函数名不等于恢复了其 SQL 或权限策略。

## 6. 局域网无纸化阅读协议

实现是另一条 **随机端口** HTTP 服务，`listen(0,"0.0.0.0")`，不是直接固定使用 3000。传入快照并启动；若服务已存在，更新快照并复用端口。结束会关闭服务，清除 snapshot、renderedHtml、vocabCache。证据 `L:292–322`。

服务复用完整桌面前端，生产上游 `http://127.0.0.1:3000`，开发上游由调用者传入 5173。**头部注释的“GET / 返回 302”已过时：L:164–168 明确说明根路径直接代理 HTML，避免 HashRouter 因 hash 不进入 HTTP 请求而无限重定向。** SPA 链接使用 `#/script-book-reader/<projectId>?lan=1`。

| 路径 | 实现行为 |
|---|---|
| GET `/api/state` | 无快照为 404；有快照返回 spread snapshot，并给 `annotations:[]`、`project:null`、`prefs:null` 默认值；将媒体 URL 替换为 LAN 相对路径；附 `vocab` 字典 |
| GET `/api/rendered-html` | 就绪返回 HTML；未就绪为 202 `{ready:false,message:"snapshot is being generated"}` |
| GET `/api/vocab` | `{vocab}` |
| POST `/api/preload-vocab` | `{words}`，成功 `{success:true,count}`；坏 JSON 400；预加载失败 500 |
| `/media/audio` | `snapshot.audioFileName` 对应的项目文件流 |
| `/media/cover` | `snapshot.coverFileName` 对应的图片 |
| `/media/pdf` | `snapshot.pdfFileName` 对应的 PDF |
| GET `/api/dictionary/:word` | 优先 vocabCache 命中，否则代理本地 3000 同名接口 |
| POST `/api/translate` | 将输入 JSON 转发到本地 `/api/translate-subtitles` |
| 其他请求 | method/headers/body 代理至完整 frontendBase；过滤 hop-by-hop 等头 |

媒体读取按 `projectFilesPath/snapshot.projectId/fileName` 拼路径。Range 实现接受 `bytes=start-end`，返回 206 与 `Content-Range/Accept-Ranges`；越界 416；缺文件 404；无 Range 为 200。注意未显式覆盖 HTTP Range 的所有变体，不应据此宣称完整 RFC 兼容。证据 `L:95–143、169–290`。

LAN 地址取所有非内部 IPv4，排序优先 `192.168.*`、`10.*`、`172.16–31.*`、`100.64.*`、其余；拼接 `http://<ip>:<port>`。这只是地址选择规则，不能证明某网卡可被手机实际访问。

## 7. 浏览器插件下载码

协议前缀 **`ydl://`**，其后是 JSON→UTF-8→Base64。字段：

```ts
type DownloadCode = {
  v: number; // 文档示例为 1
  url: string;
  site: string;
  domain: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    expirationDate: number | null; // Unix 秒
  }>;
  ts: number; // Unix 秒
};
```

来源 `P` 第 1–4 节。前端 `kne` 解析函数在 `F@762426`，只检查前缀、可解码 JSON、`url` 存在且 `cookies` 为数组；并未在此验证全部字段。随后通过本地 `/api/media-info`、`/api/media-download` 提交。

协议文档中包含将 Cookie 转成 Netscape Cookie 文件或 header 供下载器使用的说明；这是目标产品的协议描述，本文没有采集、生成或传递任何真实 Cookie。Base64 是编码，不是加密；复刻需要把下载码当作携带登录凭据的输入处理，不能作为普通无敏感分享字符串记录到日志。

## 8. 复刻建议和待证实边界

1. 优先建立 project/lrcLine/annotation 三层数据模型以及本地媒体文件层，确保字幕编辑后所有视图共享同一项目和行 ID。
2. 文件保存接口需支持分块与进度，前端不要将 1 GB 媒体长期复制到 IndexedDB 或 React state。
3. 保留“本地项目数据 + 云账号/授权/词典”边界，分别实现网络失败和离线回退。原应用并非全部功能都依赖云，也并非完全离线。
4. LAN 快照需要独立只读装载通道，不能让移动端假设有 Electron preload。
5. 导出/分享包兼容性、服务器计费规则、数据库 RLS、云函数实际实现、DAB/NOB 算法、完整响应 schema 均未恢复。复刻时应定义自己的实现或补充样本验证，不应在文档中假称已一比一还原。

