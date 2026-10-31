package com.pepapage.project;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pepapage.common.BizException;
import com.pepapage.project.entity.BookProject;
import com.pepapage.project.mapper.BookProjectMapper;
import com.pepapage.storage.OssService;
import com.pepapage.storage.StorageKeys;
import com.pepapage.task.TaskService;
import com.pepapage.task.entity.ProcessTask;
import com.pepapage.task.mapper.ProcessTaskMapper;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 编辑器音频库（契约 §5）：清单 book-audio-library.json 只有本服务写，识别由 worker 的
 * library_asr 任务完成，进度通过 /internal/tasks/{taskId}/library-progress 回写；
 * 不参与原书对齐，不改项目 status 和 processingSteps。
 * 对同一项目的清单读改写按项目 id 加锁（单实例 JVM 内），GET 不加锁。
 */
@Service
@RequiredArgsConstructor
public class AudioLibraryService {

    /** 音频库清单文件（契约 §5.2） */
    static final String MANIFEST_FILE = "book-audio-library.json";
    /** 框与音源绑定文件（契约 §5.1），删除音源时同步清理其中的引用 */
    private static final String CUSTOM_AUDIO_FILE = "book-custom-audio.json";
    /** 音频库文件名前缀：沿用区域自定义音频的 custom-audio- 前缀，旧的 custom-audio-* 文件也可补识别 */
    private static final String NAME_PREFIX = "custom-audio-";

    private final BookProjectService projectService;
    private final ProjectFileService fileService;
    private final OssService ossService;
    private final TaskService taskService;
    private final ProcessTaskMapper taskMapper;
    private final BookProjectMapper projectMapper;
    private final ObjectMapper objectMapper;

    /** 清单中的一项；null 字段序列化时显式保留（全局 non_null 会丢掉，契约 §5.2 示例含 null）。 */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record LibraryItem(
            String fileName,
            String originalName,
            String status,
            Integer progress,
            String error,
            Double duration,
            Integer lineCount,
            Integer wordCount,
            String asrFile,
            String taskId,
            String createdAt,
            String updatedAt) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record LibraryManifest(int version, List<LibraryItem> items) {
    }

    /** POST /audio-library 请求体 */
    public record AddRequest(
            @NotBlank(message = "文件名不能为空") String fileName,
            @NotBlank(message = "原始文件名不能为空") String originalName) {
    }

    /** DELETE /audio-library 返回：被清理掉的框绑定 boxKey */
    public record DeleteResult(List<String> removedBoxKeys) {
    }

    /** worker 识别进度回调请求体（契约 §5.5） */
    public record LibraryProgressRequest(
            String fileName,
            @Pattern(regexp = "running|succeeded|failed", message = "状态不正确") String status,
            @Min(0) @Max(100) Integer progress,
            String error,
            Double duration,
            Integer lineCount,
            Integer wordCount,
            String asrFile) {
    }

    /** 每个项目一把锁，串行化清单（及绑定文件）的读改写。 */
    private final ConcurrentHashMap<Long, Object> locks = new ConcurrentHashMap<>();

    /** 查看清单（契约 §5.4 GET）。清单文件不存在视为空清单。 */
    public LibraryManifest list(Long userId, Long id) {
        BookProject p = projectService.requireOwned(userId, id);
        return readManifest(prefix(p));
    }

    /**
     * 加入音频库并投递识别任务（契约 §5.4 POST）。已在清单里且 queued/running 时直接返回该项；
     * 其他状态重置为 queued 重新识别。持锁期间：先写清单（taskId 为空）→ 投递任务 → 回填 taskId 后才释放锁，
     * 保证 worker 的进度回调（同一把锁）一定能看到 taskId。
     */
    public LibraryItem add(Long userId, Long id, AddRequest req) {
        BookProject p = projectService.requireOwned(userId, id);
        String prefix = prefix(p);
        String fileName = req.fileName();
        validateAudioName(fileName);
        String originalName = normalizeOriginalName(req.originalName());
        if (!ossService.exists(prefix + fileName)) {
            throw BizException.notFound("音频文件");
        }
        synchronized (lock(id)) {
            LibraryManifest manifest = readManifest(prefix);
            LibraryItem existing = findItem(manifest, fileName);
            // 排队中 / 识别中直接返回，不重复投递任务
            if (existing != null && ("queued".equals(existing.status()) || "running".equals(existing.status()))) {
                return existing;
            }
            String now = Instant.now().toString();
            LibraryItem queued = existing == null
                    ? new LibraryItem(fileName, originalName, "queued", 0, null, null, null, null, null, null, now, now)
                    // 失败 / 成功的重试：重置识别字段后重新识别
                    : new LibraryItem(fileName, existing.originalName(), "queued", 0, null, null, null, null, null,
                            null, existing.createdAt(), now);
            upsert(manifest, queued);
            writeManifest(prefix, manifest);
            ProcessTask task = taskService.enqueue(p, "library_asr", Map.of("fileName", fileName));
            LibraryItem withTask = withTaskId(queued, String.valueOf(task.getId()));
            upsert(manifest, withTask);
            writeManifest(prefix, manifest);
            return withTask;
        }
    }

