# 绘本源复刻：团队接口契约（Lead 维护）

所有成员按本文对接。需要改契约时先发消息给 lead，不要各自发明。规格依据：
`PepaPage-绘本源-本期复刻任务书.md`、`analysis/picture-book-ui-spec.md`、`analysis/picture-book-data-spec.md`、`analysis/frontend-findings.md`。

## 1. 存储

- 项目文件全部在 OSS：`users/{userId}/book-projects/{projectId}/<fileName>`，fileName 与数据规格第 4 节表格一致（book.pdf、book-audio.<ext>、audio.wav、subtitles.lrc、word-timestamps.json、book-ocr.json、book-ocr-reviewed.json、book-cover.jpg、book-alignment.json、book-page-mapping.json、book-audio-mapping.json、tts-0001.wav、book-custom-codes.json、book-custom-audio.json、custom-audio-*.ext、reader-merged.wav、reader-merged-meta.json、aux-code.json）。
- 多音频上传仍为 `audio/<uuid>.<ext>`（已实现，保留），mapping 里 `fileName` 写 `audio/<uuid>.<ext>`。
- 辅码设置原版放 localStorage，本复刻存为项目文件 `aux-code.json`（便于课件包携带）。
- JSON 结构严格按数据规格（BookOcr、alignment、mapping、custom-codes、custom-audio、辅码默认值）。坐标为 OCR 渲染平面像素（PDF 以 scale=2 渲染，即 144 dpi），页码 1 起始，sentenceIndex 0 起始（例外见下方页码基准表）。
- 单音频产物格式与原版一致，写出一律用下面的结构。读取方（worker 重对齐、server `/reader` 和 `/analysis`）同时兼容旧 worker 写出的结构，旧结构见 `docs/picture-book-single-audio-plan.md` 4.2 节，旧项目不用重跑也能打开。
  - `subtitles.lrc`：文件名不变，内容是 SRT 文本（序号、`HH:MM:SS,mmm --> HH:MM:SS,mmm`、文本，字幕之间空一行）。读取按内容判断：有 SRT 时间行就按 SRT，否则按方括号 LRC，都不是视为没有字幕。worker 的 `worker/subtitles.py` 与 server 的 `SubtitleParser` 规则一致。
  - `word-timestamps.json`：顶层只有 `version` 和 `words`，`words` 的键是字幕行号字符串（0 起始）：`{"version":1,"words":{"0":[{"text":"Hello","start":0.94,"end":1.25}]}}`。
  - `book-alignment.json`：`{version:1,sentenceCount,matchedCount,mode,alignments:[{sentenceIndex,start,end,confidence,words:[{start,end,confidence}]}]}`，未匹配的 start/end 为 -1。
  - `book-page-mapping.json`：`mappings` 是"行号字符串 → 0 起始页"的对象：`{"version":1,"lineCount":2,"pageCount":13,"mappings":{"0":0,"1":0},"tailRefinedCount":0}`。
  - `book-line-ocr-mapping.json`：`{version:1,lineCount,sentenceCount,matchedCount,entries:[{lineIndex,sentenceIndex,pageIndex,score}]}`，未命中时 sentenceIndex 和 pageIndex 为 -1，score 为 0。
- 页码基准：

  | 位置 | 字段 | 起始 |
  |---|---|---|
  | book-ocr.json | `pages[].index`、`sentences[].pageIndex`、`blocks[].pageIndex` | 1 |
  | book-ocr.json | `sentenceIndex` | 0 |
  | book-page-mapping.json | `mappings` 的值 | 0 |
  | book-line-ocr-mapping.json | `entries[].pageIndex` | 0（未经原版样本验证，样本里只有 -1）；-1 表示未命中 |
  | book-audio-mapping.json | `entries[].pageIndex` | 1（数据规格 5.3） |
  | 编辑器 boxKey `p<page>:s<i>` | page | 1 |
  | `/reader` 的 cues 和 clips | `pageIndex` | 1 |
  | `/analysis` | `lines[].page`、`pages[].index` | 1 |

- **单音频对齐和阅读都读原始 `book-ocr.json`**，不读 `book-ocr-reviewed.json`：原版对齐 `rSe` 读的是原始 OCR，worker 单音频对齐、`/reader` 和 `/analysis` 的单音频分支都照此处理，避免句号与校对稿错位。后果是单音频校对后重对齐和阅读结果不变。这与数据规格第 6 节"阅读器读校对后 OCR"的说法不一致，是用户确认过的取舍。tts 和 multi 仍先读 `book-ocr-reviewed.json`，没有再读原始 OCR。
- 行映射 `book-line-ocr-mapping.json` 的 `entries[].pageIndex` 按 0 起始写出（与页映射一致），这个起始值**未经原版样本验证**（原版样本里只有 -1）。

