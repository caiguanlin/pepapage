package com.pepapage.project;

import com.pepapage.common.Result;
import com.pepapage.common.UserContext;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequiredArgsConstructor
public class ReaderController {

    private final ReaderService readerService;

    @GetMapping("/api/book-projects/{id}/reader")
    public Result<Map<String, Object>> reader(@PathVariable Long id) {
        return Result.ok(readerService.reader(UserContext.requireUserId(), id));
    }
}
