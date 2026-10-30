package com.pepapage.project;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pepapage.common.BizException;
import com.pepapage.project.entity.BookProject;
import com.pepapage.storage.OssService;
import com.pepapage.storage.StorageKeys;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.Set;

/** 项目目录下文件的读写（相对文件名，前缀固定为 users/{uid}/book-projects/{pid}/）。 */
@Service
@RequiredArgsConstructor
public class ProjectFileService {

    /** 前端可写的 JSON 文件白名单（契约 §2）。 */
    public static final Set<String> WRITABLE_JSON = Set.of(
            "book-ocr-reviewed.json", "book-alignment.json", "book-custom-codes.json",
            "book-custom-audio.json", "book-audio-mapping.json", "aux-code.json");

    public record FileInfo(String name, long size, String updatedAt) {
    }

    private final BookProjectService projectService;
    private final OssService ossService;
    private final ObjectMapper objectMapper;

    public List<FileInfo> list(Long userId, Long id) {
        BookProject p = projectService.requireOwned(userId, id);
        String prefix = StorageKeys.projectPrefix(p.getUserId(), p.getId());
        return ossService.list(prefix).stream()
                .filter(o -> o.key().length() > prefix.length())
                .map(o -> new FileInfo(o.key().substring(prefix.length()), o.size(),
                        Instant.ofEpochMilli(o.lastModified()).toString()))
                .toList();
    }

    public String url(Long userId, Long id, String name) {
        String key = key(userId, id, name);
        if (!ossService.exists(key)) {
            throw BizException.notFound("文件");
        }
        return ossService.signedGetUrl(key);
    }

    /** 读取并解析 JSON，不存在返回 null。 */
    public JsonNode readJson(Long userId, Long id, String name) {
        return readJsonByKey(key(userId, id, name));
    }

    public JsonNode readJsonByKey(String key) {
        byte[] bytes = ossService.getObject(key);
        if (bytes == null) {
            return null;
        }
        try {
            return objectMapper.readTree(bytes);
        } catch (IOException e) {
            throw new BizException("文件不是合法 JSON");
        }
    }

    public void writeJson(Long userId, Long id, String name, JsonNode content) {
        if (!WRITABLE_JSON.contains(name)) {
            throw new BizException("该文件不允许写入");
        }
        if (content == null) {
            throw new BizException("内容不能为空");
        }
        try {
            ossService.putJson(key(userId, id, name), objectMapper.writeValueAsString(content));
        } catch (IOException e) {
            throw new BizException("序列化失败");
        }
    }

    public void delete(Long userId, Long id, String name) {
        if (!"book-ocr-reviewed.json".equals(name) && !(name != null && name.startsWith("custom-audio-"))) {
            throw new BizException("该文件不允许删除");
        }
        ossService.delete(key(userId, id, name));
    }

    private String key(Long userId, Long id, String name) {
        if (!StorageKeys.isSafeRelativeName(name)) {
            throw new BizException("文件名不合法");
        }
        BookProject p = projectService.requireOwned(userId, id);
        return StorageKeys.projectPrefix(p.getUserId(), p.getId()) + name;
    }
}
