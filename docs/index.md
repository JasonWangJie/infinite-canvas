# Infinite Canvas Documentation Index

## 二开服务器部署

本节适用于本仓库二开的 **无限画布（Infinite Canvas）New API 受管版**。正式访问地址为 `https://canvas.aiimg.lol`，服务器 `40.160.139.185` 上的 `4000` 端口由 Docker Compose 发布。

| 项目 | 实际配置 |
| --- | --- |
| Compose 项目 | `infinite-canvas` |
| 服务器部署配置 | `/etc/infinite-canvas/compose.yml`，同目录下有 `nginx.conf.template` 和 `canvas.env` |
| 前端 | 服务 `app`，容器 `infinite-canvas-app-1`，宿主机 `4000` 映射到容器 `3000/tcp` |
| 前端静态文件 | 前端镜像内的 `/usr/share/nginx/html/` |
| Canvas BFF | 服务 `canvas-server`，容器 `infinite-canvas-canvas-server-1`，容器内端口 `3001/tcp` |
| 发布与备份目录 | `/opt/infinite-canvas-releases/` 和 `/opt/infinite-canvas-backups/`，按发布批次归档 |

已核对的前端镜像为 `infinite-canvas:20261109-seedream-filter-9978163`，对应发布源码位于 `/opt/infinite-canvas-releases/20261109-seedream-filter-9978163/source/`，本次发布的回退脚本在 `/opt/infinite-canvas-backups/20261109-seedream-filter-9978163/rollback.sh`。发布版本会更新，排查前在服务器上运行以下命令确认实际运行的容器和镜像。

```sh
docker compose -f /etc/infinite-canvas/compose.yml ps
docker inspect --format '{{.Config.Image}}' infinite-canvas-app-1 infinite-canvas-canvas-server-1
```

构建前端镜像前，确保发布包中的 `web/docker-entrypoint.sh` 使用 LF 换行。切换镜像前，用实际部署模板在临时容器中执行 `nginx -t` 检查启动脚本和配置。

## Overview

- [Quick Start](/docs/overview/quick-start)
- [Features](/docs/overview/features)
- [Deploy on Render](/docs/overview/render)
- [Docker Deployment](/docs/overview/docker)
- [Third-party Prompt Sources](/docs/overview/third-party-prompt-repositories)

## Canvas Guide

- [Canvas Node Guide](/docs/canvas/canvas-node-manual)
- [Canvas Shortcuts](/docs/canvas/canvas-shortcuts)

## Development and Data

- [Local Development](/docs/development/local-development)
- [Canvas Data Structure](/docs/development/canvas-data-structure)
- [How the Local Codex Connection Works (upstream standalone edition)](/docs/development/local-codex-canvas)

## Business

- [Open-source License](/docs/business/license)
- [Business Cooperation](/docs/business/business)

## Support and Security

- [Report a Vulnerability](/docs/support/security)
- [Sponsor the Project](/docs/support/sponsor)

## Project Progress

- [Changelog](/docs/progress/changelog)
- [Pending Tests](/docs/progress/pending-test)
- [TODO](/docs/progress/todo)

## Notes

- This branch is the New API managed edition. Read the Quick Start and Local Development pages before running it: the frontend requires Canvas BFF and a New API instance with Canvas authorization integration.
- Browser requests use the same-origin `/auth` and `/api` routes. Credentials remain in Canvas BFF; model and channel authorization comes from New API.
- Projects, assets, configuration, generation records and media live in browser IndexedDB, partitioned by the authorized user's `subject`. Logout retains saved data; this is not cloud synchronization.
- WebDAV, arbitrary AI hosts, browser API keys, local proxies, local Agent connections, model scripts and remote plugin installation are disabled. Their remaining documentation describes upstream standalone features.
- Use `docker-compose.managed.yml` for the managed deployment topology. Docker static-resource paths, real HTTPS authorization and production upgrade/rollback still require acceptance testing.
