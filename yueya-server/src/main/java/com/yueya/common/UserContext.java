package com.yueya.common;

/** 当前请求的登录用户 ID，由 AuthInterceptor 写入，请求结束清理。 */
public final class UserContext {

    private static final ThreadLocal<Long> HOLDER = new ThreadLocal<>();

    private UserContext() {
    }

    public static void set(Long userId) {
        HOLDER.set(userId);
    }

    public static Long requireUserId() {
        Long id = HOLDER.get();
        if (id == null) {
            throw BizException.unauthorized();
        }
        return id;
    }

    public static void clear() {
        HOLDER.remove();
    }
}
