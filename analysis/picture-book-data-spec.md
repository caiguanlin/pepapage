# PepaPage 2.3.6 绘本源：数据、处理管线与导出规格

分析日期：2026-10-30。本期以绘本源为实现重点，动画源只做入口占位。本文保留发布包静态基线，新增所选完成项目文件的只读结构验证与原版UI实际课件导出；详见 [运行补证及证据边界](runtime-20261030/README.md)。示例默认是字段形状示意，明确标“实样”的内容才来自本轮观察。收费接口、OCR/ASR/TTS生成步骤及硬件效果未验证。

## 1. 证据与实现边界

`F` 指 `analysis/asar/dist/assets/index-CpWPkl9w.js`；`F@数字` 是 Python 按 UTF-8 解码后的 **0 起始 Unicode 字符偏移**，不是字节偏移。可用文末检索词在原始压缩文件中定位。Electron 通道列表另见 `electron-ipc.md`，通用数据库/API 另见 `data-contracts.md`。

核心区间：

| 证据位置 | 内容 |
|---|---|
| F@337981、346221 | NexusDB 及 v20 stores |
| F@347195 | bookProjects 增删改、按用户查询 |
| F@721261–727500 | PDF 页渲染、详细 OCR、分句、封面 |
| F@742678–750300 | 单音频对齐、页映射、词级时间、框键 |
| F@750300–755000 | OCR 校对读取、保存、编辑与重建 |
| F@1000000–1008000 | ASR 行与 OCR 映射、多音频匹配 |
| F@1444400–1467800 | 绘本项目创建、四步任务、重试、阅读影子项目 |
| F@3638000–3659000 | 图片转 PDF、上传来源与模式选择 |
| F@3660000–3669000 | 辅码设置、规范化、音频去重键 |
| F@3730000–3749500 | 点读码分配、PDF/音频 ZIP、主进程导出 |
| F@3796505、3812000–3820000 | 自定义区域、音频、框与手动时段持久化 |
| F@3887264–3890500 | `.nexusbookpkg` 导入/导出 |
| F@3891900–3901200 | books/bookFolders 的界面数据操作 |

静态产物足以恢复前端数据契约与大部分状态机；不等于已恢复 `.jsc` 主进程实现、完整课件二进制格式、服务器算法、实际计费或打印笔兼容性。

## 2. 三类记录必须区分

数据库为 Dexie IndexedDB `NexusDB`，最高 schema v20。索引字符串仅定义索引，不约束记录全部字段。

| Store | 主键/索引 | 已观察用途 |
|---|---|---|
| bookFolders | `id, parentId, userId` | 绘本目录树 |
| books | `id, folderId, userId, status` | 手动新建绘本草稿；编辑器提示开发中 |
| bookProjects | `id, folderId, userId, status, updatedAt` | 导入原书制作、OCR、配音、点读课件 |

`books` 的创建对象：`{id:UUID,title,description?:string,folderId,pageCount:0,status:"draft",style,author?:displayName,createdAt:Date,updatedAt:Date,userId}`。`style` 来自 UI 样式选项；本文未将选项扩充为不存在的完整编辑系统。点击草稿时显示“绘本编辑器开发中”。证据 F@3900538，检索 `ft.books.add`、`绘本编辑器开发中`。

`bookFolders` 创建对象：`{id:UUID,name,parentId,createdAt:Date,userId}`。重命名只改 `name`。批量移动操作在事务中按记录类型更新 `parentId` 或 `folderId`；阻止文件夹移动到自己或后代。批量删除文件夹将子文件夹、books、bookProjects 移到上一级，再删除文件夹；另一个单文件夹删除分支只显式处理 bookFolders/books，需复刻时明确是否保留这个分支差异。证据 F@3898336–3900183。

`bookProjects` 查询按 `userId`；每次 `cl` 更新额外写入 `updatedAt:Date.now()`。创建前先保存文件，再插入记录；创建过程中没有观察到覆盖所有文件与 IndexedDB 的共同事务。删除先删 DB，再尝试删除项目文件，文件删除失败只记录警告。证据 `u3` F@1458617、`Tq`、`cl` F@347247。

## 3. bookProjects 字段契约

以下是前端创建及后续写入的联合字段集，不代表所有字段每次同时存在。

