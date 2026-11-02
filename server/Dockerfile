# Lumina server with the NVIDIA GPU (CUDA). Build from the repository root:
#   docker build -f server/Dockerfile -t lumina-server .
#
# Not yet built or tested on Linux (Lumina 5.0 phase 1): the CUDA, cuDNN and ONNX Runtime versions below
# must match what the pinned `ort` release downloads.

FROM rust:1-bookworm AS build
WORKDIR /src
COPY src-tauri/ ./src-tauri/
WORKDIR /src/src-tauri
# Only the server and the engine are built (the desktop app's Tauri crates are not)
RUN cargo build --release -p lumina-server \
    && mkdir -p /out \
    && cp target/release/lumina-server /out/ \
    # ONNX Runtime's CUDA provider comes as shared libraries next to the binary
    && find target/release -maxdepth 1 -name 'libonnxruntime*.so*' -exec cp {} /out/ \;

FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04
# ffmpeg: video frames, HEIC and playable copies; tzdata: photo dates from file times in local time;
# libssl3 + ca-certificates: model downloads over HTTPS
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/ /opt/lumina/
ENV LD_LIBRARY_PATH=/opt/lumina \
    LUMINA_DATA_DIR=/data \
    LUMINA_LIBRARIES=/photos
VOLUME ["/data"]
ENTRYPOINT ["/opt/lumina/lumina-server"]
CMD ["serve"]
