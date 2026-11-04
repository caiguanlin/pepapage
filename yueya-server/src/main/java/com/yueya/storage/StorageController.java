package com.yueya.storage;

import com.yueya.common.BizException;
import com.yueya.common.Result;
import com.yueya.common.UserContext;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/storage")
@RequiredArgsConstructor
public class StorageController {

    private final OssService ossService;

    /** 为当前用户自己的文件签发临时下载地址（播放音频、显示 PDF、封面）。 */
    @GetMapping("/signed-url")
    public Result<Map<String, String>> signedUrl(@RequestParam String key) {
        String prefix = StorageKeys.userPrefix(UserContext.requireUserId());
        if (!key.startsWith(prefix) || key.contains("..")) {
            throw new BizException(403, "无权访问该文件");
        }
        return Result.ok(Map.of("url", ossService.signedGetUrl(key)));
    }
}
