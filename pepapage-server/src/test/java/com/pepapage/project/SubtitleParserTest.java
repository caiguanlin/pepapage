package com.pepapage.project;

import com.pepapage.project.SubtitleParser.Line;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 用例照搬 pepapage-worker/tests/test_subtitles.py，期望值与 worker 的 parse_subtitles 输出一致。 */
class SubtitleParserTest {

    private static List<Line> parse(String text) {
        return SubtitleParser.parse(text);
    }

    @Test
    void sampleSrt() {
        String srt = "1\n00:00:00,940 --> 00:00:01,250\nHello\n\n"
                + "2\n00:00:01,500 --> 00:00:02,900\nButterfly ...\n";
        assertEquals(List.of(new Line(0, 0.94, 1.25, "Hello"), new Line(1, 1.5, 2.9, "Butterfly ...")), parse(srt));
    }

    @Test
    void srtWithBomAndCrlf() {
        String text = "\uFEFF1\r\n00:00:00,940 --> 00:00:01,250\r\nHello\r\n\r\n"
                + "2\r\n00:00:01,500 --> 00:00:02,900\r\nButterfly ...\r\n";
        assertEquals(List.of(new Line(0, 0.94, 1.25, "Hello"), new Line(1, 1.5, 2.9, "Butterfly ...")), parse(text));
    }

    @Test
    void srtDetails() {
        // 无序号、多行文本带标签、1 位毫秒、空文本字幕保留、不按时间排序
        String text = "00:00:05,5 --> 00:00:06.25\n<i>Big</i> red\n  bus  \n\n"
                + "7\n00:00:01,000 --> 00:00:02,000\n\n\n"
                + "8\n1:02,000 --> 1:03,000\nlast\n";
        assertEquals(List.of(new Line(0, 5.5, 6.25, "Big red bus"), new Line(1, 1.0, 2.0, ""),
                new Line(2, 62.0, 63.0, "last")), parse(text));
    }

    @Test
    void lrcFromOldWorker() {
        List<Line> rows = parse("[00:01.20]hi\n[01:05.50]yo\n");
        assertEquals(List.of(new Line(0, 1.2, 65.5, "hi"), new Line(1, 65.5, 68.5, "yo")), rows);
    }

    @Test
    void lrcEndMarkerAndMultiTags() {
        assertEquals(List.of(new Line(0, 1.0, 2.5, "hi")), parse("[00:01.00]hi\n[00:02.50]\n"));
        List<Line> rows = parse("[00:03.00][00:01.00]la\n[00:02.00]mid\n");
        assertEquals(List.of(new Line(0, 1.0, 2.0, "la"), new Line(1, 2.0, 3.0, "mid"), new Line(2, 3.0, 6.0, "la")),
                rows);
    }

    @Test
    void unknownTextReturnsEmpty() {
        assertEquals(List.of(), parse("just some words\nnothing timed here"));
        assertEquals(List.of(), parse(""));
        assertTrue(parse(null).isEmpty());
    }

    /** 期望值取自 worker 的 parse_subtitles 实际输出：Unicode 数字、Python 空白字符集、round(x, 3)。 */
    @Test
    void unicodeDetailsMatchPython() {
        assertEquals(List.of(new Line(0, 62.5, 65.5, "x")), parse("[\uFF10\uFF11:\uFF10\uFF12.\uFF15]x\n"));
        String srt = "\u0661\n00:00:01,5\u00A0-->\u300000:00:02,25\n\u0085 hi \u3000\n\u001C\n"
                + "2\n00:00:03,000 --> 00:00:04,000\nyo";
        assertEquals(List.of(new Line(0, 1.5, 2.25, "hi"), new Line(1, 3.0, 4.0, "yo")), parse(srt));
        assertEquals(List.of(new Line(0, 1.004, 2.001, "a"), new Line(1, 2.001, 5.001, "b")),
                parse("[00:01.004]a\n[00:02.0005]b"));
    }
}
