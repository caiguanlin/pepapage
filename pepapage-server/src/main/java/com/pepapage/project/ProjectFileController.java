package com.pepapage.project;

import com.fasterxml.jackson.databind.JsonNode;
import com.pepapage.common.Result;
import com.pepapage.common.UserContext;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/** 项目文件接口（契约 §2）：列表、签名 URL、JSON 读写、删除。name 为项目目录内相对文件名。 */
@RestController
@RequestMapping("/api/book-projects/{id}/files")
@RequiredArgsConstructor
public class ProjectFileController {

    private final ProjectFileService fileService;

    @GetMapping
    public Result<List<ProjectFileService.FileInfo>> list(@PathVariable Long id) {
        return Result.ok(fileService.list(UserContext.requireUserId(), id));
    }

    @GetMapping("/url")
    public Result<Map<String, String>> url(@PathVariable Long id, @RequestParam String name) {
        return Result.ok(Map.of("url", fileService.url(UserContext.requireUserId(), id, name)));
    }

    @GetMapping("/json")
    public Result<JsonNode> readJson(@PathVariable Long id, @RequestParam String name) {
        return Result.ok(fileService.readJson(UserContext.requireUserId(), id, name));
    }

    @PutMapping("/json")
    public Result<Void> writeJson(@PathVariable Long id, @RequestParam String name, @RequestBody JsonNode content) {
        fileService.writeJson(UserContext.requireUserId(), id, name, content);
        return Result.ok();
    }

    @DeleteMapping
    public Result<Void> delete(@PathVariable Long id, @RequestParam String name) {
        fileService.delete(UserContext.requireUserId(), id, name);
        return Result.ok();
    }
}
