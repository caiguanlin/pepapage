package com.yueya.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "yueya")
public record AppProperties(Jwt jwt, Worker worker, Oss oss) {

    public record Jwt(String secret, int ttlHours) {
    }

    public record Worker(String token, String taskStream) {
    }

    public record Oss(String endpoint, String bucket, String accessKeyId, String accessKeySecret,
                      int uploadExpireSeconds, int maxUploadMb, int downloadExpireSeconds) {

        public boolean configured() {
            return notBlank(endpoint) && notBlank(bucket) && notBlank(accessKeyId) && notBlank(accessKeySecret);
        }

        private static boolean notBlank(String s) {
            return s != null && !s.isBlank();
        }
    }
}
