#!/bin/sh
set -eu
# Only the fixed persistent-data mount is prepared as root. The app runs as node.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown node:node /data
  chmod 700 /data
  exec gosu node "$@"
fi
exec "$@"
