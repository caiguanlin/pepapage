package com.yueya.auth;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.yueya.auth.convert.UserConverter;
import com.yueya.auth.dto.AuthDtos.LoginRequest;
import com.yueya.auth.dto.AuthDtos.LoginResponse;
import com.yueya.auth.dto.AuthDtos.RegisterRequest;
import com.yueya.auth.dto.AuthDtos.UserInfo;
import com.yueya.common.BizException;
import com.yueya.user.entity.User;
import com.yueya.user.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

import java.util.Locale;

@Service
@RequiredArgsConstructor
public class AuthService {

    private final UserMapper userMapper;
    private final TokenService tokenService;
    private final UserConverter userConverter;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    public LoginResponse register(RegisterRequest req) {
        String email = req.email().trim().toLowerCase(Locale.ROOT);
        User user = new User();
        user.setEmail(email);
        user.setPasswordHash(encoder.encode(req.password()));
        user.setNickname(req.nickname() == null || req.nickname().isBlank() ? email.split("@")[0] : req.nickname().trim());
        try {
            userMapper.insert(user);
        } catch (DuplicateKeyException e) {
            throw new BizException(409, "该邮箱已注册");
        }
        return new LoginResponse(tokenService.issue(user.getId()), userConverter.toInfo(user));
    }

    public LoginResponse login(LoginRequest req) {
        String email = req.email().trim().toLowerCase(Locale.ROOT);
        User user = userMapper.selectOne(Wrappers.<User>lambdaQuery().eq(User::getEmail, email));
        if (user == null || !encoder.matches(req.password(), user.getPasswordHash())) {
            throw new BizException(401, "邮箱或密码错误");
        }
        return new LoginResponse(tokenService.issue(user.getId()), userConverter.toInfo(user));
    }

    public UserInfo me(Long userId) {
        User user = userMapper.selectById(userId);
        if (user == null) {
            throw BizException.unauthorized();
        }
        return userConverter.toInfo(user);
    }
}
