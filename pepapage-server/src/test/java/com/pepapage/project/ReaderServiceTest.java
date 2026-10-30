package com.pepapage.project;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pepapage.common.BizException;
import com.pepapage.project.entity.BookProject;
import com.pepapage.storage.OssService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ReaderServiceTest {

    private static final long USER_ID = 7L;
    private static final long PROJECT_ID = 11L;
    private static final String PREFIX = "users/7/book-projects/11/";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final String RAW_OCR = """
            {"version":1,"pageCount":1,"sentenceCount":2,
             "pages":[{"index":1,"width":1000,"height":1400,"sentenceStart":0,"sentenceCount":2}],
             "sentences":[
               {"id":"s0","pageIndex":1,"sentenceIndex":0,"text":"Raw zero","box":{"x":1,"y":2,"width":3,"height":4}},
               {"id":"s1","pageIndex":1,"sentenceIndex":1,"text":"Raw one","box":{"x":5,"y":6,"width":7,"height":8}}],
             "blocks":[]}""";

    private static final String REVIEWED_OCR = """
            {"version":1,"pageCount":1,"sentenceCount":2,
             "pages":[{"index":1,"width":1000,"height":1400,"sentenceStart":0,"sentenceCount":2}],
             "sentences":[
               {"id":"s0","pageIndex":1,"sentenceIndex":0,"text":"Reviewed zero","box":{"x":90,"y":90,"width":9,"height":9}},
               {"id":"s1","pageIndex":1,"sentenceIndex":1,"text":"Reviewed one","box":{"x":91,"y":91,"width":9,"height":9}}],
             "blocks":[]}""";

    @Mock
    private BookProjectService projectService;
    @Mock
    private ProjectFileService fileService;
    @Mock
    private OssService ossService;
    @InjectMocks
    private ReaderService readerService;

    /** 相对文件名 → JSON 文本；未放入的文件视为不存在。 */
    private final Map<String, String> files = new HashMap<>();

    @BeforeEach
    void setUp() {
        lenient().when(fileService.readJsonByKey(anyString())).thenAnswer(inv -> {
            String key = inv.getArgument(0);
            String json = key.startsWith(PREFIX) ? files.get(key.substring(PREFIX.length())) : null;
            return json == null ? null : MAPPER.readTree(json);
        });
        lenient().when(ossService.signedGetUrl(anyString())).thenAnswer(inv -> "https://signed/" + inv.getArgument(0));
    }

    private BookProject project(String mode) {
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
        return p;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Map<String, Object> out, String key) {
        return (List<Map<String, Object>>) out.get(key);
    }

    @Test
    void singleReadsRawOcrEvenWhenReviewedExists() {
        project("single");
        when(ossService.exists(PREFIX + "audio.wav")).thenReturn(true);
        files.put("book-ocr.json", RAW_OCR);
        files.put("book-ocr-reviewed.json", REVIEWED_OCR);
        files.put("book-alignment.json", """
                {"version":1,"sentenceCount":2,"matchedCount":2,"mode":"word","alignments":[
                  {"sentenceIndex":0,"start":0.5,"end":1.5,"confidence":0.9},
                  {"sentenceIndex":1,"start":2.0,"end":3.0,"confidence":0.8}]}""");

        Map<String, Object> out = readerService.reader(USER_ID, PROJECT_ID);

        List<Map<String, Object>> cues = list(out, "cues");
        assertEquals(2, cues.size());
        assertEquals("Raw zero", cues.get(0).get("text"));
        assertEquals(1, ((JsonNode) cues.get(0).get("box")).get("x").asInt());
        assertEquals("Raw one", cues.get(1).get("text"));
        assertEquals(5, ((JsonNode) cues.get(1).get("box")).get("x").asInt());
        assertEquals(1, cues.get(0).get("pageIndex"));
        assertEquals(Map.of("url", "https://signed/" + PREFIX + "audio.wav"), out.get("audio"));
    }

    @Test
    void singleSkipsSentencesWithoutTimes() {
        project("single");
        when(ossService.exists(PREFIX + "audio.wav")).thenReturn(false);
        files.put("book-ocr.json", RAW_OCR);
        files.put("book-alignment.json", """
                {"version":1,"sentenceCount":3,"matchedCount":1,"mode":"word","alignments":[
                  {"sentenceIndex":0,"start":-1,"end":-1,"confidence":0},
                  {"sentenceIndex":1,"start":2.0,"end":-1,"confidence":0},
                  {"sentenceIndex":1,"start":2.0,"end":3.0,"confidence":0.8}]}""");

        Map<String, Object> out = readerService.reader(USER_ID, PROJECT_ID);

        List<Map<String, Object>> cues = list(out, "cues");
        assertEquals(1, cues.size());
        assertEquals(1, cues.get(0).get("sentenceIndex"));
        assertEquals(2.0, cues.get(0).get("start"));
        assertEquals(Map.of("url", "https://signed/" + PREFIX + "book-audio.mp3"), out.get("audio"));
    }

    @Test
    void multiWithoutMappingFile() {
        project("multi");
        files.put("book-ocr.json", RAW_OCR);
        BizException e = assertThrows(BizException.class, () -> readerService.reader(USER_ID, PROJECT_ID));
        assertEquals("多音频未经过模型处理，无法使用阅读器", e.getMessage());
        assertEquals(400, e.getCode());
    }

    @Test
    void multiWithEmptyEntries() {
        project("multi");
        files.put("book-audio-mapping.json", """
                {"version":1,"audioMode":"multi","fileCount":0,"pageCount":1,"matchedCount":0,"entries":[]}""");
        BizException e = assertThrows(BizException.class, () -> readerService.reader(USER_ID, PROJECT_ID));
        assertEquals("多音频未经过模型处理，无法使用阅读器", e.getMessage());
    }

    @Test
    void multiWithEntriesMissingPageIndex() {
        project("multi");
        files.put("book-audio-mapping.json", """
                {"version":1,"audioMode":"multi","fileCount":2,"pageCount":1,"matchedCount":0,"entries":[
                  {"fileName":"audio/a.mp3","originalName":"a.mp3","pageIndex":null,"box":null,"matchType":null},
                  {"fileName":"audio/b.mp3","originalName":"b.mp3","box":null,"matchType":null},
                  {"fileName":"","originalName":"c.mp3","pageIndex":1,"box":null,"matchType":null}]}""");
        BizException e = assertThrows(BizException.class, () -> readerService.reader(USER_ID, PROJECT_ID));
        assertEquals("多音频未经过模型处理，无法使用阅读器", e.getMessage());
    }

    @Test
    void multiKeepsOriginalOrderAndPrefersReviewedOcr() {
        project("multi");
        files.put("book-ocr.json", RAW_OCR);
        files.put("book-ocr-reviewed.json", REVIEWED_OCR);
        files.put("book-audio-mapping.json", """
                {"version":1,"audioMode":"multi","fileCount":3,"pageCount":1,"matchedCount":2,"entries":[
                  {"fileName":"audio/b.mp3","originalName":"b.mp3","pageIndex":1,"box":null,"matchType":"exact","sentenceIndex":1},
                  {"fileName":"audio/x.mp3","originalName":"x.mp3","pageIndex":null,"box":null,"matchType":null},
                  {"fileName":"audio/a.mp3","originalName":"a.mp3","pageIndex":1,"box":null,"matchType":"exact","sentenceIndex":0}]}""");

        Map<String, Object> out = readerService.reader(USER_ID, PROJECT_ID);

        List<Map<String, Object>> clips = list(out, "clips");
        assertEquals(2, clips.size());
        assertEquals("https://signed/" + PREFIX + "audio/b.mp3", clips.get(0).get("url"));
        assertEquals("Reviewed one", clips.get(0).get("text"));
        assertEquals("https://signed/" + PREFIX + "audio/a.mp3", clips.get(1).get("url"));
    }

    @Test
    void ttsWithoutMappingFile() {
        project("tts");
        files.put("book-ocr.json", RAW_OCR);
        BizException e = assertThrows(BizException.class, () -> readerService.reader(USER_ID, PROJECT_ID));
        assertEquals("没有可用的配音音频，请先完成配音", e.getMessage());
    }

    @Test
    void ttsClipsSortedBySentenceIndex() {
        project("tts");
        files.put("book-ocr.json", RAW_OCR);
        files.put("book-audio-mapping.json", """
                {"version":1,"audioMode":"tts","fileCount":4,"pageCount":1,"matchedCount":4,"entries":[
                  {"fileName":"tts-0010.wav","originalName":"ten","pageIndex":1,"box":null,"matchType":"exact"},
                  {"fileName":"tts-0002.wav","originalName":"one","pageIndex":1,"box":null,"matchType":"exact","sentenceIndex":1},
                  {"fileName":"tts-0001.wav","originalName":"zero","pageIndex":1,"box":null,"matchType":"exact","sentenceIndex":0},
                  {"fileName":"tts-0009.wav","originalName":"eight","pageIndex":1,"box":null,"matchType":"exact","sentenceIndex":8}]}""");

        Map<String, Object> out = readerService.reader(USER_ID, PROJECT_ID);

        List<Map<String, Object>> clips = list(out, "clips");
        assertEquals(List.of(
                        "https://signed/" + PREFIX + "tts-0001.wav",
                        "https://signed/" + PREFIX + "tts-0002.wav",
                        "https://signed/" + PREFIX + "tts-0009.wav",
                        "https://signed/" + PREFIX + "tts-0010.wav"),
                clips.stream().map(c -> c.get("url")).toList());
        assertEquals("Raw zero", clips.get(0).get("text"));
        assertFalse(clips.get(3).containsKey("sentenceIndex"));
        assertEquals(List.of(), out.get("cues"));
        assertEquals(null, out.get("audio"));
    }
}
