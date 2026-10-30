package com.pepapage.project;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.pepapage.common.BizException;
import com.pepapage.folder.BookFolderService;
import com.pepapage.project.dto.ProjectDtos.CreateProjectRequest;
import com.pepapage.project.dto.ProjectDtos.SubmitAudioFile;
import com.pepapage.project.dto.ProjectDtos.SubmitProjectRequest;
import com.pepapage.project.dto.ProjectDtos.UploadPolicyRequest;
import com.pepapage.project.entity.BookProject;
import com.pepapage.project.entity.BookProject.AudioFile;
import com.pepapage.project.entity.BookProject.ProcessingStep;
import com.pepapage.project.mapper.BookProjectMapper;
import com.pepapage.storage.OssService;
import com.pepapage.storage.StorageKeys;
import com.pepapage.task.TaskService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

@Service
@RequiredArgsConstructor
public class BookProjectService {

    /** 阶段顺序固定：ocr → audio_conversion → transcription → alignment */
    public static final List<String> STEP_KEYS = List.of("ocr", "audio_conversion", "transcription", "alignment");

    private final BookProjectMapper projectMapper;
    private final BookFolderService folderService;
    private final OssService ossService;
    private final TaskService taskService;

    /**
     * keyword 非空时为全局搜索（忽略 folderId）；否则列出指定文件夹（null 为根目录）。
     * sort=title 按名称；其余按 updatedAt（编辑过的项目前移，与原版一致）。
     */
    public List<BookProject> list(Long userId, Long folderId, String keyword, String sort, boolean asc) {
        LambdaQueryWrapper<BookProject> q = Wrappers.<BookProject>lambdaQuery().eq(BookProject::getUserId, userId);
        if (keyword != null && !keyword.isBlank()) {
            q.like(BookProject::getTitle, keyword.trim());
        } else if (folderId == null) {
            q.isNull(BookProject::getFolderId);
        } else {
            q.eq(BookProject::getFolderId, folderId);
        }
        if ("title".equals(sort)) {
            q.orderBy(true, asc, BookProject::getTitle);
        } else {
            q.orderBy(true, asc, BookProject::getUpdatedAt);
        }
        return projectMapper.selectList(q);
    }

    public BookProject get(Long userId, Long id) {
        return requireOwned(userId, id);
    }

    public BookProject create(Long userId, CreateProjectRequest req) {
        if (req.folderId() != null) {
            folderService.requireOwned(userId, req.folderId());
        }
        String lower = req.sourceFileName().toLowerCase();
        if (lower.endsWith(".epub")) {
            throw new BizException("已不再支持 EPUB，请使用 PDF 或图片作为书籍源");
        }
        if (!lower.endsWith(".pdf")) {
            throw new BizException("书籍文件需为 PDF（图片请在前端合成 PDF 后上传）");
        }
        BookProject p = new BookProject();
        p.setUserId(userId);
        p.setFolderId(req.folderId());
        p.setTitle(resolveTitle(req.title(), req.sourceFileName()));
        p.setAudioMode(req.audioMode());
        p.setSourceType("pdf");
        if ("tts".equals(req.audioMode())) {
            p.setTtsVoice(req.ttsVoice() == null ? "Bella" : req.ttsVoice());
            p.setTtsSpeed(req.ttsSpeed() == null ? BigDecimal.ONE : req.ttsSpeed());
        }
        p.setStatus("uploading");
        p.setCurrentStepIndex(0);
        p.setOcrConfirmed(false);
        p.setProcessingSteps(initialSteps(req.audioMode()));
        projectMapper.insert(p);
        return p;
    }

    public OssService.UploadPolicy uploadPolicy(Long userId, Long id, UploadPolicyRequest req) {
        BookProject p = requireOwned(userId, id);
        if (!"uploading".equals(p.getStatus())) {
            throw new BizException("项目已提交，不能再上传源文件");
        }
        String key = switch (req.kind()) {
            case "source" -> StorageKeys.bookSource(userId, id);
            case "audio" -> {
                requireMode(p, "single");
                yield StorageKeys.bookAudio(userId, id, req.fileName());
            }
            case "multi_audio" -> {
                requireMode(p, "multi");
                yield StorageKeys.multiAudio(userId, id, req.fileName());
            }
            default -> throw new BizException("文件类型不正确");
        };
        return ossService.createUploadPolicy(key);
    }

