package com.yueya.project;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.yueya.project.entity.BookProject;
import com.yueya.storage.OssService;
import com.yueya.storage.StorageKeys;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 解析详情（契约 §2 GET /book-projects/{id}/analysis）：合并 OCR、alignment、字幕、词时间、页映射、行映射，
 * 供解析详情弹窗和编辑器右栏共用。页码一律 1 起始（lines[].page、pages[].index）。
 * <ul>
 *   <li>OCR：single 只读原始 book-ocr.json（与对齐一致）；multi/tts 先读 book-ocr-reviewed.json。</li>
 *   <li>字幕：subtitles.lrc 按 {@link SubtitleParser} 解析（SRT 新 / LRC 旧）。词：新结构按行号键取，
 *       旧平铺数组按 line.start &lt;= w.start &lt; line.end 分配。</li>
 *   <li>pageMatch：行映射命中句（新 entries.sentenceIndex &gt;= 0 或旧 sentenceIndexes 非空）为 exact，
 *       page = entry.pageIndex + 1（pageIndex 0 起始，未经原版样本验证），pageIndex 为 -1 时取句子的 pageIndex；
 *       否则页映射有该行为 heuristic，page = 映射值 + 1；都没有为 none。</li>
 *   <li>blocks：single 所属句 alignment start &gt;= 0 为 matched 并继承句子时间；tts 在 book-audio-mapping 里有该句为 tts
 *       并附签名 audioUrl；其余（含 multi）为 unmatched，时间 -1。</li>
 *   <li>regionType：版面区域类型，来自 book-ocr.json（worker 按区域分组 OCR 且组带类型时写入，值集见原版
 *       Sqe，如 doc_title/text/image；原版对 sentences 与 blocks 一同写入）。原样透传：blocks 没有该字段时
 *       显式 null，sentences 没有时省略（与各自 regionIndex 的处理一致）。解析详情弹窗用它把文字块按相邻
 *       regionIndex+regionType 分组并显示组标题（原版 Sqe/kqe/Nqe），无值时不显示组标题，与原版一致。</li>
 * </ul>
 * 响应用 ObjectNode 组装：全局配置 default-property-inclusion=non_null 会丢掉 Map 里的 null，
 * 而前端类型要求 pdfUrl/audioUrl/page/sentenceIndex/regionIndex 显式为 null（regionType 仅 blocks 要求显式 null）。
 */
@Service
@RequiredArgsConstructor
public class AnalysisService {

    private static final JsonNodeFactory NF = JsonNodeFactory.instance;

    private final BookProjectService projectService;
    private final ProjectFileService fileService;
    private final OssService ossService;

    /** 行映射命中：sentenceIndex 0 起始；page0 为 0 起始页，-1 表示没有页信息。 */
    private record Exact(int sentenceIndex, int page0) {
    }

