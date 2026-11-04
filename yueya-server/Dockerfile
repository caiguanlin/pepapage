# syntax=docker/dockerfile:1
# Yueya 后端：Maven + JDK 21 构建 fat jar，JRE 21 运行（目标平台 linux/amd64）
# 构建上下文 = yueya-server 目录：docker build -t yueya-server .
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build

# 先拉依赖，充分利用层缓存
COPY pom.xml ./
RUN mvn -B --no-transfer-progress dependency:go-offline

COPY src ./src

# 本地私密配置绝不能进入产物 jar：
# .dockerignore 已把 application-local.yml(.example) 挡在上下文外，这里再兜底删除一次
RUN rm -f src/main/resources/application-local.yml \
          src/main/resources/application-local.yml.example

# 打包（含单元测试），并硬校验 jar 里没有本地私密配置，泄漏则直接构建失败
RUN mvn -B --no-transfer-progress package \
  && if jar tf target/yueya-server-0.1.0-SNAPSHOT.jar | grep -q 'application-local'; then \
       echo "ERROR: application-local.yml leaked into jar"; exit 1; fi

# 单独取出 fat jar，运行阶段只拷这一个文件
RUN cp target/yueya-server-0.1.0-SNAPSHOT.jar /yueya-server.jar


FROM eclipse-temurin:21-jre-alpine AS runtime

# 非 root 运行
RUN addgroup -S pepa && adduser -S -H -G pepa pepa

WORKDIR /app
COPY --from=build --chown=pepa:pepa /yueya-server.jar app.jar
USER pepa

# 生产 profile；数据库/Redis/OSS/JWT 等敏感配置一律经环境变量注入
# （application.yml 中均为 ${ENV:默认值}，运行时不读任何本地私密文件）
ENV SPRING_PROFILES_ACTIVE=prod

EXPOSE 8080

# 复用现有公开健康端点 GET /api/health（不依赖 DB/Redis 可用性）
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["java", "-jar", "app.jar"]
