#!/usr/bin/env bash
# Runs the integration tests against a throwaway, SSL-enabled PostgreSQL in Docker.
#
# If DB_HOST is already set, uses that database instead. The SSL tests are then
# skipped, as they rely on the certificates generated here.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${DB_HOST:-}" ]]; then
  container="recurrent-queries-test-$$"
  port="${TEST_DB_PORT:-54329}"
  certs="$(mktemp -d)"
  trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$certs"' EXIT

  # A throwaway CA, and a server certificate it signs, valid only for "localhost".
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=Test CA" \
    -keyout "$certs/ca.key" -out "$certs/ca.crt" 2>/dev/null
  mkdir "$certs/server"
  openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
    -keyout "$certs/server/server.key" -out "$certs/server.csr" 2>/dev/null
  printf 'subjectAltName=DNS:localhost\n' > "$certs/server.ext"
  openssl x509 -req -days 1 -in "$certs/server.csr" \
    -CA "$certs/ca.crt" -CAkey "$certs/ca.key" -CAcreateserial \
    -extfile "$certs/server.ext" -out "$certs/server/server.crt" 2>/dev/null

  # The server files are copied in with `docker cp` rather than bind-mounted,
  # so this works whatever Docker's file sharing settings are. PostgreSQL
  # refuses a key file that others can read, or that it doesn't own, so they
  # are then installed with the right owner and mode before it starts.
  docker create --rm --name "$container" \
    -e POSTGRES_PASSWORD=secret \
    -p "127.0.0.1:${port}:5432" \
    --entrypoint sh \
    postgres:16-alpine -c '
      install -d -o postgres -m 700 /ssl &&
      install -o postgres -m 600 /certs/server.key /ssl/server.key &&
      install -o postgres -m 644 /certs/server.crt /ssl/server.crt &&
      exec docker-entrypoint.sh postgres \
        -c ssl=on -c ssl_cert_file=/ssl/server.crt -c ssl_key_file=/ssl/server.key
    ' >/dev/null
  docker cp "$certs/server" "$container:/certs" >/dev/null
  docker start "$container" >/dev/null

  echo "Waiting for PostgreSQL on port ${port}..."
  ready=
  for _ in $(seq 1 30); do
    if docker exec "$container" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ -z "$ready" ]]; then
    echo "PostgreSQL did not become ready. Container logs:" >&2
    docker logs "$container" >&2 2>&1 || echo "(container already exited)" >&2
    exit 1
  fi

  export DB_HOST=localhost DB_PORT="$port" DB_NAME=postgres DB_USER=postgres DB_PASSWORD=secret
  # Trust the test CA, as Lambda does with /var/runtime/ca-cert.pem for RDS.
  export NODE_EXTRA_CA_CERTS="$certs/ca.crt"
  export TEST_SSL=1
fi

# The shell expands the pattern: Node 20 does not support globs in --test.
node --test --test-timeout=30000 test/*.test.js