```ts
type BookProject = {
  id: string; title: string; userId: string; folderId?: string | null;
  sourceType: "pdf"; sourceFileName: string; // 当前上传路径统一 book.pdf
  audioMode: "single" | "multi" | "tts";
  audioFileName: string; // multi 为第一份音频；tts 通常为空
  audioFiles?: { fileName: string; originalName: string }[];
  multiAudioAlign?: "filename" | "asr"; // 缺省表示手动多音频模式
  ttsVoice?: string; ttsSpeed?: number; // 缺省 Bella / 1
  status: "processing" | "completed" | "failed";
  processingSteps: {
    name: "ocr" | "audio_conversion" | "transcription" | "alignment";
    status: "pending" | "processing" | "completed" | "failed" | "skipped";
    progress: number;
  }[];
  currentStepIndex: number;
  createdAt: number; updatedAt: number; // Date.now 毫秒
  processingError?: string; subtitleTaskId?: string;
  pageCount?: number; sentenceCount?: number; matchedSentenceCount?: number;
  matchedAudioCount?: number; duration?: number; // 秒；TTS 有近似估算，见下文
  asrModel?: string; ocrConfirmed?: boolean;
};
```

创建 `single` 时必须有音频文件名和二进制；`multi` 至少一份音频；`tts` 无需输入音频。缺少 Electron 文件桥会报“文件存储不可用”。`sourceType` 的处理函数仍有形参，但当前 OCR 输出强制 `pdf`，不能据此推断 EPUB 正常支持。

## 4. 输入文件与磁盘契约

当前上传接受 PDF 或图片；EPUB 明确拒绝并提示使用 PDF/图片。图片扩展名包含 jpg/jpeg/png/webp/bmp/gif/tif/tiff，按自然顺序排序，转 JPEG 后逐图生成 PDF 页面。保存源文件统一名 `book.pdf`。`selectBookSource` 仅单PDF分支会扫描同目录、同basename（忽略大小写）的首个mp3/wav/m4a/aac/flac/ogg/wma；图片分支不附音频，也无目录选择。多PDF或PDF/图片混选返回错误。前端证据 F@3638000–3659000；主进程main.js第1014行的补证见 [静态核对](runtime-20261030/static-findings.md)。

应用通过 `electronAPI.saveProjectFile(projectId,fileName,arrayBuffer)`、`readProjectFile`、`deleteProjectFile` 操作项目文件。可消费的媒体 URL 为：

```text
http://127.0.0.1:3000/api/project-files/<URL编码 projectId>/<URL编码 fileName>
```

下表为**项目目录内逻辑相对路径**。主进程明文现已确认根为 `app.getPath('userData')/project-files`。Windows便携模式或可写安装目录可能覆盖userData：非便携先选同盘已存在的 `PepaPage-data`，否则安装目录 `user-data`；不满足条件则沿用系统路径。本次进程与所选项目文件实际位于 `D:/systemSoft/PepaPage/user-data/project-files`，不能将此机器路径硬编码给所有安装。见main.js第143行及静态补证。

| 文件 | 产生者/用途 |
|---|---|
| book.pdf | 原 PDF 或图片合成 PDF；裁剪会原位覆盖 |
| book-audio.<ext> | single 上传的原始音频 |
| audio-0001.<ext> 等 | multi 上传音频，保留原扩展名；原名另存 audioFiles |
| audio.wav | 音频转换输出；多音频识别过程中复用此文件 |
| subtitles.lrc | single识别结果；本轮Tiny实样内容为SRT，扩展名不保证实际序列化格式 |
| word-timestamps.json | 识别词级时间；读取方取对象的 `words` |
| book-ocr.json | 原始 OCR、页尺寸、句子和块 |
| book-ocr-reviewed.json | 校对后的 OCR；读取器优先选用 |
| book-cover.jpg | 第一页封面 |
| book-alignment.json | single 对齐及手动时段、排除框、重复、框覆盖 |
| book-page-mapping.json | 字幕行→书页映射 |
| book-line-ocr-mapping.json | ASR 行→OCR 句映射 |
| book-audio-mapping.json | multi/tts 音频文件→页框映射 |
| tts-0001.wav 等 | 每句独立 TTS 波形 |
| book-custom-codes.json | `{regions:[...]}` 手工码区 |
| book-custom-audio.json | `{version:1,entries:{[boxKey]:音频对象}}` |
| custom-audio-<sanitizedKey>-<base36Timestamp>.<ext> | 区域自定义音频 |
| reader-merged.wav | multi/tts 合并的阅读器音频 |
| reader-merged-meta.json | `{signature,durations}` 合并缓存 |

