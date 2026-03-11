FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Create data directory for SQLite persistence
RUN mkdir -p /app/data

RUN groupadd -g 1001 botuser && \
    useradd -u 1001 -g botuser -s /bin/sh botuser && \
    chown -R botuser:botuser /app/data

USER botuser

ENV DOTENV_CONFIG_QUIET=true

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

CMD ["node", "dist/index.js"]
