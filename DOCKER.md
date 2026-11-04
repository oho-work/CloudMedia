# Docker 部署

提供 Node.js 24 多阶段镜像和 Docker Compose 配置。镜像构建前端及服务端，运行时使用普通用户；影视资料、任务、设置和海报二进制统一保存在 PostgreSQL，应用容器重建后继续保留。

所有运行模式均禁止将图片写入项目或容器目录。未配置数据库时，开发预览图片只暂存在内存，重启后重新获取；`POSTER_DIR` 不再生效。

图片自动保存在 PostgreSQL 的 `poster_files` 表，页面通过 `/media/posters/...` 接口从数据库读取，无需在设置页单独配置图片归档。应用不创建本地图片、JSON 数据或备份文件，不需要应用数据卷。页面不回退源站图片，缺失海报由后台自动补存与重试。

需要 Docker Engine 或 Docker Desktop（Linux 容器模式）以及 Docker Compose v2。以下命令均在项目根目录运行。示例使用 PowerShell；Linux/macOS 将 `Copy-Item` 换成 `cp`。

尚未获取源码时，先按 [README 中的步骤](README.md#环境与启动) 克隆 `git@github.com:oho-work/CloudMedia.git` 的 `dev` 分支。镜像仅包含构建后的应用，不包含个人 `.env`、本地采集数据或海报；已有部署的数据迁移步骤见下文。

| 文件 | 用途 |
| --- | --- |
| `Dockerfile` | 构建前端和服务端，启动生产服务。 |
| `.dockerignore` | 排除本地凭据、数据、依赖和 Git 记录。 |
| `compose.yaml` | 运行应用，连接已有 PostgreSQL。 |
| `compose.postgres.yaml` | 可选配置，在同一项目内运行 PostgreSQL 16。 |
| `.env.docker.example` | Docker 专用配置示例，复制为 `.env.docker` 后填写。 |

## 连接现有 PostgreSQL

适合继续使用本项目已经采集的数据。先准备配置：

```powershell
Copy-Item .env.docker.example .env.docker
```

编辑 `.env.docker`，填入实际连接和随机访问令牌。例如：

```dotenv
DATABASE_URL='postgresql://app_user:URL_ENCODED_PASSWORD@host.docker.internal:5432/postgres'
PGSCHEMA=cloudmedia
APP_AUTH_TOKEN=YOUR_LONG_RANDOM_TOKEN
BIND_ADDRESS=127.0.0.1
HTTP_PORT=3001
```

如果数据库在另一台机器，使用那台机器可访问的地址；数据库在 Docker 宿主机时使用 `host.docker.internal`。容器内的 `127.0.0.1` 指向容器自身。Linux 的宿主机映射已在 Compose 中配置，数据库仍需允许来自 Docker 网络的连接。

连接密码需进行 URL 编码，例如 `@` 编为 `%40`、`#` 编为 `%23`。含 `$` 的值在环境文件中用单引号包围，防止 Compose 插值；单引号不会成为实际值的一部分。`.env.docker` 与本机启动使用的 `.env` 独立，启动命令必须带 `--env-file .env.docker`。填写真实令牌后，首次打开网页输入该令牌。

先检查配置和构建镜像，这两步可以在本机继续采集时执行：

```powershell
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker build
```

实际切换到 Docker 前，等待或取消当前采集，并停止原来的 CloudMedia 服务，释放端口和数据库 schema 锁。同一个 schema 只允许一个实例运行；仅更换 HTTP 端口仍无法同时访问同一个 schema。

连接相同数据库和 schema 时，影片、播放地址、设置及已经入库的图片直接继续使用。旧版部署中的 `data/posters` 不再作为图片读取来源；升级前应将仍需保留的图片直接导入 `poster_files` 并核验，不要通过复制到容器磁盘代替入库。缺失的数据库图片会按已保存原图地址或详情页重新归档。

```powershell
docker compose --env-file .env.docker up -d
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs --tail 100 -f app
```

打开 [http://127.0.0.1:3001](http://127.0.0.1:3001)。如修改了 `HTTP_PORT`，使用对应端口。按 `Ctrl+C` 退出日志查看，容器继续运行。

## 同时部署 PostgreSQL

新部署且没有现成数据库时，可使用附带的 PostgreSQL 服务。仍先复制 `.env.docker.example` 为 `.env.docker`，将其中数据库配置改为：

```dotenv
POSTGRES_DB=cloudmedia
POSTGRES_USER=cloudmedia
POSTGRES_PASSWORD=YOUR_STRONG_DATABASE_PASSWORD
DATABASE_URL='postgresql://cloudmedia:URL_ENCODED_DATABASE_PASSWORD@postgres:5432/cloudmedia'
PGSCHEMA=cloudmedia
APP_AUTH_TOKEN=YOUR_LONG_RANDOM_TOKEN
BIND_ADDRESS=127.0.0.1
HTTP_PORT=3001
```

`POSTGRES_PASSWORD` 填原始密码，连接 URL 填同一个密码的 URL 编码形式。必须同时填写 `DATABASE_URL`；`postgres` 是 Compose 内部服务名，数据库端口不会发布到宿主机。

```powershell
docker compose --env-file .env.docker -f compose.yaml -f compose.postgres.yaml config --quiet
docker compose --env-file .env.docker -f compose.yaml -f compose.postgres.yaml up -d --build
docker compose --env-file .env.docker -f compose.yaml -f compose.postgres.yaml ps
```

应用会等待数据库健康后启动。后续的 `logs`、`stop`、`down`、`exec`、`cp` 等命令也要保留相同的两个 `-f` 参数。

这是一个新的数据库，不会自动迁移原外部数据库或 JSON 文件中的数据。`POSTGRES_*` 变量只在数据库卷首次初始化时生效；已有数据卷时修改环境文件不会重置账号或密码。更换 PostgreSQL 大版本前应按其升级流程操作。

## 持久化与更新

默认 Compose 项目名为 `cloudmedia`，应用服务不挂载任何数据卷：

| 持久卷 | 保存内容 |
| --- | --- |
| `cloudmedia_postgres-data` | 可选 PostgreSQL 服务的数据目录。 |

应用数据保存在 PostgreSQL 的 `PGSCHEMA` 中，默认 `cloudmedia`，包含资料用的五张 JSONB 表及图片用的 `poster_files` 表。使用外部 PostgreSQL 时不会创建应用数据卷；可选的 `postgres-data` 是数据库服务自身的数据盘。Compose 配置要求提供数据库连接，不会意外进入 JSON 预览模式，数据库故障也不会回退磁盘。容器内必须监听 `0.0.0.0`，因此即使只向宿主机回环地址发布端口，也需要填写 `APP_AUTH_TOKEN`。

更新代码后，在采集结束或取消后执行：

```powershell
docker compose --env-file .env.docker up -d --build
```

使用附带数据库时，仍需加上两个 `-f` 参数。更新会重建应用容器并中断正在进行的采集，已保存的数据保留。容器收到停止信号后会尝试保存检查点；重启不会自动续接某个历史任务，请在“采集源”重新选择原日期区间。未过期的播放地址缓存会复用。每日定时采集需要容器持续运行，`restart: unless-stopped` 会在 Docker 服务恢复后重启容器；手动停止的容器需要手动启动。

应用不自动创建本地备份。迁移数据时按数据库管理员的流程处理完整 schema，包含 `poster_files`，无需迁移应用机器的图片目录。单独妥善保存 `.env.docker`。`docker compose down` 会删除容器及项目网络，保留数据库持久卷；**不要对需要保留数据的附带数据库执行 `down -v`**，它会删除 PostgreSQL 数据卷。

## 采集与访问

进入“采集源”，555 影视选择“立即采集”，提供今天、全部、区间三种范围，默认今天；区间显示开始和结束日期选择器，编辑源无需重复设置范围。并发数代表同时处理的影片数，涵盖资料、播放地址和速度/分辨率检测，完成一部即补入下一部并按需翻页。所有范围均不限制影片、列表页和播放页数量。长任务可以在“任务记录”查看进度、错误或取消，终态记录可以删除且不影响影片、资源和图片。源站的更新时间是当前最后更新时间，无法还原已经被后来更新覆盖的历史版本。

每日运行时间可设置多条，统一使用北京时间；应用通过 NTP 校时，不读取容器时区作为调度依据。需允许容器访问 `ntp.aliyun.com`、`ntp.tencent.com` 或 `time.cloudflare.com` 的 UDP 123 端口。未校时或时间已过期时暂停新采集，详情见 [README 的定时说明](README.md#定时更新与资源检测)。

需要局域网访问时，将 `BIND_ADDRESS` 改为宿主机的局域网 IP 或 `0.0.0.0`，重新创建容器，并通过宿主机 IP 访问。反向代理转发时应保留原始 `Host`，使浏览器请求的 `Origin` 与应用收到的主机一致。时区和定时采集时间在“系统设置”中修改，容器宿主机时区不影响默认的 `Asia/Shanghai` 日期判断。

## 排查问题

- **缺少变量**：`config --quiet` 会指出缺少 `DATABASE_URL`、`APP_AUTH_TOKEN` 或附带数据库的 `POSTGRES_PASSWORD`；填写 `.env.docker` 并确认命令包含 `--env-file`。
- **端口占用**：先停止原服务，或修改 `HTTP_PORT`。使用同一数据库 schema 时仍需停止旧实例。
- **数据库拒绝连接**：检查容器可达的地址、PostgreSQL 监听和访问规则、大小写敏感的用户名及密码 URL 编码；连接失败会停止启动，不会切换到文件模式。
- **schema 已有实例**：确认原本机或其他容器实例已经退出；不要通过更换 schema 来误以为空库是数据丢失。
- **海报写入失败**：检查 PostgreSQL 连接、`poster_files` 权限和数据库容量；不会改写本地文件作为回退。
- **重建后海报丢失**：检查连接的数据库和 schema 是否一致，以及 `poster_files` 是否完整；旧图片目录不参与数据库模式读取。
- **采集因访问受限停止**：在任务记录检查 401/403、验证码或超时错误；已保存数据保留，访问恢复后可重新采集原区间。

健康检查为 `GET /api/health`，不需要令牌。`docker compose ps` 可查看容器健康状态；健康检查失败本身不会触发 Docker 自动重启，需结合日志检查数据库及服务状态。
