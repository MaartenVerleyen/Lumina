#!/usr/bin/env bash
# Upgrades the Lumina server installed as a system service (as on cachy: /srv/lumina, lumina-server.service).
#
#   bash scripts/linux/upgrade-server.sh [BRANCH-OR-TAG]   build and install it (default: main)
#   bash scripts/linux/upgrade-server.sh --rollback        put the previous version back
#
# From Windows, in one go:  ssh -t cachy 'bash ~/Projects/Lumina/scripts/linux/upgrade-server.sh'
#
# The server keeps running while the new version builds; it is down only for the restart. Before that the
# database is copied with SQLite's backup API (backups/, the last few kept), and the running program and web
# client are kept as .prev. If the new version doesn't answer within two minutes, the previous one goes back
# by itself. Restarting the service asks for your sudo password, unless a sudoers rule allows it (see
# server/README.md, "Upgrading").
#
# A tray installed for this user (~/.local/bin/lumina-tray) is built and replaced too, and started again with
# the same options if it runs.
#
# Settings: LUMINA_SRC (the git checkout, default ~/Projects/Lumina), LUMINA_HOME (default /srv/lumina),
# LUMINA_SERVICE (default lumina-server), LUMINA_RESTART (a command of its own to restart the server, for
# instance "systemctl --user restart lumina-server" for a user service), LUMINA_TRAY (the installed tray,
# default ~/.local/bin/lumina-tray).
set -euo pipefail

# Run from a copy: checking out the new version may change this very file while bash is still reading it
if [[ "${LUMINA_UPGRADE_COPY:-}" != 1 ]]; then
  copy=$(mktemp --suffix=-lumina-upgrade.sh)
  cp "$0" "$copy"
  LUMINA_UPGRADE_COPY=1 LUMINA_UPGRADE_SCRIPT="$(realpath "$0")" exec bash "$copy" "$@"
fi
SCRIPT=${LUMINA_UPGRADE_SCRIPT:-$0}

SRC=${LUMINA_SRC:-$HOME/Projects/Lumina}
DEST=${LUMINA_HOME:-/srv/lumina}
SERVICE=${LUMINA_SERVICE:-lumina-server}
CONFIG=$DEST/lumina-server.toml
BACKUPS=$DEST/backups
KEEP_BACKUPS=3
TRAY=${LUMINA_TRAY:-$HOME/.local/bin/lumina-tray}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[[ -f $CONFIG ]] || fail "No $CONFIG: set LUMINA_HOME to where the server is installed"
setting() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\(.*\)\".*/\1/p" "$CONFIG" | head -1; }
DATA=$(setting data_dir)
LISTEN=$(setting listen)
LISTEN=${LISTEN:-127.0.0.1:8080}
LISTEN=${LISTEN/0.0.0.0/127.0.0.1}
[[ -n $DATA ]] || fail "No data_dir in $CONFIG"

# The running version, from the status the tray reads (servers before 5.5 don't have it: "an older version")
running_version() {
  local key
  key=$(cat "$DATA/local-access.key" 2>/dev/null) || return 1
  curl -fsS --max-time 3 -H "x-lumina-local-key: $key" "http://$LISTEN/local/status" 2>/dev/null |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' 2>/dev/null
}

restart() {
  say "Restarting $SERVICE"
  if [[ -n ${LUMINA_RESTART:-} ]]; then
    bash -c "$LUMINA_RESTART"
  else
    sudo systemctl restart "$SERVICE"
  fi
}

# Waits for the server to answer again (the first start after an upgrade may migrate the database first)
wait_until_up() {
  local i version
  for i in $(seq 1 120); do
    if version=$(running_version); then
      echo "Running: $version"
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  [[ -f $DEST/bin/lumina-server.prev ]] || fail "There is no previous version to go back to"
  say "Putting the previous version back"
  mv -f "$DEST/bin/lumina-server.prev" "$DEST/bin/lumina-server"
  if [[ -d $DEST/web.prev ]]; then
    rm -rf "$DEST/web"
    mv "$DEST/web.prev" "$DEST/web"
  fi
  restart
  # An older server has no status to ask: its web page answering will do
  for _ in $(seq 1 60); do
    if curl -fs --max-time 3 -o /dev/null "http://$LISTEN/"; then
      echo "The previous version is running."
      latest=$(ls -1t "$BACKUPS"/library-*.db 2>/dev/null | head -1 || true)
      [[ -n $latest ]] && echo "The database as it was before the upgrade: $latest (put it back only if this version can't open the current one)."
      return 0
    fi
    sleep 1
  done
  fail "The previous version doesn't answer either: sudo journalctl -u $SERVICE -n 80"
}

