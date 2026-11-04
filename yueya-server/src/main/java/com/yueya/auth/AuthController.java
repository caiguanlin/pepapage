package com.yueya.auth;

import com.yueya.auth.dto.AuthDtos.LoginRequest;
import com.yueya.auth.dto.AuthDtos.LoginResponse;
import com.yueya.auth.dto.AuthDtos.RegisterRequest;
import com.yueya.auth.dto.AuthDtos.UserInfo;
import com.yueya.common.Result;
import com.yueya.common.UserContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;
    private final TokenService tokenService;

    @GetMapping("/health")
    public Result<Map<String, String>> health() {
        return Result.ok(Map.of("status", "up"));
    }

    @PostMapping("/auth/register")
    public Result<LoginResponse> register(@Valid @RequestBody RegisterRequest req) {
        return Result.ok(authService.register(req));
    }

    @PostMapping("/auth/login")
    public Result<LoginResponse> login(@Valid @RequestBody LoginRequest req) {
        return Result.ok(authService.login(req));
    }

    @PostMapping("/auth/logout")
    public Result<Void> logout(HttpServletRequest request) {
        String token = AuthInterceptor.extractBearer(request);
        if (token != null) {
            tokenService.revoke(token);
        }
        return Result.ok();
    }

    @GetMapping("/auth/me")
    public Result<UserInfo> me() {
        return Result.ok(authService.me(UserContext.requireUserId()));
    }
}
