# 播放检查与影视库筛选实施计划

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 采集支持 100 并发且不检测视频，仅播放时检测当前集全部线路，影视库分类筛选并每页 12 部。

**Architecture:** 后端保留受控检测器并将触发点从采集移到播放动作；同集键在 shared 模块供前后端使用。影视库查询在分页前组合筛选，React 提供分类页签和筛选面板。

**Tech Stack:** TypeScript / Express / React / PostgreSQL / node:test。

**Spec:** docs/superpowers/specs/2026-11-05-playback-check-library-design.md

## Global Constraints

- 在 dev 修改；中文提交；服务代码变更后重启。
- 采集并发 1–100，默认 1；旧自动检测配置不能重新启动采集检测。
- 查看详情不检测，点击播放立刻后台检测同集各线路且播放器独立启动。
- 每页 12 部；筛选条件更换回第一页；图片仍通过本站读取。

## Review Focus

- 同集不同标签及季/上中下不能误匹配。
- 切集和关闭弹窗时，旧请求不能覆盖当前显示或重复启动视频。
- 个别线路失效时其他线路仍保存测量。
- 旧配置 probeEnabled=true 时采集仍无视频测量。
- 空结果、无片源、多条件和超出末页时分页仍正确。

## Task 1：后端采集与播放检查

- [x] 在 episode / API / Worker 测试中复现规范化、100 边界、采集不测量和同集全部线路检测。
- [x] 运行新增测试确认 RED。
- [x] 修改 worker.ts、collector.ts、defaults.ts、validation.ts，新增 shared/episode.ts；app.ts 底部暴露 check-playback、移除旧 probe 接口、refresh 改为只解析。
- [x] 运行相关测试，并将原自动采集检测测试改为新契约。

## Task 2：影视库查询及显示

- [x] 新建查询 API 测试覆盖 12 条默认分页、多条件组合、完整 facets、非法参数、短剧和空结果。
- [x] 确认 RED，增加 server/library.ts 并替换 app.ts 列表路由。
- [x] 更新 App.tsx 的 Library 与局部样式：分类子标题、筛选、状态卡片、12 条分页及清除条件。
- [x] 运行查询测试与页面核对。

## Task 3：播放动作及集线路显示

- [x] 验证播放操作发起检查而详情加载不检查，播放不等待检查响应。
- [x] 更新 App.tsx 的 Player/MovieModal：点击播放检查同集，线路表显示当前检测状态和结果，切集竞态受保护；移除独立检测入口。
- [x] 前端并发边界改为 100，设置页改为播放检查参数，采集任务卡去掉自动检测文案。
- [x] 为短剧分类补回归用例，更新 README。

## Task 4：集成与交付

- [x] 独立审查改动、运行全套 npm test、npm run build 和 git diff --check。
- [x] 重启服务、核对数据库/页面/新列表接口；不凭验证发起真实采集或视频测量。
- [x] 中文提交，报告行为、验证与提交号。

## 验证记录

- 全套 `npm test`：288 项通过，0 失败；`npm run build` 成功（保留既有 HLS 包体大小提示）。
- 本地内存样本验证分类组合、12/5 分页、移动端两列；详情和待播切集无视频请求，播放后仅当前集全部线路检测，播放器先启动加载。
- 审查修复保存失败被吞、旧轮询覆盖刷新地址、刷新旧线路重启当前线路的问题；保存错误返回 500 且等待其他线路结束。
- 服务重启后 PostgreSQL 健康、北京时间已同步、旧自动检测配置归为 false，实际页面显示 12 张卡片。
- 重启前运行中的 2026-11-05 采集已保留结果，重启后按相同日期范围恢复，沿用原有 20 并发设置；新任务无视频测量。
