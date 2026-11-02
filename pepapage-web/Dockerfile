# syntax=docker/dockerfile:1
# PepaPage 前端：Node 22 构建 + Nginx 静态服务/反代（目标平台 linux/amd64）
# 构建上下文 = pepapage-web 目录：docker build -t pepapage-web .
FROM node:22-alpine AS build
WORKDIR /app

# 先装依赖，充分利用层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 显式拷贝构建必需内容（.dockerignore 已排除 dist、node_modules、.env 等）
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src

RUN npm run build


FROM nginx:alpine AS runtime
# 用本项目配置替换默认站点：SPA fallback + /api 反代 + /internal 404
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
