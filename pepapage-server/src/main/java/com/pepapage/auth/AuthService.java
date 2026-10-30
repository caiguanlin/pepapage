package com.pepapage.auth;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.pepapage.auth.convert.UserConverter;
import com.pepapage.auth.dto.AuthDtos.LoginRequest;
import com.pepapage.auth.dto.AuthDtos.LoginResponse;
import com.pepapage.auth.dto.AuthDtos.RegisterRequest;
import com.pepapage.auth.dto.AuthDtos.UserInfo;
import com.pepapage.common.BizException;
import com.pepapage.user.entity.User;
import com.pepapage.user.mapper.UserMapper;
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