    /**
     * 从清单移除、删除音频文件与识别结果、并清理 book-custom-audio.json 里所有引用该音源的框绑定
     * （契约 §5.4 DELETE）。清单里没有该项也照样删文件和绑定（用于清理）。
     */
    public DeleteResult remove(Long userId, Long id, String fileName) {
        BookProject p = projectService.requireOwned(userId, id);
        String prefix = prefix(p);
        validateAudioName(fileName);
        List<String> removedBoxKeys;
        synchronized (lock(id)) {
            LibraryManifest manifest = readManifest(prefix);
            boolean changed = manifest.items().removeIf(item -> item.fileName().equals(fileName));
            if (changed) {
                writeManifest(prefix, manifest);
            }
            removedBoxKeys = unbindCustomAudio(prefix, fileName);
        }
        // 音频文件与识别结果一并删除（OSS 删除不存在的 key 无副作用）
        ossService.delete(prefix + fileName);
        ossService.delete(prefix + fileName + ".asr.json");
        return new DeleteResult(removedBoxKeys);
    }

    /**
     * worker 识别进度回调（契约 §5.5）：更新清单对应项和 process_task.status，绝不修改项目实体。
     * 清单里找不到该项（识别中被删除）或 taskId 与本任务不符（旧任务的迟到回报）时返回成功并忽略；
     * 忽略且 status=succeeded 且该项已不存在时，顺手删掉 worker 刚写的识别结果。
     */
    public void libraryProgress(Long taskId, LibraryProgressRequest req) {
        ProcessTask task = taskMapper.selectById(taskId);
        if (task == null) {
            throw BizException.notFound("任务");
        }
        BookProject p = projectMapper.selectById(task.getProjectId());
        if (p == null) {
            throw BizException.notFound("项目");
        }
        String prefix = prefix(p);
        String status = req.status();
        if (status == null || status.isBlank()) {
            throw new BizException("状态不能为空");
        }
        String fileName = req.fileName();
        if (req.asrFile() != null && !req.asrFile().equals(fileName + ".asr.json")) {
            throw new BizException("asrFile 不正确");
        }
        boolean succeeded = "succeeded".equals(status);
        boolean failed = "failed".equals(status);
        // error 仅 failed 时有值；failed 缺省为「识别失败」
        String error = failed ? (req.error() == null || req.error().isBlank() ? "识别失败" : req.error()) : null;
        synchronized (lock(p.getId())) {
            LibraryManifest manifest = readManifest(prefix);
            LibraryItem existing = fileName == null ? null : findItem(manifest, fileName);
            if (existing == null) {
                // 识别中该项被删除：忽略；succeeded 时清掉 worker 刚写的识别结果
                if (succeeded && fileName != null && !fileName.isBlank()) {
                    ossService.delete(prefix + fileName + ".asr.json");
                }
                return;
            }
            // 旧任务的迟到回报（重试后 taskId 已换新）
            if (existing.taskId() != null && !existing.taskId().equals(String.valueOf(taskId))) {
                return;
            }
            Integer progress;
            if (succeeded) {
                progress = 100;
            } else {
                progress = req.progress() != null ? req.progress() : existing.progress();
            }
            LibraryItem updated = new LibraryItem(existing.fileName(), existing.originalName(), status, progress, error,
                    req.duration() != null ? req.duration() : existing.duration(),
                    req.lineCount() != null ? req.lineCount() : existing.lineCount(),
                    req.wordCount() != null ? req.wordCount() : existing.wordCount(),
                    req.asrFile() != null ? req.asrFile() : existing.asrFile(),
                    existing.taskId(), existing.createdAt(), Instant.now().toString());
            upsert(manifest, updated);
            writeManifest(prefix, manifest);
        }
        // 同步 process_task 状态（running/succeeded/failed，failed 带 error）
        String taskStatus = switch (status) {
            case "succeeded", "failed" -> status;
            default -> "running";
        };
        taskMapper.update(Wrappers.<ProcessTask>lambdaUpdate()
                .eq(ProcessTask::getId, taskId)
                .set(ProcessTask::getStatus, taskStatus)
                .set(ProcessTask::getError, failed ? error : null));
    }

