import Lake
open Lake DSL

/-! # lean-tea-chuhan — 楚漢恋歌 (Chu-Han Love Song)

Two-Dimensional narrative game set in BCE 209-195 China. Six playable
protagonists (Liu Bang, Xiang Yu, Han Xin, Zhang Liang, Xiao He,
Fan Zeng), each with their wife arc + historical fate. Two-layer
dialogue (outer speech + inner monologue) drives the "charmer /
egoist" double face of Liu Bang and the corresponding interior
voices of the others. LeanJs + DOM + Canvas 2D + LMStudio-backed
NPC chat.

Depends on the [Verilean/lean-tea](https://github.com/Verilean/lean-tea)
core (LeanTea + LeanJs libraries).

Run:

    lake build chuhan_serve
    ./.lake/build/bin/chuhan_serve --port 8050
-/

package «lean-tea-chuhan» where
  precompileModules := false

/-- Pin to the current lean-tea main; bump the rev when the LeanTea /
    LeanJs API changes. Use `lake update` to fetch the latest. -/
require «lean-tea» from git
  "https://github.com/Verilean/lean-tea.git" @ "feat/gemini-mcp"

lean_lib ChuHanLib where
  roots := #[`ChuHan.Game]

/-- 楚漢恋歌 SPA + LLM TRPG server. -/
lean_exe chuhan_serve where
  root := `ChuHan.Serve
