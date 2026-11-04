package com.yueya.project;

import com.fasterxml.jackson.databind.JsonNode;
import com.yueya.common.Result;
import com.yueya.common.UserContext;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** 解析详情接口（契约 §2）：解析详情弹窗与编辑器右栏共用。 */
@RestController
@RequiredArgsConstructor
public class AnalysisController {

    private final AnalysisService analysisService;

    @GetMapping("/api/book-projects/{id}/analysis")
    public Result<JsonNode> analysis(@PathVariable Long id) {
        return Result.ok(analysisService.analysis(UserContext.requireUserId(), id));
    }
}
