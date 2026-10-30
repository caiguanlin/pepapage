package com.pepapage.export;

import com.pepapage.common.BizException;
import com.pepapage.common.Result;
import com.pepapage.export.entity.BookExport;
import com.pepapage.export.mapper.BookExportMapper;
import com.pepapage.project.entity.BookProject;
import com.pepapage.project.mapper.BookProjectMapper;
import com.pepapage.storage.StorageKeys;
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

/** 仅供 worker 调用（/internal/** 由 WorkerAuthInterceptor 校验 X-Worker-Token）。 */
@RestController
@RequestMapping("/internal/exports")
@RequiredArgsConstructor
public class InternalExportController {

    private final BookExportMapper exportMapper;
    private final BookProjectMapper projectMapper;
    private final ProcessTaskMapper taskMapper;

    public record ExportInfo(Long id, Long projectId, String type, Long taskId, String status) {
    }

    public record ExportDetail(ExportInfo export, BookProject project, Long userId, String ossPrefix) {
    }

    /** fileName 为 OSS key（如 <ossPrefix>exports/<exportId>.zip）。 */
    public record ExportProgress(
            @Pattern(regexp = "queued|running|succeeded|failed") String status,
            @Min(0) @Max(100) Integer progress,
            String error,
            String fileName) {
    }

    @GetMapping("/{exportId}")
    public Result<ExportDetail> detail(@PathVariable Long exportId) {
        BookExport e = require(exportId);
        BookProject p = projectMapper.selectById(e.getProjectId());
        if (p == null) {
            throw BizException.notFound("项目");
        }
        return Result.ok(new ExportDetail(
                new ExportInfo(e.getId(), e.getProjectId(), e.getType(), e.getTaskId(), e.getStatus()),
                p, p.getUserId(), StorageKeys.projectPrefix(p.getUserId(), p.getId())));
    }

    @PostMapping("/{exportId}/progress")
    @Transactional
    public Result<Void> progress(@PathVariable Long exportId, @Valid @RequestBody ExportProgress req) {
        BookExport e = require(exportId);
        if (req.fileName() != null) {
            String prefix = StorageKeys.userPrefix(e.getUserId());
            if (!req.fileName().startsWith(prefix) || req.fileName().contains("..")) {
                throw new BizException("导出文件 key 不正确");
            }
            e.setFileName(req.fileName());
        }
        if (req.status() != null) {
            e.setStatus(req.status());
        }
        if (req.progress() != null) {
            e.setProgress(req.progress());
        }
        if ("succeeded".equals(req.status())) {
            e.setProgress(100);
        }
        if (req.error() != null || "failed".equals(req.status())) {
            e.setError(req.error() == null ? "导出失败" : req.error());
        }
        exportMapper.updateById(e);
        if (e.getTaskId() != null && req.status() != null) {
            ProcessTask t = new ProcessTask();
            t.setId(e.getTaskId());
            t.setStatus(req.status());
            t.setError("failed".equals(req.status()) ? e.getError() : null);
            taskMapper.updateById(t);
        }
        return Result.ok();
    }

    private BookExport require(Long id) {
        BookExport e = exportMapper.selectById(id);
        if (e == null) {
            throw BizException.notFound("导出任务");
        }
        return e;
    }
}
