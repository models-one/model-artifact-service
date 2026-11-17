FROM oven/bun:1.3.12 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY assets ./assets
RUN bun run build

FROM oven/bun:1.3.12-slim
WORKDIR /app
COPY package.json bun.lock ./
COPY --from=build /app/node_modules ./node_modules
RUN mkdir /app/data && chown bun:bun /app/data
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/assets ./assets
USER bun
ENV CONFIG_PATH=/app/config.json
EXPOSE 3000
CMD ["bun", "dist/index.js"]