    public ObjectNode analysis(Long userId, Long id) {
        BookProject p = projectService.requireOwned(userId, id);
        String prefix = StorageKeys.projectPrefix(p.getUserId(), p.getId());
        String mode = p.getAudioMode();
        boolean single = "single".equals(mode);
        boolean tts = "tts".equals(mode);

        JsonNode ocr = single ? null : fileService.readJsonByKey(prefix + "book-ocr-reviewed.json");
        if (ocr == null) {
            ocr = fileService.readJsonByKey(prefix + "book-ocr.json");
        }
        JsonNode alignment = fileService.readJsonByKey(prefix + "book-alignment.json");
        Map<Integer, JsonNode> aligned = new HashMap<>();
        for (JsonNode a : array(alignment, "alignments")) {
            if (a.hasNonNull("sentenceIndex")) {
                aligned.putIfAbsent(a.get("sentenceIndex").asInt(), a);
            }
        }

        ObjectNode out = NF.objectNode();
        out.put("audioMode", mode);
        out.put("pdfUrl", p.getSourceFileKey() == null ? null : ossService.signedGetUrl(p.getSourceFileKey()));
        String audioKey = null;
        if (single) {
            audioKey = ossService.exists(prefix + "audio.wav") ? prefix + "audio.wav" : p.getAudioFileKey();
        }
        out.put("audioUrl", audioKey == null ? null : ossService.signedGetUrl(audioKey));

        // pages
        ArrayNode pages = out.putArray("pages");
        JsonNode ocrPages = array(ocr, "pages");
        for (int i = 0; i < ocrPages.size(); i++) {
            JsonNode pg = ocrPages.get(i);
            ObjectNode page = pages.addObject();
            page.put("index", pg.path("index").asInt(i + 1));
            page.put("width", pg.path("width").asDouble());
            page.put("height", pg.path("height").asDouble());
            page.put("sentenceStart", pg.path("sentenceStart").asInt());
            page.put("sentenceCount", pg.path("sentenceCount").asInt());
        }

        // sentences
        ArrayNode sentences = out.putArray("sentences");
        Map<Integer, JsonNode> sentenceByIndex = new HashMap<>();
        JsonNode ocrSentences = array(ocr, "sentences");
        for (int i = 0; i < ocrSentences.size(); i++) {
            JsonNode s = ocrSentences.get(i);
            int si = s.hasNonNull("sentenceIndex") ? s.get("sentenceIndex").asInt() : i;
            sentenceByIndex.put(si, s);
            JsonNode a = aligned.get(si);
            ObjectNode o = sentences.addObject();
            o.put("sentenceIndex", si);
            o.put("pageIndex", s.path("pageIndex").asInt());
            o.put("text", s.path("text").asText(""));
            if (s.hasNonNull("box")) {
                o.set("box", s.get("box"));
            }
            if (s.hasNonNull("regionIndex")) {
                o.put("regionIndex", s.get("regionIndex").asInt());
            }
            if (s.hasNonNull("regionType")) {
                o.put("regionType", s.get("regionType").asText());
            }
            o.put("start", time(a, "start"));
            o.put("end", time(a, "end"));
            if (a != null && a.path("words").isArray()) {
                ArrayNode words = o.putArray("words");
                for (JsonNode w : a.get("words")) {
                    ObjectNode wo = words.addObject();
                    wo.put("start", w.path("start").asDouble(-1));
                    wo.put("end", w.path("end").asDouble(-1));
                    wo.put("confidence", w.path("confidence").asDouble(0));
                }
            }
        }

        // tts：sentenceIndex → 签名 URL（同一句多条时取第一条）
        Map<Integer, String> ttsUrls = new LinkedHashMap<>();
        if (tts) {
            JsonNode mapping = fileService.readJsonByKey(prefix + "book-audio-mapping.json");
            for (JsonNode e : array(mapping, "entries")) {
                String fileName = e.path("fileName").asText("");
                if (fileName.isBlank() || !e.hasNonNull("sentenceIndex")) {
                    continue;
                }
                int si = e.get("sentenceIndex").asInt();
                if (!ttsUrls.containsKey(si)) {
                    String key = fileName.startsWith("users/") ? fileName : prefix + fileName;
                    ttsUrls.put(si, ossService.signedGetUrl(key));
                }
            }
        }

        // blocks
        ArrayNode blocks = out.putArray("blocks");
        JsonNode ocrBlocks = array(ocr, "blocks");
        for (int i = 0; i < ocrBlocks.size(); i++) {
            JsonNode b = ocrBlocks.get(i);
            int si = b.path("sentenceIndex").asInt(-1);
            ObjectNode o = blocks.addObject();
            String blockId = b.path("id").asText("");
            o.put("id", blockId.isEmpty() ? "b" + i : blockId);
            o.put("pageIndex", b.path("pageIndex").asInt());
            if (b.hasNonNull("regionIndex")) {
                o.put("regionIndex", b.get("regionIndex").asInt());
            } else {
                o.putNull("regionIndex");
            }
            // 原样透传 book-ocr.json 的版面区域类型；OCR 没有时显式 null（前端不显示组标题）
            if (b.hasNonNull("regionType")) {
                o.put("regionType", b.get("regionType").asText());
            } else {
                o.putNull("regionType");
            }
            o.put("text", b.path("text").asText(""));
            if (b.hasNonNull("box")) {
                o.set("box", b.get("box"));
            }
            o.put("sentenceIndex", si);
            JsonNode a = aligned.get(si);
            if (single && a != null && time(a, "start") >= 0) {
                o.put("start", time(a, "start"));
                o.put("end", time(a, "end"));
                o.put("status", "matched");
            } else if (tts && ttsUrls.containsKey(si)) {
                o.put("start", -1.0);
                o.put("end", -1.0);
                o.put("status", "tts");
                o.put("audioUrl", ttsUrls.get(si));
            } else {
                o.put("start", -1.0);
                o.put("end", -1.0);
                o.put("status", "unmatched");
            }
        }

        // lines
        ArrayNode lines = out.putArray("lines");
        byte[] raw = ossService.getObject(prefix + "subtitles.lrc");
        List<SubtitleParser.Line> subtitleLines =
                raw == null ? List.of() : SubtitleParser.parse(new String(raw, StandardCharsets.UTF_8));
        if (!subtitleLines.isEmpty()) {
            JsonNode wt = fileService.readJsonByKey(prefix + "word-timestamps.json");
            JsonNode words = wt == null ? NF.missingNode() : wt.path("words");
            Map<Integer, Exact> exact = lineOcrMatches(fileService.readJsonByKey(prefix + "book-line-ocr-mapping.json"));
            Map<Integer, Integer> heuristic = pageMatches(fileService.readJsonByKey(prefix + "book-page-mapping.json"),
                    subtitleLines);
            for (SubtitleParser.Line line : subtitleLines) {
                ObjectNode o = lines.addObject();
                o.put("index", line.index());
                o.put("start", line.start());
                o.put("end", line.end());
                o.put("text", line.text());
                o.set("words", lineWords(words, line));
                Exact ex = exact.get(line.index());
                Integer page0 = heuristic.get(line.index());
                if (ex != null) {
                    // 行映射 pageIndex 0 起始（未经原版样本验证）；-1 时取句子自己的 1 起始 pageIndex
                    Integer page = ex.page0() >= 0 ? Integer.valueOf(ex.page0() + 1)
                            : sentencePage(sentenceByIndex, ex.sentenceIndex());
                    o.put("page", page);
                    o.put("pageMatch", "exact");
                    o.put("sentenceIndex", ex.sentenceIndex());
                } else if (page0 != null) {
                    o.put("page", page0 + 1);
                    o.put("pageMatch", "heuristic");
                    o.putNull("sentenceIndex");
                } else {
                    o.putNull("page");
                    o.put("pageMatch", "none");
                    o.putNull("sentenceIndex");
                }
            }
        }

        // counts
        int matched;
        if (single) {
            if (alignment != null && alignment.path("matchedCount").isNumber()) {
                matched = alignment.get("matchedCount").asInt();
            } else {
                matched = (int) aligned.values().stream().filter(a -> time(a, "start") >= 0).count();
            }
        } else if (tts) {
            matched = ttsUrls.size();
        } else {
            matched = 0;
        }
        ObjectNode counts = out.putObject("counts");
        counts.put("pages", pages.size());
        counts.put("sentences", sentences.size());
        counts.put("blocks", blocks.size());
        counts.put("lines", lines.size());
        counts.put("matched", matched);
        return out;
    }

