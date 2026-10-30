package com.pepapage.storage;

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
