package com.pepapage.export;

import com.pepapage.common.BizException;
import com.pepapage.export.entity.BookExport;
import com.pepapage.export.mapper.BookExportMapper;
import com.pepapage.project.BookProjectService;
import com.pepapage.project.entity.BookProject;
import com.pepapage.storage.OssService;
import com.pepapage.task.TaskService;
import com.pepapage.task.entity.ProcessTask;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashMap;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class ExportService {

    private final BookExportMapper exportMapper;
    private final BookProjectService projectService;
    private final TaskService taskService;
    private final OssService ossService;

    /** 对外视图：fileName 为纯文件名，url 仅 succeeded 时返回。 */
    public record ExportView(Long id, Long projectId, String type, String status, Integer progress,
                             String error, String fileName, String url) {
    }

    @Transactional
    public Long create(Long userId, Long projectId, String type) {
        BookProject p = projectService.requireOwned(userId, projectId);
        if (!"completed".equals(p.getStatus())) {
            throw new BizException("项目制作完成后才能导出");
        }
        BookExport e = new BookExport();
        e.setUserId(userId);
        e.setProjectId(projectId);
        e.setType(type);
        e.setStatus("queued");
        e.setProgress(0);
        exportMapper.insert(e);
        Map<String, String> extra = new LinkedHashMap<>();
        extra.put("exportId", String.valueOf(e.getId()));
        extra.put("type", type);
        ProcessTask task = taskService.enqueue(p, "book_export", extra);
        e.setTaskId(task.getId());
        exportMapper.updateById(e);
        return e.getId();
    }

    public ExportView get(Long userId, Long exportId) {
        BookExport e = exportMapper.selectById(exportId);
        if (e == null || !e.getUserId().equals(userId)) {
            throw BizException.notFound("导出任务");
        }
        return view(e);
    }

    ExportView view(BookExport e) {
        String url = null;
        String name = e.getFileName();
        if ("succeeded".equals(e.getStatus()) && name != null) {
            url = ossService.signedGetUrl(name);
        }
        String plain = name == null ? null : name.substring(name.lastIndexOf('/') + 1);
        return new ExportView(e.getId(), e.getProjectId(), e.getType(), e.getStatus(), e.getProgress(),
                e.getError(), plain, url);
    }
}
