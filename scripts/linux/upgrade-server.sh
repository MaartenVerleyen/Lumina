#!/usr/bin/env bash
# Upgrades the Lumina server installed as a system service (as on cachy: /srv/lumina, lumina-server.service).
#
#   bash upgrade-server.sh                        the latest release from GitHub
#   bash upgrade-server.sh v6.0.0                 that release
#   bash upgrade-server.sh --if-newer             the latest release, only when it is newer (for a timer)
#   bash upgrade-server.sh --from-source [REF]    built from the git checkout (default: main)
#   bash upgrade-server.sh --rollback             the previous version back
#
# A release carries a ready bundle (.github/workflows/server.yml): the server, ONNX Runtime's GPU libraries, the
# tray and the web client. Its SHA-256 is checked before anything is installed. The bundle also brings this
# script, installed as <home>/bin/upgrade-server.sh, so that copy is always the newest:
#   ssh -t cachy 'bash /srv/lumina/bin/upgrade-server.sh'
#
# The server is down only for the restart. Before that the database is copied with SQLite's backup API
# (backups/, the last few kept), and the running program and web client are kept as .prev. If the new version
# doesn't answer within two minutes, the previous one goes back by itself. A tray installed for this user
# (~/.local/bin/lumina-tray) is replaced too, and started again with its own options if it runs. Restarting the
# service asks for your sudo password, unless a sudoers rule allows it (server/README.md, "Upgrading").
#
# Settings: LUMINA_HOME (default /srv/lumina), LUMINA_SERVICE (default lumina-server), LUMINA_REPO (default
# MaartenVerleyen/Lumina), LUMINA_SRC (the git checkout for --from-source, default ~/Projects/Lumina),
# LUMINA_RESTART (a command of its own to restart the server, for instance "systemctl --user restart
# lumina-server" for a user service), LUMINA_TRAY (the installed tray, default ~/.local/bin/lumina-tray).
set -euo pipefail

# Run from a copy: the upgrade may replace this very file while bash is still reading it
if [[ "${LUMINA_UPGRADE_COPY:-}" != 1 ]]; then
  copy=$(mktemp --suffix=-lumina-upgrade.sh)
  cp "$0" "$copy"
  LUMINA_UPGRADE_COPY=1 LUMINA_UPGRADE_SCRIPT="$(realpath "$0")" exec bash "$copy" "$@"
fi

DEST=${LUMINA_HOME:-/srv/lumina}
SERVICE=${LUMINA_SERVICE:-lumina-server}
REPO=${LUMINA_REPO:-MaartenVerleyen/Lumina}
SRC=${LUMINA_SRC:-$HOME/Projects/Lumina}
TRAY=${LUMINA_TRAY:-$HOME/.local/bin/lumina-tray}
CONFIG=$DEST/lumina-server.toml
BACKUPS=$DEST/backups
KEEP_BACKUPS=3
WORK=$(mktemp -d --suffix=-lumina-upgrade)
trap 'rm -rf "$WORK"' EXIT

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
  local version
  for _ in $(seq 1 120); do
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

