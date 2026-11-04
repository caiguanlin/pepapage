package com.yueya.auth;

import com.yueya.config.AppProperties;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.Optional;
import java.util.UUID;

/**
 * JWT 签发与校验。每个 token 的 jti 同时写入 Redis，退出登录时删除，
 * 因此 token 可以被服务端主动作废。
 */
@Service
public class TokenService {

    private static final String KEY_PREFIX = "auth:token:";

    private final SecretKey key;
    private final Duration ttl;
    private final StringRedisTemplate redis;

    public TokenService(AppProperties props, StringRedisTemplate redis) {
        byte[] secret = props.jwt().secret().getBytes(StandardCharsets.UTF_8);
        if (secret.length < 32) {
            throw new IllegalStateException("yueya.jwt.secret 长度至少 32 字节");
        }
        this.key = Keys.hmacShaKeyFor(secret);
        this.ttl = Duration.ofHours(props.jwt().ttlHours());
        this.redis = redis;
    }

    public String issue(Long userId) {
        String jti = UUID.randomUUID().toString();
        Instant now = Instant.now();
        String token = Jwts.builder()
                .id(jti)
                .subject(String.valueOf(userId))
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(ttl)))
                .signWith(key)
                .compact();
        redis.opsForValue().set(KEY_PREFIX + jti, String.valueOf(userId), ttl);
        return token;
    }

    /** 校验签名、过期时间和 Redis 中的会话记录，返回用户 ID。 */
    public Optional<Long> verify(String token) {
        try {
            Claims claims = Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload();
            String stored = redis.opsForValue().get(KEY_PREFIX + claims.getId());
            if (stored == null || !stored.equals(claims.getSubject())) {
                return Optional.empty();
            }
            return Optional.of(Long.valueOf(claims.getSubject()));
        } catch (JwtException | IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    public void revoke(String token) {
        try {
            Claims claims = Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload();
            redis.delete(KEY_PREFIX + claims.getId());
        } catch (JwtException | IllegalArgumentException ignored) {
            // 无效 token 无需作废
        }
    }
}
