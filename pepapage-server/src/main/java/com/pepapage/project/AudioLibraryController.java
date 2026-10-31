package com.pepapage.project;

import com.pepapage.common.Result;
import com.pepapage.common.UserContext;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 编辑器音频库（契约 §5.4）：清单查询、加入识别、删除并清理绑定。逻辑在 {@link AudioLibraryService}。 */
@RestController
@RequestMapping("/api/book-projects/{id}/audio-library")
@RequiredArgsConstructor
public class AudioLibraryController {

    private final AudioLibraryService audioLibraryService;

    @GetMapping
    public Result<AudioLibraryService.LibraryManifest> get(@PathVariable Long id) {
        return Result.ok(audioLibraryService.list(UserContext.requireUserId(), id));
    }

    @PostMapping
    public Result<AudioLibraryService.LibraryItem> add(@PathVariable Long id,
                                                       @Valid @RequestBody AudioLibraryService.AddRequest req) {
        return Result.ok(audioLibraryService.add(UserContext.requireUserId(), id, req));
    }

    @DeleteMapping
    public Result<AudioLibraryService.DeleteResult> delete(@PathVariable Long id, @RequestParam String fileName) {
        return Result.ok(audioLibraryService.remove(UserContext.requireUserId(), id, fileName));
    }
}
