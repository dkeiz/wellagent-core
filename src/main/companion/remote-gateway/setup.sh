#!/usr/bin/env sh
set -eu

APP_DIR="${REMOTE_GATEWAY_DIR:-$HOME/localagent-remote-gateway}"
PORT="${REMOTE_GATEWAY_PORT:-8791}"

mkdir -p "$APP_DIR"
cp -R . "$APP_DIR"

cat > "$APP_DIR/localagent-remote-gateway.env" <<ENV
REMOTE_GATEWAY_HOST=0.0.0.0
REMOTE_GATEWAY_PORT=$PORT
REMOTE_GATEWAY_SECRET=${REMOTE_GATEWAY_SECRET:-change-me-before-start}
ENV

cat > "$APP_DIR/start.sh" <<'SH'
#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/localagent-remote-gateway.env"
exec node "$(dirname "$0")/server.js"
SH
chmod +x "$APP_DIR/start.sh"

echo "Installed to $APP_DIR"
echo "Edit $APP_DIR/localagent-remote-gateway.env, then run: $APP_DIR/start.sh"
