package com.yueya.courseware;

import com.yueya.common.BizException;
import com.yueya.common.Result;
import com.yueya.common.UserContext;
import com.yueya.project.dto.ProjectDtos.CoursewareExportRequest;
import com.yueya.project.entity.BookProject;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.util.List;

@RestController
@RequestMapping("/api/book-courseware")
@RequiredArgsConstructor
public class CoursewareController {

    private final CoursewareService coursewareService;

    @PostMapping("/export")
    public Result<CoursewareService.ExportResult> export(@RequestBody CoursewareExportRequest req) {
        return Result.ok(coursewareService.export(UserContext.requireUserId(), req.projectIds(), req.folderIds()));
    }

    @PostMapping("/import")
    public Result<List<BookProject>> importPackage(@RequestPart("file") MultipartFile file,
                                                   @RequestParam(required = false) Long folderId) {
        if (file == null || file.isEmpty()) {
            throw new BizException("请选择课件包文件");
        }
        try (InputStream in = file.getInputStream()) {
            return Result.ok(coursewareService.importPackage(UserContext.requireUserId(), in, folderId));
        } catch (IOException e) {
            throw new BizException("读取上传文件失败");
        }
    }
}
