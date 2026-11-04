package com.yueya.project;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.StringJoiner;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * subtitles.lrc 内容解析，规则与 worker/subtitles.py 的 parse_subtitles 完全一致：
 * <ul>
 *   <li>去掉开头一个 BOM，CRLF/CR 统一成 LF；</li>
 *   <li>任一行含 SRT 时间行就按 SRT 解析：按空行分块，每块取第一条时间行，其后各行去空白、用空格拼接并去掉 HTML 标签；
 *       1–2 位毫秒按小数理解（",5" 是 500 毫秒）；文本为空的字幕也保留；不按时间排序；</li>
 *   <li>否则按方括号 LRC 解析：一行可有多个时间标签；空内容的标签只作上一行的结束时间；
 *       按 start 稳定排序，end 取下一个标签的时间，最后一行 +3 秒，时间保留 3 位小数；</li>
 *   <li>两种都不是返回空列表。index 0 起始，与 word-timestamps.json 的行号键对应。</li>
 * </ul>
 * Python str 正则里的 {@code \d} 是任意 Unicode 十进制数字，{@code \s} 和 {@code str.strip()} 认的是 {@code str.isspace()}
 * 为真的字符；这里显式写出同样的字符集，保证两边对同一文本得到相同结果。
 */
public final class SubtitleParser {

    /** 一条字幕：index 0 起始，时间单位秒。 */
    public record Line(int index, double start, double end, String text) {
    }

    private static final String D = "\\p{Nd}";
    private static final String WS =
            "[\\t\\n\\x0B\\f\\r\\x1C-\\x1F \\x85\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]";
    private static final String TS = "(?:(" + D + "+):)?(" + D + "{1,2}):(" + D + "{1,2})[,.](" + D + "{1,3})";
    private static final Pattern SRT_TIME = Pattern.compile(TS + WS + "*-->" + WS + "*" + TS);
    private static final Pattern LRC_TAG = Pattern.compile("\\[(" + D + "+):(" + D + "+(?:\\." + D + "+)?)\\]");
    private static final Pattern LRC_ANY_TAG = Pattern.compile("\\[[^\\]]*\\]");
    private static final Pattern HTML_TAG = Pattern.compile("<[^>]*>");
    private static final Pattern BLANK_LINE = Pattern.compile("\\n" + WS + "*\\n");
    private static final long[] POW10 = {1, 10, 100, 1000};

    private SubtitleParser() {
    }

    /** subtitles.lrc 内容 → 字幕行。SRT 优先，其次 LRC，都不是（或为 null）返回空列表。 */
    public static List<Line> parse(String text) {
        if (text == null) {
            return new ArrayList<>();
        }
        if (text.startsWith("\uFEFF")) {
            text = text.substring(1);
        }
        text = text.replace("\r\n", "\n").replace("\r", "\n");
        for (String line : text.split("\n", -1)) {
            if (SRT_TIME.matcher(line).find()) {
                return parseSrt(text);
            }
        }
        return parseLrc(text);
    }

    private static List<Line> parseSrt(String text) {
        List<Line> rows = new ArrayList<>();
        for (String block : BLANK_LINE.split(text, -1)) {
            String[] lines = block.split("\n", -1);
            for (int k = 0; k < lines.length; k++) {
                Matcher m = SRT_TIME.matcher(lines[k]);
                if (!m.find()) {
                    continue;
                }
                StringJoiner body = new StringJoiner(" ");
                for (int j = k + 1; j < lines.length; j++) {
                    String t = strip(lines[j]);
                    if (!t.isEmpty()) {
                        body.add(t);
                    }
                }
                String clean = strip(HTML_TAG.matcher(body.toString()).replaceAll(""));
                // 文本为空也保留，保证 index 与 word-timestamps 的行号键对得上
                rows.add(new Line(rows.size(),
                        srtSeconds(m.group(1), m.group(2), m.group(3), m.group(4)),
                        srtSeconds(m.group(5), m.group(6), m.group(7), m.group(8)), clean));
                break;
            }
        }
        return rows;
    }

    /** content 为 null 的是空时间标签，只用作上一行的结束时间。 */
    private record Entry(double start, String content) {
    }

    private static List<Line> parseLrc(String text) {
        List<Entry> entries = new ArrayList<>();
        for (String line : text.split("\n", -1)) {
            Matcher m = LRC_TAG.matcher(line);
            List<String[]> tags = new ArrayList<>();
            while (m.find()) {
                tags.add(new String[]{m.group(1), m.group(2)});
            }
            if (tags.isEmpty()) {
                continue;
            }
            String content = strip(LRC_ANY_TAG.matcher(line).replaceAll(""));
            for (String[] tag : tags) {
                double start = round3(Long.parseLong(ascii(tag[0])) * 60 + Double.parseDouble(ascii(tag[1])));
                entries.add(new Entry(start, content.isEmpty() ? null : content));
            }
        }
        entries.sort(Comparator.comparingDouble(Entry::start)); // List.sort 稳定，与 Python 一致
        List<Line> rows = new ArrayList<>();
        for (int i = 0; i < entries.size(); i++) {
            Entry e = entries.get(i);
            if (e.content() == null) {
                continue;
            }
            double end = i + 1 < entries.size() ? entries.get(i + 1).start() : round3(e.start() + 3.0);
            rows.add(new Line(rows.size(), e.start(), end, e.content()));
        }
        return rows;
    }

    private static double srtSeconds(String h, String m, String s, String frac) {
        String f = ascii(frac);
        long ms = Long.parseLong(f) * POW10[3 - f.length()]; // 1–2 位按小数理解
        long totalMs = (((h == null ? 0 : Long.parseLong(ascii(h))) * 60 + Long.parseLong(ascii(m))) * 60
                + Long.parseLong(ascii(s))) * 1000 + ms;
        return totalMs / 1000.0;
    }

    /** 与 Python round(x, 3) 相同：按二进制精确值四舍六入五成双到 3 位小数。 */
    private static double round3(double x) {
        return new BigDecimal(x).setScale(3, RoundingMode.HALF_EVEN).doubleValue();
    }

    /** Unicode 十进制数字转成 ASCII 数字（与 Python int()/float() 接受的数字一致），其他字符原样保留。 */
    private static String ascii(String digits) {
        StringBuilder sb = new StringBuilder(digits.length());
        digits.codePoints().forEach(cp -> {
            int d = Character.digit(cp, 10);
            if (d >= 0) {
                sb.append((char) ('0' + d));
            } else {
                sb.appendCodePoint(cp);
            }
        });
        return sb.toString();
    }

    /** 与 Python str.isspace() 相同的空白字符集。 */
    private static boolean isSpace(char c) {
        return Character.isWhitespace(c) || Character.isSpaceChar(c) || c == '\u0085';
    }

    /** 与 Python str.strip() 相同。 */
    private static String strip(String s) {
        int b = 0;
        int e = s.length();
        while (b < e && isSpace(s.charAt(b))) {
            b++;
        }
        while (e > b && isSpace(s.charAt(e - 1))) {
            e--;
        }
        return s.substring(b, e);
    }
}
