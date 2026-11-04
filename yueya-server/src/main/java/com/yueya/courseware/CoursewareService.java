package com.yueya.courseware;

import com.baomidou.mybatisplus.core.toolkit.IdWorker;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.yueya.common.BizException;
import com.yueya.folder.BookFolderService;
import com.yueya.folder.entity.BookFolder;
import com.yueya.folder.mapper.BookFolderMapper;
import com.yueya.project.BookProjectService;
import com.yueya.project.entity.BookProject;
import com.yueya.project.entity.BookProject.AudioFile;
import com.yueya.project.entity.BookProject.ProcessingStep;
import com.yueya.project.mapper.BookProjectMapper;
import com.yueya.storage.OssService;
import com.yueya.storage.StorageKeys;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * 课件包 .nexusbookpkg（数据规格第 11 节）：zip，根目录 manifest.json，项目文件放 projects/&lt;id&gt;/。
 * manifest: {version:"1.0-book", timestamp, folders:BookFolder[], projects:[{id,data,auxCode}]}
 */
@Service
@RequiredArgsConstructor
public class CoursewareService {

    public static final String VERSION = "1.0-book";
    private static final String AUX_CODE_FILE = "aux-code.json";

    private final BookProjectMapper projectMapper;
    private final BookFolderMapper folderMapper;
    private final BookFolderService folderService;
    private final BookProjectService projectService;
    private final OssService ossService;
    private final ObjectMapper objectMapper;

    public record ExportResult(String url, String fileName) {
    }

    public ExportResult export(Long userId, List<Long> projectIds, List<Long> folderIds) {
        List<BookFolder> allFolders = folderService.listAll(userId);
        Map<Long, List<BookFolder>> children = new HashMap<>();
        allFolders.forEach(f -> children.computeIfAbsent(f.getParentId(), k -> new ArrayList<>()).add(f));

        // 选中文件夹及其全部子孙
        Map<Long, BookFolder> folders = new LinkedHashMap<>();
        if (folderIds != null) {
            for (Long fid : folderIds) {
                BookFolder root = folderService.requireOwned(userId, fid);
                collect(root, children, folders);
            }
        }
        Set<Long> ids = new LinkedHashSet<>(projectIds == null ? List.of() : projectIds);
        if (!folders.isEmpty()) {
            projectMapper.selectList(Wrappers.<BookProject>lambdaQuery()
                            .eq(BookProject::getUserId, userId)
                            .in(BookProject::getFolderId, folders.keySet()))
                    .forEach(p -> ids.add(p.getId()));
        }
        if (ids.isEmpty()) {
            throw new BizException("请选择要导出的项目或文件夹");
        }
        List<BookProject> projects = projectMapper.selectList(Wrappers.<BookProject>lambdaQuery()
                .eq(BookProject::getUserId, userId)
                .in(BookProject::getId, ids)
                .eq(BookProject::getStatus, "completed"));
        if (projects.isEmpty()) {
            throw new BizException("没有可导出的已完成项目");
        }

        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(buf, StandardCharsets.UTF_8)) {
            ObjectNode manifest = objectMapper.createObjectNode();
            manifest.put("version", VERSION);
            manifest.put("timestamp", Instant.now().toString());
            manifest.set("folders", objectMapper.valueToTree(new ArrayList<>(folders.values())));
            ArrayNode arr = manifest.putArray("projects");
            for (BookProject p : projects) {
                String prefix = StorageKeys.projectPrefix(userId, p.getId());
                JsonNode auxCode = null;
                for (OssService.ObjectInfo o : ossService.list(prefix)) {
                    String rel = o.key().substring(prefix.length());
                    if (rel.isEmpty() || rel.endsWith("/")) {
                        continue;
                    }
                    byte[] bytes = ossService.getObject(o.key());
                    if (bytes == null) {
                        continue;
                    }
                    if (AUX_CODE_FILE.equals(rel)) {
                        try {
                            auxCode = objectMapper.readTree(bytes);
                        } catch (IOException ignored) {
                            // 非法 JSON 时 auxCode 置空，文件仍随包
                        }
                    }
                    zip.putNextEntry(new ZipEntry("projects/" + p.getId() + "/" + rel));
                    zip.write(bytes);
                    zip.closeEntry();
                }
                ObjectNode item = arr.addObject();
                item.put("id", String.valueOf(p.getId()));
                ObjectNode data = objectMapper.valueToTree(p);
                data.remove("userId"); // 规格：userId 清空
                item.set("data", data);
                item.set("auxCode", auxCode);
            }
            zip.putNextEntry(new ZipEntry("manifest.json"));
            zip.write(objectMapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(manifest));
            zip.closeEntry();
        } catch (IOException e) {
            throw new BizException(500, "生成课件包失败: " + e.getMessage());
        }

