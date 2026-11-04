# 影视资料与图片永久归档实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留 PostgreSQL 元数据，使图片永久落盘、浏览脱离源站，并补存已有图片。

**Architecture:** 图片下载模块负责验证、内容去重及原子写文件，归档器负责已有影片检查与可恢复重试。Worker 持久化归档状态和资源历史；HTTP 与前端仅暴露本地图片。后台补存与 HTTP 启动分离。

**Tech Stack:** Node.js 22.12+、TypeScript、React、PostgreSQL、node:test，无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-04-local-media-archive-design.md`

## Global Constraints

- PostgreSQL 保留现有连接；图片二进制仅保存到部署机器 `data/posters` 或 `POSTER_DIR`。
- 图片最多 4 MiB，内容 SHA-256 命名；不得回退到远程图片。
- 不保存视频；元数据和检测结果使用现有持久化流程。
- 不提交凭据、实际资料或海报；提交信息中文；代码修改后构建并重启验证。

## Review Focus

- 旧数据库本地图片路径但文件丢失，需恢复或明确缺失，绝不能显示伪成功。
- 下载失败或旧缓存缺失不丢已保存的元数据或可用本地图片。
- 取消下载/异常响应不留下被视为成功的半文件。
- 前端列表和详情不请求远程海报，未点击播放不请求视频。
- 启动只保存变化记录，归档失败可继续运行并持久重试。

### Task 1: 图片文件归档

**Files:** `server/posters.ts`, `tests/posters.test.ts`

**Interfaces:** `archivePoster(url, referer, settings, signal?) => Promise<PosterFile>`；`inspectPoster(path) => Promise<PosterFile|null>`；`PosterFile {path,sha256,mime,bytes,downloadedAt}`；保留 `cachePoster` 字符串兼容封装。

- [ ] 先写临时 HTTP、目录测试：成功落盘、上游关闭仍可读、相同内容去重、假图片/空/过大拒绝、缺失/非法路径、取消，运行确认失败。
- [ ] 实现内容识别、有界读取、内容哈希、原子落盘和缓存检查；失败抛错而非返回上游 URL。
- [ ] 运行 `node --import tsx --test tests/posters.test.ts`，预期全部通过。

### Task 2: 持久化初始化

**Files:** `server/store.ts`, `tests/store.test.ts`

**Interfaces:** PostgreSQL 加载原始记录建立 `persisted` 快照，再规范化来源和未完成任务。

- [ ] 隔离 pg.Pool 边界测试不变记录不 UPSERT、来源补全与 queued/running 中断仍保存；先运行确认失败。
- [ ] 实现原始记录快照，运行 `node --import tsx --test tests/store.test.ts`，预期全部通过。

### Task 3: 归档队列、历史与 API

**Files:** `shared/types.ts`, `server/poster-archive.ts`, `server/catalog.ts`, `server/worker.ts`, `server/app.ts`, `tests/poster-archive.test.ts`, `tests/catalog.test.ts`, `tests/api.test.ts`

**Interfaces:** `PosterArchiver` 提供 `archiveMovie`、`start`、`stop`、`retry`、`summary`；`Movie.posterArchive` 记录图片状态；资源 `urlHistory` 与 `probeHistory` 记录已取得内容；GET `/api/archive/posters` 与 POST `/api/archive/posters/retry`。

- [ ] 测试远程海报补存、失败持久重试、本地缺失、旧详情恢复、终止、历史不丢；运行确认失败。
- [ ] 实现限速单队列，启动后异步补存、采集完成尝试归档、来源缺失时仅恢复海报而不重采视频。
- [ ] API 返回仅本地图片，缺失文件 404；历史字段保留过往地址与检测，运行相关测试全部通过。

### Task 4: 页面与交付

**Files:** `shared/poster-path.ts`, `tests/poster-path.test.ts`, `web/App.tsx`, `web/styles.css`, `README.md`, `DOCKER.md`

**Interfaces:** `localPosterPath(value)` 只接受本站哈希图片路径；设置页消费 Task 3 归档统计接口。

- [ ] 路径测试先失败，再实现仅本地显示与缺失状态；播放器明确点击播放后才加载。
- [ ] 设置页展示图片统计并允许手动重试；文档说明文件永久保存、失败处理、备份及迁移。
- [ ] 完整 `npm test`、`npm run typecheck`、`npm run build`；独立审查修正后以中文提交。
- [ ] 重启实际服务，核对 PostgreSQL、页面、静态文件与后台图片统计，汇报补存与无法恢复数量。
