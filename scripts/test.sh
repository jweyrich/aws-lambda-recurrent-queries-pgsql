#!/usr/bin/env bash
# Runs the integration tests against a throwaway PostgreSQL in Docker.
# If DB_HOST is already set (e.g. in CI), uses that database instead.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${DB_HOST:-}" ]]; then
  container="recurrent-queries-test-$$"
  port="${TEST_DB_PORT:-54329}"

  docker run --rm -d --name "$container" \
    -e POSTGRES_PASSWORD=secret \
    -p "127.0.0.1:${port}:5432" \
    postgres:16-alpine >/dev/null
  trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT

  echo "Waiting for PostgreSQL on port ${port}..."
  for _ in $(seq 1 30); do
    docker exec "$container" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$container" pg_isready -U postgres -h 127.0.0.1 >/dev/null

  export DB_HOST=127.0.0.1 DB_PORT="$port" DB_NAME=postgres DB_USER=postgres DB_PASSWORD=secret
fi

node --test --test-timeout=30000 "test/**/*.test.js"
