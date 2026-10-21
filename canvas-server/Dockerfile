FROM oven/bun:1.4.0

WORKDIR /app
COPY canvas-server/package.json canvas-server/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY canvas-server/src ./src
COPY LICENSE /licenses/infinite-canvas-LICENSE
RUN mkdir -p /data && chown -R bun:bun /app /data

USER bun
ENV DATA_DIR=/data PORT=3001 NODE_ENV=production
EXPOSE 3001
CMD ["bun", "src/index.ts"]
