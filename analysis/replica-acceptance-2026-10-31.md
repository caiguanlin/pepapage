# 绘本源单音频与 TTS 复刻验收记录

日期：2026-10-31（Asia/Shanghai）。代码基线：`57491a1 fix(web): 音轨面板收起再展开后重新绘制波形`。验收依据：`PepaPage-绘本源-本期复刻任务书.md` 第 6 节、`docs/picture-book-single-audio-plan.md` Task 12。

## 1. 环境

| 组件 | 实际情况 |
|---|---|
| 服务端 | `pepapage-server`，`spring-boot:run`，profile `local`，端口 8080；MySQL 本机 3306，Redis 为远程腾讯云实例 |
| OSS | 阿里云 OSS 广州，项目文件真实读写 |
| worker | `python -m worker.main`，Python 3.12.6；faster-whisper 1.2.1（模型 base）、rapidocr-onnxruntime 1.4.4、PyAV 19.0.2、kittenml 0.9.7、onnxruntime 1.31.1、phonemizer 3.4.0、espeakng-loader 0.2.4 |
| TTS 模型 | 原版自带 `kitten-cache-micro`（`kitten_tts_micro_v0_8.onnx` 等 3 个文件），放在 `pepapage-worker/models/`，未提交 |
| 前端 | Vite 开发服务器，端口 5173，浏览器从 `http://localhost:5173` 访问（原因见下） |
| 夹具 | `analysis/fixtures/PepaPage-picture-book-sample.pdf`（2 页，每页 2 句） |

**音频来源的限制**：单音频流程用的 `narration.mp3` 是合成语音（文件带 AIGC 标签），内容与夹具 PDF 一致。它能验证流程和产物结构，**不能评价识别质量**。没有拿到真人朗读夹具 PDF 的音频。唯一一次非合成音频的检查是第 4 节的 PAGE1 比对。

验收过程的驱动脚本和日志放在 `pepapage-worker/tmp/acceptance/`（该目录被 `.gitignore` 忽略，不提交）。本文摘录了其中的关键数字。浏览器验收截图在 `pepapage-worker/tmp/acceptance/ui/` 下，文中写作 `ui/NN`（工作台）和 `editor/NN`（辅码编辑器），同样不提交。

服务端 CORS 只放行 `http://localhost:5173`（`application.yml` 的 `cors.allowed-origins`）。用 `http://127.0.0.1:5173` 打开前端时登录等 POST 请求返回 403 "Invalid CORS request"，所以浏览器验收都在 `localhost:5173` 下进行。

## 2. 自动化检查

在基线提交上重新执行，全部通过：

| 检查 | 命令 | 结果 |
|---|---|---|
| worker 单元测试 | `cd pepapage-worker; .venv\Scripts\python.exe -m pytest -q tests` | 56 passed |
| 服务端测试 | `cd pepapage-server; mvn -q test` | 29 个用例，0 失败：AnalysisServiceTest 7、BookProjectServiceTest 7、ReaderServiceTest 8、SubtitleParserTest 7 |
| 前端构建 | `cd pepapage-web; npm run build` | `tsc -b` 无错误，vite 构建成功；主包 858 kB 超过 500 kB 的提示是既有警告 |
| worker 冒烟 | `cd pepapage-worker; python tools/smoke.py` | exit 0，三个场景结果见下 |

冒烟的三个场景（本地目录存储，不经过 server 和 OSS）：

- single + KittenTTS 朗读旁白：四步完成，时长 15.642 秒，4/4 句对齐；`book_realign` 后手动设置保留；`oid_zip` 导出含 `Sample Book.pdf`、`1/25001.mp3`–`25004.mp3`、`codes.json`、`readme.txt`；`pdf` 导出成功。
- single + 夹具 mp4（音轨与书无关）：按预期在识别步骤失败，原因"语音识别结果为空（音频中未识别到语音）"。
- tts：`book_full` 停在待校对；`book_tts` 用 KittenTTS 逐句配音，4 条映射 `tts-0001.wav`–`tts-0004.wav`，时长 15.195 秒；`oid_zip` 导出成功。

与上一次冒烟相比，只有两处对齐时间相差不超过 0.06 秒，属于识别的正常波动。

