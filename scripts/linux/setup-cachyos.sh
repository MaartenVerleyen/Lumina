#!/usr/bin/env bash
# Sets up a CachyOS (Arch) machine to develop and test Lumina: build tools, Rust, Node, ffmpeg, the GitHub
# CLI, Claude Code, optionally Docker with the NVIDIA runtime, Ollama and Tailscale; then clones Lumina and
# builds the server once. Safe to run again: it skips what is already there.
#
#   bash setup-cachyos.sh [options]
#
#   --dir DIR        Where Lumina is cloned (default: ~/Projects/Lumina)
#   --branch NAME    Branch to check out (default: lumina-5)
#   --docker         Docker + NVIDIA Container Toolkit (to build and run server/docker-compose.yml)
#   --ollama         Ollama with CUDA, as a system service (captions without Docker)
#   --tailscale      Tailscale (to reach this machine and copy the test library from the Windows PC)
#   --no-desktop     Skip the libraries the desktop app (Tauri/WebKitGTK) needs
#   --no-build       Don't build anything after cloning
#
# The repository is private: the script signs you in to GitHub (gh auth login) when needed.
# It never installs or changes the NVIDIA driver; it only checks that one works (see the end).
set -euo pipefail

DIR="$HOME/Projects/Lumina"
BRANCH="lumina-5"
REPO="MaartenVerleyen/Lumina"
WITH_DOCKER=0 WITH_OLLAMA=0 WITH_TAILSCALE=0 WITH_DESKTOP=1 BUILD=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --docker) WITH_DOCKER=1; shift ;;
    --ollama) WITH_OLLAMA=1; shift ;;
    --tailscale) WITH_TAILSCALE=1; shift ;;
    --no-desktop) WITH_DESKTOP=0; shift ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
note() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [[ $EUID -eq 0 ]]; then
  echo "Run this as your own user (it uses sudo where needed), not as root." >&2
  exit 1
fi
if ! have pacman; then
  echo "This script is for CachyOS / Arch (pacman not found)." >&2
  exit 1
fi

# ---------- packages ----------
step "System packages"
PACKAGES=(
  base-devel git curl wget unzip pkgconf openssl   # building (rusqlite, ort and reqwest need a C toolchain and OpenSSL)
  rustup                                           # Rust toolchains (the workspace uses edition 2024)
  ffmpeg                                          # video frames, HEIC and playable copies on Linux
  python                                           # scripts/test-library
  github-cli                                       # cloning the private repository, releases
  sqlite                                           # inspecting library.db by hand
)
# The frontend (Vite, React, TypeScript) needs Node 22.12+. An installed Node is kept as it is: the
# nodejs-lts-* packages conflict with nodejs, and Node 22 LTS is fine.
if have node; then
  have npm || PACKAGES+=(npm)
else
  PACKAGES+=(nodejs npm)
fi
if [[ $WITH_DESKTOP -eq 1 ]]; then
  # Tauri v2 on Linux: WebKitGTK 4.1 and friends (https://v2.tauri.app/start/prerequisites/)
  PACKAGES+=(webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg xdotool file appmenu-gtk-module)
fi
[[ $WITH_DOCKER -eq 1 ]] && PACKAGES+=(docker docker-compose docker-buildx nvidia-container-toolkit)
[[ $WITH_OLLAMA -eq 1 ]] && PACKAGES+=(ollama-cuda)
[[ $WITH_TAILSCALE -eq 1 ]] && PACKAGES+=(tailscale)
sudo pacman -Syu --needed --noconfirm "${PACKAGES[@]}"

step "Rust"
if ! rustup toolchain list | grep -q '^stable'; then
  rustup default stable
else
  rustup update stable
fi
rustc --version

# ---------- services ----------
if [[ $WITH_DOCKER -eq 1 ]]; then
  step "Docker with the NVIDIA runtime"
  sudo systemctl enable --now docker
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker
  if ! id -nG "$USER" | grep -qw docker; then
    sudo usermod -aG docker "$USER"
    note "You were added to the docker group: log out and in again before using docker without sudo."
  fi
fi
if [[ $WITH_OLLAMA -eq 1 ]]; then
  step "Ollama"
  sudo systemctl enable --now ollama
  note "Pull the caption model when you need it: ollama pull qwen3-vl:8b-instruct"
fi
if [[ $WITH_TAILSCALE -eq 1 ]]; then
  step "Tailscale"
  sudo systemctl enable --now tailscaled
  tailscale status >/dev/null 2>&1 || sudo tailscale up
fi

# ---------- Claude Code ----------
step "Claude Code"
if have claude; then
  claude --version || true
else
  curl -fsSL https://claude.ai/install.sh | bash
  note "Start it with 'claude' in the Lumina folder and sign in with the same account as on Windows."
fi

# ---------- the repository ----------
step "GitHub sign-in"
if ! gh auth status >/dev/null 2>&1; then
  gh auth login --hostname github.com --git-protocol https --web
fi
gh auth setup-git

step "Lumina in $DIR"
if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" fetch origin
else
  mkdir -p "$(dirname "$DIR")"
  gh repo clone "$REPO" "$DIR"
fi
git -C "$DIR" checkout "$BRANCH"
git -C "$DIR" pull --ff-only origin "$BRANCH" || note "Couldn't fast-forward $BRANCH (local changes?); left as it is."
if [[ -z "$(git -C "$DIR" config user.email || true)" ]]; then
  git -C "$DIR" config user.name "MaartenVerleyen"
  git -C "$DIR" config user.email "maarten.verleyen@gmail.com"
fi

if [[ $BUILD -eq 1 ]]; then
  step "Frontend packages"
  (cd "$DIR" && npm ci)
  step "Building lumina-server (first build takes a few minutes)"
  (cd "$DIR/src-tauri" && cargo build --release -p lumina-server)
  step "Engine tests"
  (cd "$DIR/src-tauri" && cargo test -p lumina-core --lib) || note "Some engine tests fail on Linux: that is the first thing to look at (see CLAUDE.md)."
fi

# ---------- checks ----------
step "Checks"
if have nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then
  nvidia-smi -L
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
else
  note "No working NVIDIA driver (nvidia-smi). Lumina falls back to the CPU. On CachyOS, 'sudo chwd -a' picks a driver;"
  note "a GTX 980 Ti (Maxwell) needs the 580xx proprietary series, not the open modules."
fi
ffmpeg -hide_banner -version | head -1
have ffmpeg && ffmpeg -hide_banner -decoders 2>/dev/null | grep -qi hevc && echo "ffmpeg decodes HEVC (iPhone videos and HEIC)"

cat <<EOF

Done. Next:
  cd "$DIR" && claude
  Copy the test library from the Windows PC (C:\\LuminaTest\\Library, 268 MB) to ~/LuminaTest/Library, e.g. over
  Tailscale from Windows:  scp -r C:\\LuminaTest\\Library $USER@$(hostname):~/LuminaTest/
  Then:  cd "$DIR/src-tauri" && LUMINA_DATA_DIR=~/LuminaTest/ServerData ./target/release/lumina-server scan ~/LuminaTest/Library
EOF
