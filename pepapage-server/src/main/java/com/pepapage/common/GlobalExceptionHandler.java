package com.pepapage.common;

import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

import java.util.stream.Collectors;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(BizException.class)
    public Result<Void> handleBiz(BizException e, HttpServletResponse response) {
        response.setStatus(e.getCode() >= 400 && e.getCode() < 600 ? e.getCode() : 400);
        return Result.fail(e.getCode(), e.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public Result<Void> handleValid(MethodArgumentNotValidException e, HttpServletResponse response) {
        response.setStatus(400);
        String msg = e.getBindingResult().getFieldErrors().stream()
                .map(FieldError::getDefaultMessage)
                .collect(Collectors.joining("；"));
        return Result.fail(400, msg);
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public Result<Void> handleTooLarge(MaxUploadSizeExceededException e, HttpServletResponse response) {
        response.setStatus(413);
        return Result.fail(413, "上传文件不能超过 50MB");
    }

    @ExceptionHandler(org.springframework.web.servlet.resource.NoResourceFoundException.class)
    public Result<Void> handleNotFound(Exception e, HttpServletResponse response) {
        response.setStatus(404);
        return Result.fail(404, "接口不存在");
    }

    @ExceptionHandler(Exception.class)
    public Result<Void> handleOther(Exception e, HttpServletResponse response) {
        log.error("未处理异常", e);
        response.setStatus(500);
        return Result.fail(500, "服务器内部错误");
    }
}
