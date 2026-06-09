# ---- Whisper build stage -----------------------------------------------
# Compiles whisper.cpp and downloads a speech model so voice transcription is
# fully self-hosted inside this image: the browser records audio and POSTs it
# to /api/stt — no third-party speech service, nothing for users to install.
FROM debian:bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
        git build-essential cmake curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
# Pin the whisper.cpp release for reproducible builds.
ARG WHISPER_CPP_REF=v1.7.4
RUN git clone --depth 1 --branch ${WHISPER_CPP_REF} \
        https://github.com/ggml-org/whisper.cpp /whisper.cpp
# Static, portable binary (no -march=native so it runs on any builder/runtime,
# no OpenMP so the slim runtime image needs no extra libraries).
RUN cmake -S /whisper.cpp -B /whisper.cpp/build \
        -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
        -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF && \
    cmake --build /whisper.cpp/build --config Release -j --target whisper-cli
# base.en (~142 MB) is a good accuracy/speed balance on small instances.
# Use --build-arg WHISPER_MODEL=tiny.en for a smaller/faster image.
ARG WHISPER_MODEL=base.en
RUN curl -fsSL -o /ggml-model.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin

# ---- App image -----------------------------------------------------------
# Node 22 is required for the built-in node:sqlite module the backend uses.
FROM node:22-slim

WORKDIR /app

# pnpm via corepack (matches the "packageManager" field in package.json)
RUN corepack enable

# Install deps first (better layer caching)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# App source + build the Gantt bundle into dist/
COPY . .
RUN pnpm run build

# Drop dev dependencies (vite etc.) now that the build is done
RUN pnpm prune --prod

# Self-hosted speech-to-text (see server/stt.js). Unset these to disable.
COPY --from=whisper /whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /ggml-model.bin /opt/whisper/ggml-model.bin
ENV WHISPER_BIN=/usr/local/bin/whisper-cli
ENV WHISPER_MODEL=/opt/whisper/ggml-model.bin

ENV NODE_ENV=production
# Database lives here — mount a Railway Volume at /data to persist it.
ENV DATA_DIR=/data

# Railway provides $PORT at runtime; the server reads it (defaults to 3000).
EXPOSE 3000
CMD ["node", "server/index.js"]
