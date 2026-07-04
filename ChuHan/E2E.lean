import LeanTea
import LeanTea.Browser

/-! # chuhan-e2e — Playwright button smoke test

Drives the *running* server with a real Chromium via `LeanTea.Browser`
(the Playwright bridge) and auto-plays the game: on each screen it finds
every `[data-msg]` button, clicks them, presses Enter to advance dialogue,
and watches for runtime failures — uncaught errors, unhandled rejections,
`console.error`, and handlers that throw on click.

This is the *runtime* half of the button-safety story. The boot-time
`auditButtons` (Serve.lean) proves statically that every button tag has a
handler; this proves the handlers actually run without throwing — the
class of bug the static audit can't see (a wired-but-throwing handler, an
overlay that traps the UI, a missing element the handler queries).

Run against a live server:
```
cd lean-tea-chuhan
./.lake/build/bin/chuhan_serve --port 8090 &        # or reuse a running one
LEANTEA_BROWSER_BRIDGE=…/lean-elm/tools/browser-bridge/bridge.js \
LEANTEA_BROWSER_HEADLESS=1 \
CHUHAN_URL=http://127.0.0.1:8090/ \
  ./.lake/build/bin/chuhan_e2e
```
Exits non-zero (and lists them) if any button click produced a runtime
error. -/

open LeanTea.Browser
open Lean (Json)

/-- The whole crawl runs inside the page as one async expression: a SPA
that never navigates, so a single `evaluate` can click through the entire
session. Returns `{errors, tags, clicks, reachedConclude, concludeClicked}`.
Kept in single-quoted JS so it needs no Lean escaping. -/
def crawlerJs : String :=
"(async () => {
  const errors = [];
  addEventListener('error', e => errors.push('error: ' + (e.message || e)));
  addEventListener('unhandledrejection', e =>
    errors.push('reject: ' + ((e.reason && e.reason.message) || e.reason)));
  const oe = console.error;
  console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ')); oe.apply(console, a); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).pointerEvents !== 'none';
  };
  const tags = new Set();
  const sigc = {};
  let reachedConclude = false, concludeClicked = false, clicks = 0;
  // Buttons that kick off WebLLM / image gen: async, need a GPU + model,
  // and would just hang the smoke. Skip them (they can't throw on click).
  const skip = /gmSubmit|gmSend|llmSend|loadAI|imgGen|llmLoadAI/;
  for (let step = 0; step < 160; step++) {
    const btns = [...document.querySelectorAll('[data-msg]')].filter(vis);
    if (btns.some(b => (b.getAttribute('data-msg') || '').includes('concludeChat'))) reachedConclude = true;
    if (!btns.length) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      await sleep(50);
      continue;
    }
    let pick = btns.find(b => { const m = b.getAttribute('data-msg') || ''; return !tags.has(m) && !skip.test(m); });
    if (!pick) pick = btns.find(b => !skip.test(b.getAttribute('data-msg') || '')) || btns[0];
    const msg = pick.getAttribute('data-msg') || '';
    tags.add(msg);
    const stage = document.querySelector('#stage');
    const sig = (stage ? stage.textContent.slice(0, 60) : '') + '|' + msg;
    sigc[sig] = (sigc[sig] || 0) + 1;
    if (sigc[sig] > 3) { if (btns.length === 1) break; else continue; }
    // dispatch a real bubbling click (works for SVG nodes too — SVGElement
    // has no .click() method, unlike HTMLElement) so the delegation fires.
    try { pick.dispatchEvent(new MouseEvent('click', { bubbles: true })); clicks++; } catch (e) { errors.push('click threw [' + msg + ']: ' + e.message); }
    if (/concludeChat/.test(msg)) concludeClicked = true;
    await sleep(90);
  }
  return { errors, tags: [...tags], clicks, reachedConclude, concludeClicked };
})()"