注意：通用媒体 helper 的 2 MiB 分块策略另见 `data-contracts.md`；绘本创建函数直接调用 `saveProjectFile`，不能把分块策略误认成所有调用方都显式执行的步骤。

## 5. 四个固定步骤与调度

步骤序号始终是 0 OCR、1 音频转换、2 转写、3 对齐。`skipped` 进度为 100，非删除该步骤。

| 模式 | OCR | 音频转换 | 转写 | 对齐 |
|---|---|---|---|---|
| single | pending | pending | pending | pending |
| multi + asr | pending | skipped | pending | pending |
| multi + filename | pending | skipped | skipped | pending |
| multi + 未指定 | pending（只取页面） | skipped | skipped | skipped |
| tts | pending | skipped | skipped | pending |

证据 `dse` F@1444400。上传 UI 的 multi 创建对象没有写入 `multiAudioAlign`，所以默认走手动多音频流程；不要仅因存在 filename/asr 分支，就把自动映射当成所有多音频项目的默认行为。

轮询间隔 3000 ms，按 `updatedAt` 降序选 processing 项目，最多并行处理 2 个；内存 `Set` 防止同项目重复进入，finally 移除。步骤更新将 currentStepIndex 取旧值与当前索引最大值。异常会把指定/当前/processing 步骤标 failed、progress0，项目 status failed 并写 processingError。证据 F@1457500–1458617，检索 `Ywe=3000`、`Xwe=2`、`XT`、`sSe`、`iSe`、`d3`。

### 5.1 OCR 与页坐标

PDF.js 按 scale2 渲染页面，再将 PNG base64 交给 `recognizeImageDetailed(base64,options?)`。可选 `options.detection.boxScoreThreshold`。响应至少消费 `success,error,lines,width,height,regions`；行消费 `text,box,words,regionIndex`，词消费 `text,box`。按响应布局区域分组；无区域时整页一组。第一页另保存 JPEG 封面，quality .8。

默认并发 3 页。单页识别异常记录日志并替换为空页，继续其他页；总句数为 0 时制作失败。无自动对齐的 multi 只执行页面尺寸/封面提取，OCR 结果 sentenceCount 为0，不调用实际文字识别。

```ts
type Box = { x:number; y:number; width:number; height:number };
type BookOcr = {
 version:1; sourceType:"pdf"; pageCount:number; sentenceCount:number;
 pages:{index:number; width?:number; height?:number;
        sentenceStart:number; sentenceCount:number}[];
 sentences:{id:string; pageIndex:number; sentenceIndex:number; text:string;
            words:{text:string;box?:Box}[]; box?:Box;
            regionIndex?:number;regionType?:string}[];
 blocks:{id:string;pageIndex:number;text:string;box?:Box;sentenceIndex:number;
         regionIndex?:number;regionType?:string}[];
};
```

`pages.index`、`sentences.pageIndex`、`blocks.pageIndex` **从1开始**；`sentenceIndex` **从0开始**；`sentenceStart` 指向全书 sentences 数组。坐标为 OCR 渲染平面的像素，不是 PDF pt 或屏幕 CSS px。导出中通过 `width/2 * 25.4/72` 换算原页面毫米尺寸，随后再计算纸张缩放与偏移。必须保留页尺寸与坐标尺度。

分句考虑中英标点、缩写与小数点；有 mr/mrs/ms/dr/st/jr/sr/prof/vs/etc/inc/ltd/dept/est/no/fig 等缩写特判。一个句组最多累积6个行片段。句框合并相应词/行框；blocks 保留行片段→句子的关联。证据 `une` F@721261、`Mme`、`mne` F@724899、`Pme`、`Jwe`、`Ome`。

### 5.2 single：识别与对齐

读 `/api/whisper/config` 的 currentModel；缺失或读取失败默认 `qwen-asr-cloud`。转换原音频为 audio.wav 后：云模式调用云 ASR，再交本地 cloud-asr-postprocess 整理；本地模式创建字幕任务，每3秒轮询，直到 completed 且有 lrcText，或 failed/error。这个轮询分支未见固定总超时。

