# 单镜像一体化部署：一个 Node 进程在同一端口提供网页、REST、MCP 与 Socket.IO。

# 国内网络可改为加速站，如 docker.m.daocloud.io/library/node:22-bookworm-slim。
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
# 国内网络默认走 npmmirror；GitHub Actions 中传入 https://registry.npmjs.org。
ARG NPM_REGISTRY=https://registry.npmmirror.com
# 可选：Debian 软件源镜像主机（如 mirrors.aliyun.com），为空则用官方源。
ARG DEBIAN_MIRROR=
ENV CI=true \
    npm_config_registry=${NPM_REGISTRY} \
    npm_config_store_dir=/pnpm/store
RUN if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.30.2
WORKDIR /app

# 先只复制清单，依赖层在源码变化时可复用。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN --mount=type=cache,id=serpent-pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# 构建完成后只保留运行时依赖。
RUN --mount=type=cache,id=serpent-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --offline


FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8008
WORKDIR /app
# 运行时目录结构与仓库一致：dist 会读取 server/src/docs、examples/scripts 与 web/dist。
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/node_modules ./server/node_modules
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/server/src/docs ./server/src/docs
COPY --from=build --chown=node:node /app/examples ./examples
COPY --from=build --chown=node:node /app/web/dist ./web/dist
RUN mkdir -p /app/server/data && chown node:node /app/server/data

USER node
WORKDIR /app/server
# SQLite 数据库与 .jwt_secret 都在这里，必须挂卷持久化。
VOLUME ["/app/server/data"]
EXPOSE 8008
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8008)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
