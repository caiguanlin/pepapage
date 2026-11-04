package com.yueya.project;

import com.fasterxml.jackson.databind.JsonNode;
import com.yueya.common.BizException;
import com.yueya.project.entity.BookProject;
import com.yueya.storage.OssService;
import com.yueya.storage.StorageKeys;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 阅读器数据（契约 §2 GET /book-projects/{id}/reader）。
 * single：原始 book-ocr.json（与原版对齐 rSe 一致，不读校对稿）+ book-alignment.json，跳过 start/end&lt;0 的句子；
 * multi/tts：OCR 优先 book-ocr-reviewed.json；book-audio-mapping.json 只保留有 fileName 和 pageIndex 的条目
 * （tts 按 sentenceIndex 升序），为空时报原版错误；有 reader-merged.wav 时按 meta.durations 累加出 cues，否则返回 clips。
 */
@Service
@RequiredArgsConstructor
public class ReaderService {

    static final String MULTI_EMPTY = "多音频未经过模型处理，无法使用阅读器";
    static final String TTS_EMPTY = "没有可用的配音音频，请先完成配音";

    private final BookProjectService projectService;
    private final ProjectFileService fileService;
    private final OssService ossService;

    public Map<String, Object> reader(Long userId, Long id) {
        BookProject p = projectService.requireOwned(userId, id);
        String prefix = StorageKeys.projectPrefix(p.getUserId(), p.getId());
        boolean single = "single".equals(p.getAudioMode());

        JsonNode ocr = single ? null : fileService.readJsonByKey(prefix + "book-ocr-reviewed.json");
        if (ocr == null) {
            ocr = fileService.readJsonByKey(prefix + "book-ocr.json");
        }
        Map<Integer, JsonNode> sentences = new HashMap<>();
        List<Map<String, Object>> pages = new ArrayList<>();
        if (ocr != null) {
            for (JsonNode pg : ocr.path("pages")) {
                Map<String, Object> page = new LinkedHashMap<>();
                page.put("index", pg.path("index").asInt());
                page.put("width", pg.path("width").asDouble());
                page.put("height", pg.path("height").asDouble());
                pages.add(page);
            }
            JsonNode arr = ocr.path("sentences");
            for (int i = 0; i < arr.size(); i++) {
                JsonNode s = arr.get(i);
                sentences.put(s.has("sentenceIndex") ? s.get("sentenceIndex").asInt() : i, s);
            }
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("project", p);
        out.put("pdfUrl", p.getSourceFileKey() == null ? null : ossService.signedGetUrl(p.getSourceFileKey()));
        out.put("pages", pages);

        List<Map<String, Object>> cues = new ArrayList<>();
        if (single) {
            String audioKey = p.getAudioFileKey();
            if (ossService.exists(prefix + "audio.wav")) {
                audioKey = prefix + "audio.wav";
            }
            out.put("audio", audioKey == null ? null : Map.of("url", ossService.signedGetUrl(audioKey)));
            JsonNode alignment = fileService.readJsonByKey(prefix + "book-alignment.json");
            if (alignment != null) {
                for (JsonNode a : alignment.path("alignments")) {
                    double start = a.path("start").asDouble(-1);
                    double end = a.path("end").asDouble(-1);
                    if (start < 0 || end < 0) {
                        continue;
                    }
                    int si = a.path("sentenceIndex").asInt();
                    JsonNode s = sentences.get(si);
                    Map<String, Object> cue = new LinkedHashMap<>();
                    cue.put("start", start);
                    cue.put("end", end);
                    cue.put("text", s == null ? "" : s.path("text").asText(""));
                    cue.put("pageIndex", s == null ? null : s.path("pageIndex").asInt());
                    if (s != null && s.hasNonNull("box")) {
                        cue.put("box", s.get("box"));
                    }
                    cue.put("sentenceIndex", si);
                    cues.add(cue);
                }
            }
            out.put("cues", cues);
            return out;
        }

        // multi / tts
        boolean tts = "tts".equals(p.getAudioMode());
        JsonNode mapping = fileService.readJsonByKey(prefix + "book-audio-mapping.json");
        List<JsonNode> entries = new ArrayList<>();
        if (mapping != null) {
            for (JsonNode e : mapping.path("entries")) {
                String fileName = e.path("fileName").asText("");
                if (!fileName.isBlank() && e.hasNonNull("pageIndex")) {
                    entries.add(e);
                }
            }
        }
        if (tts) {
            entries.sort(Comparator.comparing(
                    (JsonNode e) -> e.hasNonNull("sentenceIndex") ? e.get("sentenceIndex").asInt() : null,
                    Comparator.nullsLast(Comparator.<Integer>naturalOrder())));
        }
        if (entries.isEmpty()) {
            throw new BizException(tts ? TTS_EMPTY : MULTI_EMPTY);
        }
        String mergedKey = prefix + "reader-merged.wav";
        JsonNode meta = fileService.readJsonByKey(prefix + "reader-merged-meta.json");
        boolean merged = meta != null && meta.path("durations").isArray() && ossService.exists(mergedKey);
        if (merged) {
            JsonNode durations = meta.get("durations");
            Map<String, Object> audio = new LinkedHashMap<>();
            audio.put("url", ossService.signedGetUrl(mergedKey));
            audio.put("durations", durations);
            out.put("audio", audio);
            double t = 0;
            for (int i = 0; i < entries.size(); i++) {
                JsonNode e = entries.get(i);
                double d = i < durations.size() ? durations.get(i).asDouble() : 0;
                cues.add(entryCue(e, sentences, t, t + d));
                t += d;
            }
            out.put("cues", cues);
            return out;
        }
        out.put("audio", null);
        List<Map<String, Object>> clips = new ArrayList<>();
        for (JsonNode e : entries) {
            String fileName = e.get("fileName").asText();
            String key = fileName.startsWith("users/") ? fileName : prefix + fileName;
            Map<String, Object> clip = entryCue(e, sentences, null, null);
            clip.put("url", ossService.signedGetUrl(key));
            clips.add(clip);
        }
        out.put("cues", cues);
        out.put("clips", clips);
        return out;
    }

    private static Map<String, Object> entryCue(JsonNode e, Map<Integer, JsonNode> sentences, Double start, Double end) {
        Map<String, Object> cue = new LinkedHashMap<>();
        if (start != null) {
            cue.put("start", start);
            cue.put("end", end);
        }
        JsonNode s = e.hasNonNull("sentenceIndex") ? sentences.get(e.get("sentenceIndex").asInt()) : null;
        String text = s != null ? s.path("text").asText("") : e.path("originalName").asText("");
        cue.put("text", text);
        Object pageIndex = e.hasNonNull("pageIndex") ? e.get("pageIndex").asInt()
                : (s != null ? s.path("pageIndex").asInt() : null);
        cue.put("pageIndex", pageIndex);
        if (e.hasNonNull("box")) {
            cue.put("box", e.get("box"));
        } else if (s != null && s.hasNonNull("box")) {
            cue.put("box", s.get("box"));
        }
        if (e.hasNonNull("sentenceIndex")) {
            cue.put("sentenceIndex", e.get("sentenceIndex").asInt());
        }
        return cue;
    }
}