对齐读取 **原始 book-ocr.json**、subtitles.lrc 与可选 word-timestamps.json。`t0e` 优先词级对齐，再使用句/字幕相似匹配及修正，输出：

```ts
{
 version:1, sentenceCount:number, matchedCount:number,
 mode:"word"|"line",
 alignments:{sentenceIndex:number,start:number,end:number,confidence:number,
             words?:{start:number,end:number,confidence:number}[]}[]
}
```

未匹配句保留 `{sentenceIndex,start:-1,end:-1,confidence:0}`，不能当作从0秒播放。词数组与 OCR 句 words 下标对应，未匹配词也为 -1。当一个句子已有词级时间时，块找不到对应词的分支视词级信息为权威，不总是退回整句时间；这会影响哪些框可以点读。证据 F@742678–749900，`t0e`、`hM`、`XE`。

页映射先用字符串 bigram 覆盖率与单调路径，再精修每页最多末尾3行：下一页覆盖率至少 .5，且比本页高 .15 才改判。文件为 `{version:1,lineCount,pageCount,mappings,tailRefinedCount}`；mappings 的字幕行索引与目标页索引均从0开始。`book-line-ocr-mapping.json` 为 ASR 行与 OCR 句关联，精确输出类型应以实际序列化样本继续验证，不能与句对齐数组互换。

**本轮实样补证**（单一Tiny完成项目，不是所有模型的完整schema）：

```ts
// word-timestamps.json：以字幕行号为键，不是一个平铺words数组
{ version:1, words:{ [lineIndex:string]:{text:string,start:number,end:number}[] } }
// book-line-ocr-mapping.json
{ version:1, lineCount:number, sentenceCount:number, matchedCount:number,
  entries:{lineIndex:number,sentenceIndex:number,pageIndex:number,score:number}[] }
```

样本13页、OCR26句/39块、字幕2条、词时间7词；alignment为word模式、26项、matchedCount2。行→OCR句文件却为matchedCount0，两项均sentenceIndex/pageIndex=-1、score0；页映射将两行都放到零起始页0。三类映射不可混用；未知/未命中索引不可当作第一页。卡片“字幕26”实为OCR句数口径，并非字幕条数。文件哈希和完整结构摘要见 [FILE-P1](runtime-20261030/project-observation.json)。

实样 `subtitles.lrc` 实际是带序号、`00:00:00,940 --> 00:00:01,250` 这类区间的SRT文本，并非方括号时间戳LRC。UI读取成功且显示2条；文件名不能作为格式断言，复刻时应依据内容检测。此结论只覆盖该Tiny样本，其他模型输出格式仍需采样。

### 5.3 multi：文件名、ASR 与手动绑定

文件名模式按 originalName 自然排序、忽略大小写。将文件名与 OCR 候选文本规范化，先 exact 后 fuzzy；包含匹配设最小长度阈值。候选只能使用一次；优先最短规范文本，再按候选顺序。未命中保留 null。

ASR 模式按 audioFiles 顺序逐份读入、转换、识别，拼接该文件 LRC 文本后与 OCR 候选匹配。分词含英文数字、中日韩文字，zero–twenty 归一成数字。主要评分为 .7 recall + .3 precision，通常 recall 至少 .6（短至2词可 .5）、precision 至少 .3、总分至少 .5；另有前缀回退与页序/回退惩罚。这里是静态实现摘要，不能用单一阈值代替完整算法。

```ts
{
 version:1, audioMode:"multi", audioAlign:"filename"|"asr",
 fileCount:number,pageCount:number,matchedCount:number,
 entries:{fileName:string,originalName:string,pageIndex:number|null,
          box:Box|null,matchType:"exact"|"fuzzy"|"asr"|null}[]
}
```

手动模式不要求 OCR 文本存在，用户将音频拖入页面/框区完成绑定；多音频拆分编辑可以重写 mapping 中 pageIndex/box、matchedCount。映射 `pageIndex` 沿用 OCR 的1起始，但点读编辑/导出页面数组用0起始，须在边界转换。证据 `vye` F@1003717、`_ye` F@1006002、`eSe`/`tSe`、F@3815000–3817600。

