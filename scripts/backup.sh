#!/usr/bin/env bash
# Ежедневная копия базы и фото eda+ на сервере. Хранит последние 14 копий базы.
# Запуск: ./scripts/backup.sh   (из cron — см. DEPLOY-ORACLE.md)
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/eda-backups}"
KEEP="${KEEP:-14}"
STAMP="$(date +%Y-%m-%d_%H%M)"
NAME="eda-$STAMP.db"

cd "$PROJECT_DIR"
mkdir -p "$BACKUP_DIR"

# 1. Согласованная копия базы внутри контейнера, затем перенос на диск сервера.
docker compose exec -T eda node server/backup.js "data/backups/$NAME"
docker compose cp "eda:/app/data/backups/$NAME" "$BACKUP_DIR/$NAME"
docker compose exec -T eda rm -f "data/backups/$NAME"
gzip -f "$BACKUP_DIR/$NAME"

# 2. Фото блюд: файлы не меняются после загрузки, поэтому храним одну актуальную копию папки.
rm -rf "$BACKUP_DIR/uploads"
docker compose cp eda:/app/data/uploads "$BACKUP_DIR/uploads"

# 3. Удаляем старые копии базы, оставляя последние $KEEP.
ls -1t "$BACKUP_DIR"/eda-*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "$(date '+%F %T') готово: $BACKUP_DIR/$NAME.gz"
