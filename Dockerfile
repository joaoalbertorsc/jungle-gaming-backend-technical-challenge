# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.4 AS base
WORKDIR /app

# Production dependencies only, resolved from the committed lockfile.
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Bun runs TypeScript directly, so the runtime image ships the sources without a build step.
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json bunfig.toml ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
