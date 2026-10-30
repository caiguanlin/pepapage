# 绘本源静态补证（2026-10-30）

本文件只记录发布包静态事实，不表示执行了对应业务。目标为当前已安装的 `D:/systemSoft/PepaPage/resources/app.asar`。由 ASAR 格式解析器定向提取文件，不执行发布包 JavaScript。

## 身份与证据

- ASAR SHA-256：`dfefd44f6eff9af2bb475cae65749a654cdc65704c4b123d4556d26a02c79844`，与原报告一致。
- 前端 F=`dist/assets/index-CpWPkl9w.js`，4,270,859 字节，SHA-256 `370edc610902cfe5203a8068b105e98d190408c92282578a4d88273e68aa1c66`。
- M=`dist-electron/electron/main.js`，130,439 字节，SHA-256 `00072624097fef25e6b4d9ead3056c651fa0f798a67acb65edcbf616e339db7d`。
- P=`dist-electron/electron/preload.js`，11,783 字节，SHA-256 `8b2d7ac23aca3e2d4a4bd8ef482e80ef93a9060d3929eef5d9037b18b4eaa1d9`。
- 所有提取文件身份：[selected-artifacts.json](selected-artifacts.json)。可检索的原文片段、行号和字符偏移：[focused-source-observations.json](focused-source-observations.json)。偏移为零起始 Unicode 码点，与既有 F@ 约定一致；行号从 1 开始。定向提取的完整代码仅在本地static目录保留，不入Git。
- REA 6.8.0 定向分析 M/P、package.json、projectFiles.js、portable.js，记录 `ev_4570edcc6bd3acb30c32c800a56d0409c4f0d15afb394d8cb2537670f69e95b8`，完整 bundle 已发布于 `static/rea-main-evidence.json`（322,468,878 字节）。前端 F 不在这次 REA 语义分析选集内；下列 F 结论来自人工读取静态产物。完整归档身份经过 REA 记录，22,340 个非选中文件没有分析。

## 1. 书源选择的精确边界

M 第 1014 行、字符 41428，检索 `ipcMain.handle('select-book-source'`。

- 原生对话框 `properties: ['openFile','multiSelections']`，不是目录选择器。
- 可选单个 PDF 或多张 jpg/jpeg/png/webp/bmp/gif/tif/tiff。图片按文件名自然顺序、忽略大小写返回，附首张图片所在目录的目录名 `dirName`；图片分支**不扫描附带音频**。
- PDF 与图片混选、多个 PDF 均返回“PDF 请一次选择一个（图片才可多选，且不要与 PDF 混选）”。
- 单个 PDF 才扫描同目录，寻找 basename 与 PDF basename 相同（大小写不敏感）的首个音频。扩展名为 `.mp3/.wav/.m4a/.aac/.flac/.ogg/.wma`。不是“同目录任意音频”或“自动附上整目录音频”。
- PDF 返回 `{source:{name,buffer},audio?}`；图片返回 `{source:{name:'N 张图片',images:[{name,buffer}],dirName?}}`。读取异常返回 `{error}`，取消返回 null。

建议把既有规格中“同目录音频”收窄为“同目录同名音频（仅 PDF 选择分支）”，不要增加“选择文件夹”入口。

## 2. 手动多音频 completed 不保证能进入阅读器

F@1447408 `async function Jwe` 只写页尺寸、封面和句子/块为空的 OCR 元数据。默认手动多音频不生成 `book-audio-mapping.json`。

F@1463742 `function hSe`：非 TTS 只消费 `book-audio-mapping.json.entries`，跳过没有 `pageIndex` 的条目；依据项目 `audioFiles` 顺序排布。

F@1464553 `async function h3`：multi/tts 用 hSe 取得播放序列；为空时 multi 抛出“多音频未经过模型处理，无法使用阅读器”，TTS 抛出“没有可用的配音音频，请先完成配音”。读取列表不含 `book-custom-codes.json` 或 `book-custom-audio.json`。因此默认 multi 制作完成、以及在辅码中手动画框绑定自定义音频，不能直接推断阅读器可用。辅码/点读流程应与阅读器资格分开验证。

F@3817674 附近 `const kn=v.useCallback(Ce=>` 将手动音源绑定写入 `book-custom-audio.json`。另有 `[multi-split]` 分支会修改已有自动映射，但要求已有映射对象及相应条目，不能将其当作默认手动模式创建映射的通用途径。

建议为“完成卡片 → 阅读器”流程增加“single / 有有效音频页映射的 multi/tts”条件。保留共享阅读器实现范围，同时记录默认手动 multi 的原版错误分支。

## 3. 课件包导出与主进程边界

F@3887781 `async function uHe`：先筛选 completed，再从显式选择和文件夹后代汇总项目。没有可导出项目时抛错。manifest 为 `version:'1.0-book'`、ISO timestamp、显式选中的 folders、`projects:[{id,data:{...project,userId:''},auxCode}]`。文件夹递归收项目，不等于完整递归收目录。

请求为 `exportBookCourseware({manifest,filename})`，单项目以净化标题命名，多项目加“等N个”，扩展名 `.nexusbookpkg`。结果 `canceled` 作为“已取消导出”错误处理；成功消费 `success/path`。

P 第 64 行与 M 第 2731 行精确通道对应 `export-book-courseware`，进度事件 `book-courseware:export-progress`；导入通道为 `preview-book-courseware`、`decrypt-book-courseware`、`copy-book-courseware-project`、`cleanup-book-courseware-temp`，进度 `book-courseware:import-progress`。

M 将业务委派给 `loadSecuredModule('bookCourseware')` 的 `exportBookCoursewareInMain` 等方法。该模块是 `.jsc`，未恢复加解密和成员布局。代码注释“简单加密、无服务端校验”只能作为注释存在的事实，不能替代运行收费或安全策略结论。

## 4. 项目文件根目录可确定规则，不能硬编码一台机器路径

M 第 143 行、F 无关，检索 `const portableMode = isPortableMode();`。Windows 打包应用若 portable 或 exe 目录可写，会覆盖 userData：非 portable 时优先同盘根目录已存在的 `PepaPage-data`，否则 `exeDir/user-data`；portable 用 `exeDir/user-data`。不满足条件时沿用系统 userData。

M 接着定义 `projectFilesPath = path.join(userDataPath,'project-files')`；`lib/projectFiles.js` 第 3 行 helper 同样采用 `app.getPath('userData')/project-files`。

## 5. REA 导出诊断与保留边界

REA 已完成静态分析并发布 bundle，随后报告 `cleanup_incomplete`，原因是暂存 `static/.rea-write-szp3i4/content` 被 Windows 报 EBUSY；不是“没有产出证据”。`static/rea-main-summary.json` 实际保存的是该完整诊断（含 partial_observation），不是有效的简短 summary，应避免全文打开。

后续只读 `inspect-evidence-bundle` 被自身内存检查拒绝：认证估算约 4.98 GB，可用 heap 约 3.43 GB；未重复分析原始目标。暂存清理命令被自动批准审查拒绝，原文仅给出 `blocked by policy`，未提供进一步原因；保留暂存文件，未尝试绕过。此问题不影响已发布证据或人工读取上述静态文件。
