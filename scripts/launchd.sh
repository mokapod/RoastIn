#!/bin/bash
# Install and manage RoastIn's per-user launchd service.
set -euo pipefail

LABEL="com.mokapod.roastin"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
SERVICE="${DOMAIN}/${LABEL}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
PYTHON="${APP_DIR}/.venv/bin/python"
SERVER="${APP_DIR}/server.py"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/RoastIn"
STDOUT_LOG="${LOG_DIR}/stdout.log"
STDERR_LOG="${LOG_DIR}/stderr.log"
PORT=""

load_port() {
  [[ -x "${PYTHON}" ]] || fail "missing ${PYTHON}; create the venv and install requirements first"
  PORT="$(cd "${APP_DIR}" && "${PYTHON}" -c 'from roastin.config import HTTP_PORT; print(HTTP_PORT)')"
  [[ "${PORT}" =~ ^[0-9]+$ ]] || fail "settings.json produced an invalid server.httpPort: ${PORT}"
}

usage() {
  cat <<EOF
Usage: ./scripts/launchd.sh <command>

Commands:
  install    Generate, load and verify the per-user LaunchAgent
  status     Show service status, listener, HTTP health and log paths
  restart    Restart the installed service and verify HTTP health
  uninstall  Unload the service and remove its generated plist
  logs       Follow stdout and stderr (Ctrl-C to stop)
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

escape_xml() {
  printf '%s' "$1" \
    | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
          -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

service_loaded() {
  launchctl print "${SERVICE}" >/dev/null 2>&1
}

listener_pid() {
  lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}

http_ok() {
  curl -fsSL --max-time 8 -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null
}

wait_for_http() {
  local i
  for i in {1..20}; do
    if http_ok; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

write_plist() {
  local app_xml python_xml server_xml stdout_xml stderr_xml
  app_xml="$(escape_xml "${APP_DIR}")"
  python_xml="$(escape_xml "${PYTHON}")"
  server_xml="$(escape_xml "${SERVER}")"
  stdout_xml="$(escape_xml "${STDOUT_LOG}")"
  stderr_xml="$(escape_xml "${STDERR_LOG}")"

  mkdir -p "$(dirname "${PLIST}")" "${LOG_DIR}"

  cat > "${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${python_xml}</string>
    <string>${server_xml}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${app_xml}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ProcessType</key>
  <string>Interactive</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
  </dict>

  <key>StandardOutPath</key>
  <string>${stdout_xml}</string>

  <key>StandardErrorPath</key>
  <string>${stderr_xml}</string>

  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
EOF

  plutil -lint "${PLIST}" >/dev/null
}

verify_prerequisites() {
  [[ "$(uname -s)" == "Darwin" ]] || fail "launchd installation requires macOS"
  [[ -x "${PYTHON}" ]] || fail "missing ${PYTHON}; create the venv and install requirements first"
  [[ -f "${SERVER}" ]] || fail "missing ${SERVER}"
  command -v launchctl >/dev/null || fail "launchctl is unavailable"
  command -v curl >/dev/null || fail "curl is unavailable"
  command -v lsof >/dev/null || fail "lsof is unavailable"
  command -v plutil >/dev/null || fail "plutil is unavailable"
  load_port
}

install_service() {
  verify_prerequisites

  local pid old_cmd
  pid="$(listener_pid)"
  if [[ -n "${pid}" ]]; then
    old_cmd="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
    if service_loaded; then
      launchctl bootout "${SERVICE}" >/dev/null 2>&1 || true
    elif [[ "${old_cmd}" == *"${SERVER}"* || "${old_cmd}" == *"server.py"* ]]; then
      printf 'Stopping the existing RoastIn server (PID %s).\n' "${pid}"
      kill "${pid}"
      for _ in {1..10}; do
        [[ -z "$(listener_pid)" ]] && break
        sleep 0.5
      done
    else
      fail "port ${PORT} is used by PID ${pid}: ${old_cmd}"
    fi
  elif service_loaded; then
    launchctl bootout "${SERVICE}" >/dev/null 2>&1 || true
  fi

  [[ -z "$(listener_pid)" ]] || fail "port ${PORT} did not become free"

  write_plist
  launchctl bootstrap "${DOMAIN}" "${PLIST}"
  launchctl enable "${SERVICE}"
  launchctl kickstart -k "${SERVICE}"

  if ! wait_for_http; then
    printf '\nRoastIn did not answer on port 8080. Recent logs:\n' >&2
    tail -n 20 "${STDOUT_LOG}" >&2 2>/dev/null || true
    tail -n 20 "${STDERR_LOG}" >&2 2>/dev/null || true
    exit 1
  fi

  printf 'Installed %s\n' "${LABEL}"
  printf 'Plist: %s\n' "${PLIST}"
  printf 'URL:   http://localhost:%s/RoastIn/index.html\n' "${PORT}"
  printf 'Logs:  %s and %s\n' "${STDOUT_LOG}" "${STDERR_LOG}"
}

show_status() {
  verify_prerequisites
  local pid="$(listener_pid)"
  if service_loaded; then
    launchctl print "${SERVICE}" | sed -n \
      -e '/state =/p' -e '/pid =/p' -e '/runs =/p' -e '/last exit code =/p'
  else
    printf 'Service is not loaded.\n'
  fi

  if [[ -n "${pid}" ]]; then
    printf 'Listener: PID %s on port %s\n' "${pid}" "${PORT}"
  else
    printf 'Listener: none on port %s\n' "${PORT}"
  fi

  if http_ok; then
    printf 'HTTP:     200 OK\n'
  else
    printf 'HTTP:     unavailable\n'
  fi

  printf 'Plist:    %s\n' "${PLIST}"
  printf 'Logs:     %s and %s\n' "${STDOUT_LOG}" "${STDERR_LOG}"
}

restart_service() {
  verify_prerequisites
  [[ -f "${PLIST}" ]] || fail "${PLIST} is not installed; run install first"
  service_loaded || fail "service is not loaded; run install first"
  launchctl kickstart -k "${SERVICE}"
  wait_for_http || fail "RoastIn did not answer after restart; check ${STDERR_LOG}"
  printf 'Restarted %s (HTTP 200).\n' "${LABEL}"
}

uninstall_service() {
  if service_loaded; then
    launchctl bootout "${SERVICE}"
  fi
  rm -f "${PLIST}"
  printf 'Uninstalled %s. Logs were kept in %s.\n' "${LABEL}" "${LOG_DIR}"
}

follow_logs() {
  mkdir -p "${LOG_DIR}"
  touch "${STDOUT_LOG}" "${STDERR_LOG}"
  tail -f "${STDOUT_LOG}" "${STDERR_LOG}"
}

case "${1:-}" in
  install)   install_service ;;
  status)    show_status ;;
  restart)   restart_service ;;
  uninstall) uninstall_service ;;
  logs)      follow_logs ;;
  *) usage; exit 2 ;;
esac
