# 楚漢恋歌 — Asset Credits

Every image, sound file and quoted verse used by `chuhan_serve` is either
generated locally by an open-weights model on the author's machine or
sourced from a work in the public domain. Nothing in this directory is
copied from a third-party creative work.

## Visual assets

Everything under `examples/ChuHan/assets/*.png`.

- **Model**: [FLUX.1-schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell)
  by Black Forest Labs
- **License**: Apache License 2.0 — outputs are freely usable, including
  commercially, and no attribution to Black Forest Labs is required. This
  credit is voluntary.
- **Pipeline**: [ComfyUI](https://github.com/comfyanonymous/ComfyUI) driving
  the standard `SD3LatentImage` → `KSampler` (`euler` / `simple`, 4 steps,
  cfg 1.0) → `VAEDecode` → `SaveImage` graph. The exact prompts are
  reproducible from the scripts under `tools/` (`gen_all.py` for portraits
  + backgrounds, `gen_endings.py` for ending scenes, `gen_extras.py` for
  supporting cast, `gen_ziying.py` and `gen_lugong.py` for the two later
  additions).
- **Total**: 45 PNGs — 9 protagonist portraits, 5 wife portraits, 5
  supporting NPC portraits (呂公, 子嬰, plus late-additions), 19 scene
  backgrounds, 9 ending stills. ~28 MB.

## Audio assets

Everything under `examples/ChuHan/assets/bgm_*.ogg` and
`examples/ChuHan/assets/sfx_*.ogg`.

- **Model**: [Stable Audio Open 1.0](https://huggingface.co/stabilityai/stable-audio-open-1.0)
  by Stability AI
- **License**: [Stability AI Community License](https://stability.ai/community-license-agreement)
  — outputs are freely usable for individual use and for commercial use
  under an annual revenue threshold. Above that threshold a paid
  enterprise licence applies. Redistribution of this repository is well
  within the community terms.
- **Pipeline**: ComfyUI with the standard Stable Audio graph
  (`CheckpointLoaderSimple` + `CLIPLoader(type="stable_audio")` +
  `ConditioningStableAudio` + `KSampler` (`dpmpp_3m_sde_gpu` /
  `exponential`, 100 steps, cfg 6.0) + `VAEDecodeAudio` + `SaveAudio`).
  WAV output is transcoded to Ogg/Vorbis (`q=4`) with `ffmpeg` for a
  smaller browser payload. Full reproduction scripts under `tools/`
  (`gen_bgm.py` for the 8 BGM loops, `gen_sfx.py` for the 5 short SFX
  clips).
- **T5 text encoder**: `text_encoder/model.safetensors` from the same
  Stable Audio Open 1.0 repository, saved locally as
  `t5_base_stable_audio.safetensors` and loaded through ComfyUI's
  `CLIPLoader`. Distributed under the same Community License.
- **Total**: 8 BGM loops (~3.3 MB) + 5 SFX clips (~160 kB).

## Quoted verse

Two Chinese poems are quoted verbatim inside the game text, in a scene
where their historical performance is dramatised:

- **「力は山を抜き、気は世を蓋う…」** — 項羽's 垓下歌 (Song of Gaixia),
  composed circa 202 BCE the night before his final battle.
- **「漢兵、已に地を略す…」** — 虞姫's 和項王歌 (Reply to King Xiang),
  same night.

Both survive in `史記・項羽本紀` (Sima Qian, c. 94 BCE) and are ~2200 years
old — indisputably public domain.

## SQLite amalgamation

Not a ChuHan asset per se but worth noting for the repository as a whole:
`c/sqlite3.c` is vendored from the [SQLite amalgamation](https://sqlite.org/amalgamation.html)
which is placed in the public domain by its authors.

## What this game does *not* borrow

The scene structure, character interpretations (Liu Bang's charmer /
egoist double-face, Han Xin's western march, Fan Zeng's hidden-END
kill, etc.), dialogue and inner monologues are all original writing by
the author. The Chu-Han contention (BCE 209-202) is public domain
historical material and this work is one of many creative retellings.
