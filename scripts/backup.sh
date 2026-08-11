#!/usr/bin/env sh
set -eu

echo "scripts/backup.sh has been retired." >&2
echo "It produced an unsigned, unencrypted, non-versioned artifact that cannot be treated as a verified server backup." >&2
echo "Use the unified offline backup runner when it is delivered; do not use this script for new backups." >&2
exit 2