    @Transactional
    public BookProject submit(Long userId, Long id, SubmitProjectRequest req) {
        BookProject p = requireOwned(userId, id);
        if (!"uploading".equals(p.getStatus())) {
            throw new BizException("项目已提交");
        }
        String prefix = StorageKeys.projectPrefix(userId, id);
        if (!StorageKeys.bookSource(userId, id).equals(req.sourceFileKey())) {
            throw new BizException("书籍文件 key 不正确");
        }
        requireUploaded(req.sourceFileKey(), "书籍文件");
        p.setSourceFileKey(req.sourceFileKey());

        switch (p.getAudioMode()) {
            case "single" -> {
                String key = req.audioFileKey();
                if (key == null || !key.startsWith(prefix + "book-audio.")) {
                    throw new BizException("单音频模式需上传整书音频");
                }
                requireUploaded(key, "整书音频");
                p.setAudioFileKey(key);
            }
            case "multi" -> {
                List<SubmitAudioFile> files = req.audioFiles();
                if (files == null || files.isEmpty()) {
                    throw new BizException("多音频模式至少需要 1 个音频文件");
                }
                List<AudioFile> list = new ArrayList<>();
                for (SubmitAudioFile f : files) {
                    if (!f.fileKey().startsWith(prefix + "audio/")) {
                        throw new BizException("音频文件 key 不正确");
                    }
                    requireUploaded(f.fileKey(), f.originalName());
                    list.add(new AudioFile(f.fileKey(), f.originalName()));
                }
                p.setAudioFiles(list);
            }
            default -> {
                // tts 模式无需音频
            }
        }
        p.setStatus("processing");
        projectMapper.updateById(p);
        taskService.enqueue(p, "book_full");
        return p;
    }

    /** 失败项目全量重试：重置阶段、清错误，重新投递任务，不新建项目。 */
    @Transactional
    public BookProject retry(Long userId, Long id) {
        BookProject p = requireOwned(userId, id);
        if (!"failed".equals(p.getStatus())) {
            throw new BizException("只有失败的项目可以重试");
        }
        p.setStatus("processing");
        p.setCurrentStepIndex(0);
        p.setProcessingSteps(initialSteps(p.getAudioMode()));
        projectMapper.updateById(p);
        projectMapper.update(Wrappers.<BookProject>lambdaUpdate()
                .eq(BookProject::getId, id)
                .set(BookProject::getProcessingError, null));
        p.setProcessingError(null);
        taskService.enqueue(p, "book_full");
        return p;
    }

    public BookProject rename(Long userId, Long id, String title) {
        BookProject p = requireOwned(userId, id);
        p.setTitle(title.trim());
        projectMapper.updateById(p);
        return p;
    }

    public void move(Long userId, List<Long> ids, Long folderId) {
        if (folderId != null) {
            folderService.requireOwned(userId, folderId);
        }
        projectMapper.update(Wrappers.<BookProject>lambdaUpdate()
                .eq(BookProject::getUserId, userId)
                .in(BookProject::getId, ids)
                .set(BookProject::getFolderId, folderId));
    }

    /** 永久删除：删除记录及 OSS 中该项目的全部文件。 */
    public void delete(Long userId, List<Long> ids) {
        List<BookProject> owned = projectMapper.selectList(Wrappers.<BookProject>lambdaQuery()
                .eq(BookProject::getUserId, userId)
                .in(BookProject::getId, ids));
        if (owned.isEmpty()) {
            return;
        }
        projectMapper.deleteByIds(owned.stream().map(BookProject::getId).toList());
        owned.forEach(p -> ossService.deletePrefix(StorageKeys.projectPrefix(userId, p.getId())));
    }

    public BookProject requireOwned(Long userId, Long id) {
        BookProject p = projectMapper.selectById(id);
        if (p == null || !p.getUserId().equals(userId)) {
            throw BizException.notFound("项目");
        }
        return p;
    }

    /** 各模式初始阶段：multi 只做页面准备；tts 跳过音频转换与识别，最后一步合成配音。 */
    static List<ProcessingStep> initialSteps(String mode) {
        List<String> statuses = switch (mode) {
            case "single" -> List.of("pending", "pending", "pending", "pending");
            case "multi" -> List.of("pending", "skipped", "skipped", "skipped");
            case "tts" -> List.of("pending", "skipped", "skipped", "pending");
            default -> throw new BizException("铺码模式不正确");
        };
        List<ProcessingStep> steps = new ArrayList<>();
        for (int i = 0; i < STEP_KEYS.size(); i++) {
            steps.add(ProcessingStep.of(STEP_KEYS.get(i), statuses.get(i)));
        }
        return steps;
    }

    private static String resolveTitle(String title, String sourceFileName) {
        if (title != null && !title.isBlank()) {
            return title.trim();
        }
        int dot = sourceFileName.lastIndexOf('.');
        String stem = dot > 0 ? sourceFileName.substring(0, dot) : sourceFileName;
        return stem.isBlank() ? "未命名绘本" : stem;
    }

    private static void requireMode(BookProject p, String mode) {
        if (!mode.equals(p.getAudioMode())) {
            throw new BizException("当前铺码模式不需要该文件");
        }
    }

    private void requireUploaded(String key, String what) {
        if (!ossService.exists(key)) {
            throw new BizException(what + " 尚未上传完成");
        }
    }
}
