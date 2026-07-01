# 楚漢恋歌 — Chu-Han Love Song

A 2D narrative game set in BCE 209-195 China. Six playable protagonists
from the Chu-Han contention:

- **劉邦** (Liu Bang) — the charmer with an egoist under the mask
- **項羽** (Xiang Yu) — the young tiger with 虞姫 at his side
- **韓信** (Han Xin) — the strategist, from washerwoman's rice to
  Bactria (hidden 韓信西征 END)
- **張良** (Zhang Liang) — the Daoist advisor
- **蕭何** (Xiao He) — the quiet chancellor who bet on the wrong man
- **范増** (Fan Zeng) — the seventy-year-old strategist and 玉玦三度

Two-layer dialogue (outer speech + inner monologue in 《》), 35+ endings
including alt-history, three mini-games (顔相鑑定 / 玉玦三度 / 背水之陣),
free-text TRPG resolution via LLM at pivotal moments (LMStudio + Gemini
compatible), photorealistic assets generated with FLUX.1-schnell and
Stable Audio Open 1.0 through ComfyUI.

## Stack

- [lean-tea](https://github.com/Verilean/lean-tea) — LeanTea framework
  (HTTP, LLM clients, template engine, LeanJs compiler)
- Vanilla DOM + Canvas 2D on the browser side (single `page.html`)
- LMStudio (OpenAI-compatible) for NPC chat + aiResolve verdicts

## Run

```sh
lake update
lake build chuhan_serve
./.lake/build/bin/chuhan_serve --port 8050
# → http://localhost:8050/
```

LLM chat + aiResolve verdicts want an LMStudio instance at
`http://127.0.0.1:11211/v1` (default). Any OpenAI-compatible endpoint
works — override with `LMSTUDIO_BASE_URL=…`.

## Layout

    ChuHan/
      Game.lean          — loads Game.leanjs
      Game.leanjs        — 4000+ line game logic in the LeanJs subset
      Serve.lean         — HTTP handler, /assets router, /api/ask, /api/resolve
      page.html          — SPA shell + widget kit CSS
      assets/            — FLUX-generated portraits + backgrounds + endings,
                           Stable Audio-generated BGM + SFX
      ASSETS.md          — provenance + licence notes
      README.md          — this file's cousin (setup + gameplay guide)
      MISSING_ASSETS.txt — auto-generated at server boot (asset audit)
