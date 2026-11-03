# Lumina server with the NVIDIA GPU (CUDA). Build from the repository root:
#   docker build -f server/Dockerfile -t lumina-server .
#
# The pinned `ort` release downloads an ONNX Runtime built for CUDA 13 and cuDNN 9 (it ships no CUDA 12
# build), so the runtime image must have those. CUDA 13.0 matches the oldest driver that runs CUDA 13 (580).

# The web client: the same Vite build as the desktop app
FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY public/ ./public/
COPY src/ ./src/
RUN npm run build

# Built on the runtime image's Ubuntu: ONNX Runtime's prebuilt static library needs glibc 2.38 and GCC 13's
# libstdc++ (Debian bookworm has 2.36 and 12), and the binary must not need a newer glibc than it runs on
FROM ubuntu:24.04 AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev cmake curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /src
COPY src-tauri/ ./src-tauri/
WORKDIR /src/src-tauri
ENV ORT_CUDA_VERSION=13
# Only the server and the engine are built (the desktop app's Tauri crates are not)
RUN cargo build --release -p lumina-server \
    && mkdir -p /out \
    && cp target/release/lumina-server /out/ \
    # ONNX Runtime's CUDA provider comes as shared libraries next to the binary
    && find target/release -maxdepth 1 -name 'libonnxruntime*.so*' -exec cp {} /out/ \;

FROM nvidia/cuda:13.0.2-cudnn-runtime-ubuntu24.04
# ffmpeg: video frames, HEIC and playable copies; tzdata: photo dates from file times in local time;
# libssl3 + ca-certificates: model downloads over HTTPS
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/ /opt/lumina/
COPY --from=web /src/dist/ /opt/lumina/web/
# Inside the container the server listens on all interfaces so Docker can forward the port; the compose
# file publishes it on the host's 127.0.0.1 only, where `tailscale serve` picks it up
ENV LD_LIBRARY_PATH=/opt/lumina \
    LUMINA_DATA_DIR=/data \
    LUMINA_LIBRARIES=/photos \
    LUMINA_WEB_DIR=/opt/lumina/web \
    LUMINA_LISTEN=0.0.0.0:8080
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/opt/lumina/lumina-server"]
CMD ["serve"]
