#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: scripts/backup.sh /absolute/backup-directory" >&2
  exit 2
fi

backup_dir=$1
case "$backup_dir" in
  /*) ;;
  *) echo "Backup directory must be an absolute path" >&2; exit 2 ;;
esac

mkdir -p "$backup_dir"
backup_dir=$(cd "$backup_dir" && pwd -P)
test -n "$backup_dir"
if [ -n "$(find "$backup_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "Backup directory must be empty: $backup_dir" >&2
  exit 2
fi

restart_server=false
cleanup() {
  if [ "$restart_server" = true ]; then
    docker compose start server >/dev/null
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if docker compose ps --status running --services | grep -qx server; then
  restart_server=true
  docker compose stop server >/dev/null
fi

docker compose exec -T postgres pg_dump -U notegen -d notegen --format=custom > "$backup_dir/database.dump"
docker compose cp server:/var/lib/note-gen-server/blobs "$backup_dir/blobs"
date -u +%Y-%m-%dT%H:%M:%SZ > "$backup_dir/created-at.txt"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$backup_dir" && sha256sum database.dump > SHA256SUMS)
else
  (cd "$backup_dir" && shasum -a 256 database.dump > SHA256SUMS)
fi

if [ "$restart_server" = true ]; then
  docker compose start server >/dev/null
  restart_server=false
fi

echo "Backup written to $backup_dir"