## 3. 验收项

状态："已验证"指在本环境实际操作并看到结果；"部分验证"指只验证了一部分判定标准，缺的部分写在证据栏；"未验证"指没有执行。

| 编号 | 场景 | 状态 | 证据 |
|---|---|---|---|
| PB-02 | 绘本空状态 | 部分验证 | 侧栏"绘本源"高亮，面包屑、搜索、排序和工具按钮齐全（ui/01）。根目录已有项目，改用新建的空文件夹看空状态（ui/02）。空状态文案、面包屑和搜索占位与原版截图 06 不一致，见第 5 节界面差异 1、2 |
| PB-04 | 三种模式切换 | 已验证 | 单音频：书籍文件和整书音频必填，未选书时"开始制作"置灰，选书后可用（ui/03、07）。多音频：没有 ASR 和文件名匹配控件（ui/04）。无音频：默认 Bella，8 个声线，语速 0.5–1.5、默认 1.0x（ui/05）。书源校验：两个 PDF、PDF 加图片都提示"PDF 请一次选择一个（图片才可多选，且不要与 PDF 混选）"，非图片文件提示"仅支持 PDF / 图片（.jpg .jpeg .png .webp .bmp .gif .tif .tiff）"，与原版逐字一致（ui/06）。表单文案和控件形态与原版有差异，见第 5 节界面差异 4 |
| PB-05 | PDF 导入 | 已验证 | 界面：用夹具 PDF 通过创建表单建 TTS 项目，标题自动填 `PepaPage-picture-book-sample`，卡片显示页 2，OCR 后出现封面（ui/08）。接口：不传标题创建 multi 项目，服务端同样按文件名生成标题，页数 2，封面 `book-cover.jpg`，源文件 `book.pdf` |
| PB-07 | 单音频 | 部分验证 | 接口：项目"验收-单音频"四步全部 completed，时长 10.11 秒，`sentenceCount` 4、`matchedSentenceCount` 4，`asrModel` 为 `faster-whisper-base`。`/analysis` 返回 4 条字幕，全部 exact，页码 1、1、2、2；`/reader` 返回 4 个 cue。界面：完成卡片统计为"页N/字幕N · 已对齐N · 时长m:ss"，徽标"本地模型"，底部有"辅码"按钮（ui/01）；解析详情副标题"PDF · 2 页 · 4 个文字块 · 已对齐 4"，字幕页签 4 行徽标 P1、P1、P2、P2，点第 3 行翻到第 2 页并用 rose 框高亮对应句子（ui/20），播放中行变 amber（ui/21）。未验证：从界面创建单音频项目；识别质量（音频是合成语音） |
| PB-11 | 无音频 | 已验证 | 项目"验收-无音频"：`book_full` 后停在 processing、第 3 步 pending、`ocrConfirmed=false`，即待校对。`confirm-ocr` 后约 6 秒完成，生成 `tts-0001.wav`–`tts-0004.wav` 和 `book-audio-mapping.json`，`matchedAudioCount` 4。写入校对稿（第 1 句改为 "I see a big green square."）后按校稿重新配音：`tts-0001.wav` 从 161644 字节变为 196444 字节，映射文本更新，`/reader` 返回 4 个 clip。界面：新建的 TTS 项目约 30 秒后显示"待校对识别结果 / 点开确认后开始配音"和"去校对"按钮（ui/08），校对页 2 页 4 句（ui/09），确认后卡片显示制作进度，约 1 分钟后完成，统计为"无音频 · 页2/音频- · 已映射4"（ui/10）。完成的 TTS 卡片菜单为详情、校对识别结果、按校稿重新配音、删除项目（ui/11）；详情只有"文字块"页签，块带"配音"徽标（ui/12）。校对页按钮文案与原版不同，见第 5 节界面差异 5 |
| PB-12 | 错误与重试 | 已验证 | 三类失败都写入了原因：无语音音频在识别步骤失败，"语音识别结果为空（音频中未识别到语音）"；空白 PDF 在 OCR 步骤失败，"OCR 未识别到任何文字（总句数为 0）"；worker 指向不存在的模型目录时配音失败，"TTS 全部失败：TTS 模型未下载：请把 kitten-cache-micro 放到 KITTEN_MODEL_DIR（当前：…）"。三次重试都沿用原项目 id，项目总数不增加。TTS 失败后重试回到待校对（`ocrConfirmed=false`），再确认后完成。界面：失败卡片的封面红色渐变层显示原因原文，带重试按钮（ui/01、28）；失败卡片菜单为重试、删除项目（ui/28）；点失败卡封面弹出"重新制作该项目？"，取消后状态不变（ui/17） |
| PB-13 | 仅重对齐 | 已验证 | 在 `book-alignment.json` 写入 manualRanges、excludedBoxKeys、repeatCounts、boxOverrides 后重对齐：只重写 `book-alignment.json`、`book-page-mapping.json`、`book-line-ocr-mapping.json`；`audio.wav`、`subtitles.lrc`、`word-timestamps.json`、`book-ocr.json` 的 sha256 不变；四项手动设置全部保留。单音频按约定读原始 OCR，校对稿不影响单音频重对齐；TTS 的"按校稿重新配音"使用校对稿，见 PB-11。界面：在 page1 的解析详情点"重新对齐"，确认后卡片进入制作中，随后恢复 completed（ui/27）；完成的单音频卡片菜单为详情、重新对齐、删除项目（ui/18） |
| PB-14 | 辅码区域 | 已验证 | 项目"验收-单音频"的辅码编辑器。选中框显示 8 个缩放手柄和右上角删除按钮（editor/11）；拖动移动、se 角缩放、e 边缩放都生效，保存后写入 `boxOverrides`（editor/12）。手动铺码：选矩形或圆形工具后顶部出现"按住拖动画出区域，松开完成；Esc 取消"（editor/16），拖动画出矩形后自动切回选择工具（editor/17）；单击放下默认圆形，26×26mm，即 147 个 OCR 像素（editor/18、19）；按 Esc 后单击不再建区（editor/20）。删除：手动区域的删除按钮提示"删除区域（Delete）"，句子框的是"不赋码（Delete）"，点后句子框变灰虚线、音轨显示"已跳过"，可恢复（editor/14、15）；Delete 键删除手动区域（editor/22）。测试区域删除并保存后，`book-custom-codes.json` 与测试前逐字段相同 |
| PB-15 | 音轨与试听 | 已验证 | 选中 p1:s0 后音轨载入其区间 0.100–1.100，波形正常绘制（editor/23）；收起再展开后波形重新绘制，非透明像素数与收起前相同（editor/24–26），`57491a1` 的修复有效。输入框改为 0.200–1.000 生效；"下句头"把结束设为 1.820（下一句开头），"上句尾"把开始设为 3.600（上一句结尾）；复制后选 p2:s2 粘贴得 0.200–1.000（editor/27）；"重置"回到自动区间 4.120–5.300，遍数 2 保留。点"试听"显示"播放中"，播完恢复"试听"（editor/28）；点画布上的框也会试听。右栏识别文字：4 行、头部"18 词"，选中框时重叠的词高亮并滚动到可见处（editor/11、30）；点区间外的词扩展首或末，点首词收缩，清空后点词重新开始一个区间（editor/30、31）；右栏可收起到 40px（editor/32）。未测：拖动波形上的手柄、波形缩放与平移、Ctrl+C / Ctrl+V 快捷键 |
| PB-21 | 重启恢复 | 已验证 | 服务端在 09:01 重启，之前（10-30 23:40）创建的单音频项目在重启后仍能读出状态、文件和 `/reader`。worker 在 12:09 重启后正常接收任务。界面：刷新工作台后卡片和排序恢复（ui/29）；在 `/reader/<id>` 刷新后阅读器回到原书和原页码（ui/30）；辅码编辑器保存后刷新，`boxOverrides` 的新位置、`manualRanges` 的 0.2–1.0 和辅码开关状态都保持（editor/29、35） |
| PB-23 | 绘本阅读入口 | 已验证 | 界面：点完成的单音频卡片进入 `/reader/<id>`，PDF 正常渲染（ui/15）；点完成的 TTS 卡片进入阅读器，"朗读"后句框变琥珀色，底部显示句子文本和"暂停"（ui/14），返回后回到工作台。点默认手动分支的 multi 卡片不跳转，工作台顶部显示"多音频未经过模型处理，无法使用阅读器"（ui/16）。"详情"在更多菜单里，与阅读入口分开。接口：single `/reader` HTTP 200、4 个 cue；tts HTTP 200、4 个 clip；multi HTTP 400。阅读器本身的功能比原版少，见第 5 节界面差异 7 |