    /** node.field 是数组时返回它，否则返回空数组。 */
    private static JsonNode array(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v != null && v.isArray() ? v : NF.arrayNode();
    }

    private static double time(JsonNode alignment, String field) {
        return alignment == null ? -1 : alignment.path(field).asDouble(-1);
    }

    private static Integer sentencePage(Map<Integer, JsonNode> sentenceByIndex, int sentenceIndex) {
        JsonNode s = sentenceByIndex.get(sentenceIndex);
        return s != null && s.hasNonNull("pageIndex") ? Integer.valueOf(s.get("pageIndex").asInt()) : null;
    }

    /** 某行的词：新结构 words["行号"]；旧平铺数组按 line.start &lt;= w.start &lt; line.end。缺数字 start/end 的词丢弃。 */
    private static ArrayNode lineWords(JsonNode words, SubtitleParser.Line line) {
        ArrayNode out = NF.arrayNode();
        JsonNode items;
        boolean flat = words.isArray();
        if (words.isObject()) {
            items = words.path(String.valueOf(line.index()));
        } else if (flat) {
            items = words;
        } else {
            return out;
        }
        if (!items.isArray()) {
            return out;
        }
        for (JsonNode w : items) {
            if (!w.isObject() || !w.path("start").isNumber() || !w.path("end").isNumber()) {
                continue;
            }
            double start = w.get("start").asDouble();
            if (flat && !(line.start() <= start && start < line.end())) {
                continue;
            }
            ObjectNode wo = out.addObject();
            wo.put("text", w.path("text").asText(""));
            wo.put("start", start);
            wo.put("end", w.get("end").asDouble());
        }
        return out;
    }