此处重写已有mapping的分支不能推导为默认手动模式会创建mapping。默认multi仅准备页面元数据；手工码区/音源分别存custom-codes/custom-audio，阅读器仅消费有效audio-mapping.entries。两条链路须独立验证，见第9节。

### 5.4 无音频 TTS

TTS 在 OCR 后等 `ocrConfirmed:true`，未确认时留在 processing/步骤3。读取优先校对后的 OCR；动态载入 `kittenTtsClient-ByAFtYYr.js`，先 initKittenTts，再每个非空句调用 kittenTtsGenerate(text,voice,speed)，默认 Bella/1。

没有 box 的句子和生成异常的句子会跳过；全部失败才整体失败，部分成功也可 completed。输出音频 `tts-0001.wav` 等，命名编号可能因跳过存在空洞。mapping 形状与 multi 类似但 `audioMode:"tts"`、没有 audioAlign；entry 增加 sentenceIndex，matchType 固定 exact，originalName 为句子前30字符。duration 用 WAV byteLength/48000 累加估算，非逐文件解码后的精确时长。界面错误明确提示模型下载及英文书籍条件，不据此声称任意中文 TTS 可用。证据 F@1452800–1454600，`nSe`。

## 6. 校对与修改的持久化

`fM` 先读并解析 book-ocr-reviewed.json，无法解析则退回原始 OCR。`FP` 保存校对文件；`d0e` 删除校对文件。校对草稿包含 `{key,pageIndex,text,words,box,regionIndex,regionType,originIndexes,manual?}`；保存时重新组装 BookOcr，剔除空文本、重编号 sentenceIndex、更新每页起始/句数及 blocks 关联。

支持改文字、删除、合并上一句（同页）、光标处分句、插空句、手绘框与改框。分句按文本字符比例切 words/框，属于几何近似；手绘/改框最小8像素，手动句按垂直中心排序。单页重 OCR 后会重建全书句索引；全部重 OCR 支持默认并发3和取消回调。证据 F@750300–755000、`BP`、`H7`、`f0e`、`p0e`、`m0e`、`g0e`、`b0e`、`y0e`。

点读编辑的覆盖数据实际写入 `book-alignment.json`：

```ts
{
 // 其余对齐字段保留；没有对齐时先造 version1 / mode line / 空 alignments
 manualRanges?: { [boxKey:string]: {
   start:number;end:number;sentenceIndexes:number[];text:string;updatedAt:string
 }};
 excludedBoxKeys?: string[];
 repeatCounts?: { [boxKey:string]: number }; // 1..9；1 删除覆盖项
 boxOverrides?: { [boxKey:string]: Box };
}
```

已观察框键：句子 `p<page>:s<sentence>`、页 `p<page>:page`、分段 `seg:<id>`、块 `block:<id>`、多音频 `multi:<fileName>`、自定义 `custom:<id>`。不同调用方 page 下标需根据上下文核对，不能解析键字符串后全局统一加减1。

自定义区域文件为 `{regions:[...]}`，编辑消费区域 id、页号、x/y/width/height，另有 rect/ellipse 与四点形状相关处理；全部可选几何字段未恢复为严格 schema。自定义音频 entries 是按 boxKey 索引的对象，值 `{fileName,originalName,updatedAt:ISO}`。单文件上限50 MiB；重传替换后删除旧 `custom-audio-` 文件，解绑也尝试删除旧文件。删除自定义区域同时清理其手动时段、重复和自定义音频。证据 F@3796505、F@3812000–3820000。

关键差异：TTS/阅读器读取 review-aware `fM`；single 的自动对齐 `rSe` 显式读取原始 book-ocr.json。校对后如何触发重新生成、避免旧索引覆盖错位，应按界面实际动作验证，不能假定所有处理阶段自动使用校对文件。

## 7. 重试、重新对齐与裁剪

| 动作/检索函数 | 静态行为 |
|---|---|
| xF 全重试 | 用当前模式重建四步骤，OCR processing，索引0，清错误和 subtitleTaskId；未观察该函数主动清理旧结果文件 |
| hse 重新对齐 | 前3步必须全部为 completed 才只重置第3步；否则转全重试。skipped 不等于 completed，必须保留这个判断差异 |
| aSe 确认 OCR | 设 ocrConfirmed true、processing、索引3，可更新 sentenceCount |
| fse 校对后重对齐 | 第3步 pending0，OCR confirmed true，索引3，可更新句数 |
| oSe 裁剪 PDF | 要求存在水平/垂直切分线或删除标记；覆盖源 PDF，只重置0/3步，保留其他步；转写已完成才保留 subtitleTaskId |

