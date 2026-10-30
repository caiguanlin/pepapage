package com.pepapage.project;

import com.pepapage.common.Result;
import com.pepapage.common.UserContext;
import com.pepapage.project.dto.ProjectDtos.BatchDeleteRequest;
import com.pepapage.project.dto.ProjectDtos.CreateProjectRequest;
import com.pepapage.project.dto.ProjectDtos.MoveProjectsRequest;
import com.pepapage.project.dto.ProjectDtos.RenameProjectRequest;
import com.pepapage.project.dto.ProjectDtos.SubmitProjectRequest;
import com.pepapage.project.dto.ProjectDtos.UploadPolicyRequest;
import com.pepapage.project.entity.BookProject;
import com.pepapage.storage.OssService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 创建流程：POST 创建（uploading）→ POST upload-policy 取直传凭证 → 浏览器直传 OSS → POST submit 开始制作。
 */
@RestController
@RequestMapping("/api/book-projects")
@RequiredArgsConstructor
public class BookProjectController {

    private final BookProjectService projectService;

    @GetMapping
    public Result<List<BookProject>> list(@RequestParam(required = false) Long folderId,
                                          @RequestParam(required = false) String keyword,
                                          @RequestParam(defaultValue = "createdAt") String sort,
                                          @RequestParam(defaultValue = "desc") String order) {
        return Result.ok(projectService.list(UserContext.requireUserId(), folderId, keyword, sort,
                "asc".equalsIgnoreCase(order)));
    }

    @GetMapping("/{id}")
    public Result<BookProject> get(@PathVariable Long id) {
        return Result.ok(projectService.get(UserContext.requireUserId(), id));
    }

    @PostMapping
    public Result<BookProject> create(@Valid @RequestBody CreateProjectRequest req) {
        return Result.ok(projectService.create(UserContext.requireUserId(), req));
    }

    @PostMapping("/{id}/upload-policy")
    public Result<OssService.UploadPolicy> uploadPolicy(@PathVariable Long id, @Valid @RequestBody UploadPolicyRequest req) {
        return Result.ok(projectService.uploadPolicy(UserContext.requireUserId(), id, req));
    }

    @PostMapping("/{id}/submit")
    public Result<BookProject> submit(@PathVariable Long id, @Valid @RequestBody SubmitProjectRequest req) {
        return Result.ok(projectService.submit(UserContext.requireUserId(), id, req));
    }

    @PostMapping("/{id}/retry")
    public Result<BookProject> retry(@PathVariable Long id) {
        return Result.ok(projectService.retry(UserContext.requireUserId(), id));
    }

    @PutMapping("/{id}/title")
    public Result<BookProject> rename(@PathVariable Long id, @Valid @RequestBody RenameProjectRequest req) {
        return Result.ok(projectService.rename(UserContext.requireUserId(), id, req.title()));
    }

    @PostMapping("/move")
    public Result<Void> move(@Valid @RequestBody MoveProjectsRequest req) {
        projectService.move(UserContext.requireUserId(), req.ids(), req.folderId());
        return Result.ok();
    }

    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        projectService.delete(UserContext.requireUserId(), List.of(id));
        return Result.ok();
    }

    @PostMapping("/batch-delete")
    public Result<Void> batchDelete(@Valid @RequestBody BatchDeleteRequest req) {
        projectService.delete(UserContext.requireUserId(), req.ids());
        return Result.ok();
    }
}
