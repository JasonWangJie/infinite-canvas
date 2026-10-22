# Infinite Canvas Documentation Index

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