## 4. 产物与原版比对

### 4.1 顶层键

单音频项目"验收-单音频"的五份 JSON 与 `analysis/runtime-20261030/project-observation.json`（原版 PAGE1）的顶层键集合逐一相同：

| 文件 | 顶层键 |
|---|---|
| book-ocr.json | version, sourceType, pageCount, sentenceCount, pages, sentences, blocks |
| book-alignment.json | version, sentenceCount, matchedCount, mode, alignments |
| word-timestamps.json | version, words（words 的键为字幕行号字符串） |
| book-page-mapping.json | version, lineCount, pageCount, mappings, tailRefinedCount |
| book-line-ocr-mapping.json | version, lineCount, sentenceCount, matchedCount, entries |

`subtitles.lrc` 内容为 SRT。项目文件清单与原版 PAGE1 相同，没有多出的文件。

`book-audio-mapping.json`（tts）的顶层键为 version, audioMode, fileCount, pageCount, matchedCount, entries。原版观测里没有 tts 项目，这份文件无法比对。

### 4.2 用原版音频重做 PAGE1

用原版 PAGE1 的 `book.pdf` 和 `book-audio.mp3`（两者 sha256 与原版相同）在本复刻里创建项目，结果与原版不同：

| 项目 | 本复刻 | 原版 |
|---|---|---|
| OCR 句数 / 文字块 | 22 / 40 | 26 / 39 |
| 第 1 页尺寸与句数 | 1088×1674，2 句 | 1087×1673，3 句 |
| 字幕条数 | 1 | 2 |
| 词数 | 8 | 7 |
| 已对齐句数 | 1 | 2 |
| 行映射命中 | 1（score 0.671） | 0 |

