package com.pepapage.storage;

import java.security.SecureRandom;
import java.util.Locale;
import java.util.UUID;

/** OSS key 规则统一在此生成，所有 key 均以 users/{userId}/ 开头，便于做归属校验。 */
public final class StorageKeys {

    private StorageKeys() {
    }

    public static String userPrefix(Long userId) {
        return "users/" + userId + "/";
    }

    public static String projectPrefix(Long userId, Long projectId) {
        return userPrefix(userId) + "book-projects/" + projectId + "/";
    }

    public static String bookSource(Long userId, Long projectId) {
        return projectPrefix(userId, projectId) + "book.pdf";
    }

    public static String bookAudio(Long userId, Long projectId, String originalName) {
        return projectPrefix(userId, projectId) + "book-audio." + extension(originalName, "mp3");
    }

    public static String multiAudio(Long userId, Long projectId, String originalName) {
        return projectPrefix(userId, projectId) + "audio/" + UUID.randomUUID() + "." + extension(originalName, "mp3");
    }

    public static String cover(Long userId, Long projectId) {
        return projectPrefix(userId, projectId) + "cover.jpg";
    }

    /** 区域自定义音频：custom-audio-<sanitizedKey>-<base36Timestamp>.<ext>（相对项目目录的文件名）。 */
    public static String customAudioName(String boxKey, String originalName) {
        String sanitized = boxKey == null ? "box" : boxKey.replaceAll("[^A-Za-z0-9_-]", "_");
        if (sanitized.length() > 80) {
            sanitized = sanitized.substring(0, 80);
        }
        return "custom-audio-" + sanitized + "-" + Long.toString(System.currentTimeMillis(), 36)
                + "." + extension(originalName, "mp3");
    }

    /** 音频库随机后缀字符集：小写字母与数字 */
    private static final String RANDOM_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
    private static final SecureRandom RANDOM = new SecureRandom();

    /** 音频库音频：custom-audio-lib-<base36Timestamp><4位[a-z0-9]随机>.<ext>（相对项目目录的文件名）。 */
    public static String libraryAudioName(String originalName) {
        StringBuilder rnd = new StringBuilder(4);
        for (int i = 0; i < 4; i++) {
            rnd.append(RANDOM_CHARS.charAt(RANDOM.nextInt(RANDOM_CHARS.length())));
        }
        return "custom-audio-lib-" + Long.toString(System.currentTimeMillis(), 36) + rnd
                + "." + extension(originalName, "mp3");
    }

    /**
     * 校验项目内相对文件名：只允许字母数字 . _ - 与一层子目录（如 audio/xxx.mp3），禁止 .. 和绝对路径。
     */
    public static boolean isSafeRelativeName(String name) {
        return name != null && !name.isBlank() && name.length() <= 255
                && !name.contains("..") && !name.startsWith("/")
                && name.matches("[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)?");
    }

    public static String coursewareKey(Long userId, String id) {
        return userPrefix(userId) + "courseware/" + id + ".nexusbookpkg";
    }

    /** 课件包导入时把旧项目目录前缀替换为新前缀。 */
    public static String rebase(String key, String newPrefix) {
        if (key == null) {
            return null;
        }
        return key.replaceFirst("^users/[^/]*/book-projects/[^/]+/", newPrefix);
    }

    static String extension(String fileName, String fallback) {
        if (fileName == null) {
            return fallback;
        }
        int dot = fileName.lastIndexOf('.');
        if (dot < 0 || dot == fileName.length() - 1) {
            return fallback;
        }
        String ext = fileName.substring(dot + 1).toLowerCase(Locale.ROOT);
        return ext.matches("[a-z0-9]{1,8}") ? ext : fallback;
    }
}
