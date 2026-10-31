package com.pepapage.task;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.pepapage.common.BizException;
import com.pepapage.common.Result;
import com.pepapage.project.AudioLibraryService;
import com.pepapage.project.entity.BookProject;
import com.pepapage.project.entity.BookProject.ProcessingStep;
import com.pepapage.project.mapper.BookProjectMapper;
import com.pepapage.task.entity.ProcessTask;
import com.pepapage.task.mapper.ProcessTaskMapper;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Pattern;
import lombok.RequiredArgsConstructor;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.util.HashMap;
import java.util.Map;

/** 仅供 Python worker 调用（X-Worker-Token 鉴权）。 */
@RestController
@RequestMapping("/internal/tasks")
@RequiredArgsConstructor
public class InternalTaskController {

    private final ProcessTaskMapper taskMapper;
    private final BookProjectMapper projectMapper;
    private final AudioLibraryService audioLibraryService;

    /** ossPrefix = users/{uid}/book-projects/{pid}/（以 / 结尾）。 */
    public record TaskDetail(ProcessTask task, BookProject project, Long userId, String ossPrefix) {
    }

    /**
     * 进度回调。stepKey/stepStatus/progress 更新单个阶段；
     * projectStatus=completed/failed 时结束任务。其余字段为处理结果，非空才写入。
     */
    public record ProgressRequest(
            String stepKey,
            @Pattern(regexp = "pending|running|completed|skipped|failed") String stepStatus,
            @Min(0) @Max(100) Integer progress,
            Integer currentStepIndex,
            @Pattern(regexp = "processing|completed|failed") String projectStatus,
            String error,
            Integer pageCount,
            BigDecimal durationSeconds,
            String coverKey,
            Map<String, Object> metadataPatch) {
    }

    @GetMapping("/{taskId}")
    public Result<TaskDetail> detail(@PathVariable Long taskId) {
        ProcessTask task = requireTask(taskId);
        BookProject project = projectMapper.selectById(task.getProjectId());
        if (project == null) {
            throw BizException.notFound("项目");
        }
        return Result.ok(new TaskDetail(task, project, project.getUserId(),
                com.pepapage.storage.StorageKeys.projectPrefix(project.getUserId(), project.getId())));
    }

    @PostMapping("/{taskId}/progress")
    @Transactional
    public Result<Void> progress(@PathVariable Long taskId, @Valid @RequestBody ProgressRequest req) {
        ProcessTask task = requireTask(taskId);
        BookProject p = projectMapper.selectById(task.getProjectId());
        if (p == null) {
            throw BizException.notFound("项目");
        }
        if (req.stepKey() != null && p.getProcessingSteps() != null) {
            for (ProcessingStep step : p.getProcessingSteps()) {
                if (step.getKey().equals(req.stepKey())) {
                    if (req.stepStatus() != null) {
                        step.setStatus(req.stepStatus());
                    }
                    if (req.progress() != null) {
                        step.setProgress(req.progress());
                    }
                }
            }
        }
        if (req.currentStepIndex() != null) {
            p.setCurrentStepIndex(req.currentStepIndex());
        }
        if (req.pageCount() != null) {
            p.setPageCount(req.pageCount());
        }
        if (req.durationSeconds() != null) {
            p.setDurationSeconds(req.durationSeconds());
        }
        if (req.coverKey() != null) {
            p.setCoverKey(req.coverKey());
        }
        if (req.metadataPatch() != null) {
            Map<String, Object> meta = p.getMetadata() == null ? new HashMap<>() : new HashMap<>(p.getMetadata());
            meta.putAll(req.metadataPatch());
            p.setMetadata(meta);
        }
        if (req.projectStatus() != null) {
            p.setStatus(req.projectStatus());
            if ("failed".equals(req.projectStatus())) {
                p.setProcessingError(req.error() == null ? "处理失败" : req.error());
            }
        }
        projectMapper.updateById(p);

        String taskStatus = switch (req.projectStatus() == null ? "" : req.projectStatus()) {
            case "completed" -> "succeeded";
            case "failed" -> "failed";
            default -> "running";
        };
        taskMapper.update(Wrappers.<ProcessTask>lambdaUpdate()
                .eq(ProcessTask::getId, taskId)
                .set(ProcessTask::getStatus, taskStatus)
                .set(ProcessTask::getError, "failed".equals(taskStatus) ? req.error() : null));
        return Result.ok();
    }

    /** 音频库识别进度回调（契约 §5.5）：只更新清单对应项和任务状态，不碰项目。 */
    @PostMapping("/{taskId}/library-progress")
    public Result<Void> libraryProgress(@PathVariable Long taskId,
                                        @Valid @RequestBody AudioLibraryService.LibraryProgressRequest req) {
        audioLibraryService.libraryProgress(taskId, req);
        return Result.ok();
    }

    private ProcessTask requireTask(Long taskId) {
        ProcessTask task = taskMapper.selectById(taskId);
        if (task == null) {
            throw BizException.notFound("任务");
        }
        return task;
    }
}