结构一致，数值不一致。差异来自 OCR 断句（rapidocr 与原版 OCR 引擎不同）、识别模型（faster-whisper base 与原版 Tiny 模型的实现不同）和行映射打分阈值。本期不追求数值一致，记录在第 5 节。

## 5. 未验证与遗留

- 识别质量：没有真人朗读夹具 PDF 的音频，单音频流程只用合成语音验证过。
- 数值一致性：见 4.2 节，OCR 句数、字幕条数和对齐数与原版不同。
- 行映射 `entries[].pageIndex` 的 0 起始仍未经原版样本验证。原版 PAGE1 只有 -1；本复刻的 4 条命中为 0、0、1、1。
- 原版观测里没有 tts 项目，`book-audio-mapping.json` 只按数据规格 5.3 节核对。
- 本期范围外：多音频、积分、课件导入（任务书 PB-08–10、16–20、22、24 不在本次记录）。

### 5.1 界面差异（功能可用，文案或形态与原版不同）

浏览器验收发现以下差异。之后按原版截图和构建代码 `index-CpWPkl9w.js` 改了其中大部分，并在浏览器里复查过，每条后面写明现状。

1. 空状态：本复刻原来是"这里还是空的 / 导入课包，或上传 PDF / 图片制作第一本点读绘本"，带三个按钮；原版截图 06 是"还没有绘本，开始创作吧 / 可以先新建文件夹整理素材，也可以直接制作一本绘本项目。"，两个按钮（新建文件夹、制作项目）。**已改**为原版文案、图标块和两个按钮。空状态不再有导入按钮，"导入课件 / 导入课包"的不一致随之消失。搜索无结果时显示原版的"没有找到匹配的内容"。
2. 顶栏：面包屑原来是"绘本源"（原版"绘本书籍"），搜索占位是"搜索工作空间"（原版"搜索绘本 / 文件夹..."），排序控件顺序是"创建日期、名称"（原版"名称、日期"）。**已改**。`TopBar` 新增 `searchPlaceholder`，其他页面仍是"搜索工作空间"。排序标签改为"日期"，切到另一个排序键时回到升序，与原版一致。
3. 项目卡片标题右侧原来没有原版截图 08 里的"原创"徽标。**已加**。原版构建代码里绘本源卡片无条件显示该徽标，复刻同样无条件显示。
4. 创建表单：分组标题"音频"（原版"音频与识别模型"）；必填标记用"＊"（原版写"必填"）；书籍文件说明、整书音频字段说明与原版不同；单音频模型区是"云端模型 / 本地模型"两张卡（原版是已选模型 Tiny ~75 MB 卡片加"更改"）；TTS 声线用下拉框（原版是女声、男声两组共 8 个按钮）；多音频模式缺少绿色"手动铺码"提示框。**已改**分组标题（单音频"音频与识别模型"、多音频"音频文件"、TTS"自动配音"）、必填标记（标签右侧灰色"必填"）、两处字段说明、TTS 声线按钮和语速卡片、多音频提示框。**未改**：单音频模型区，仍是计划第 8 节的遗留项。原版字段默认说明"点击右侧按钮选择文件"没有照搬，因为复刻的上传区整块可点，没有右侧按钮。
5. OCR 校对页：确认按钮原来是"确认并继续配音"（原版"确认并开始配音"），另有一个原版没有的"仅保存"按钮。**已改**：去掉"仅保存"，tts 项目的按钮为"确认并开始配音"。原版只有 tts 能进校对页；复刻的编辑器另有"校对文字"入口，非 tts 项目的按钮仍是"保存并重对齐"。
6. 解析详情"文字块"页签原来是平铺列表，没有按版面区域分组的标题（原版截图 18 有）。**已改**：`/analysis` 的 blocks 和 sentences 透传 `book-ocr.json` 的 `regionType`（契约见 `docs/team-contract.md`），弹窗按相邻的 regionIndex 加 regionType 分组并显示组标题。"验收-单音频"第 1 页显示"标题""正文"两组。OCR 没有版面区域类型的老项目不显示组标题，与原版一致。
7. 阅读器只有返回、书名、页码和"朗读"；原版截图 19 的左侧工具条、笔记和单词本栏、顶部搜索字幕与语速栏、底部播放条都没有。**未改**，本期计划没有包含阅读器功能，只要求入口和返回。
8. 辅码编辑器开启辅码后，点阵预览在 100% 缩放下几乎看不出来，原版截图 10 的网点明显得多。**已调**：按截图 10 估算为点距约 1 mm、点径约 2 px、灰点 alpha 0.3，点阵随缩放同步缩放。原版预览是桌面端生成的真实码点 PNG，Web 复刻只是示意，浓度不保证与原版相同。
9. 辅码关闭时"导出点读包"按钮已 disabled，但样式仍是实心 indigo，看不出置灰。**已改**为原版禁用样式（slate-100 底、slate-400 字、`cursor-not-allowed`），提示文字改为"请先开启「辅码开关」"。

### 5.2 实现按原版截图、与计划字面不同

- 常用设置的入口码字段标签是"入口码"，"书籍入口编号"只作为输入框的 title。计划 Task 10 的改名表要求标签改为"书籍入口编号"，但原版截图 13 的标签就是"入口码"，实现与原版一致。
- 编辑器右栏点词没有做 Shift+点击扩展，改为原版截图 11 底部提示的规则：点区间外的词扩展首或末，点首、末词收缩。每行的时间显示一位小数，"N 词"只在头部显示总数，也是按截图 11。`RecognizedTextPanel.tsx` 头部注释写明了这个取舍，计划 Task 11 允许"以截图为准"。

### 5.3 验收留下的数据改动

项目"验收-单音频"（`2116193548679368706`）的 `book-alignment.json` 保留了编辑器测试的结果：`manualRanges["p1:s0"]` 为 0.2–1.0，`boxOverrides["p1:s0"]` 为 `{x:136,y:146,width:526,height:94}`。测试前的快照在 `pepapage-worker/tmp/acceptance/ui/editor/baseline-*.json`。工作台验收新建的空文件夹和 TTS 项目已删除；page1 按计划执行过一次重新对齐，已恢复 completed。
