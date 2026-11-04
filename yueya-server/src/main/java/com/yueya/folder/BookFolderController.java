package com.yueya.folder;

import com.yueya.common.Result;
import com.yueya.common.UserContext;
import com.yueya.folder.entity.BookFolder;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/book-folders")
@RequiredArgsConstructor
public class BookFolderController {

    private final BookFolderService folderService;

    public record CreateFolderRequest(
            @NotBlank(message = "文件夹名称不能为空") @Size(max = 100, message = "名称最多 100 字") String name,
            Long parentId) {
    }

    public record RenameFolderRequest(
            @NotBlank(message = "文件夹名称不能为空") @Size(max = 100, message = "名称最多 100 字") String name) {
    }

    /** parentId 为 null 表示移到根目录 */
    public record MoveFolderRequest(Long parentId) {
    }

    @GetMapping
    public Result<List<BookFolder>> list() {
        return Result.ok(folderService.listAll(UserContext.requireUserId()));
    }

    @PostMapping
    public Result<BookFolder> create(@Valid @RequestBody CreateFolderRequest req) {
        return Result.ok(folderService.create(UserContext.requireUserId(), req.name(), req.parentId()));
    }

    @PutMapping("/{id}/name")
    public Result<BookFolder> rename(@PathVariable Long id, @Valid @RequestBody RenameFolderRequest req) {
        return Result.ok(folderService.rename(UserContext.requireUserId(), id, req.name()));
    }

    @PutMapping("/{id}/parent")
    public Result<Void> move(@PathVariable Long id, @RequestBody MoveFolderRequest req) {
        folderService.move(UserContext.requireUserId(), id, req.parentId());
        return Result.ok();
    }

    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        folderService.delete(UserContext.requireUserId(), id);
        return Result.ok();
    }
}
