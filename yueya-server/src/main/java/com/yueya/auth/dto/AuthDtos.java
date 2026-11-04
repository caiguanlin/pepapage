package com.yueya.auth.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public final class AuthDtos {

    private AuthDtos() {
    }

    public record RegisterRequest(
            @NotBlank(message = "邮箱不能为空") @Email(message = "邮箱格式不正确") String email,
            @NotBlank(message = "密码不能为空") @Size(min = 8, max = 64, message = "密码长度需为 8-64 位") String password,
            @Size(max = 32, message = "昵称最多 32 字") String nickname) {
    }

    public record LoginRequest(
            @NotBlank(message = "邮箱不能为空") String email,
            @NotBlank(message = "密码不能为空") String password) {
    }

    public record UserInfo(Long id, String email, String nickname) {
    }

    public record LoginResponse(String token, UserInfo user) {
    }
}