if [[ ${1:-} == --rollback ]]; then
  rollback
  exit 0
fi
REF=${1:-main}

before=$(running_version || echo "an older version")
say "Lumina server now: $before. Upgrading to $REF from $SRC"

say "Getting $REF"
cd "$SRC"
[[ -z $(git status --porcelain --untracked-files=no) ]] || fail "$SRC has changes of its own: commit or stash them first"
git fetch --tags --quiet origin
if git show-ref --verify --quiet "refs/remotes/origin/$REF"; then
  git checkout --quiet "$REF" 2>/dev/null || git checkout --quiet -b "$REF" "origin/$REF"
  git merge --ff-only --quiet "origin/$REF"
else
  git checkout --quiet "$REF"
fi
echo "At $(git log -1 --format='%h %s')"

say "Building the web client"
npm ci --silent
npm run build --silent

say "Building the server (the running one carries on meanwhile)"
packages=(-p lumina-server)
[[ -x $TRAY ]] && packages+=(-p lumina-tray)
(cd src-tauri && cargo build --release "${packages[@]}")
NEW_VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/crates/lumina-server/Cargo.toml | head -1)

say "Copying the database (SQLite backup, safe while the server runs)"
mkdir -p "$BACKUPS"
backup="$BACKUPS/library-$(date +%Y-%m-%d-%H%M)-before-$NEW_VERSION.db"
sqlite3 "$DATA/library.db" ".backup '$backup'"
echo "$backup ($(du -h "$backup" | cut -f1))"
ls -1t "$BACKUPS"/library-*.db | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f

say "Installing $NEW_VERSION"
install -m 755 src-tauri/target/release/lumina-server "$DEST/bin/lumina-server.new"
rm -rf "$DEST/web.new"
cp -r dist "$DEST/web.new"
cp -f "$DEST/bin/lumina-server" "$DEST/bin/lumina-server.prev"
mv -f "$DEST/bin/lumina-server.new" "$DEST/bin/lumina-server"
# ONNX Runtime's GPU part sits next to the program (as in the Docker image): without these files faces and
# smart search run on the CPU, several times slower. The build has them as links into ort's download cache.
for lib in src-tauri/target/release/libonnxruntime*.so*; do
  [[ -e $lib ]] && cp -fL "$lib" "$DEST/bin/$(basename "$lib")"
done
rm -rf "$DEST/web.prev"
mv "$DEST/web" "$DEST/web.prev"
mv "$DEST/web.new" "$DEST/web"

# The tray: the new program in place, and a running one started again with its own options, in its own
# desktop session (the variables it was started with)
update_tray() {
  [[ -x $TRAY ]] || return 0
  say "Updating the tray"
  install -m 755 src-tauri/target/release/lumina-tray "$TRAY.new"
  mv -f "$TRAY.new" "$TRAY"
  local pid
  pid=$(pgrep -u "$(id -u)" -x lumina-tray | head -1) || true
  if [[ -z $pid ]]; then
    echo "Installed; it starts with the next login."
    return 0
  fi
  local args envs
  mapfile -d '' args < "/proc/$pid/cmdline"
  mapfile -d '' envs < "/proc/$pid/environ"
  kill "$pid"
  for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  (cd ~ && env -i "${envs[@]}" setsid "$TRAY" "${args[@]:1}" > "$HOME/.cache/lumina-tray.log" 2>&1 < /dev/null &)
  echo "Started again."
}

restart
if wait_until_up; then
  update_tray
  say "Done: $before → $NEW_VERSION"
  echo "Going back, if need be: bash $SCRIPT --rollback"
else
  printf '\n\033[31mThe new version doesn'"'"'t answer. Its log:\033[0m\n'
  sudo journalctl -u "$SERVICE" -n 40 --no-pager || true
  rollback
  exit 1
fi
