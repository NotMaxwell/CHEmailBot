# The web server only.
#
# Contact-form assist is deliberately NOT in here: it drives a HEADED browser
# you read and click Submit in, which a container cannot show you. Keep running
# it on the host with `bun run form:assist <id>`.

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Playwright belongs to the form-assist CLI, not the server. Without this its
# postinstall can pull ~150MB of browsers into an image that never opens one.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN bun install --frozen-lockfile

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# config.ts reads the version from package.json; db.ts reads data/schema.sql.
COPY package.json ./
COPY data/schema.sql ./data/schema.sql
COPY src ./src

# Inside the container the app must listen on all interfaces to be reachable at
# all. compose publishes it to 127.0.0.1 on the host, so it still is not on
# your network -- check the ports line there before changing it.
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["bun", "src/index.ts"]