    /**
     * 行 OCR 映射里命中句的行。新结构 entries[{lineIndex,sentenceIndex,pageIndex,score}]（未命中为 -1）；
     * 旧结构 mappings[{lineIndex,sentenceIndexes:[...]}] 取第一个句号，没有页信息。
     */
    private static Map<Integer, Exact> lineOcrMatches(JsonNode mapping) {
        Map<Integer, Exact> out = new HashMap<>();
        if (mapping == null) {
            return out;
        }
        if (mapping.path("entries").isArray()) {
            JsonNode entries = mapping.get("entries");
            for (int k = 0; k < entries.size(); k++) {
                JsonNode e = entries.get(k);
                int si = e.path("sentenceIndex").asInt(-1);
                if (si >= 0) {
                    out.putIfAbsent(e.path("lineIndex").asInt(k), new Exact(si, e.path("pageIndex").asInt(-1)));
                }
            }
        } else if (mapping.path("mappings").isArray()) {
            JsonNode entries = mapping.get("mappings");
            for (int k = 0; k < entries.size(); k++) {
                JsonNode e = entries.get(k);
                JsonNode idx = e.path("sentenceIndexes");
                int si = idx.isArray() && !idx.isEmpty() ? idx.get(0).asInt(-1) : -1;
                if (si >= 0) {
                    out.putIfAbsent(e.path("lineIndex").asInt(k), new Exact(si, -1));
                }
            }
        }
        return out;
    }

    /** 页映射：新结构 mappings{"行号": 0 起始页}；旧结构 mappings[{lineIndex,pageIndex}]。返回行号 → 0 起始页。 */
    private static Map<Integer, Integer> pageMatches(JsonNode mapping, List<SubtitleParser.Line> lines) {
        Map<Integer, Integer> out = new HashMap<>();
        if (mapping == null) {
            return out;
        }
        JsonNode mappings = mapping.path("mappings");
        if (mappings.isObject()) {
            for (SubtitleParser.Line line : lines) {
                JsonNode v = mappings.path(String.valueOf(line.index()));
                if (v.isNumber() && v.asInt() >= 0) {
                    out.put(line.index(), v.asInt());
                }
            }
        } else if (mappings.isArray()) {
            for (int k = 0; k < mappings.size(); k++) {
                JsonNode e = mappings.get(k);
                JsonNode v = e.path("pageIndex");
                if (v.isNumber() && v.asInt() >= 0) {
                    out.putIfAbsent(e.path("lineIndex").asInt(k), v.asInt());
                }
            }
        }
        return out;
    }
}
