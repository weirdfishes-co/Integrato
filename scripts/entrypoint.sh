#!/bin/sh
# Railway (and plain `docker run -v`) mounts the volume at runtime, owned by
# root. That mount lands on top of /data and hides the ownership set during the
# build, so the unprivileged user cannot create the database file and
# better-sqlite3 fails with SQLITE_CANTOPEN.
#
# The container therefore starts as root, takes ownership of the volume, and
# immediately drops to the `node` user for the server itself.
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ -d "$DATA_DIR" ] && [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
  echo "entrypoint: taking ownership of $DATA_DIR" >&2
  chown -R node:node "$DATA_DIR"
fi

exec setpriv --reuid=node --regid=node --init-groups "$@"
