#!/bin/sh
# A key bind-mounted from Windows arrives world-readable and OpenSSH refuses it.
# Copy it to a private tmpfs-like location with 0600 and point the server there.
set -eu
if [ -f "${ODOO_SH_SSH_KEY_PATH:-}" ]; then
  umask 077
  cp "$ODOO_SH_SSH_KEY_PATH" /tmp/odoo_sh_key
  chmod 600 /tmp/odoo_sh_key
  export ODOO_SH_SSH_KEY_PATH=/tmp/odoo_sh_key
else
  echo "odoo-sh-mcp: SSH key not found at '${ODOO_SH_SSH_KEY_PATH:-}' (mount it with -v <key>:/keys/id:ro)" >&2
  exit 1
fi
exec node /app/dist/index.js "$@"
