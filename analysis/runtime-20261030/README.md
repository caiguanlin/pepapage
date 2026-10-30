# 绘本源续分析：运行观察与补证

日期：2026-10-30（Asia/Shanghai）。对象：用户已经打开的 Windows x64 PepaPage 2.3.6，安装目录 `D:/systemSoft/PepaPage`。本轮复用一个已有的单音频完成项目 `page1`，不表示本轮执行过其创建、OCR 或 ASR。

## 1. 证据来源与身份

| 标识 | 来源与范围 |
|---|---|
| UI-08～UI-23 | Windows Computer Use 对现有实例的实际操作、截图；不是 REA CDP 运行捕获 |
| FILE-P1 | [项目文件结构摘要](project-observation.json)：只读读取所选项目文件、哈希及统计，不复制整书与音频 |
| FILE-PKG | [课件样本外层摘要](courseware-observation.json)：实际由原版 UI 导出的 `.nexusbookpkg` |
| REA-FUSES | `ev_c62c850c29c850803708596a69d011defcadf89088c3c32c188b74fd5b666d99`，[完整 fuse Evidence](rea/electron-fuses.json) |
| REA-MAIN | `ev_4570edcc6bd3acb30c32c800a56d0409c4f0d15afb394d8cb2537670f69e95b8`，选 main/preload 等五个文件，详见 [静态补证](static-findings.md) |
| REA-FRONT-PARTIAL | `ev_95d6859a04095e4a2bd9de639a1c0cf75a8119a5188e4edcb34021f78354c46a`，前端单文件分析触及 300000ms provider deadline，仅保留部分证据，不能据此宣称前端语义分析完成 |

已安装 ASAR SHA-256 为 `dfefd44f6eff9af2bb475cae65749a654cdc65704c4b123d4556d26a02c79844`，与总报告对应版本一致。主 EXE 为 201,233,408 字节，SHA-256 `8eef83579fadf1700e6158da0000c3d170f4311bceccca7072f4cfbddec283e7`。REA 版本 6.8.0。当前主进程没有 CDP 监听；fuse 允许 Node inspect 参数并不表示当前 Inspector 已启用。本轮通过 CLI 使用 REA，没有重启原应用或修改 MCP 配置。

[REA本地证据索引](rea-index.json) 保留各记录ID、文件哈希、选集、超时与清理限制。旧报告所指 `analysis/rea-evidence.json`、`analysis/asar-inventory.json` 在本轮开始时不存在，本轮没有将旧报告叙述当作可读取的完整证据复用。

## 2. 实际完成的检查

| 结论 | 证据 | 边界 |
|---|---|---|
| 已有 single/Tiny 卡片显示页13、字幕26、已对齐2、时长0:04 | UI-08，FILE-P1 | 创建过程不在观察窗口内；短音频不能代表整书识别质量 |
| 更多菜单为详情、重新对齐、删除项目；完成卡片主体进入阅读器，返回绘本源后卡片恢复 | UI-16、17、18、19 | 没有触发重对齐或删除；未全面测试阅读器播放/查词/标注 |
| 辅码默认关闭；页面已显示识别框和入口贴纸；开启后文字区叠加点阵且导出按钮启用 | UI-09、10 | 入口贴纸预览不是成功导出证明 |
| 选中文字框会显示八个缩放手柄和删除按钮、选中对应识别词，并出现停靠底部的音轨 | UI-11 | 本轮未拖动框、删除、改起止或替换音源 |
| 所选 Butterfly 框显示 2.020–2.900 秒、遍数1；点击区域出现“播放中”，随后恢复“试听” | UI-11 | 是播放控件状态观察，未通过独立音频采集评估听感/切音精度 |
| 常用设置显示入口56001、内容25001、一段一码、图码一体；码点为600dpi/2×2 | UI-13、14 | 这些值是当前项目值，与静态默认一致，不替代所有历史项目配置 |
| 手动铺码提供矩形/圆形，说明支持拖放或划区 | UI-15 | 只检查入口，没有在用户原书上新建区域 |
| 点读导出确认显示200积分、当前0、余额不足且确认禁用 | UI-12 | 取消返回，未授权、未扣费、未生成点读 ZIP/PDF |
| 全选后出现导出课件、导出单词本、移动、删除；导出课件经原生另存为成功 | UI-20、21，FILE-PKG | 无收费确认，完成后余额仍0；这不是证明所有包/所有服务永久免费 |
| 多音频创建表单明确手动、免识别、免费；无文件时开始制作禁用 | UI-22 | 未创建 multi 项目 |
| 无音频表单显示8个英文声线、Bella和1.0x、本地KittenTTS说明；无需上传音频 | UI-23 | 未初始化/下载TTS模型，未实际合成 |

