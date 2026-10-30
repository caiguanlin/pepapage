package com.pepapage.project;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pepapage.common.Result;
import com.pepapage.project.entity.BookProject;
import com.pepapage.storage.OssService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AnalysisServiceTest {

    private static final long USER_ID = 7L;
    private static final long PROJECT_ID = 11L;
    private static final String PREFIX = "users/7/book-projects/11/";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** 4.1 节样本：SRT 两条字幕。 */
    private static final String SAMPLE_SRT = "1\n00:00:00,940 --> 00:00:01,250\nHello\n\n"
            + "2\n00:00:01,500 --> 00:00:02,900\nButterfly ...\n";

    @Mock
    private BookProjectService projectService;
    @Mock
    private ProjectFileService fileService;
    @Mock
    private OssService ossService;
    @InjectMocks
    private AnalysisService analysisService;

    /** 相对文件名 → JSON 文本；未放入的文件视为不存在。 */
    private final Map<String, String> files = new HashMap<>();
    /** 相对文件名 → 原始文本（ossService.getObject 读取，如 subtitles.lrc）。 */
    private final Map<String, String> objects = new HashMap<>();

    @BeforeEach
    void setUp() {
        lenient().when(fileService.readJsonByKey(anyString())).thenAnswer(inv -> {
            String json = files.get(relative(inv.getArgument(0)));
            return json == null ? null : MAPPER.readTree(json);
        });
        lenient().when(ossService.getObject(anyString())).thenAnswer(inv -> {
            String text = objects.get(relative(inv.getArgument(0)));
            return text == null ? null : text.getBytes(StandardCharsets.UTF_8);
        });
        lenient().when(ossService.signedGetUrl(anyString())).thenAnswer(inv -> "https://signed/" + inv.getArgument(0));
    }

    private static String relative(String key) {
        return key.startsWith(PREFIX) ? key.substring(PREFIX.length()) : null;
    }

    private void project(String mode) {
        BookProject p = new BookProject();
        p.setId(PROJECT_ID);
        p.setUserId(USER_ID);
        p.setAudioMode(mode);
        p.setStatus("completed");
        p.setSourceFileKey(PREFIX + "book.pdf");
        if ("single".equals(mode)) {
            p.setAudioFileKey(PREFIX + "book-audio.mp3");
        }
        when(projectService.requireOwned(USER_ID, PROJECT_ID)).thenReturn(p);
    }

    /**
     * 按原版样本形状构造 OCR：13 页、26 句、39 块，第 1 页 3 句，第 2–12 页各 2 句，第 13 页 1 句。
     * 偶数句 2 块、奇数句 1 块；每句的第二块不带 regionIndex。
     */
    private static String sampleOcr(String textPrefix) {
        ObjectNode ocr = MAPPER.createObjectNode();
        ocr.put("version", 1).put("sourceType", "pdf").put("pageCount", 13).put("sentenceCount", 26);
        ArrayNode pages = ocr.putArray("pages");
        ArrayNode sentences = ocr.putArray("sentences");
        ArrayNode blocks = ocr.putArray("blocks");
        int si = 0;
        for (int page = 1; page <= 13; page++) {
            int count = page == 1 ? 3 : page == 13 ? 1 : 2;
            pages.addObject().put("index", page).put("width", 1087).put("height", 1673)
                    .put("sentenceStart", si).put("sentenceCount", count);
            for (int k = 0; k < count; k++, si++) {
                ObjectNode s = sentences.addObject();
                s.put("id", "s" + si).put("pageIndex", page).put("sentenceIndex", si)
                        .put("text", textPrefix + " " + si).put("regionIndex", 0);
                s.putArray("words");
                s.putObject("box").put("x", 10).put("y", 40 * k).put("width", 300).put("height", 30);
                int blockCount = si % 2 == 0 ? 2 : 1;
                for (int b = 0; b < blockCount; b++) {
                    ObjectNode block = blocks.addObject();
                    block.put("id", "b" + blocks.size()).put("pageIndex", page).put("text", textPrefix + " block " + si)
                            .put("sentenceIndex", si);
                    block.putObject("box").put("x", 10).put("y", 40 * k + 15 * b).put("width", 300).put("height", 15);
                    if (b == 0) {
                        block.put("regionIndex", 0);
                    }
                }
            }
        }
        return ocr.toString();
    }

    /** 26 句，第 0、1 句命中（0.94–1.25、1.5–2.9），其余 -1。 */
    private static String sampleAlignment(boolean withMatchedCount) {
        ObjectNode a = MAPPER.createObjectNode();
        a.put("version", 1).put("sentenceCount", 26);
        if (withMatchedCount) {
            a.put("matchedCount", 2);
        }
        a.put("mode", "word");
        ArrayNode arr = a.putArray("alignments");
        for (int i = 0; i < 26; i++) {
            double start = i == 0 ? 0.94 : i == 1 ? 1.5 : -1;
            double end = i == 0 ? 1.25 : i == 1 ? 2.9 : -1;
            double conf = i < 2 ? 0.9 : 0;
            ObjectNode e = arr.addObject().put("sentenceIndex", i).put("start", start).put("end", end)
                    .put("confidence", conf);
            e.putArray("words").addObject().put("start", start).put("end", end).put("confidence", conf);
        }
        return a.toString();
    }

    private JsonNode run() {
        return analysisService.analysis(USER_ID, PROJECT_ID);
    }

    private static List<String> texts(JsonNode words) {
        List<String> out = new ArrayList<>();
        words.forEach(w -> out.add(w.get("text").asText()));
        return out;
    }

    /** 与 application.yml 的 default-property-inclusion: non_null 相同的序列化。 */
    private static String serialize(JsonNode out) throws Exception {
        return new ObjectMapper().setDefaultPropertyInclusion(JsonInclude.Include.NON_NULL)
                .writeValueAsString(Result.ok(out));
    }

    private static void assertSampleCounts(JsonNode out) {
        JsonNode counts = out.get("counts");
        assertEquals(13, counts.get("pages").asInt());
        assertEquals(26, counts.get("sentences").asInt());
        assertEquals(39, counts.get("blocks").asInt());
        assertEquals(2, counts.get("lines").asInt());
        assertEquals(2, counts.get("matched").asInt());
    }

    @Test
    void singleSampleWithNewStructures() throws Exception {
        project("single");
        when(ossService.exists(PREFIX + "audio.wav")).thenReturn(true);
        files.put("book-ocr.json", sampleOcr("Raw"));
        files.put("book-ocr-reviewed.json", sampleOcr("Reviewed"));
        files.put("book-alignment.json", sampleAlignment(true));
        objects.put("subtitles.lrc", SAMPLE_SRT);
        files.put("word-timestamps.json", """
                {"version":1,"words":{"0":[{"text":"Hello","start":0.94,"end":1.25}],
                                      "1":[{"text":"Butterfly","start":2.02,"end":2.9}]}}""");
        files.put("book-page-mapping.json", """
                {"version":1,"lineCount":2,"pageCount":13,"mappings":{"0":0,"1":0},"tailRefinedCount":0}""");
        files.put("book-line-ocr-mapping.json", """
                {"version":1,"lineCount":2,"sentenceCount":26,"matchedCount":0,"entries":[
                  {"lineIndex":0,"sentenceIndex":-1,"pageIndex":-1,"score":0},
                  {"lineIndex":1,"sentenceIndex":-1,"pageIndex":-1,"score":0}]}""");

        JsonNode out = run();

        assertEquals("single", out.get("audioMode").asText());
        assertEquals("https://signed/" + PREFIX + "book.pdf", out.get("pdfUrl").asText());
        assertEquals("https://signed/" + PREFIX + "audio.wav", out.get("audioUrl").asText());
        assertSampleCounts(out);

        JsonNode lines = out.get("lines");
        assertEquals(2, lines.size());
        for (JsonNode line : lines) {
            assertEquals(1, line.get("page").asInt());
            assertEquals("heuristic", line.get("pageMatch").asText());
            assertTrue(line.get("sentenceIndex").isNull());
        }
        assertEquals("Hello", lines.get(0).get("text").asText());
        assertEquals(0.94, lines.get(0).get("start").asDouble());
        assertEquals(1.25, lines.get(0).get("end").asDouble());
        assertEquals(List.of("Hello"), texts(lines.get(0).get("words")));
        assertEquals(List.of("Butterfly"), texts(lines.get(1).get("words")));
        assertEquals(2.02, lines.get(1).get("words").get(0).get("start").asDouble());

        JsonNode page1 = out.get("pages").get(0);
        assertEquals(1, page1.get("index").asInt());
        assertEquals(0, page1.get("sentenceStart").asInt());
        assertEquals(3, page1.get("sentenceCount").asInt());
        assertEquals(13, out.get("pages").get(12).get("index").asInt());

        // single 读原始 OCR，时间来自 alignment
        JsonNode s0 = out.get("sentences").get(0);
        assertEquals("Raw 0", s0.get("text").asText());
        assertEquals(1, s0.get("pageIndex").asInt());
        assertEquals(0, s0.get("regionIndex").asInt());
        assertEquals(10, s0.get("box").get("x").asInt());
        assertEquals(0.94, s0.get("start").asDouble());
        assertEquals(0.9, s0.get("words").get(0).get("confidence").asDouble());
        assertEquals(-1, out.get("sentences").get(2).get("start").asDouble());

        JsonNode blocks = out.get("blocks");
        // b0、b1 属于第 0 句，b2 属于第 1 句，b3、b4 属于第 2 句
        assertEquals("matched", blocks.get(0).get("status").asText());
        assertEquals(0.94, blocks.get(0).get("start").asDouble());
        assertEquals(1.25, blocks.get(1).get("end").asDouble());
        assertTrue(blocks.get(1).get("regionIndex").isNull());
        assertEquals("matched", blocks.get(2).get("status").asText());
        assertEquals(1.5, blocks.get(2).get("start").asDouble());
        assertEquals("unmatched", blocks.get(3).get("status").asText());
        assertEquals(-1, blocks.get(3).get("start").asDouble());
        assertEquals(2, blocks.get(3).get("sentenceIndex").asInt());
        assertFalse(blocks.get(3).has("audioUrl"));

        String json = serialize(out);
        assertTrue(json.contains("\"sentenceIndex\":null"), json);
        assertTrue(json.contains("\"regionIndex\":null"), json);
    }

    @Test
    void singleSampleWithOldStructures() {
        project("single");
        when(ossService.exists(PREFIX + "audio.wav")).thenReturn(false);
        files.put("book-ocr.json", sampleOcr("Raw"));
        files.put("book-alignment.json", sampleAlignment(false));
        objects.put("subtitles.lrc", "[00:00.94]Hello\n[00:01.50]Butterfly ...\n");
        files.put("word-timestamps.json", """
                {"version":1,"model":"base","language":"en","segments":[],"words":[
                  {"text":"Hello","start":0.94,"end":1.25,"probability":0.9},
                  {"text":"Butterfly","start":2.02,"end":2.9,"probability":0.8},
                  {"text":"broken","start":null,"end":3.0},
                  {"text":"late","start":4.5,"end":4.9}]}""");
        files.put("book-page-mapping.json", """
                {"version":1,"lineCount":2,"pageCount":13,"tailRefinedCount":0,"mappings":[
                  {"lineIndex":0,"pageIndex":0,"start":0.94,"end":1.5,"text":"Hello","score":0.4},
                  {"lineIndex":1,"pageIndex":0,"start":1.5,"end":4.5,"text":"Butterfly ...","score":0.3}]}""");
        files.put("book-line-ocr-mapping.json", """
                {"version":1,"lineCount":2,"sentenceCount":26,"mappings":[
                  {"lineIndex":0,"start":0.94,"end":1.5,"text":"Hello","sentenceIndexes":[]},
                  {"lineIndex":1,"start":1.5,"end":4.5,"text":"Butterfly ...","sentenceIndexes":[]}]}""");

        JsonNode out = run();

        assertEquals("https://signed/" + PREFIX + "book-audio.mp3", out.get("audioUrl").asText());
        assertSampleCounts(out); // 没有 matchedCount 时统计 start >= 0 的句数

        JsonNode lines = out.get("lines");
        assertEquals(2, lines.size());
        for (JsonNode line : lines) {
            assertEquals(1, line.get("page").asInt());
            assertEquals("heuristic", line.get("pageMatch").asText());
            assertTrue(line.get("sentenceIndex").isNull());
        }
        assertEquals(1.5, lines.get(0).get("end").asDouble());
        assertEquals(4.5, lines.get(1).get("end").asDouble());
        // 平铺词按 line.start <= w.start < line.end 分配；4.5 等于第 2 行 end，不归入
        assertEquals(List.of("Hello"), texts(lines.get(0).get("words")));
        assertEquals(List.of("Butterfly"), texts(lines.get(1).get("words")));
        assertFalse(lines.get(0).get("words").get(0).has("probability"));
        assertEquals("matched", out.get("blocks").get(0).get("status").asText());
    }

    @Test
    void exactMatchesFromLineMapping() {
        project("single");
        files.put("book-ocr.json", sampleOcr("Raw"));
        objects.put("subtitles.lrc", "1\n00:00:01,000 --> 00:00:02,000\na\n\n"
                + "2\n00:00:02,000 --> 00:00:03,000\nb\n\n"
                + "3\n00:00:03,000 --> 00:00:04,000\nc\n");
        // 第 0 行带 0 起始 pageIndex；第 1 行 pageIndex 为 -1，取句子 5 的 pageIndex（第 3 页）；第 2 行没有任何映射
        files.put("book-line-ocr-mapping.json", """
                {"version":1,"lineCount":3,"sentenceCount":26,"matchedCount":2,"entries":[
                  {"lineIndex":0,"sentenceIndex":3,"pageIndex":1,"score":0.9},
                  {"lineIndex":1,"sentenceIndex":5,"pageIndex":-1,"score":0.8},
                  {"lineIndex":2,"sentenceIndex":-1,"pageIndex":-1,"score":0}]}""");
        files.put("book-page-mapping.json", """
                {"version":1,"lineCount":3,"pageCount":13,"mappings":{"0":0,"1":0},"tailRefinedCount":0}""");

        JsonNode lines = run().get("lines");

        assertEquals("exact", lines.get(0).get("pageMatch").asText());
        assertEquals(2, lines.get(0).get("page").asInt());
        assertEquals(3, lines.get(0).get("sentenceIndex").asInt());
        assertEquals("exact", lines.get(1).get("pageMatch").asText());
        assertEquals(3, lines.get(1).get("page").asInt());
        assertEquals(5, lines.get(1).get("sentenceIndex").asInt());
        assertEquals("none", lines.get(2).get("pageMatch").asText());
        assertTrue(lines.get(2).get("page").isNull());
        assertTrue(lines.get(2).get("sentenceIndex").isNull());
        assertEquals(0, lines.get(2).get("words").size());
    }

    @Test
    void exactMatchFromOldLineMappingUsesFirstSentence() {
        project("single");
        files.put("book-ocr.json", sampleOcr("Raw"));
        objects.put("subtitles.lrc", "[00:01.00]a\n[00:02.00]b\n");
        files.put("book-line-ocr-mapping.json", """
                {"version":1,"mappings":[
                  {"lineIndex":0,"start":1.0,"end":2.0,"text":"a","sentenceIndexes":[5,6]},
                  {"lineIndex":1,"start":2.0,"end":5.0,"text":"b","sentenceIndexes":[]}]}""");

        JsonNode lines = run().get("lines");

        assertEquals("exact", lines.get(0).get("pageMatch").asText());
        assertEquals(5, lines.get(0).get("sentenceIndex").asInt());
        assertEquals(3, lines.get(0).get("page").asInt());
        assertEquals("none", lines.get(1).get("pageMatch").asText());
    }

    @Test
    void ttsBlocksUseAudioMappingAndReviewedOcr() throws Exception {
        project("tts");
        files.put("book-ocr.json", sampleOcr("Raw"));
        files.put("book-ocr-reviewed.json", sampleOcr("Reviewed"));
        files.put("book-audio-mapping.json", """
                {"version":1,"audioMode":"tts","fileCount":4,"pageCount":13,"matchedCount":4,"entries":[
                  {"fileName":"tts-0003.wav","originalName":"two","pageIndex":1,"box":null,"matchType":"exact","sentenceIndex":2},
                  {"fileName":"tts-0001.wav","originalName":"zero","pageIndex":1,"box":null,"matchType":"exact","sentenceIndex":0},
                  {"fileName":"","originalName":"four","pageIndex":2,"box":null,"matchType":"exact","sentenceIndex":4},
                  {"fileName":"tts-0099.wav","originalName":"none","pageIndex":2,"box":null,"matchType":"exact"}]}""");

        JsonNode out = run();

        assertEquals("tts", out.get("audioMode").asText());
        assertTrue(out.get("audioUrl").isNull());
        assertEquals("Reviewed 0", out.get("sentences").get(0).get("text").asText());
        JsonNode blocks = out.get("blocks");
        assertEquals("tts", blocks.get(0).get("status").asText());
        assertEquals("https://signed/" + PREFIX + "tts-0001.wav", blocks.get(0).get("audioUrl").asText());
        assertEquals(-1, blocks.get(0).get("start").asDouble());
        assertEquals("unmatched", blocks.get(2).get("status").asText()); // 第 1 句没有配音
        assertFalse(blocks.get(2).has("audioUrl"));
        assertEquals("https://signed/" + PREFIX + "tts-0003.wav", blocks.get(3).get("audioUrl").asText());
        assertEquals("unmatched", blocks.get(6).get("status").asText()); // 第 4 句的条目没有 fileName
        assertEquals(2, out.get("counts").get("matched").asInt());
        assertEquals(0, out.get("lines").size());
        assertEquals(0, out.get("counts").get("lines").asInt());
        assertTrue(serialize(out).contains("\"audioUrl\":null"));
    }

    @Test
    void multiBlocksAreAllUnmatched() {
        project("multi");
        files.put("book-ocr.json", sampleOcr("Raw"));
        files.put("book-alignment.json", sampleAlignment(true));
        files.put("book-audio-mapping.json", """
                {"version":1,"audioMode":"multi","fileCount":1,"pageCount":13,"matchedCount":1,"entries":[
                  {"fileName":"audio/a.mp3","originalName":"a.mp3","pageIndex":1,"box":null,"matchType":"exact","sentenceIndex":0}]}""");

        JsonNode out = run();

        assertTrue(out.get("audioUrl").isNull());
        out.get("blocks").forEach(b -> assertEquals("unmatched", b.get("status").asText()));
        assertEquals(39, out.get("counts").get("blocks").asInt());
        assertEquals(0, out.get("counts").get("matched").asInt());
    }

    @Test
    void missingFilesGiveEmptyAnalysis() {
        project("single");
        when(ossService.exists(PREFIX + "audio.wav")).thenReturn(false);

        JsonNode out = run();

        assertEquals(0, out.get("pages").size());
        assertEquals(0, out.get("sentences").size());
        assertEquals(0, out.get("blocks").size());
        assertEquals(0, out.get("lines").size());
        assertEquals(0, out.get("counts").get("matched").asInt());
    }
}
