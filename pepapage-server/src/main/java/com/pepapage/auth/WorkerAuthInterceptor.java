package com.pepapage.auth;

import com.pepapage.common.BizException;
import com.pepapage.config.AppProperties;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** /internal/** 仅供 Python worker 调用，用共享密钥鉴权。生产环境还应在网关层禁止外网访问。 */
@Component
@RequiredArgsConstructor
public class WorkerAuthInterceptor implements HandlerInterceptor {

    private final AppProperties props;

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        String token = request.getHeader("X-Worker-Token");
        byte[] expected = props.worker().token().getBytes(StandardCharsets.UTF_8);
        if (token == null || !MessageDigest.isEqual(expected, token.getBytes(StandardCharsets.UTF_8))) {
            throw new BizException(403, "worker 鉴权失败");
        }
        return true;
    }
}
