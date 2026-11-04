package com.yueya.config;

import com.yueya.auth.AuthInterceptor;
import com.yueya.auth.WorkerAuthInterceptor;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

// 前端与 /api 同源访问（开发走 Vite 代理，生产走反向代理），因此不配置 CORS
@Configuration
@RequiredArgsConstructor
public class WebConfig implements WebMvcConfigurer {

    private final AuthInterceptor authInterceptor;
    private final WorkerAuthInterceptor workerAuthInterceptor;

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(authInterceptor)
                .addPathPatterns("/api/**")
                .excludePathPatterns("/api/auth/login", "/api/auth/register", "/api/health");
        registry.addInterceptor(workerAuthInterceptor)
                .addPathPatterns("/internal/**");
    }
}
