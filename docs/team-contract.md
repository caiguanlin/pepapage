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
| GET | /book-projects/{id}/analysis | 解析详情，解析详情弹窗与编辑器右栏共用：`{audioMode,pdfUrl,audioUrl,pages,sentences,blocks,lines,counts}`，字段见 `pepapage-web/src/api/editorTypes.ts` 的 `BookAnalysis`，页码 1 起始，缺省值显式为 null。OCR：single 读原始，multi/tts 先读校对稿。`audioUrl` 仅 single（优先 audio.wav，其次 audioFileKey）。sentences 的时间来自 alignment，未匹配为 -1。lines 由 subtitles.lrc 解析，合并按行的词时间；行映射命中句为 `exact`（page = pageIndex+1，pageIndex 为 -1 时取句子的 pageIndex），否则页映射有该行为 `heuristic`（page = 映射值+1），都没有为 `none`。blocks：single 所属句 start≥0 为 `matched` 并继承句子时间；tts 在 book-audio-mapping 里有该句为 `tts` 并带签名 `audioUrl`；其余为 `unmatched`，multi 一律 `unmatched`。`counts.matched`：single 取 alignment.matchedCount（没有就统计 start≥0 的句数），tts 取有 fileName 的配音句数，multi 为 0 |

ProjectStatus 增加 `awaiting_review`? —— 不增加。tts 等待校对的判定：`audioMode==tts && status==processing && ocrConfirmed==false && steps[0].status==completed`。前端据此显示“待校对”。

## 3. Worker 任务（pepapage-worker 负责）

Redis Stream 消息 `{taskId, taskType}`；taskType：`book_full`、`book_realign`、`book_tts`、`book_export`。worker 直接用 oss2 读写项目文件（配置同 server，写在 worker/.env）。进度回调用现有 `/internal/tasks/{taskId}/progress`；导出任务回调 `/internal/exports/{exportId}/progress`（server 新增，字段 status/progress/error/fileName）。`/internal/tasks/{taskId}` 详情增加 `ossPrefix`。

处理要求：不伪造成功；真实 PDF 渲染（pymupdf）、真实 OCR（rapidocr-onnxruntime）、音频转换（PyAV 或 imageio-ffmpeg 自带 ffmpeg）、ASR（faster-whisper，模型可配）、对齐、TTS（本机可用引擎，如 Windows SAPI/pyttsx3 或 kokoro-onnx，英文），点读 ZIP/PDF 导出（PyMuPDF 生成内容 PDF + 码点层，pydub/av 剪辑 mp3）。

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