证据 F@1459733–1462300。对于用户自行编辑覆盖，应设计版本/索引一致性保护；这是复刻实现建议，原前端未见全链路版本失效机制。

## 8. IPC 与 HTTP 消费契约

表中响应为调用方实际使用的字段；不代表响应只有这些字段。

| 接口 | 请求/参数 | 消费响应与副作用 |
|---|---|---|
| selectBookSource | 本地选择 | source `{name,buffer}` 或 `{images:[{name,buffer}],dirName}`；可带 audio `{name,buffer}` |
| saveProjectFile | projectId,fileName,ArrayBuffer | 保存文件；readProjectFile 返回对象的 data |
| recognizeImageDetailed | PNG base64、可选 detection threshold | success/error/lines/regions/width/height，见 OCR 节 |
| GET /api/whisper/config | 无业务 body | currentModel |
| POST /api/convert-audio | FormData file(audio.wav)、projectId | 需 HTTP ok；随后读项目 audio.wav；前端未在此消费稳定输出字段 |
| POST /api/generate-subtitles | FormData file(audio.wav)、projectId | taskId 必须存在；credentials include |
| GET /api/subtitle-status/:taskId | taskId | status,lrcText,error,progress；可从 steps 中 subtitle_generation 取 progress |
| 云 ASR helper vM | WAV 文件与进度回调 | lrcText,segments；真实供应商返回需另核对 |
| POST /api/cloud-asr-postprocess | JSON `{projectId,lrcText,segments,isVideo:false}` | 需 HTTP ok；整理本地字幕/时间戳 |
| POST /api/project-files/:id/export-audio-zip | JSON `{clips,coverAudioBase64?,coverSourceFile?,coverSegments?}` | success,path,error；path 交给主进程打包 |
| POST /api/book-oid-stage | PDF Blob，octet-stream | success,path,error；生成待打包暂存路径 |
| bookOidBundlePickPath | 建议 ZIP 名 | 选中 `{name,dir}`；取消为空 |
| exportBookOidBundle | token,projectId,fileName,dirPath,files:[{name,path}],audioZipPath,readme | ok；取消 canceled；失败 error |
| bookOidStageCleanup | 暂存路径数组 | finally 调用清理 |

字幕创建 helper 默认最多2次重试，即总计3次尝试；5xx、Failed to fetch 等分支线性等待1秒、2秒。会识别重定向到 applet-auth-bridge 的会话过期情况。该策略不是整个制作管线的统一自动重试。证据 a8 F@759474、o8 F@760710、jne/l8 F@764100。

## 9. 阅读器衔接

绘本可生成标准 projects 记录作为阅读“影子项目”，标记 `bookShadow:true`，`sourceType:"pdf_audio"`、processingStatus completed；包含 pdfUrl/audioUrl/lrcUrl/coverUrl/pageCount/lineCount 和 metadata `{pagesText,mappings}`。它用于复用既有阅读器，不能在动画列表当成真实动画项目展示；过滤函数会排除 bookShadow 与 bookProjects ID。

single 从句对齐、行句映射生成时间字幕；multi 按原音频清单排序，TTS 按 sentenceIndex 排序，解码独立音频、各声道取平均转单声道、重采样到第一段采样率后合成16bit WAV。每段累计实际解码时长生成字幕，没有词级时间。缓存 signature 仅为文件名 `join("|")`，durations 数组长度也需一致；仅同名文件内容变化时缓存是否失效是潜在差异。证据 F@1462300–1467820，`h3`、`uSe`、`hSe`、`bF`。

**进入条件补证**：`hSe` 读取 `book-audio-mapping.json.entries`，跳过无pageIndex的multi条目。播放序列为空时，`h3` 对multi抛“多音频未经过模型处理，无法使用阅读器”，对tts抛“没有可用的配音音频，请先完成配音”。它不读取custom-codes/custom-audio；故completed手动multi不保证可阅读。F@1463742、1464553；该错误目前静态确认。single样本的卡片→共享阅读器→返回绘本源已经UI运行确认，尚未全面验证同步播放。

