/-! # examples/ChuHan/Game.lean — loader for `Game.leanjs`

Mirrors the `Reversi/Game.lean` shape — just probes a list of
candidate paths and returns the source. The actual game logic
(scene runner, character select, Liu Bang Act 1, action battle)
lives in `Game.leanjs` next door. -/

namespace ChuHan

private def candidates : List String := [
  -- Standalone repo layout (this repo): files live under `ChuHan/`.
  "ChuHan/Game.leanjs",
  "../ChuHan/Game.leanjs",
  -- Monorepo layout (lean-elm/examples): kept for in-tree builds.
  "examples/ChuHan/Game.leanjs",
  "../examples/ChuHan/Game.leanjs",
  "../../examples/ChuHan/Game.leanjs",
  "lean-elm/examples/ChuHan/Game.leanjs"
]

/-- Locate the entry `Game.leanjs` and return both its source and its
    path. The path lets the include resolver find sibling files
    (`Story.leanjs`, `Sandbox.leanjs`) relative to this file. -/
def loadSourceAt : IO (String × String) := do
  for path in candidates do
    if ← System.FilePath.pathExists path then
      let src ← IO.FS.readFile path
      IO.eprintln s!"chuhan: loaded {src.utf8ByteSize} bytes from {path}"
      return (src, path)
  throw <| IO.userError <|
    "couldn't locate ChuHan/Game.leanjs — tried: "
    ++ String.intercalate ", " candidates

def loadSource : IO String := (·.1) <$> loadSourceAt

end ChuHan
