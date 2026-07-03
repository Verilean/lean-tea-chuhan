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

/- Dependency source for LeanTea / LeanJs.

   Default: the pinned upstream git rev (CI / release / fresh clones).
   Bump with `lake update lean-tea`.

   Local development: to build against a working copy of
   `Verilean/lean-tea` (e.g. while extending LeanJs), point at it with
   a Lake config flag or an env var, then run `lake update lean-tea`
   once so the manifest picks up the new source:

       lake -Klean_tea_dir=/abs/path/to/lean-elm update lean-tea
       lake -Klean_tea_dir=/abs/path/to/lean-elm build chuhan_serve

   or, equivalently, export the path once:

       export LEANTEA_DIR=/abs/path/to/lean-elm
       lake update lean-tea && lake build chuhan_serve

   The flag wins over the env var; unset both to fall back to git. -/
meta if ((get_config? lean_tea_dir) <|> (run_io (IO.getEnv "LEANTEA_DIR"))).isSome then
require «lean-tea» from
  (((get_config? lean_tea_dir) <|> (run_io (IO.getEnv "LEANTEA_DIR"))).getD "")
else
require «lean-tea» from git
  "https://github.com/Verilean/lean-tea.git" @ "main"

lean_lib ChuHanLib where
  roots := #[`ChuHan.Game]

/-- 楚漢恋歌 SPA + LLM TRPG server. -/
lean_exe chuhan_serve where
  root := `ChuHan.Serve