## 2. 后端新增接口（pepapage-server 负责）

全部 `/api` 前缀、Bearer 鉴权、`Result{code,message,data}` 包装，校验项目归属。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /book-projects/{id}/files | 列出项目下文件 `[{name,size,updatedAt}]` |
| GET | /book-projects/{id}/files/url?name= | 返回 `{url}` 签名下载 URL；文件不存在 404 |
| GET | /book-projects/{id}/files/json?name= | 读取 JSON 文件内容（直接返回解析后的对象；不存在返回 data=null） |
| PUT | /book-projects/{id}/files/json?name= | 写 JSON 文件，body 即内容。白名单：book-ocr-reviewed.json、book-alignment.json、book-custom-codes.json、book-custom-audio.json、book-audio-mapping.json、aux-code.json |
| DELETE | /book-projects/{id}/files?name= | 删除文件，白名单：book-ocr-reviewed.json、custom-audio-* |
| POST | /book-projects/{id}/upload-policy | 现有接口，kind 增加 `custom_audio`（key=`custom-audio-<sanitizedKey>-<base36ts>.<ext>`，body 增加 `boxKey`；返回的 policy.key 即文件路径）。限制 50 MiB |
| POST | /book-projects/{id}/confirm-ocr | body `{sentenceCount?}`；仅 tts 模式；设 ocrConfirmed=true、步骤3 pending、currentStepIndex=3、status processing，投递 `book_tts` 任务 |
| POST | /book-projects/{id}/realign | 规格 hse：前三步全 completed 只重置步骤3并投递 `book_realign`；否则等同全重试 `book_full` |
| POST | /book-projects/{id}/retry | 已有；允许 failed 项目 |
| POST | /book-projects/{id}/exports | body `{type:"oid_zip"|"pdf"}`，投递 `book_export` 任务，返回 `{exportId}` |
| GET | /book-exports/{exportId} | `{id,projectId,type,status:queued/running/succeeded/failed,progress,error,fileName,url?}`，succeeded 时带签名 url |
| POST | /book-courseware/export | body `{projectIds:[],folderIds:[]}`，服务端生成 `.nexusbookpkg`（zip：manifest.json + projects/<id>/文件），返回 `{url,fileName}`；仅 completed 项目 |
| POST | /book-courseware/import | multipart file；按规格第 11 节恢复到 body `folderId`（query 参数），返回导入项目列表 |
| GET | /book-projects/{id}/reader | 阅读器数据：`{project,pdfUrl,audio:{url,durations?}|null,pages:[{index,width,height}],cues:[{start,end,text,pageIndex,box?,sentenceIndex?}]}`，single 用 alignment+ocr 生成；multi/tts 若无 reader-merged.wav 则返回 `clips:[{url,pageIndex,box,start?,end?}]` 列表由前端顺序播放 |
| GET | /book-projects/{id}/analysis | 解析详情，解析详情弹窗与编辑器右栏共用：`{audioMode,pdfUrl,audioUrl,pages,sentences,blocks,lines,counts}`，字段见 `pepapage-web/src/api/editorTypes.ts` 的 `BookAnalysis`，页码 1 起始，缺省值显式为 null。OCR：single 读原始，multi/tts 先读校对稿。`audioUrl` 仅 single（优先 audio.wav，其次 audioFileKey）。sentences 的时间来自 alignment，未匹配为 -1。lines 由 subtitles.lrc 解析，合并按行的词时间；行映射命中句为 `exact`（page = pageIndex+1，pageIndex 为 -1 时取句子的 pageIndex），否则页映射有该行为 `heuristic`（page = 映射值+1），都没有为 `none`。blocks：single 所属句 start≥0 为 `matched` 并继承句子时间；tts 在 book-audio-mapping 里有该句为 `tts` 并带签名 `audioUrl`；其余为 `unmatched`，multi 一律 `unmatched`。`counts.matched`：single 取 alignment.matchedCount（没有就统计 start≥0 的句数），tts 取有 fileName 的配音句数，multi 为 0。blocks/sentences 原样透传 book-ocr.json 的版面区域类型 `regionType`（值集见原版 Sqe，如 `doc_title`/`text`），OCR 没有时 blocks 显式 null、sentences 省略该字段，解析详情弹窗据此按相邻区域分组并显示组标题 |