# A release's bundle: unpacked into $WORK/bundle after its SHA-256 matched. Sets NEW_VERSION.
from_release() {
  local tag=${1:-} only_newer=${2:-} api release
  api="https://api.github.com/repos/$REPO/releases/${tag:+tags/}${tag:-latest}"
  release=$(curl -fsSL "$api") || fail "Can't reach the release on GitHub ($api)"
  # The bundle and its checksum: "<url> <name>" lines
  local assets
  assets=$(python3 -c '
import json, sys
r = json.load(sys.stdin)
for a in r.get("assets", []):
    n = a["name"]
    if n.startswith("lumina-server-") and (n.endswith("-linux-x86_64.tar.gz") or n.endswith("-linux-x86_64.tar.gz.sha256")):
        print(a["browser_download_url"], n)' <<< "$release")
  local bundle sum
  bundle=$(awk '$2 ~ /\.tar\.gz$/ {print $1; exit}' <<< "$assets")
  sum=$(awk '$2 ~ /\.sha256$/ {print $1; exit}' <<< "$assets")
  if [[ -z $bundle || -z $sum ]]; then
    # The timer tries again tomorrow
    [[ -n $only_newer ]] && { echo "The latest release has no server bundle (yet)."; exit 0; }
    fail "That release has no server bundle (yet): the Server build runs for about 15 minutes after a release is published"
  fi
  NEW_VERSION=$(sed -n 's/.*lumina-server-\(.*\)-linux-x86_64\.tar\.gz$/\1/p' <<< "$bundle")
  if [[ -n $only_newer && $NEW_VERSION == "$(running_version || true)" ]]; then
    echo "Already on $NEW_VERSION."
    exit 0
  fi
  say "Downloading Lumina server $NEW_VERSION"
  (cd "$WORK" && curl -fsSLO "$bundle" && curl -fsSLO "$sum" && sha256sum --quiet -c ./*.sha256) ||
    fail "The download doesn't match its checksum: nothing was installed"
  mkdir -p "$WORK/bundle"
  tar -xzf "$WORK"/lumina-server-*.tar.gz -C "$WORK/bundle" --strip-components=1
}

# Built from the git checkout into the same layout as a bundle. Sets NEW_VERSION.
from_source() {
  local ref=${1:-main}
  say "Getting $ref"
  cd "$SRC"
  [[ -z $(git status --porcelain --untracked-files=no) ]] || fail "$SRC has changes of its own: commit or stash them first"
  git fetch --tags --quiet origin
  if git show-ref --verify --quiet "refs/remotes/origin/$ref"; then
    git checkout --quiet "$ref" 2>/dev/null || git checkout --quiet -b "$ref" "origin/$ref"
    git merge --ff-only --quiet "origin/$ref"
  else
    git checkout --quiet "$ref"
  fi
  echo "At $(git log -1 --format='%h %s')"
  say "Building the web client"
  npm ci --silent
  npm run build --silent
  say "Building the server (the running one carries on meanwhile)"
  local packages=(-p lumina-server)
  [[ -x $TRAY ]] && packages+=(-p lumina-tray)
  (cd src-tauri && cargo build --release "${packages[@]}")
  NEW_VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/crates/lumina-server/Cargo.toml | head -1)
  local b=$WORK/bundle
  mkdir -p "$b/bin"
  cp src-tauri/target/release/lumina-server "$b/bin/"
  [[ -x $TRAY ]] && cp src-tauri/target/release/lumina-tray "$b/bin/"
  # The build has ONNX Runtime's libraries as links into ort's download cache: the files themselves
  for lib in src-tauri/target/release/libonnxruntime*.so*; do
    [[ -e $lib ]] && cp -L "$lib" "$b/bin/"
  done
  cp scripts/linux/upgrade-server.sh "$b/bin/"
  cp -r dist "$b/web"
}

# The tray: the new program in place, and a running one started again with its own options, in its own desktop
# session (the variables it was started with)
update_tray() {
  [[ -x $TRAY && -f $WORK/bundle/bin/lumina-tray ]] || return 0
  say "Updating the tray"
  install -m 755 "$WORK/bundle/bin/lumina-tray" "$TRAY.new"
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

case ${1:-} in
  --rollback)
    rollback
    exit 0
    ;;
esac

before=$(running_version || echo "an older version")
say "Lumina server now: $before"
case ${1:-} in
  --from-source) from_source "${2:-main}" ;;
  --if-newer) from_release "" newer ;;
  -*) fail "Unknown option $1 (see the top of this script)" ;;
  *) from_release "${1:-}" ;;
esac

say "Copying the database (SQLite backup, safe while the server runs)"
mkdir -p "$BACKUPS"
backup="$BACKUPS/library-$(date +%Y-%m-%d-%H%M)-before-$NEW_VERSION.db"
sqlite3 "$DATA/library.db" ".backup '$backup'"
echo "$backup ($(du -h "$backup" | cut -f1))"
ls -1t "$BACKUPS"/library-*.db | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f

say "Installing $NEW_VERSION"
b=$WORK/bundle
install -m 755 "$b/bin/lumina-server" "$DEST/bin/lumina-server.new"
rm -rf "$DEST/web.new"
cp -r "$b/web" "$DEST/web.new"
cp -f "$DEST/bin/lumina-server" "$DEST/bin/lumina-server.prev"
mv -f "$DEST/bin/lumina-server.new" "$DEST/bin/lumina-server"
# ONNX Runtime's GPU part sits next to the program (as in the Docker image): without these files faces and
# smart search run on the CPU, several times slower
for lib in "$b"/bin/libonnxruntime*.so*; do
  [[ -e $lib ]] && cp -f "$lib" "$DEST/bin/"
done
[[ -f $b/bin/upgrade-server.sh ]] && install -m 755 "$b/bin/upgrade-server.sh" "$DEST/bin/upgrade-server.sh"
rm -rf "$DEST/web.prev"
mv "$DEST/web" "$DEST/web.prev"
mv "$DEST/web.new" "$DEST/web"

restart
if wait_until_up; then
  update_tray
  say "Done: $before → $NEW_VERSION"
  echo "Going back, if need be: bash $DEST/bin/upgrade-server.sh --rollback"
else
  printf '\n\033[31mThe new version doesn'"'"'t answer. Its log:\033[0m\n'
  sudo journalctl -u "$SERVICE" -n 40 --no-pager || true
  rollback
  exit 1
fi
