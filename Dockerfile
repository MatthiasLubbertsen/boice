# syntax=docker/dockerfile:1

# 1. Frontend
FROM node:22-alpine AS web
RUN corepack enable
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# 2. Backend (pure Go, no CGO: the SQLite driver is modernc.org/sqlite)
FROM golang:1.27-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go test ./... && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /boice .

# 3. Runtime: one static binary, CA certificates for the HTTPS calls, non-root user
FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 boice && mkdir /data && chown boice /data
COPY --from=server /boice /usr/local/bin/boice
USER boice
ENV DATA_DIR=/data ADDR=:8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["boice"]