ProjectStatus 增加 `awaiting_review`? —— 不增加。tts 等待校对的判定：`audioMode==tts && status==processing && ocrConfirmed==false && steps[0].status==completed`。前端据此显示“待校对”。

## 3. Worker 任务（pepapage-worker 负责）

Redis Stream 消息 `{taskId, taskType}`；taskType：`book_full`、`book_realign`、`book_tts`、`book_export`。worker 直接用 oss2 读写项目文件（配置同 server，写在 worker/.env）。进度回调用现有 `/internal/tasks/{taskId}/progress`；导出任务回调 `/internal/exports/{exportId}/progress`（server 新增，字段 status/progress/error/fileName）。`/internal/tasks/{taskId}` 详情增加 `ossPrefix`。

处理要求：不伪造成功；真实 PDF 渲染（pymupdf）、真实 OCR（rapidocr-onnxruntime）、音频转换（PyAV 或 imageio-ffmpeg 自带 ffmpeg）、ASR（faster-whisper，模型可配）、对齐、TTS（KittenTTS 0.8 micro ONNX 模型，目录由 `KITTEN_MODEL_DIR` 指定，8 个英文声线，输出 24 kHz 16 位单声道 WAV；缺模型或音素库时报错，不回退到 SAPI），点读 ZIP/PDF 导出（PyMuPDF 生成内容 PDF + 码点层，pydub/av 剪辑 mp3）。

## 4. 前端路由（pepapage-web）

| 路由 | 负责人 | 内容 |
|---|---|---|
| /picture-books, /picture-books/folder/:folderId | web-workbench | 工作台、文件夹、创建表单、卡片、更多菜单、课件导入导出入口 |
| /animations | web-workbench | 占位页 |
| /picture-books/:id/review | web-editor | OCR 校对（tts 待校对、任意模式校对后重对齐） |
| /picture-books/:id/editor | web-editor | 原书辅码编辑器（区域、音轨、试听、入口码、导出设置、导出） |
| /reader/:id | web-editor | 共享阅读器，返回绘本源 |
| 卡片“详情” | web-workbench | 更多菜单中的解析详情弹窗 |

创建表单的限制：创建表单不实现"同目录同名音频自动附带"。原版只允许选一个 PDF，再扫描其所在目录；浏览器拿不到目录内容。图片项目的标题也拿不到所在文件夹名，沿用 `titleFromImages`。

API 封装：web-workbench 只改 `src/api/books.ts` 现有段与 `types.ts`；web-editor 新建 `src/api/projectFiles.ts`、`src/api/editorTypes.ts`。`src/router.tsx` 由 web-editor 追加自己的三条路由，web-workbench 不动 router 其他部分以外的行。

## 5. 编辑器音频库（2026-10-31 新增，single 编辑器右侧「音频」列）

用户在编辑器里上传的音频作为额外音源，上传后单独做语音识别（转码 + faster-whisper），识别出的字幕行和词时间只用于该音源的按词裁剪，**不参与原书对齐**，不改 `subtitles.lrc`、`word-timestamps.json`、`book-alignment.json`，也不改项目 status 和 processingSteps。

### 5.1 文件

| 文件 | 写入方 | 内容 |
|---|---|---|
| `custom-audio-lib-<base36ts><4位随机>.<ext>` | 浏览器直传 | 音频原文件。沿用 `custom-audio-` 前缀，现有的删除白名单、导出剪辑、课件打包不用改 |
| `book-audio-library.json` | **只有 server 写**（不进前端 JSON 写白名单） | 音频库清单，见 5.2 |
| `<音频文件名>.asr.json` | worker | 识别结果，见 5.3；前端用现有 `GET files/json?name=` 读取 |

框与音源的绑定仍写在 `book-custom-audio.json`（`entries[boxKey] = {fileName, originalName, updatedAt, start?, end?}`），start/end 是相对该音频文件的裁剪秒数。

### 5.2 清单 `book-audio-library.json`

```json
{"version":1,"items":[{
  "fileName":"custom-audio-lib-mh3k2a9xq1.mp3","originalName":"page3.mp3",
  "status":"queued","progress":0,"error":null,
  "duration":null,"lineCount":null,"wordCount":null,"asrFile":null,
  "taskId":"190...","createdAt":"2026-10-31T08:00:00Z","updatedAt":"2026-10-31T08:00:00Z"}]}
```