## 10. 辅码设置与点读 ZIP

设置存 localStorage `auxCode:<projectId>`，与区域/音频/对齐 JSON 分开；课件包会额外带这份配置。默认值：

```json
{
 "enabled":false,"entryCode":56001,"contentStartCode":25001,
 "level":"paragraph","printMode":"integrated","dpi":"600","dotSize":"2",
 "removeBlack":"keep","paper":"A4","customPaperMm":{"w":210,"h":297},
 "orientation":"portrait","lineMerge":"normal","boxPadding":"12",
 "imageCode":"off","entryRect":null,"entryPos":null,
 "entryPlacement":"first","entryCorner":"tr","entrySizeMm":25,
 "entryStyle":"focus","entryBoxKey":null,"bindingPageNumbers":true
}
```

枚举：level page/paragraph/sentence；printMode integrated/separate；dpi600/1200；removeBlack keep/remove；paper A4/A5/B5/custom；orientation portrait/landscape；lineMerge off/normal/loose；imageCode off/page/caption；entryPlacement first/all；entryCorner tl/tr/bl/br；entryStyle flag/ticket/focus/dotted/plain。600 dpi 点大小1/2/3，1200 dpi 点大小2/3。内容码600 dpi为25001–26000，1200 dpi为25001–25310；入口1x1、2x2为56001–56494，3x3为56001–56310。自定义纸宽高30–600mm，入口大小12–40mm；boxPadding 0/6/12/24/36/48/60/72/96/120（OCR像素）。证据 F@3660000–3669000，`Ya`、`xN`、`ej`、`Sp`。

导出流程：生成纸张布局→区域与音频规划→码点层→内容 PDF→音频 ZIP→暂存 PDF→授权 token→主进程打包→清理暂存。当前存在授权开关 `$Ie=true`，导出前调用 `authorize-book-oid-export`，请求 project_id，消费 token；未执行此接口，不能声称导出免费或可绕过服务器。

区域音频按以下键去重，同一音频只占一个内容码：单文件 `file:<name>`，多文件 `files:<name;name>`，时间段 `ranges:<start三位小数-end三位小数;...>`，重复大于1加 `|xN`。时长不大于 .005 秒的段过滤。码从 contentStartCode 递增，超上限报错；自定义区域在普通区域之后分配。图像框 priority0、文本/自定义1、框即入口2。内容码交原生码点生成时 oidNumber 为 code−25000；入口使用独立入口码。

音频 clip 为：

```ts
{
 fileName:"25001.mp3", segments:{start:number,end:number}[],
 sourceFile?:string, sourceFiles?:string[], repeatCount?:number
}
```

sourceFile/sourceFiles 存在时 segments 可为空；否则由显式 timeRanges 或 sentenceIndexes 对应时间段构造，排序后导出。支持把现有框指定为入口 `entryBoxKey`，此时框用入口码、其音频可作为 cover.mp3，不再单铺入口贴纸。

ZIP 主要内容：`cover.mp3`（有入口音频时）、`1/<code>.mp3` 内容音频、内容 PDF、可选独立码点层 PDF、说明文本。完整物理内部路径与说明文件名以主进程最终打包为准。integrated 合成内容+码点；separate 分离两份 PDF。可加装订页码。内容尺寸超纸张可等比缩小，码点物理尺寸保持1:1；keep 优先矢量合成，异常回退栅格化；remove 栅格化并调用 convertJpegToCmykNoK，失败可回退 RGB。原生 OID 图案、CMYK 细节与真实打印识别率未在静态前端中确认。

## 11. `.nexusbookpkg` 课件包

此包用于跨项目导入导出，与点读 ZIP 的消费用途不同。仅已 completed 的 bookProjects 可导出；选文件夹会递归选择其下已完成项目。名称为净化后的首项目标题，多个时附“等N个”，后缀 `.nexusbookpkg`。

```ts
{
 version:"1.0-book", timestamp:ISO,
 folders:BookFolder[],
 projects:{id:string,data:BookProject,auxCode:object|null}[]
}
```