    /** POST / DELETE 共用的文件名校验：安全相对名、custom-audio- 开头、不以 .json 结尾。 */
    private static void validateAudioName(String fileName) {
        if (!StorageKeys.isSafeRelativeName(fileName)) {
            throw new BizException("文件名不合法");
        }
        if (!fileName.startsWith(NAME_PREFIX)) {
            throw new BizException("音频文件名必须以 " + NAME_PREFIX + " 开头");
        }
        if (fileName.endsWith(".json")) {
            throw new BizException("音频文件名不能以 .json 结尾");
        }
    }

    /** originalName 非空、截到 255 字符。 */
    private static String normalizeOriginalName(String originalName) {
        String name = originalName == null ? "" : originalName.trim();
        if (name.isEmpty()) {
            throw new BizException("原始文件名不能为空");
        }
        return name.length() > 255 ? name.substring(0, 255) : name;
    }

    private static String prefix(BookProject p) {
        return StorageKeys.projectPrefix(p.getUserId(), p.getId());
    }

    private Object lock(Long projectId) {
        return locks.computeIfAbsent(projectId, k -> new Object());
    }

    private static LibraryItem findItem(LibraryManifest manifest, String fileName) {
        return manifest.items().stream()
                .filter(item -> item.fileName().equals(fileName))
                .findFirst()
                .orElse(null);
    }

    /** 按 fileName 覆盖或追加，保持 items 按加入顺序排列。 */
    private static void upsert(LibraryManifest manifest, LibraryItem item) {
        for (int i = 0; i < manifest.items().size(); i++) {
            if (manifest.items().get(i).fileName().equals(item.fileName())) {
                manifest.items().set(i, item);
                return;
            }
        }
        manifest.items().add(item);
    }

    private static LibraryItem withTaskId(LibraryItem item, String taskId) {
        return new LibraryItem(item.fileName(), item.originalName(), item.status(), item.progress(), item.error(),
                item.duration(), item.lineCount(), item.wordCount(), item.asrFile(),
                taskId, item.createdAt(), item.updatedAt());
    }

    /** 读清单；缺失或字段缺失时补默认值，列表保证可变。 */
    private LibraryManifest readManifest(String prefix) {
        byte[] bytes = ossService.getObject(prefix + MANIFEST_FILE);
        if (bytes == null) {
            return new LibraryManifest(1, new ArrayList<>());
        }
        try {
            LibraryManifest m = objectMapper.readValue(bytes, LibraryManifest.class);
            return new LibraryManifest(m.version() == 0 ? 1 : m.version(),
                    new ArrayList<>(m.items() == null ? List.of() : m.items()));
        } catch (IOException e) {
            throw new BizException("音频库清单不是合法 JSON");
        }
    }

    private void writeManifest(String prefix, LibraryManifest manifest) {
        try {
            ossService.putJson(prefix + MANIFEST_FILE, objectMapper.writeValueAsString(manifest));
        } catch (IOException e) {
            throw new BizException("音频库清单写入失败");
        }
    }

    /**
     * 从 book-custom-audio.json 的 entries[boxKey].fileName 里删掉所有引用该音源的绑定，
     * 有变化才写回。返回被删除的 boxKey 列表。
     */
    private List<String> unbindCustomAudio(String prefix, String fileName) {
        JsonNode root = fileService.readJsonByKey(prefix + CUSTOM_AUDIO_FILE);
        if (root == null || !root.isObject()) {
            return List.of();
        }
        JsonNode entriesNode = root.path("entries");
        if (!entriesNode.isObject()) {
            return List.of();
        }
        ObjectNode entries = (ObjectNode) entriesNode;
        List<String> removed = new ArrayList<>();
        Iterator<Map.Entry<String, JsonNode>> it = entries.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            if (fileName.equals(e.getValue().path("fileName").asText(null))) {
                removed.add(e.getKey());
            }
        }
        if (removed.isEmpty()) {
            return removed;
        }
        removed.forEach(entries::remove);
        try {
            ossService.putJson(prefix + CUSTOM_AUDIO_FILE, objectMapper.writeValueAsString(root));
        } catch (IOException e) {
            throw new BizException("音频绑定文件写入失败");
        }
        return removed;
    }
}
