#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="betterdb-valkey"
VOLUME_NAME="betterdb-valkey-data"
PORT="${1:-6379}"
ACTION="${2:-start}"

# Check if Docker is available
if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker is not installed."
  echo "Install Docker: https://docs.docker.com/get-docker/"
  exit 1
fi

case "$ACTION" in
  start)
    # Check if container already exists
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "Valkey container '${CONTAINER_NAME}' is already running on port ${PORT}."
        exit 0
      else
        echo "Starting existing Valkey container '${CONTAINER_NAME}'..."
        docker start "${CONTAINER_NAME}"
        exit 0
      fi
    fi

    # Try valkey-search image first (includes Search module)
    echo "Pulling valkey/valkey-search:8..."
    if docker pull valkey/valkey-search:8 2>/dev/null; then
      IMAGE="valkey/valkey-search:8"
    else
      echo "valkey-search image not available, falling back to valkey/valkey:8-alpine..."
      docker pull valkey/valkey:8-alpine
      IMAGE="valkey/valkey:8-alpine"
    fi

    echo "Starting Valkey container on port ${PORT}..."
    if ! docker run -d \
      --name "${CONTAINER_NAME}" \
      -p "${PORT}:6379" \
      -v "${VOLUME_NAME}:/data" \
      "${IMAGE}" \
      valkey-server --save 60 1 2>/dev/null; then
      # Port likely in use — retry on 16379
      PORT=16379
      echo "Port conflict. Retrying on port ${PORT}..."
      docker run -d \
        --name "${CONTAINER_NAME}" \
        -p "${PORT}:6379" \
        -v "${VOLUME_NAME}:/data" \
        "${IMAGE}" \
        valkey-server --save 60 1
    fi

    # Wait for startup
    sleep 2

    # Verify
    if docker exec "${CONTAINER_NAME}" valkey-cli ping | grep -q PONG; then
      echo "Valkey is running on redis://localhost:${PORT}"
    else
      echo "WARNING: Container started but ping failed. Check: docker logs ${CONTAINER_NAME}"
      exit 1
    fi
    ;;

  stop)
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      docker stop "${CONTAINER_NAME}"
      echo "Valkey container stopped."
    else
      echo "Valkey container is not running."
    fi
    ;;

  status)
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      RUNNING_PORT=$(docker port "${CONTAINER_NAME}" 6379 2>/dev/null | head -1 | cut -d: -f2)
      echo "Valkey container '${CONTAINER_NAME}' is running on port ${RUNNING_PORT:-unknown}."
    elif docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "Valkey container '${CONTAINER_NAME}' exists but is stopped."
    else
      echo "No Valkey container found."
    fi
    ;;

  remove)
    docker stop "${CONTAINER_NAME}" 2>/dev/null || true
    docker rm "${CONTAINER_NAME}" 2>/dev/null || true
    echo "Valkey container removed. Volume '${VOLUME_NAME}' preserved."
    echo "To remove data: docker volume rm ${VOLUME_NAME}"
    ;;

  *)
    echo "Usage: docker-valkey.sh [port] [start|stop|status|remove]"
    exit 1
    ;;
esac