导出时 data.userId 清空，`exportBookCourseware({manifest,filename})` 消费 success/path/error 或 canceled，监听导出进度。注意 manifest.folders 使用“显式选中”的文件夹记录筛选，而项目选择会递归，不可推断所有后代目录都完整包含于 manifest。

导入协议：previewBookCourseware({})→success/tempDir→decryptBookCourseware({tempDir})→success/manifest/extractPath→校验版本严格等于1.0-book→copyBookCoursewareProject({tempDir:extractPath,projectId:旧ID,destProjectId:新ID})。同 ID 文件夹复用；新文件夹绑定当前用户，无法在包内解析父目录则挂当前目录。项目 ID 冲突生成 UUID，重绑当前用户/目标目录，全部步骤改 completed、currentStepIndex=步骤长度、清 processingError 并更新时间，写入 bookProjects，恢复 auxCode。finally 清 preview 临时目录。响应失败会抛错，未见包级 DB+文件共同事务或全部失败回滚。

加解密、压缩成员布局、校验和及二进制兼容细节位于未恢复的主进程逻辑；preload 注释不能替代算法证据。当前可按此 manifest 设计自有导入导出，不应承诺能读写官方包。证据 F@3887264–3890500，`Rz`、`uHe`、`hHe`。

### 11.1 原版实际导出样本的外层

运行确认：从工作台全选→导出课件→原生“另存为”（类型“NexusOS 绘本课件 (*.nexusbookpkg)”）→导出完成，当前0积分下成功落盘。本次仅导出1个single完成项目，没有执行导入。样本本地保存在 `analysis/runtime-20261030/PAGE1-observed.nexusbookpkg`，2,234,925字节，SHA-256 `6fec253daa213db2a912a40e801f475ccb725120a36b473522c0ad0326ade4df`。文件及源书不入Git；可共享的 [外层摘要](runtime-20261030/courseware-observation.json) 保留身份和字段长度。

文件可按UTF-8解析为JSON，**不是直接以ZIP签名开头**。实样形状：

```ts
{
  version:1,
  protection:{enabled:true,iv:string,encryptedData:string},
  metadata:{filename:string,contentType:"application/octet-stream",
            fileHash:string,createdAt:string}
}
```

该样本iv长16、encryptedData长2,234,656、fileHash长44字符。外层数值version1与前端内部manifest字符串 `"1.0-book"` 分属两层，不能混用。字段名/enabled声明不构成加密算法或安全强度证明；内部载荷、fileHash算法、压缩/成员布局和往返兼容仍未知。成功课件导出也不代表收费点读ZIP已生成。

## 12. 实现顺序与未决项

建议先完成 PDF/图片导入→项目文件持久化→四步状态展示→手动多音频区域→OCR校对→single对齐→TTS→辅码设置和点读 ZIP→课件包及阅读器衔接。动画数据不要复用 bookProjects 做假记录。本段是实现建议，不是原版已验证的开发顺序。

进入一比一实现前仍需验证：

- 原生 OID 码点编码/素材、笔型号与真实打印兼容；600/1200 dpi 输出的物理尺寸。
- `.nexusbookpkg` 内部加解密、压缩/成员布局与往返兼容；前端manifest/IPC及原版单样本JSON外层已取得。
- 详细OCR原生引擎/模型与布局输出格式、跨模型词时间JSON schema；本轮已有单个Tiny项目的words与line→OCR结构实样，未覆盖成功精确行句匹配及其他模型。
- 校对后重对齐是否同步原始 OCR、旧 region/sentence 索引如何迁移；静态分支显示读取来源有差异。
- 手工区域完整形状字段、多文件音频绑定的全部保存路径、部分导入失败后的恢复行为。
- 服务端真实响应、错误码、收费/配额、云 ASR 与授权接口；本文没有调用验证。
- 点读ZIP确切成员文件名与内部路径待实际输出；项目根目录规则及本机实例路径已确认。

复查方式：使用 Python `s=Path(...).read_text(encoding="utf-8")`，再 `s[offset:offset+N]`；不要用字节 seek 直接套本文坐标。检索锚点包含 `function dse`、`async function u3`、`async function nSe`、`function t0e`、`book-ocr-reviewed.json`、`book-custom-codes.json`、`function hg`、`exportBookOidBundle`、`version:"1.0-book"`、`ft.books.add`。
