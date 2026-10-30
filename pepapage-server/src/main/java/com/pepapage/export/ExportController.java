package com.pepapage.export;

import com.pepapage.common.Result;
import com.pepapage.common.UserContext;
import com.pepapage.project.dto.ProjectDtos.CreateExportRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class ExportController {

    private final ExportService exportService;

    @PostMapping("/book-projects/{id}/exports")
    public Result<Map<String, String>> create(@PathVariable Long id, @Valid @RequestBody CreateExportRequest req) {
        Long exportId = exportService.create(UserContext.requireUserId(), id, req.type());
        return Result.ok(Map.of("exportId", String.valueOf(exportId)));
    }

    @GetMapping("/book-exports/{exportId}")
    public Result<ExportService.ExportView> get(@PathVariable Long exportId) {
        return Result.ok(exportService.get(UserContext.requireUserId(), exportId));
    }
}