退出时已将原项目辅码开关恢复为关闭、创建表单恢复为单音频并取消，应用留在绘本源。没有改动书页、音轨、识别文字或删除项目。本轮额外的持久化效果包括正常阅读入口可能更新的阅读影子数据、辅码设置的正常保存，以及分析目录下导出的课件文件。

## 3. 数据含义不能混用

实际项目 `book-ocr.json` 有13页、26句、39个文字块；第一页3句。`book-alignment.json` 为 `mode:"word"`、26项、`matchedCount:2`。**名为 `subtitles.lrc` 的文件实际保存SRT文本**：序号1/2、逗号毫秒时间戳与 `-->` 时段，共2条，界面也正确展示2条；不能仅按扩展名强制使用LRC解析器。`word-timestamps.json.words` 是以字幕行号字符串为键的对象，共7个词。卡片“字幕26”读取的数量与实际字幕条数不同，不能用它断言识别出了26条字幕。

`book-line-ocr-mapping.json` 有2项但 `matchedCount:0`，两项均 `sentenceIndex:-1,pageIndex:-1,score:0`；同时 `book-page-mapping.json.mappings` 将两条字幕都映射至零起始页0。句级音轨对齐、行到OCR句的精确匹配、行到书页映射是三种不同结果；界面显示 P1 和部分框可试听不意味着精确行句匹配成功。OCR页号1起始、页映射0起始，见专项规格。

## 4. 需要修正的静态结论

1. 选择书源不是目录导入。仅单PDF分支自动查找同目录、同basename且大小写不敏感的首个音频；图片分支只自然排序图片，不自动附音频。主进程明文锚点为 `select-book-source`，M第1014行。
2. completed 只表示制作状态。默认手动multi若没有有效 `book-audio-mapping.json.entries`，点击卡片会走“多音频未经过模型处理，无法使用阅读器”的代码分支。手工码区音源绑定与阅读器映射分别保存；本轮未创建multi实测该错误。
3. 项目根是 `app.getPath('userData')/project-files`。Windows可写安装目录与portable模式会影响userData；当前进程实际使用 `D:/systemSoft/PepaPage/user-data`，不能将此路径硬编码为所有安装的默认值。

详细代码锚点、完整性与限制见 [静态补证](static-findings.md)。

## 5. 截图索引

新增截图原始尺寸为1449×1069；不等同于既有1386×893基线或CSS视口。Windows进程参数显示device-scale-factor=1.5，坐标仍应按各自坐标系解释。含账户的截图遮盖账号区域；蓝色鼠标光晕仍为取证工具效果。

| 编号 | 截图 |
|---|---|
| UI-08 | [完成项目卡](../screenshots/08-book-completed.png) |
| UI-09 | [辅码初始关闭](../screenshots/09-aux-default.png) |
| UI-10 | [开启辅码](../screenshots/10-aux-enabled.png) |
| UI-11 | [码区选择、识别词与底部音轨](../screenshots/11-aux-waveform.png) |
| UI-12 | [点读导出余额不足](../screenshots/12-oid-export-balance.png) |
| UI-13 | [常用设置](../screenshots/13-aux-common-settings.png) |
| UI-14 | [码点设置](../screenshots/14-aux-dot-settings.png) |
| UI-15 | [手动铺码工具](../screenshots/15-aux-manual-tools.png) |
| UI-16 | [更多菜单](../screenshots/16-book-menu.png) |
| UI-17 | [解析详情：字幕](../screenshots/17-book-detail-subtitles.png) |
| UI-18 | [解析详情：文字块](../screenshots/18-book-detail-blocks.png) |
| UI-19 | [共享阅读器](../screenshots/19-book-reader.png) |
| UI-20 | [批量操作](../screenshots/20-book-batch-actions.png) |
| UI-21 | [课件导出完成](../screenshots/21-book-courseware-exported.png) |
| UI-22 | [多音频表单](../screenshots/22-book-create-multi.png) |
| UI-23 | [无音频表单](../screenshots/23-book-create-tts.png) |

## 6. 本轮仍未解决

OCR/ASR创建至完成、TTS校稿和合成、手工区域保存重开、裁剪应用、课件往返导入、真实点读包、扣费及打印笔兼容仍待实测。已取得的旧项目文件证明存储形状，不能倒推出本轮执行过所有生成步骤。

完整REA大证据、定向提取代码与原书课件样本仅本地保留并被Git忽略。REA-MAIN证据已发布，随后清理 `.rea-write-szp3i4/content` 遇到Windows EBUSY；自动批准审查拒绝清理命令，返回 `blocked by policy`，暂存副本保留。前端provider超时也已记录，未重复相同分析，未将部分证据标成完整恢复。