        String key = StorageKeys.coursewareKey(userId, UUID.randomUUID().toString());
        ossService.putObject(key, buf.toByteArray(), "application/zip");
        String fileName = (projects.size() == 1 ? projects.get(0).getTitle() : "绘本课件包-" + LocalDate.now())
                + ".nexusbookpkg";
        return new ExportResult(ossService.signedGetUrl(key), fileName);
    }

    private static void collect(BookFolder f, Map<Long, List<BookFolder>> children, Map<Long, BookFolder> out) {
        if (out.putIfAbsent(f.getId(), f) != null) {
            return;
        }
        for (BookFolder c : children.getOrDefault(f.getId(), List.of())) {
            collect(c, children, out);
        }
    }

    @Transactional
    public List<BookProject> importPackage(Long userId, InputStream in, Long targetFolderId) {
        if (targetFolderId != null) {
            folderService.requireOwned(userId, targetFolderId);
        }
        // 1. 解包
        JsonNode manifest = null;
        Map<String, Map<String, byte[]>> files = new HashMap<>();
        try (ZipInputStream zip = new ZipInputStream(in, StandardCharsets.UTF_8)) {
            ZipEntry e;
            while ((e = zip.getNextEntry()) != null) {
                if (e.isDirectory()) {
                    continue;
                }
                String name = e.getName().replace('\\', '/');
                byte[] bytes = zip.readAllBytes();
                if ("manifest.json".equals(name)) {
                    manifest = objectMapper.readTree(bytes);
                } else if (name.startsWith("projects/")) {
                    String rest = name.substring("projects/".length());
                    int slash = rest.indexOf('/');
                    if (slash <= 0) {
                        continue;
                    }
                    String rel = rest.substring(slash + 1);
                    if (!StorageKeys.isSafeRelativeName(rel)) {
                        continue;
                    }
                    files.computeIfAbsent(rest.substring(0, slash), k -> new HashMap<>()).put(rel, bytes);
                }
            }
        } catch (IOException e) {
            throw new BizException("课件包解析失败: " + e.getMessage());
        }
        if (manifest == null) {
            throw new BizException("课件包缺少 manifest.json");
        }
        if (!VERSION.equals(manifest.path("version").asText())) {
            throw new BizException("课件包版本不兼容: " + manifest.path("version").asText());
        }

        // 2. 文件夹：同 id 且属于当前用户则复用，否则新建；父级无法解析时挂到目标文件夹
        Map<Long, Long> folderMap = new HashMap<>();
        List<BookFolder> toCreate = new ArrayList<>();
        Map<Long, Long> oldParent = new HashMap<>();
        for (JsonNode fn : manifest.path("folders")) {
            BookFolder f = objectMapper.convertValue(fn, BookFolder.class);
            if (f.getId() == null) {
                continue;
            }
            BookFolder existing = folderMapper.selectById(f.getId());
            if (existing != null && Objects.equals(existing.getUserId(), userId)) {
                folderMap.put(f.getId(), existing.getId());
            } else {
                Long newId = IdWorker.getId();
                folderMap.put(f.getId(), newId);
                oldParent.put(newId, f.getParentId());
                BookFolder nf = new BookFolder();
                nf.setId(newId);
                nf.setUserId(userId);
                nf.setName(f.getName() == null || f.getName().isBlank() ? "未命名文件夹" : f.getName());
                toCreate.add(nf);
            }
        }
        for (BookFolder nf : toCreate) {
            Long op = oldParent.get(nf.getId());
            nf.setParentId(op != null && folderMap.containsKey(op) ? folderMap.get(op) : targetFolderId);
            folderMapper.insert(nf);
        }

        // 3. 项目：新 ID、新前缀、步骤全部 completed
        List<BookProject> result = new ArrayList<>();
        for (JsonNode item : manifest.path("projects")) {
            String oldId = item.path("id").asText();
            JsonNode data = item.path("data");
            if (!data.isObject()) {
                continue;
            }
            BookProject src = objectMapper.convertValue(data, BookProject.class);
            Long newId = IdWorker.getId();
            String prefix = StorageKeys.projectPrefix(userId, newId);
            BookProject p = new BookProject();
            p.setId(newId);
            p.setUserId(userId);
            p.setFolderId(src.getFolderId() != null && folderMap.containsKey(src.getFolderId())
                    ? folderMap.get(src.getFolderId()) : targetFolderId);
            p.setTitle(src.getTitle() == null ? "未命名绘本" : src.getTitle());
            p.setAudioMode(src.getAudioMode() == null ? "single" : src.getAudioMode());
            p.setSourceType(src.getSourceType());
            p.setSourceFileKey(StorageKeys.rebase(src.getSourceFileKey(), prefix));
            p.setCoverKey(StorageKeys.rebase(src.getCoverKey(), prefix));
            p.setAudioFileKey(StorageKeys.rebase(src.getAudioFileKey(), prefix));
            if (src.getAudioFiles() != null) {
                p.setAudioFiles(src.getAudioFiles().stream()
                        .map(a -> new AudioFile(StorageKeys.rebase(a.fileKey(), prefix), a.originalName()))
                        .toList());
            }
            p.setTtsVoice(src.getTtsVoice());
            p.setTtsSpeed(src.getTtsSpeed());
            p.setStatus("completed");
            List<ProcessingStep> steps = new ArrayList<>();
            for (String k : BookProjectService.STEP_KEYS) {
                ProcessingStep s = ProcessingStep.of(k, "completed");
                s.setProgress(100);
                steps.add(s);
            }
            p.setProcessingSteps(steps);
            p.setCurrentStepIndex(steps.size());
            p.setProcessingError(null);
            p.setOcrConfirmed(Boolean.TRUE.equals(src.getOcrConfirmed()));
            p.setPageCount(src.getPageCount());
            p.setDurationSeconds(src.getDurationSeconds());
            p.setMetadata(src.getMetadata());
            projectMapper.insert(p);

            Map<String, byte[]> pf = files.getOrDefault(oldId, Map.of());
            for (Map.Entry<String, byte[]> e : pf.entrySet()) {
                ossService.putObject(prefix + e.getKey(), e.getValue(),
                        URLConnection.guessContentTypeFromName(e.getKey()));
            }
            JsonNode aux = item.get("auxCode");
            if (aux != null && !aux.isNull() && !pf.containsKey(AUX_CODE_FILE)) {
                try {
                    ossService.putJson(prefix + AUX_CODE_FILE, objectMapper.writeValueAsString(aux));
                } catch (IOException ignored) {
                    // 忽略
                }
            }
            result.add(p);
        }
        if (result.isEmpty()) {
            throw new BizException("课件包中没有项目");
        }
        return result;
    }

    public List<BookProject> importPackage(Long userId, byte[] bytes, Long targetFolderId) {
        return importPackage(userId, new ByteArrayInputStream(bytes), targetFolderId);
    }
}