- `status`：`queued` / `running` / `succeeded` / `failed`。`progress` 0–100。`error` 仅 failed 时有值。
- succeeded 时 `duration`（秒）、`lineCount`、`wordCount`、`asrFile`（= `<fileName>.asr.json`）有值。识别不到语音也算 succeeded，`lineCount=0`。
- items 按加入顺序排列；不存在清单文件视为 `{"version":1,"items":[]}`。
- server 对同一项目的清单读改写加锁（单实例 JVM 内按项目 id 加锁即可）。

### 5.3 识别结果 `<fileName>.asr.json`

```json
{"version":1,"fileName":"custom-audio-lib-mh3k2a9xq1.mp3","duration":12.48,"language":"en","model":"faster-whisper-base",
 "lines":[{"index":0,"start":0.52,"end":2.10,"text":"I see a red bird","words":[{"text":"I","start":0.52,"end":0.61}]}]}
```

时间相对该音频文件，单位秒、保留 3 位小数。`lines[].index` 0 起始、连续；词结构与 `/analysis` 的 `lines[].words` 一致。

### 5.4 接口（全部 `/api` 前缀、Bearer 鉴权、校验项目归属）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /book-projects/{id}/upload-policy | kind 增加 `library_audio`：不需要 boxKey，不受项目 status 限制，key 为 `custom-audio-lib-<base36ts><4位随机>.<ext>`，单文件上限 200 MiB |
| GET | /book-projects/{id}/audio-library | 返回清单 `{version,items}` |
| POST | /book-projects/{id}/audio-library | body `{fileName, originalName}`。加入并开始识别：fileName 必须是安全相对名、以 `custom-audio-` 开头、不以 `.json` 结尾、OSS 上已存在。已在清单里时：queued/running 直接返回该项，其他状态重置为 queued 重新识别（用于失败重试，也用于给旧的 `custom-audio-*` 文件补识别）。先写清单再投递 `library_asr` 任务（消息附加字段 `fileName`）。返回该项 |
| DELETE | /book-projects/{id}/audio-library?fileName= | 从清单移除，删除音频文件和 `.asr.json`，并从 `book-custom-audio.json` 删掉所有引用该文件的绑定。返回 `{removedBoxKeys:[...]}` |

### 5.5 worker 任务 `library_asr`

- Redis 消息 `{taskId, taskType:"library_asr", fileName, projectId, audioMode}`；用现有 `GET /internal/tasks/{taskId}` 取 `ossPrefix`。
- 步骤：下载 fileName → 转 16k 单声道 WAV（临时文件，不上传）→ `asr.transcribe` → 写 `<fileName>.asr.json` → 回报 succeeded。
- 进度回调 `POST /internal/tasks/{taskId}/library-progress`，body `{fileName, status:"running"|"succeeded"|"failed", progress?, error?, duration?, lineCount?, wordCount?, asrFile?}`。server 更新清单对应项和 process_task.status（running/succeeded/failed），**不碰项目**。清单里找不到该项（识别中被删除）时返回成功并忽略，succeeded 时顺手删掉 worker 刚写的 `.asr.json`。
- 任何异常只回报该项 failed（error 截断 900 字），**绝不**调用 `/progress` 改项目状态。
- 旧 worker 不认识 `library_asr`，会把项目标成失败。上线顺序：先重启新 worker，再启用前端入口。

### 5.6 前端行为（single 编辑器）

- 右侧拆成两列：「音频」列在 PDF 与「识别文字」列之间，「识别文字」列在最右。两列各自可收起。
- 音频列：第一项固定为原书音频（识别结果即 `/analysis` 的 lines），其后是清单项。上传不需要先选中框，可多选文件；每项显示状态（排队中 / 识别中 N% / N 句 / 失败 + 重试）、试听、「使用」（选中框时绑定到该框）、删除（仅清单项）。有 queued/running 项时每 2 秒轮询清单。
- 点击音频列某项即在识别文字列查看该音源的识别文字；选中框时自动切到该框当前的音源。
- 识别文字列点词/拖词：若查看的音源就是选中框的音源，按现有规则改区间（原书音源写 manualRanges，清单音源写 custom-audio 的 start/end）；若不是，先把框改绑到该音源再按词设区间。两者都只改内存并标记未保存，随「保存」写入。
- 音轨面板「更换音源」也走音频库：上传 `library_audio` → POST 加入清单 → 绑定到当前框。
- 清单里的文件在解绑、换绑、删框时**不删除**，只能在音频列删除；不在清单里的旧 `custom-audio-*` 文件保留原来"没有框再用就删"的逻辑。
