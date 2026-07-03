# 楚漢恋歌 — container build for Render (or any Docker host).
#
# Single stage: build the Lean server and run it from the same image so
# the Lean runtime libraries are always present. The server reads $PORT
# (Render provides it) and defaults host to 0.0.0.0.
#
# Without an LLM endpoint the game is fully playable — the sandbox game
# master falls back to local event tables. To enable the AI game master,
# set LMSTUDIO_BASE_URL (any OpenAI-compatible endpoint) + LMSTUDIO_MODEL.
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl git ca-certificates build-essential libgmp-dev \
    && rm -rf /var/lib/apt/lists/*

# Lean toolchain manager. `--default-toolchain none` — the pinned
# version in `lean-toolchain` is installed on first `lake` invocation.
RUN curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
      | sh -s -- -y --default-toolchain none
ENV PATH="/root/.elan/bin:${PATH}"

WORKDIR /app
COPY . /app

# Resolve the lean-tea dependency and build the server. This downloads
# the pinned Lean toolchain and compiles LeanTea + LeanJs + the game.
RUN lake update && lake build chuhan_serve

ENV PORT=8050
EXPOSE 8050
CMD ["sh", "-c", "./.lake/build/bin/chuhan_serve --host 0.0.0.0 --port ${PORT}"]