/-- Image-gen diagnostic: probe the three things `loadImgGen` needs —
WebGPU (`navigator.gpu`), the diffusers.js ESM import, and the locally
served model files — plus try a real `fromPretrained` load (bounded by a
timeout) and report the actual error. Answers "why doesn't image gen
work?" without a screenshot. -/
def imgProbeJs : String :=
"(async () => {
  const out = { gpu: !!navigator.gpu, importOk: false, importErr: '', hasPipeline: false, hasSetCache: false, model: {}, load: 'skipped', loadErr: '' };
  let mod = null;
  try {
    mod = await import('https://esm.run/@aislamov/diffusers.js');
    out.importOk = !!mod;
    out.hasPipeline = !!(mod && mod.DiffusionPipeline);
    out.hasSetCache = !!(mod && mod.setModelCacheDir);
  } catch (e) { out.importErr = String((e && e.message) || e); }
  const base = location.origin + '/models/aislamov/stable-diffusion-2-1-base-onnx/';
  for (const f of ['model_index.json', 'unet/model.onnx', 'vae_decoder/model.onnx_data']) {
    try { const r = await fetch(base + f, { headers: { Range: 'bytes=0-0' } }); out.model[f] = r.status; }
    catch (e) { out.model[f] = 'ERR ' + ((e && e.message) || e); }
  }
  if (out.gpu && out.hasPipeline) {
    try {
      if (mod.setModelCacheDir) mod.setModelCacheDir(location.origin + '/models');
      const load = mod.DiffusionPipeline.fromPretrained('aislamov/stable-diffusion-2-1-base-onnx', { progressCallback: () => {} });
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('load timeout (120s)')), 120000));
      await Promise.race([load, timeout]);
      out.load = 'ok';
    } catch (e) { out.load = 'fail'; out.loadErr = String((e && e.message) || e).slice(0, 240); }
  } else {
    out.load = out.gpu ? 'no-pipeline' : 'no-webgpu';
  }
  return out;
})()"

private def jsonArr (j : Json) (key : String) : Array Json :=
  ((j.getObjVal? key).toOption.getD Json.null |>.getArr?).toOption.getD #[]

private def jsonBool (j : Json) (key : String) : Bool :=
  ((j.getObjVal? key).toOption.getD Json.null |>.getBool?).toOption.getD false

/-- Image-gen diagnostic run: report WebGPU / import / model / load. -/
def runImgProbe (url : String) : IO Unit := do
  IO.println s!"chuhan-e2e[img]: probing image generation at {url}"
  withSession fun s => do
    let _ ← s.navigate url
    let r ← s.evaluate imgProbeJs
    IO.println s!"  {r.compress}"
    let gpu := ((r.getObjVal? "gpu").toOption.getD Json.null |>.getBool?).toOption.getD false
    let load := ((r.getObjVal? "load").toOption.getD Json.null |>.getStr?).toOption.getD "?"
    if !gpu then
      IO.println "  → navigator.gpu ABSENT: this browser/headless mode has no WebGPU."
      IO.println "    image gen cannot run here; retry headed (LEANTEA_BROWSER_HEADLESS=0) on a GPU."
    else if load == "ok" then
      IO.println "  → OK: WebGPU present, diffusers imported, model pipeline loaded."
    else
      IO.println s!"  → image gen FAILS at stage: {load}"

def main : IO Unit := do
  let url := (← IO.getEnv "CHUHAN_URL").getD "http://127.0.0.1:8090/"
  if (← IO.getEnv "E2E_MODE") == some "img" then runImgProbe url else do
  IO.println s!"chuhan-e2e: driving {url} with a real Chromium"
  withSession fun s => do
    let nav ← s.navigate url
    IO.println s!"  loaded: {nav.title}"
    -- let the initial client render settle
    let _ ← s.evaluate "new Promise(r => setTimeout(r, 400))"
    let rep ← s.evaluate crawlerJs
    let errs := jsonArr rep "errors"
    let tags := jsonArr rep "tags"
    let clicks := ((rep.getObjVal? "clicks").toOption.getD Json.null |>.getNat?).toOption.getD 0
    let reachedConclude := jsonBool rep "reachedConclude"
    let concludeClicked := jsonBool rep "concludeClicked"
    IO.println s!"  clicked {clicks} buttons across {tags.size} distinct tags"
    IO.println s!"  reachedConclude={reachedConclude} concludeClicked={concludeClicked}"
    if errs.size > 0 then
      IO.eprintln s!"chuhan-e2e: FAIL — {errs.size} runtime error(s) during button clicks:"
      for e in errs do IO.eprintln s!"    {e.compress}"
      throw (IO.userError "e2e button smoke failed")
    else
      IO.println "chuhan-e2e: OK — every clicked button ran without a runtime error"
