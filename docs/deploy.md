# 部署与发版

SERPENT 是**一体化部署**：一个 Node 进程在同一端口同时提供网页、REST（`/api`）、MCP（`/mcp`）和 Socket.IO。数据都在 SQLite 与 `server/data/` 中，适合单实例运行。

## 1. Docker Compose 部署（推荐）

需要 Docker 与 Docker Compose v2。服务器上只需要两个文件：`docker-compose.yml` 和 `.env`。

```bash
mkdir serpent && cd serpent
curl -fsSLO https://raw.githubusercontent.com/DueGin/serpent/master/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/DueGin/serpent/master/.env.example -o .env
# 按需修改 .env：PUBLIC_URL、SERPENT_PORT、固定版本的 SERPENT_IMAGE 等
docker compose pull
docker compose up -d
docker compose ps        # 状态为 healthy 即启动完成
```

打开 `http://服务器:8008` 注册账号即可使用。MCP 地址为 `http://服务器:8008/mcp`。

### 配置项（`.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SERPENT_IMAGE` | `ghcr.io/duegin/serpent:latest` | 使用的镜像；生产建议固定版本，如 `ghcr.io/duegin/serpent:0.2.0` |
| `SERPENT_PORT` | `8008` | 宿主机端口 |
| `PUBLIC_URL` | `http://localhost:8008` | 对外访问地址；放在反向代理后填域名 |
| `JWT_SECRET` | 空 | 用户登录令牌签名密钥；留空则首次启动自动生成并保存在数据卷中 |
| `LADDER_AUTO` | `1` | 后台天梯匹配器；`0` 关闭（手动 queue 仍可开赛） |
| `RUNNER_WORKERS` | 自动 | 模拟 worker 线程数，默认按 CPU 选择（最多 4） |
| `PYTHON_MAX_HOSTS` | `4` | 每个 runner worker 最多同时运行的 Python 解释器数 |
| `PYTHON_WARM_HOSTS` | `1` | 每个 runner worker 预热的空闲解释器数（隐藏约 1 秒的冷启动） |

### 数据与备份

数据库和 `.jwt_secret` 在命名卷 `serpent-data`（容器内 `/app/server/data`）。备份：

```bash
docker compose stop
docker run --rm -v serpent_serpent-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/serpent-data-$(date +%Y%m%d).tgz -C /data .
docker compose start
```

不要删除这个卷：丢失 `.jwt_secret` 会让所有登录失效；丢失数据库会丢失全部账号、Agent、脚本与对局。

### 升级与回滚

```bash
# .env 中把 SERPENT_IMAGE 改成新版本（或保持 latest）
docker compose pull && docker compose up -d
```

数据库迁移在启动时自动执行，只会向前升级。回滚到旧版本前先恢复对应时间点的数据备份；新版本写过的数据库不能被旧版本打开。

### 反向代理

代理需要转发 WebSocket（Socket.IO 用于直播推送）。Nginx 示例：

```nginx
location / {
  proxy_pass http://127.0.0.1:8008;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### 资源与限制

- **单实例**：SQLite 与内存中的模拟队列不支持多副本；重启会把进行中的模拟标记为失败（已完成的对局不受影响）。
- **内存**：JS 脚本在 QuickJS 沙箱中运行，开销很小。每个 Python 参赛者独占一个解释器子进程，约 200MB；最坏占用约 `RUNNER_WORKERS × (PYTHON_MAX_HOSTS + PYTHON_WARM_HOSTS) × 200MB`，默认 4 个 worker 时约 4GB，**推荐 8GB 以上内存**。小机器可在 `.env` 中调低 `RUNNER_WORKERS` 或 `PYTHON_MAX_HOSTS`。
- 容器以非 root 用户 `node` 运行；`init: true` 让 tini 回收沙箱子进程并转发停止信号。

### Python 脚本的运行要求

Python 脚本运行在 Pyodide（WebAssembly 版 CPython）中，每个解释器再用 bubblewrap 放进独立的网络、进程、IPC 与文件系统命名空间，并叠加 Node 权限模型。这些隔离需要：

1. **容器**：`docker-compose.yml` 默认带了 `seccomp=unconfined`、`apparmor=unconfined`、`systempaths=unconfined`。Docker 默认的这三项限制会阻止容器内创建用户命名空间和挂载 `/proc`。容器本身仍是无 capability 的 `node` 用户。如果不需要 Python，可以删掉这三行：Python 脚本会被明确拒绝（`PYTHON_UNAVAILABLE`），JavaScript 不受影响。
2. **宿主机内核允许非特权用户命名空间**：
   - Ubuntu 23.10 及以后（含 24.04）默认限制非特权用户命名空间，即使容器设为 `apparmor=unconfined` 也会被拦住。需要在宿主机执行：

     ```bash
     echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-serpent-userns.conf
     sudo sysctl --system
     ```
   - 较老的 Debian 内核需要 `kernel.unprivileged_userns_clone=1`（Debian 11 及以后默认已开启）。
3. 部署后检查：`curl http://服务器:8008/api/health`，返回中 `python.available` 为 `true` 即可使用；为 `false` 时 `reason` 会说明缺少哪一项。

不用 Docker 直接部署在 Linux 上时，需要安装 `bubblewrap`（`apt-get install bubblewrap`）并满足第 2 条；macOS 使用系统自带的 `sandbox-exec`。

## 2. 从源码构建镜像

```bash
git clone https://github.com/DueGin/serpent.git && cd serpent
cp .env.example .env
docker compose up -d --build
```

国内网络在 `.env` 中设置：

```bash
NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
NPM_REGISTRY=https://registry.npmmirror.com
DEBIAN_MIRROR=mirrors.aliyun.com
```

## 3. 不用 Docker

需要 Node.js 22 和 pnpm 10。必须保留完整仓库目录：运行时会读取 `server/src/docs`、`examples/scripts` 和 `web/dist`。

```bash
pnpm install --frozen-lockfile
pnpm build
cd server && PORT=8008 node dist/index.js
```

## 4. 发版（GitHub Actions）

| 工作流 | 触发 | 内容 |
|---|---|---|
| `CI`（`.github/workflows/ci.yml`） | push 到 `master`、Pull Request | 服务端测试、两端类型检查、构建；构建镜像并启动容器做冒烟检查 |
| `Release`（`.github/workflows/release.yml`） | 推送 `vX.Y.Z` 标签 | 先跑完整 CI，再构建 `linux/amd64` + `linux/arm64` 镜像推送到 GHCR，最后创建 GitHub Release |

发布一个版本：

```bash
# 1. 三个 package.json 的 version 保持一致，标签必须等于 v + 版本号
pnpm -r exec npm pkg set version=0.2.0 && npm pkg set version=0.2.0
git commit -am "chore: release v0.2.0"
# 2. 打标签并推送
git tag v0.2.0
git push origin master v0.2.0
```

镜像标签：`0.2.0`、`0.2`、`latest`、`sha-<短提交号>`。在 Actions 页面手动运行 `Release` 默认只构建不推送，可用于演练。

首次发布后，GHCR 上的镜像包可能默认是私有的。若希望服务器匿名拉取，到 GitHub → Packages → `serpent` → Package settings 把可见性改为 Public；否则在服务器上先 `docker login ghcr.io`（使用具有 `read:packages` 权限的令牌）。
