// runtime.js — 楚漢恋歌 host runtime (extracted from page.html).
//
// This is the imperative browser glue: DOM event wiring, the render
// loop, Canvas-2D / WebGPU drawing, WebAudio, and fetch to the LLM
// endpoints. It is a *classic* script loaded right after the inline
// compiled game, so it shares the top-level const scope and can see
// initState / update / view and the sandbox helpers (sbAtmoMode,
// sbScenePrompt, sbArmyStrength, sbTargetCounts, sfxForKind, …).
//
// Game *logic* belongs in ChuHan/Game.leanjs (LeanJs-compiled); keep
// this file to host concerns only, and migrate pieces into LeanJs
// incrementally where they are logic rather than browser plumbing.


// ─── Runtime glue (the LeanJs code exposes pure functions; this
// thin layer wires DOM events + render loop). All mutable state
// lives in `state`; we re-render on every transition. ───────────
const stage = document.getElementById('stage');
const lsKey = 'chuhan-save-v2';          // autosave (every action)
const lsCheckpointKey = 'chuhan-checkpoint';  // ↩ checkpoint
function slotKey(n) { return 'chuhan-slot-' + n; }

function loadFrom(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch (_) { return null; }
}
function saveTo(key, state) {
  try { localStorage.setItem(key, JSON.stringify(state)); } catch (_) {}
}
function loadSave() { return loadFrom(lsKey); }
function persist(state) { saveTo(lsKey, state); }

// ─── Server-backed save slots (SQLite via /api/save|load|slots) ──────
// Autosave stays in localStorage (above). Named slots go to the server,
// keyed by a client-generated "save code" so the same slots can be
// restored on another device by entering the code. All host glue — the
// game logic never sees the network.
const saveCodeKey = 'chuhan-savecode';
const codeRe = /^[A-Za-z0-9_-]{4,64}$/;
function getSaveCode() {
  let c = localStorage.getItem(saveCodeKey);
  if (!c || !codeRe.test(c)) {
    const r = () => Math.random().toString(36).slice(2, 8).toUpperCase();
    c = (r() + r()).slice(0, 10);
    localStorage.setItem(saveCodeKey, c);
  }
  return c;
}
function setSaveCode(c) {
  c = (c || '').trim();
  if (!codeRe.test(c)) return false;
  localStorage.setItem(saveCodeKey, c);
  return true;
}
// Expose to Game.leanjs's menu view (serverSlotLabel / getSaveCodeStr).
window.chuhanGetSaveCode = getSaveCode;
let serverSlots = {};                       // {slot: {label, updated_at}}
window.chuhanSlotLabel = function (n) {
  const s = serverSlots[String(n)];
  if (!s) return '空き';
  const when = new Date(Number(s.updated_at) * 1000).toLocaleString();
  return (s.label || '記録') + ' — ' + when;
};
async function refreshServerSlots() {
  try {
    const r = await fetch('/api/slots?key=' + encodeURIComponent(getSaveCode()));
    const j = await r.json();
    serverSlots = {};
    for (const s of (j.slots || [])) serverSlots[String(s.slot)] = s;
  } catch (_) { /* offline: keep last cache */ }
}
function saveToast(msg) {
  let el = document.getElementById('saveToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'saveToast';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2000;background:#1b1710ee;color:#f0e6d2;border:1px solid #4a3f2f;border-radius:8px;padding:8px 14px;font-size:13px;transition:opacity .3s';
    document.body.appendChild(el);
  }
  el.textContent = msg; el.style.opacity = '1';
  clearTimeout(el._t); el._t = setTimeout(() => { el.style.opacity = '0'; }, 1800);
}
async function serverSaveSlot(n) {
  try {
    const label = (typeof describeState === 'function') ? describeState(state) : '';
    const r = await fetch('/api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: getSaveCode(), slot: String(n), label, state })
    });
    if (r.ok) { saveToast('スロット' + n + ' に保存しました'); await refreshServerSlots(); render(); }
    else saveToast('保存に失敗しました');
  } catch (_) { saveToast('サーバに接続できません(保存不可)'); }
}
async function serverLoadSlot(n) {
  try {
    const r = await fetch('/api/load?key=' + encodeURIComponent(getSaveCode()) + '&slot=' + n);
    if (r.status === 404) { saveToast('スロット' + n + ' は空です'); return; }
    if (!r.ok) { saveToast('読み込みに失敗しました'); return; }
    const j = await r.json();
    if (j && j.state) { state = j.state; persist(state); render(); saveToast('スロット' + n + ' をロードしました'); }
  } catch (_) { saveToast('サーバに接続できません(読込不可)'); }
}
// Restore another device's slots by switching to its save code.
function applySaveCodeFromInput() {
  const inp = document.getElementById('saveCodeInput');
  const v = inp ? inp.value : '';
  if (setSaveCode(v)) { saveToast('コードを ' + getSaveCode() + ' に切替'); refreshServerSlots().then(render); }
  else saveToast('コードの形式が不正です(英数4〜64文字)');
}

// ─── Leaderboard (戦績ランキング) — SQLite via /api/score|leaderboard ──
// The score is game logic (sbScore in Game.leanjs); submission + the
// ranking overlay are host glue. A finished sandbox run posts once.
const playerNameKey = 'chuhan-playername';
function getPlayerName() { return localStorage.getItem(playerNameKey) || '名もなき将'; }
function setPlayerName(n) {
  n = (n || '').trim().slice(0, 24);
  if (n) localStorage.setItem(playerNameKey, n);
  return getPlayerName();
}
function lbEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function outcomeLabel(o) {
  return o === 'win' ? '天下統一' : o === 'end' ? '時代の終焉'
    : o === 'rival' ? '落日' : o === 'lose' ? '敗亡' : o;
}
let lastScoredEnd = '';   // dedup: a given run submits once
async function submitScore() {
  if (!state.world || typeof sbScoreEntry !== 'function') return;
  const e = sbScoreEntry(state.world, state.endingId);
  const dk = e.outcome + ':' + e.year + ':' + e.score;
  if (dk === lastScoredEnd) return;   // already sent this end
  lastScoredEnd = dk;
  try {
    await fetch('/api/score', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: getSaveCode(), name: getPlayerName(),
        anchor: e.anchor, outcome: e.outcome, regions: e.regions, year: e.year, score: e.score })
    });
  } catch (_) { /* offline: skip */ }
}
function ensureLeaderboardOverlay() {
  let ov = document.getElementById('lbOverlay');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = 'lbOverlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:1500;background:rgba(0,0,0,0.88);display:none;align-items:center;justify-content:center';
  ov.innerHTML =
    "<div style='background:#1a1410;border:1px solid #4a3f2f;border-radius:10px;padding:20px;max-width:560px;width:92vw;max-height:86vh;overflow:auto;color:#f0e6d2'>" +
    "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:10px'>" +
    "<h2 style='margin:0;font-size:18px'>🏆 戦績ランキング</h2>" +
    "<button id='lbClose' class='btn btn-ghost'>閉じる</button></div>" +
    "<div style='margin-bottom:10px;font-size:12px;color:#c8b89a'>あなたの名: " +
    "<input id='lbName' class='save-code-input' style='width:auto;display:inline-block' maxlength='24' /> " +
    "<button id='lbNameSave' class='btn btn-menu'>更新</button></div>" +
    "<div id='lbBody'>読み込み中…</div></div>";
  document.body.appendChild(ov);
  ov.querySelector('#lbClose').addEventListener('click', () => { ov.style.display = 'none'; });
  ov.querySelector('#lbNameSave').addEventListener('click', () => {
    setPlayerName((document.getElementById('lbName') || {}).value);
    saveToast('名前を更新しました'); renderLeaderboardBody();
  });
  return ov;
}
async function renderLeaderboardBody() {
  const body = document.getElementById('lbBody');
  if (!body) return;
  try {
    const r = await fetch('/api/leaderboard?limit=20');
    const scores = (await r.json()).scores || [];
    if (!scores.length) { body.innerHTML = "<p style='color:#9a8d73'>まだ記録がありません。天下を競え。</p>"; return; }
    const rows = scores.map((s, i) => {
      const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.';
      return "<tr>" +
        "<td style='padding:3px 8px'>" + rank + "</td>" +
        "<td style='padding:3px 8px'>" + lbEscape(s.name || '—') + "</td>" +
        "<td style='padding:3px 8px'>" + lbEscape(s.anchor || '') + "</td>" +
        "<td style='padding:3px 8px'>" + outcomeLabel(s.outcome) + "</td>" +
        "<td style='padding:3px 8px;text-align:right'>" + s.regions + "地</td>" +
        "<td style='padding:3px 8px;text-align:right;color:#ffd54a'>" + s.score + "</td></tr>";
    }).join('');
    body.innerHTML = "<table style='width:100%;border-collapse:collapse;font-size:13px'>" +
      "<thead><tr style='color:#9a8d73;text-align:left'><th></th><th>名</th><th>主人公</th><th>結末</th><th>領地</th><th>点</th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table>";
  } catch (_) { body.innerHTML = "<p style='color:#c66'>サーバに接続できません。</p>"; }
}
function openLeaderboard() {
  const ov = ensureLeaderboardOverlay();
  ov.style.display = 'flex';
  const inp = document.getElementById('lbName'); if (inp) inp.value = getPlayerName();
  renderLeaderboardBody();
}

// Checkpoint heuristic: snapshot just before a mini-game OR when a
// new scene starts (chapter boundaries). The phase/sceneId pair acts
// as the "interesting moment" marker.
let lastCheckpointKey = '';
function maybeCheckpoint(state) {
  // Take a checkpoint when entering minigame or after a scene change.
  const key = state.phase + ':' + state.sceneId;
  if (state.phase === 'minigame' && lastCheckpointKey !== 'mini:' + key) {
    lastCheckpointKey = 'mini:' + key;
    // Save the state BEFORE the mini-game began (mini.kind unset).
    // Approximation: save current state minus the mini sub-state.
    const before = {...state, mini: state.mini && state.mini.kind ? {...state.mini, kind: ''} : state.mini};
    saveTo(lsCheckpointKey, before);
  }
}

// ─── Audio runtime: two cross-fading <audio> elements with idempotent
// play(id). Files: /assets/bgm_${id}.ogg. Empty id ('') = stop. ──
window.chuhanAudio = (function () {
  const tracks = ['title','village','court','camp','battle','journey','grief','ending'];
  // Probe asset existence once so we don't spam 404s when running
  // before BGM has been generated.
  const have = {};
  tracks.forEach((id) => {
    fetch('/assets/bgm_' + id + '.ogg', {method: 'HEAD'})
      .then((r) => { have[id] = r.ok; })
      .catch(() => { have[id] = false; });
  });

  const els = [new Audio(), new Audio()];
  els.forEach((a) => { a.loop = true; a.volume = 0; a.preload = 'auto'; });
  let active = -1;
  let currentId = '';
  let muted = localStorage.getItem('chuhan-muted') === '1';
  const target = 0.45;

  function fade(el, to, ms) {
    const from = el.volume;
    const t0 = performance.now();
    function step(t) {
      const k = Math.min(1, (t - t0) / ms);
      // Clamp: floating-point / overlapping fades can nudge this a hair
      // outside [0,1], and the browser throws on an out-of-range volume.
      el.volume = Math.max(0, Math.min(1, from + (to - from) * k));
      if (k < 1) requestAnimationFrame(step);
      else if (to === 0) { try { el.pause(); } catch (_) {} }
    }
    requestAnimationFrame(step);
  }

  function play(id) {
    if (id === currentId) return;
    currentId = id;
    // Fade out the previous track.
    if (active >= 0) fade(els[active], 0, 800);
    if (!id) { active = -1; return; }
    if (have[id] === false) return; // asset missing — silent
    const next = 1 - (active < 0 ? 1 : active);
    const el = els[next];
    el.src = '/assets/bgm_' + id + '.ogg';
    el.currentTime = 0;
    el.volume = 0;
    const tryPlay = el.play();
    if (tryPlay && tryPlay.catch) tryPlay.catch(() => {/* autoplay blocked — first click unlocks */});
    fade(el, muted ? 0 : target, 800);
    active = next;
  }

  function sfx(id) {
    if (muted) return;
    const a = new Audio('/assets/sfx_' + id + '.ogg');
    a.volume = 0.7;
    a.play().catch(() => {});
  }

  function toggleMute() {
    muted = !muted;
    localStorage.setItem('chuhan-muted', muted ? '1' : '0');
    if (active >= 0) fade(els[active], muted ? 0 : target, 200);
  }

  // First user gesture unlocks autoplay — retry current id if it didn't start.
  function unlock() {
    if (active >= 0 && els[active].paused && currentId) {
      els[active].play().catch(() => {});
    }
    document.removeEventListener('click', unlock);
    document.removeEventListener('keydown', unlock);
  }
  document.addEventListener('click', unlock);
  document.addEventListener('keydown', unlock);

  return { play, sfx, toggleMute, muted: () => muted };
})();

let state = loadSave() || initState;

// ─── Test mode: ?scene=xxx (&char=xxx) jumps directly. ────────────
(function applyUrlOverride() {
  const params = new URLSearchParams(window.location.search);
  const scene = params.get('scene');
  if (!scene) return;
  // Infer character from scene-id prefix when not given.
  let char = params.get('char') || '';
  if (!char) {
    if (scene.startsWith('liubang_'))    char = 'liubang';
    else if (scene.startsWith('xiangyu_')) char = 'xiangyu';
    else if (scene.startsWith('hanxin_'))  char = 'hanxin';
    else if (scene.startsWith('zhangliang_')) char = 'zhangliang';
    else if (scene.startsWith('xiaohe_'))  char = 'xiaohe';
    else if (scene.startsWith('fanzeng_')) char = 'fanzeng';
  }
  state = update({tag: 'jumpToScene', char: char, sceneId: scene}, state);
})();

function render() {
  stage.innerHTML = view(state);
  // The save menu is now rendered directly by LeanJs renderHud;
  // clicks fire via the existing data-msg delegation. We still
  // checkpoint here on transition.
  maybeCheckpoint(state);
  maybeStartRingLoop();
  wireChatHandlers();
  wireResolveHandlers();
  wireGmHandlers();
  wireSandboxSim();
  wireAtmo();
  wireBattle();
  wireImgGen();
  wireAction();
}

// ─── Real-time 2D action sortie (Canvas 2D, no model). You control one
// soldier (WASD/arrows = move, J/Space = slash, ESC = retreat); enemies
// swarm in; fell the target count to win. The outcome feeds the board
// via sbActionResult. This is the actual action gameplay — the sandbox
// strategy layer's counterpart. ────────────────────────────────────
let action = { raf: null, keys: {}, st: null, kb: false };

function ensureActionOverlay() {
  let ov = document.getElementById('actionOverlay');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = 'actionOverlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.9);display:none;flex-direction:column;align-items:center;justify-content:center';
  ov.innerHTML =
    "<div id='actionHud' style='color:#f0e6d2;margin-bottom:6px;font-size:14px'></div>" +
    "<canvas id='actionCanvas' width='720' height='420' style='max-width:94vw;height:auto;background:#14110c;border:1px solid #4a3f2f;border-radius:8px'></canvas>" +
    "<div style='color:#9a8d73;font-size:12px;margin-top:6px'>WASD / 矢印 = 移動 ・ J / Space = 斬撃 ・ ESC = 退却</div>" +
    "<button id='actionClose' class='btn btn-ghost' style='margin-top:8px;display:none'>戻る</button>";
  document.body.appendChild(ov);
  ov.querySelector('#actionClose').addEventListener('click', () => finishAction());
  return ov;
}

// actionInitState / actionSpawnEnemy / actionStep / actionDraw now live
// in Game.leanjs (compiled): the movement / enemy-AI / combat logic is
// LeanJs do/for, the canvas draw is thin externs. This host frame owns
// the rAF loop, the live canvas, the HUD text, and the end transition.
function actionFrame() {
  const ov = document.getElementById('actionOverlay');
  const c = document.getElementById('actionCanvas');
  if (!ov || ov.style.display === 'none' || !c) { action.raf = null; return; }
  const ctx = c.getContext('2d'), W = c.width, H = c.height;
  const wasOver = action.st.over;
  action.st = actionStep(action.st, action.keys, W, H);  // compiled LeanJs
  actionDraw(ctx, action.st, W, H);                       // compiled LeanJs
  const st = action.st;
  document.getElementById('actionHud').textContent =
    'HP ' + Math.max(0, st.hp) + '  ・  討取 ' + st.kills + ' / ' + st.target +
    (st.over ? (st.win ? '  ― 勝利！' : '  ― 敗走…') : '');
  if (st.over && !wasOver) showActionEnd();
  action.raf = requestAnimationFrame(actionFrame);
}

function showActionEnd() {
  const b = document.getElementById('actionClose');
  if (b) b.style.display = 'inline-block';
  setTimeout(() => { if (action.st && action.st.over) finishAction(); }, 1400);
}

function actionKeyDown(e){ action.keys[e.key.toLowerCase()] = true;
  if (e.key==='Escape'){ if (action.st) { action.st.over=true; action.st.win=false; } finishAction(); return; }
  if (['w','a','s','d','j',' ','arrowup','arrowdown','arrowleft','arrowright'].includes(e.key.toLowerCase())) e.preventDefault();
}
function actionKeyUp(e){ action.keys[e.key.toLowerCase()] = false; }

function openAction() {
  if (action.raf) return;
  const ov = ensureActionOverlay();
  ov.style.display = 'flex';
  ov.querySelector('#actionClose').style.display = 'none';
  const c = document.getElementById('actionCanvas');
  action.st = actionInitState(c.width, c.height);   // compiled LeanJs
  action.keys = {};
  if (!action.kb){ document.addEventListener('keydown', actionKeyDown); document.addEventListener('keyup', actionKeyUp); action.kb = true; }
  action.raf = requestAnimationFrame(actionFrame);
}
function finishAction() {
  const ov = document.getElementById('actionOverlay');
  if (ov) ov.style.display = 'none';
  if (action.raf){ cancelAnimationFrame(action.raf); action.raf = null; }
  if (action.kb){ document.removeEventListener('keydown', actionKeyDown); document.removeEventListener('keyup', actionKeyUp); action.kb = false; }
  const st = action.st; action.st = null;
  if (st && state.phase === 'sandbox' && state.world) {
    state = update({tag: 'sbActionResult', win: !!st.win, kills: st.kills}, state);
    persist(state); render();
  }
}
function wireAction() {
  const b = document.getElementById('sbAction');
  if (!b || b.dataset.wired) return;
  b.dataset.wired = '1';
  b.addEventListener('click', openAction);
}

// ─── In-browser scene illustration (SD-Turbo via diffusers.js / WebGPU).
// Optional, opt-in, cached, non-blocking. A 1-step distilled diffusion
// model paints the current situation in an ink-wash style. No server,
// no cost — same static/Steam story as the browser LLM. If WebGPU is
// absent or anything throws, we just skip it: the shader/SVG/sim
// visuals carry the scene regardless.
//
// TUNE ON A REAL WEBGPU BROWSER: the exact ONNX repo id and diffusers.js
// run() params below are the two things most likely to need adjusting;
// they're isolated as constants for that reason.
// The previous repo (aislamov/sd-turbo-onnx) 404/401s on HuggingFace.
// Use diffusers.js's documented demo ONNX model. NOTE: still best-effort
// / unverified on a real WebGPU browser — image gen is an optional flourish.
const IMG_MODEL = 'aislamov/stable-diffusion-2-1-base-onnx';
const IMG_STEPS = 20;                         // SD 2.1 base is multi-step
let imggen = { mod: null, pipe: null, ready: false, loading: false, busy: false };

function imgStatus(msg) {
  const s = document.getElementById('imgStatus');
  if (s) s.textContent = msg;
}

// scenePrompt logic now lives in Game.leanjs as sbScenePrompt(world) —
// compiled by LeanJs. This is only the host-side null guard.
function scenePrompt() {
  return state.world ? sbScenePrompt(state.world) : '';
}

async function loadImgGen() {
  if (imggen.ready || imggen.loading) return false;
  if (!navigator.gpu) { imgStatus('この端末は WebGPU 非対応（絵はスキップ）'); return false; }
  imggen.loading = true;
  imgStatus('画家（SD-Turbo）を読み込み中…（初回のみ大きめDL・以後キャッシュ）');
  try {
    if (!imggen.mod) imggen.mod = await import('https://esm.run/@aislamov/diffusers.js');
    imggen.pipe = await imggen.mod.DiffusionPipeline.fromPretrained(IMG_MODEL, {
      progressCallback: (p) => imgStatus('画家 読み込み: ' + (p && p.status ? p.status : '…'))
    });
    imggen.ready = true;
    imgStatus('画家 起動済み');
    return true;
  } catch (e) {
    const em = (e && e.message ? e.message : String(e));
    const calm = /401|403|404|not found|status/i.test(em)
      ? '画像生成モデルを読み込めませんでした（実験的機能・環境により未対応）。進行には影響しません。'
      : '画像生成に失敗しました（' + em.slice(0, 60) + '）。進行には影響しません。';
    imgStatus(calm);
    return false;
  } finally {
    imggen.loading = false;
  }
}

async function genScene() {
  if (imggen.busy) return;
  if (!imggen.ready) { const ok = await loadImgGen(); if (!ok) return; }
  imggen.busy = true;
  imgStatus('筆を執っている…');
  try {
    const canvas = document.getElementById('sbScene');
    const images = await imggen.pipe.run({
      prompt: scenePrompt(),
      numInferenceSteps: IMG_STEPS,
      guidanceScale: 7.5,
      progressCallback: (info) => { if (info && info.step != null) imgStatus('描画 ' + info.step + '/' + IMG_STEPS); }
    });
    const img = Array.isArray(images) ? images[0] : images;
    // diffusers.js tensors expose toImageData(); fall back to any canvas the lib returns.
    if (canvas && img && img.toImageData) {
      const data = await img.toImageData();
      canvas.width = data.width; canvas.height = data.height;
      canvas.getContext('2d').putImageData(data, 0, 0);
      canvas.style.display = 'block';
      imgStatus('（情景 更新）');
    } else {
      imgStatus('画像の取り出しに失敗（実機で run() の戻り値を要確認）');
    }
  } catch (e) {
    imgStatus('描画失敗: ' + (e && e.message ? e.message : e));
  } finally {
    imggen.busy = false;
  }
}

function wireImgGen() {
  const b = document.getElementById('imgGen');
  if (!b || b.dataset.wired) return;
  b.dataset.wired = '1';
  b.addEventListener('click', genScene);
}

// ─── #3 · Mass-battle showpiece. A ⚔ button opens a fullscreen overlay
// where the two armies clash — thousands of soldiers on WebGPU
// (instanced quads), or a few thousand dots on a Canvas-2D fallback.
// Army sizes track the world (漢 vs 楚 total control). Ephemeral. ────
const BATTLE_WGSL = `
struct U { time:f32, resx:f32, resy:f32, clash:f32 };
@group(0) @binding(0) var<uniform> u:U;
struct VO { @builtin(position) pos:vec4f, @location(0) col:vec3f, @location(1) uv:vec2f, @location(2) alive:f32 };
@vertex fn vs(@location(0) corner:vec2f, @location(1) sold:vec4f) -> VO {
  let side = sold.z; let t = u.time; let seed = sold.w;
  let dir = select(1.0, -1.0, side > 0.5);
  var cx = clamp(sold.x + dir * t * 0.05 * (0.6 + seed*0.8), 0.06, 0.94);
  let cy = sold.y + sin(t*3.0 + seed*30.0)*0.01;
  let near = 1.0 - abs(cx - 0.5) * 2.0;
  let dead = step(seed, u.clash * near * 0.9);
  let sz = 0.006;
  let px = (cx + corner.x*sz) * 2.0 - 1.0;
  let py = 1.0 - (cy + corner.y*sz*(u.resx/u.resy)) * 2.0;
  var o:VO;
  o.pos = vec4f(px, py, 0.0, 1.0);
  o.col = select(vec3f(0.3,0.55,1.0), vec3f(1.0,0.35,0.3), side>0.5);
  o.uv = corner; o.alive = 1.0 - dead;
  return o;
}
@fragment fn fs(in:VO) -> @location(0) vec4f {
  if (in.alive < 0.5) { discard; }
  if (length(in.uv) > 1.0) { discard; }
  return vec4f(in.col * (1.2 - length(in.uv)*0.5), 1.0);
}`;

let battle = { raf: null, render: null, starting: false };

// armyStrength logic now lives in Game.leanjs as sbArmyStrength(world,
// faction) — compiled by LeanJs. Host-side null guard only.
function armyStrength(faction) {
  return state.world ? sbArmyStrength(state.world, faction) : 20;
}

// A readable clash: 漢(blue, left) and the enemy(red, right) advance,
// MEET at a front line (highlighted band) and fight THERE — they don't
// pass through. Casualties fall at the line (flash + fade), weighted
// against the weaker army, and the stronger side pushes the line into
// enemy ground. Who's winning is visible: the losing colour thins and
// the line sits in their territory. hanN/chuN come from actual control.
function battle2D(canvas, hanN, chuN) {
  const ctx = canvas.getContext('2d'); const W = canvas.width, H = canvas.height;
  const total = Math.max(1, hanN + chuN);
  const hanShare = hanN / total;
  const push = (hanShare - 0.5) * 2;                 // -1..1, han advantage
  const N = Math.min(1500, Math.round(total * 4));
  const hanCount = Math.round(N * hanShare);
  const sol = [];
  for (let i = 0; i < N; i++) {
    const side = i < hanCount ? 0 : 1;               // 0=han(left) 1=enemy(right)
    sol.push({
      side,
      x: side ? W*0.70 + Math.random()*W*0.28 : W*0.02 + Math.random()*W*0.28,
      y: 16 + Math.random()*(H-32), seed: Math.random(), hp: 1, flash: 0
    });
  }
  const t0 = performance.now();
  return () => {
    const t = (performance.now() - t0)/1000;
    const closing = Math.min(t/2, 1);                // armies close over ~2s
    const frontX = W*0.5 + push * W*0.32 * Math.min(t/8, 1);  // line drifts to the weaker side
    ctx.fillStyle = '#0d0b08'; ctx.fillRect(0,0,W,H);
    ctx.fillStyle = 'rgba(255,210,90,0.12)'; ctx.fillRect(frontX-5, 0, 10, H);  // front-line band
    for (const s of sol) {
      if (s.hp <= 0) {
        if (s.flash > 0) { s.flash -= 0.05; ctx.fillStyle = 'rgba(255,190,110,'+Math.max(0,s.flash)+')'; ctx.fillRect(s.x-1.5, s.y-1.5, 3, 3); }
        continue;
      }
      const target = frontX + (s.side ? 7 : -7);
      const atLine = s.side ? (s.x <= target) : (s.x >= target);
      if (!atLine) {
        s.x += (s.side ? -1 : 1) * (0.6 + s.seed) * 1.7 * closing;
      } else {
        const losing = s.side ? (push > 0) : (push < 0);
        const risk = 0.008 + (losing ? 0.012 + Math.abs(push)*0.02 : 0.004);
        if (Math.random() < risk * closing) { s.hp = 0; s.flash = 1; continue; }
        s.x += (Math.random()-0.5)*1.0;              // jostle at the clash
      }
      ctx.fillStyle = s.side ? '#ff5a4d' : '#4d8cff';
      ctx.fillRect(s.x, s.y + Math.sin(t*3 + s.seed*30)*1.4, 3, 3);
    }
  };
}

async function battleWebGPU(canvas, hanN, chuN) {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter || adapter.isFallbackAdapter) return null;   // software GPU → use 2D fallback
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext('webgpu'); if (!ctx) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });
  device.pushErrorScope('validation');
  const mod = device.createShaderModule({ code: BATTLE_WGSL });
  const pipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: mod, entryPoint: 'vs', buffers: [
      { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
      { arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x4' }] }
    ]},
    fragment: { module: mod, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' }
  });
  if (await device.popErrorScope()) return null;
  // unit quad (two triangles)
  const quad = new Float32Array([-1,-1, 1,-1, 1,1,  -1,-1, 1,1, -1,1]);
  const qbuf = device.createBuffer({ size: quad.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(qbuf, 0, quad);
  const total = Math.min(30000, Math.round((hanN + chuN) * 60));
  const hanCount = Math.round(total * hanN / (hanN + chuN));
  const data = new Float32Array(total * 4);
  for (let i = 0; i < total; i++) {
    const side = i < hanCount ? 0 : 1;
    data[i*4+0] = side ? 0.72 + Math.random()*0.24 : 0.04 + Math.random()*0.24;
    data[i*4+1] = 0.06 + Math.random()*0.88;
    data[i*4+2] = side;
    data[i*4+3] = Math.random();
  }
  const ibuf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(ibuf, 0, data);
  const ubuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
  return (t) => {
    device.queue.writeBuffer(ubuf, 0, new Float32Array([t, canvas.width, canvas.height, Math.min(t/6, 1)]));
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: {r:0.05,g:0.043,b:0.03,a:1}, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipe); pass.setBindGroup(0, bind);
    pass.setVertexBuffer(0, qbuf); pass.setVertexBuffer(1, ibuf);
    pass.draw(6, total); pass.end();
    device.queue.submit([enc.finish()]);
  };
}

function ensureBattleOverlay() {
  let ov = document.getElementById('battleOverlay');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = 'battleOverlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.86);display:none;flex-direction:column;align-items:center;justify-content:center';
  ov.innerHTML =
    "<div style='color:#f0e6d2;margin-bottom:8px;font-size:15px'>会戦 ― <span style='color:#4d8cff'>漢</span> vs <span style='color:#ff5a4d'>楚</span></div>" +
    "<canvas id='battleCanvas2' width='840' height='440' style='max-width:94vw;height:auto;background:#0d0b08;border:1px solid #4a3f2f;border-radius:8px'></canvas>" +
    "<button id='battleClose' class='btn btn-ghost' style='margin-top:10px'>戻る</button>";
  document.body.appendChild(ov);
  ov.querySelector('#battleClose').addEventListener('click', closeBattle);
  return ov;
}
function battleLoop() {
  battle.t0 = performance.now();
  const frame = () => {
    const ov = document.getElementById('battleOverlay');
    if (!ov || ov.style.display === 'none' || !battle.render) { battle.raf = null; return; }
    battle.render((performance.now() - battle.t0) / 1000);
    battle.raf = requestAnimationFrame(frame);
  };
  battle.raf = requestAnimationFrame(frame);
}
function openBattle() {
  if (battle.starting) return;
  battle.starting = true;
  const ov = ensureBattleOverlay();
  ov.style.display = 'flex';
  const c = ov.querySelector('#battleCanvas2');
  const hanN = armyStrength('han'), chuN = armyStrength('chu');
  // Use the clear Canvas-2D clash. The WebGPU shader (battleWebGPU, kept
  // below) read as meaningless dots crossing, so it's no longer default.
  battle.render = battle2D(c, hanN, chuN);
  battle.starting = false;
  battleLoop();
}
function closeBattle() {
  const ov = document.getElementById('battleOverlay');
  if (ov) ov.style.display = 'none';
  if (battle.raf) { cancelAnimationFrame(battle.raf); battle.raf = null; }
  battle.render = null;
  // The clash concludes → resolve it on the board (shifts the front).
  if (state.phase === 'sandbox' && state.world) {
    state = update({tag: 'battleResolve'}, state);
    persist(state); render();
  }
}
function wireBattle() {
  const b = document.getElementById('sbBattle');
  if (!b || b.dataset.wired) return;
  b.dataset.wired = '1';
  b.addEventListener('click', openBattle);
}

// ─── P3.5 · Atmosphere sky-band. A WGSL fragment shader (WebGPU) tints
// the sandbox with the current mood — dusk / fire / sandstorm / snow —
// derived from the season and the latest event. Falls back to a
// Canvas-2D painter when WebGPU is unavailable (Safari / older), so the
// band is always alive. Mode: 0 dusk · 1 fire · 2 sandstorm · 3 snow.
const ATMO_WGSL = `
struct U { time:f32, mode:f32, resx:f32, resy:f32 };
@group(0) @binding(0) var<uniform> u:U;
@vertex fn vs(@builtin(vertex_index) i:u32) -> @builtin(position) vec4f {
  var p = array<vec2f,3>(vec2f(-1.,-1.), vec2f(3.,-1.), vec2f(-1.,3.));
  return vec4f(p[i], 0., 1.);
}
fn hash(p:vec2f)->f32 { return fract(sin(dot(p, vec2f(41.3,289.1)))*43758.5453); }
@fragment fn fs(@builtin(position) fc:vec4f) -> @location(0) vec4f {
  let uv = fc.xy / vec2f(u.resx, u.resy);
  let t = u.time;
  var col = vec3f(0.09,0.08,0.06);
  if (u.mode < 0.5) {
    col = mix(vec3f(0.16,0.10,0.08), vec3f(0.05,0.05,0.09), uv.y);
    let e = smoothstep(0.75,1.0, hash(floor(vec2f(uv.x*44., uv.y*18. - t*0.5))));
    col += vec3f(0.5,0.3,0.1)*e*0.35;
  } else if (u.mode < 1.5) {
    let n = hash(floor(vec2f(uv.x*34., uv.y*30. - t*3.5)));
    let flame = smoothstep(0.15,1.0, n) * (1.0-uv.y);
    col = mix(vec3f(0.22,0.03,0.0), vec3f(1.0,0.55,0.12), flame);
    col += vec3f(1.0,0.6,0.2)*pow(1.0-uv.y,3.0)*0.55;
  } else if (u.mode < 2.5) {
    let s = hash(floor(vec2f(uv.x*7. - t*5., uv.y*36.)));
    col = mix(vec3f(0.36,0.27,0.16), vec3f(0.52,0.42,0.26), s*0.6);
    col = mix(col, vec3f(0.27,0.21,0.13), uv.y);
  } else {
    col = mix(vec3f(0.17,0.19,0.24), vec3f(0.07,0.08,0.12), uv.y);
    let f = hash(floor(vec2f(uv.x*52., uv.y*26. + t*2.2)));
    col += vec3f(0.9,0.95,1.0)*smoothstep(0.95,1.0,f)*0.85;
  }
  return vec4f(col, 1.0);
}`;

let atmo = { state: 'idle', render: null, raf: null, tried: false,
             canvas: null, gpu: null, gpuCtx: null, gpuCanvas: null };

// sbAtmoMode(world) now lives in Game.leanjs (compiled by LeanJs). The
// atmosphere painters below call it with the live world + a null guard.

// Canvas-2D fallback painter (always available). The painter reads the
// LIVE canvas from atmo.canvas each frame rather than closing over one
// element: every sandbox re-render rebuilds stage.innerHTML and replaces
// #sbAtmo, so a captured element would go stale (blank on screen).
function atmo2D() {
  const parts = Array.from({length: 60}, () => ({
    x: Math.random(), y: Math.random(), s: Math.random()*2+0.5, v: Math.random()*0.5+0.2, init: false
  }));
  return (t) => {
    const canvas = atmo.canvas; if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    for (const p of parts) if (!p.init) { p.x *= W; p.y *= H; p.init = true; }
    const m = state.world ? sbAtmoMode(state.world) : 0;
    const g = ctx.createLinearGradient(0,0,0,H);
    if (m===1){ g.addColorStop(0,'#3a0d02'); g.addColorStop(1,'#c65214'); }
    else if (m===2){ g.addColorStop(0,'#5a4527'); g.addColorStop(1,'#3f3018'); }
    else if (m===3){ g.addColorStop(0,'#2a2f3a'); g.addColorStop(1,'#141820'); }
    else { g.addColorStop(0,'#241610'); g.addColorStop(1,'#0d0d16'); }
    ctx.fillStyle = g; ctx.fillRect(0,0,W,H);
    ctx.fillStyle = m===3 ? 'rgba(230,240,255,0.9)' : (m===1 ? 'rgba(255,180,90,0.8)' : 'rgba(200,180,140,0.5)');
    for (const p of parts) {
      if (m===1) { p.y -= p.v*2; if (p.y<0){ p.y=H; p.x=Math.random()*W; } }
      else if (m===2) { p.x -= p.v*3; if (p.x<0){ p.x=W; p.y=Math.random()*H; } }
      else { p.y += p.v; if (p.y>H){ p.y=0; p.x=Math.random()*W; } }
      ctx.fillRect(p.x, p.y, p.s, p.s);
    }
  };
}

async function atmoWebGPU() {
  if (!navigator.gpu) return null;
  // Build device + pipeline once and cache them; only the canvas context
  // is per-element and gets (re)configured inside the render closure when
  // a re-render swaps #sbAtmo for a fresh canvas.
  if (!atmo.gpu) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    // A software/fallback adapter (SwiftShader) reports success but often
    // renders black; use the Canvas-2D path there instead.
    if (!adapter || adapter.isFallbackAdapter) return null;
    const device = await adapter.requestDevice();
    const format = navigator.gpu.getPreferredCanvasFormat();
    device.pushErrorScope('validation');
    const mod = device.createShaderModule({ code: ATMO_WGSL });
    const pipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    });
    const err = await device.popErrorScope();
    if (err) return null;   // WGSL/pipeline invalid → caller uses 2D
    const ubuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
    atmo.gpu = { device, format, pipe, ubuf, bind };
  }
  const { device, format, pipe, ubuf, bind } = atmo.gpu;
  return (t) => {
    const canvas = atmo.canvas; if (!canvas) return;
    // Re-getContext + reconfigure whenever the live canvas element differs
    // from the one we last configured (i.e. after a sandbox re-render).
    let ctx = atmo.gpuCtx;
    if (atmo.gpuCanvas !== canvas || !ctx) {
      ctx = canvas.getContext('webgpu');
      if (!ctx) return;
      ctx.configure({ device, format, alphaMode: 'opaque' });
      atmo.gpuCtx = ctx; atmo.gpuCanvas = canvas;
    }
    device.queue.writeBuffer(ubuf, 0, new Float32Array([t, state.world ? sbAtmoMode(state.world) : 0, canvas.width, canvas.height]));
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: {r:0,g:0,b:0,a:1}, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
    device.queue.submit([enc.finish()]);
  };
}

function atmoStartLoop() {
  const t0 = performance.now();
  const frame = () => {
    const c = document.getElementById('sbAtmo');
    if (state.phase !== 'sandbox' || !c || !atmo.render) { atmo.raf = null; atmo.state = 'idle'; return; }
    // Publish the live canvas so the painter (2D or WebGPU) always draws to
    // the element currently in the DOM, even after a re-render swapped it.
    atmo.canvas = c;
    atmo.render((performance.now() - t0) / 1000);
    atmo.raf = requestAnimationFrame(frame);
  };
  atmo.raf = requestAnimationFrame(frame);
}

function wireAtmo() {
  const c = document.getElementById('sbAtmo');
  if (state.phase !== 'sandbox' || !c) {
    if (atmo.raf) { cancelAnimationFrame(atmo.raf); atmo.raf = null; }
    atmo.state = 'idle'; atmo.canvas = null;
    return;
  }
  // The painter re-acquires the live canvas each frame, so a single running
  // loop survives re-renders — no need to re-init when #sbAtmo is swapped.
  if (atmo.state === 'running' && atmo.raf) return;
  if (atmo.state === 'starting') return;
  atmo.state = 'starting'; atmo.canvas = c;
  const begin2D = () => { atmo.render = atmo2D(); atmo.state = 'running'; atmoStartLoop(); };
  if (atmo.tried && !navigator.gpu) { begin2D(); return; }
  atmo.tried = true;
  (async () => {
    let r = null;
    try { r = await atmoWebGPU(); } catch (e) { r = null; }
    if (r) { atmo.render = r; atmo.state = 'running'; atmoStartLoop(); }
    else begin2D();
  })();
}

// ─── Sandbox "わさわさ" agent sim (Canvas 2D). Little figures mill
// about the camp; the crowd's faction colours track the world's
// territory (flip a region and the mix visibly shifts). Purely
// ephemeral animation state — never touches the pure `state`. ───────
let sbSim = { agents: [], raf: null, w: 520, h: 150 };
// Faction colours (sbColor), notable labels (sbNotableLabel), and target
// counts (sbTargetCounts) all live in Game.leanjs now.
// Crowd-sim roster (sbSpawn / sbRebalance / sbSeed), per-frame movement
// (sbStepAgents), and the figure drawing (sbDrawFigure) all now live in
// Game.leanjs (compiled by LeanJs: do / for / while / let mut, with the
// canvas calls as thin externs). This host loop owns the live canvas,
// the rAF tick, and the draw-order sort. sbSim.w is the stage width.
function wireSandboxSim() {
  if (state.phase !== 'sandbox') {
    if (sbSim.raf !== null) { cancelAnimationFrame(sbSim.raf); sbSim.raf = null; }
    sbSim.agents = [];
    return;
  }
  if (!document.getElementById('sbStage')) return;
  if (sbSim.agents.length === 0 && state.world) sbSim.agents = sbSeed(state.world, sbSim.w);
  if (sbSim.raf !== null) return;   // loop already running
  let frames = 0;
  function frame() {
    // Re-acquire the canvas every frame: each sandbox re-render rebuilds
    // stage.innerHTML, replacing #sbStage with a fresh element. A context
    // captured once would keep drawing to the detached old canvas (blank
    // on screen). Grab the live element + its 2D context each tick.
    const c = document.getElementById('sbStage');
    if (state.phase !== 'sandbox' || !c) {
      sbSim.raf = null; return;
    }
    const ctx = c.getContext('2d');
    frames++;
    // track territory ~1.5s; advance walk one frame (both compiled LeanJs)
    if (frames % 90 === 0 && state.world) sbSim.agents = sbRebalance(sbSim.agents, state.world, sbSim.w);
    sbSim.agents = sbStepAgents(sbSim.agents, c.width);
    ctx.clearRect(0, 0, c.width, c.height);
    // ground line
    ctx.strokeStyle = '#2a2318'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, 68); ctx.lineTo(c.width, 68); ctx.stroke();
    // sort by y so nearer figures draw on top
    const drawn = sbSim.agents.slice().sort((p, q) => p.y - q.y);
    for (const a of drawn) sbDrawFigure(ctx, a);
    sbSim.raf = requestAnimationFrame(frame);
  }
  sbSim.raf = requestAnimationFrame(frame);
}

// ─── In-browser AI game master (WebLLM / WebGPU) ────────────────────
// Runs the game master entirely in the player's browser: no server, no
// API cost, works from a static host. Returns the same {narration,
// deltas} shape as /api/gm, so the rest of the pipeline is unchanged.
//
// MODEL NOTE: Gemma 4 (E2B/E4B) is not yet in WebLLM's prebuilt list
// (mlc-ai/web-llm#810 — needs an MLC WebGPU compile). We default to a
// ready prebuilt model; swap WEBLLM_MODEL to a Gemma-4 build once it's
// available (or self-compiled + hosted) — nothing else changes.
const WEBLLM_MODEL = 'gemma-2-2b-it-q4f16_1-MLC';   // ← swap for gemma4 when built
const GM_SYSTEM =
  'あなたは紀元前206年、楚漢戦争サンドボックスのゲームマスター。プレイヤーの自由な行動を読み、' +
  '世界の反応を即興で描き、盤面の変化を返す。人物の性格（項羽=誇り高い武人、韓信=野心家、' +
  '呂雉=冷徹、范増=老獪）と勢力の力関係に照らし、笑い・葛藤・驚き、時にどんでん返しを混ぜる。\n' +
  '地域ID: guanzhong xianyang hanzhong bashu pengcheng wei zhao qi / 勢力ID: han chu qin lords\n' +
  '返答は必ず次のJSON1行のみ（前後に何も付けない）:\n' +
  '{"narration":"日本語60-160字","deltas":[{"region":"地域ID","dCtrl":-25〜25の整数,"owner":"勢力ID(領有が変わる時だけ)"}]}';

let webllm = { engine: null, mod: null, ready: false, loading: false };

// Show WebLLM status on BOTH the sandbox (#gmAiStatus) and the story
// chat/resolve screens (#llmAiStatus) — otherwise the ~1GB download looks
// frozen wherever the matching element isn't present.
function gmAiStatus(msg) {
  const a = document.getElementById('gmAiStatus');
  if (a) a.textContent = msg;
  const b = document.getElementById('llmAiStatus');
  if (b) b.textContent = msg;
}

async function loadBrowserAI() {
  if (webllm.ready || webllm.loading) return;
  if (!navigator.gpu) { gmAiStatus('この端末は WebGPU 非対応（サーバ/ローカルで進行）'); return; }
  webllm.loading = true;
  gmAiStatus('AI 軍師を読み込み中…（初回のみ ~1GB DL・以後キャッシュ）');
  try {
    if (!webllm.mod) webllm.mod = await import('https://esm.run/@mlc-ai/web-llm');
    webllm.engine = await webllm.mod.CreateMLCEngine(WEBLLM_MODEL, {
      initProgressCallback: (p) => gmAiStatus('AI 軍師 読み込み: ' + (p.text || Math.round((p.progress || 0) * 100) + '%'))
    });
    webllm.ready = true;
    gmAiStatus('AI 軍師 起動済み（行動を書けば即興で応答）');
  } catch (e) {
    gmAiStatus('AI 起動失敗: ' + (e && e.message ? e.message : e) + '（サーバ/ローカルで進行）');
  } finally {
    webllm.loading = false;
  }
}

function stripFence(s) {
  const t = (s || '').trim();
  if (t.startsWith('```')) {
    const a = t.slice(t.indexOf('\n') + 1);
    return (a.endsWith('```') ? a.slice(0, -3) : a).trim();
  }
  return t;
}

async function runBrowserGM(action, world) {
  const reply = await webllm.engine.chat.completions.create({
    messages: [
      { role: 'system', content: GM_SYSTEM },
      { role: 'user', content: '【現在の盤面】\n' + world + '\n\n【行動】\n' + action }
    ],
    temperature: 0.9, max_tokens: 400
  });
  const raw = stripFence(reply.choices[0].message.content);
  const j = JSON.parse(raw);   // throws → caller falls back
  return { narration: j.narration || '（天は沈黙している）', deltas: Array.isArray(j.deltas) ? j.deltas : [],
           action: j.action || null };
}

// In-browser (WebLLM) NPC chat — same role as /api/ask, no server needed.
async function runBrowserChat(npcName, history, message) {
  const sys = 'あなたは楚漢戦争（紀元前209〜202年の中国）の登場人物「' + (npcName || '登場人物') + '」です。'
    + 'その人物として、日本語で必ず1〜3文、自然に応答してください（空の返答は禁止）。'
    + '時代や人物像を外さず、メタ発言や現代語の解説はしないこと。';
  const msgs = [{ role: 'system', content: sys }];
  // Drop empty / placeholder turns (they poison the context and make the
  // small model emit more empties) and keep only the recent history.
  const recent = (history || [])
    .filter(m => m && m.text && m.text.trim() && m.text !== '(空の応答)')
    .slice(-8);
  for (const m of recent) msgs.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
  msgs.push({ role: 'user', content: message });
  let out = '';
  for (let i = 0; i < 2 && !out; i++) {
    const r = await webllm.engine.chat.completions.create({ messages: msgs, temperature: 0.9, max_tokens: 200 });
    out = ((r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '').trim();
  }
  // Never return empty — a soft in-character line beats "(空の応答)".
  return out || (npcName + 'は、ふと言葉を呑んだ。……何かを言いかけて、やめたようだ。');
}

// In-browser (WebLLM) TRPG judgement — same shape as /api/resolve.
async function runBrowserResolve(action) {
  const sys = 'あなたは紀元前209〜202年を舞台にしたTRPGのゲームマスターです。'
    + 'プレイヤーが書いた行動を、状況・人物の性格・史実の重みに照らして3段階で判定します。'
    + 'good=うまくいく / ok=微妙な反応 / bad=失敗・致命的。'
    + '\n返答は必ず次のJSON1行のみ（前後に何も付けない）: {"outcome":"good|ok|bad","reasoning":"理由（50-150字）"}';
  const r = await webllm.engine.chat.completions.create({
    messages: [{ role: 'system', content: sys }, { role: 'user', content: '行動: ' + action }],
    temperature: 0.7, max_tokens: 200
  });
  const j = JSON.parse(stripFence(r.choices[0].message.content));   // throws → caller falls back
  return { outcome: (j.outcome === 'good' || j.outcome === 'bad') ? j.outcome : 'ok', reasoning: j.reasoning || '' };
}

// Shared: wire the "🧠 ブラウザAI起動" button + status on the story
// chat / resolve screens, so the in-browser model can be loaded there
// too (not only from the sandbox).
function wireLlmLoadButton() {
  const b = document.getElementById('llmLoadAI');
  const st = document.getElementById('llmAiStatus');
  if (webllm.ready) {
    if (st) st.textContent = 'ブラウザAI 起動済み';
    if (b) b.style.display = 'none';
    return;
  }
  // Hint only when idle — don't clobber live download progress (which
  // gmAiStatus writes here too).
  if (st && !webllm.loading && !st.textContent) st.textContent = '会話するには → 起動（初回 ~1GB・WebGPU）';
  if (!b || b.dataset.wired) return;
  b.dataset.wired = '1';
  b.addEventListener('click', () => { loadBrowserAI(); });  // progress shown via gmAiStatus
}

// ─── Sandbox game master wiring. Prefers the in-browser AI when it's
// loaded, then the server /api/gm, then the local event tables. ─────
function wireGmHandlers() {
  const load = document.getElementById('gmLoadAI');
  if (load && !load.dataset.wired) {
    load.dataset.wired = '1';
    load.addEventListener('click', loadBrowserAI);
    if (webllm.ready) gmAiStatus('AI 軍師 起動済み');
  }
  const send = document.getElementById('gmSend');
  const input = document.getElementById('gmInput');
  if (!send || !input) return;
  if (send.dataset.wired) return;
  send.dataset.wired = '1';
  const snapshot = () => {
    const w = state.world;
    if (!w) return '';
    return w.regions.map(r => r.id + '(' + r.ja + '):' + r.owner + ' ' + r.ctrl + '%').join(', ')
      + ' / BCE ' + w.year + ' ' + '春夏秋冬'[w.season];
  };
  const doSend = async () => {
    const text = input.value.trim();
    if (!text || (state.world && state.world.pending === 1)) return;
    // Free-text expedition intent ("エジプトを目指す" 等) → run the 兵站
    // model directly. Deterministic + offline; no LLM round-trip needed.
    const expTarget = (typeof sbExpeditionIntent === 'function') ? sbExpeditionIntent(text) : '';
    if (expTarget) {
      input.value = '';
      state = update({tag: 'gmSubmit', text: text}, state);       // echo ▶ 劉邦: …
      state = update({tag: 'expedition', target: expTarget}, state);  // 兵站モデル起動
      persist(state); render();
      return;
    }
    input.value = '';
    const world = snapshot();
    state = update({tag: 'gmSubmit', text: text}, state);
    persist(state); render();
    let done = false;
    // 1) in-browser AI (WebGPU) if loaded
    if (webllm.ready) {
      try {
        const r = await runBrowserGM(text, world);
        state = update({tag: 'gmResult', narration: r.narration, deltas: r.deltas, action: r.action || null}, state);
        done = true;
      } catch (e) { /* fall through to server */ }
    }
    // 2) server /api/gm
    if (!done) {
      try {
        const res = await fetch('/api/gm', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({action: text, world: world})
        });
        const j = await res.json();
        if (j.error) state = update({tag: 'gmError', text: ''}, state);
        else state = update({tag: 'gmResult', narration: j.narration || '（天は沈黙している）', deltas: j.deltas || [], action: j.action || null}, state);
        done = true;
      } catch (e) { /* 3) offline fallback */ }
    }
    if (!done) state = update({tag: 'gmError', text: ''}, state);
    persist(state); render();
  };
  send.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    // Send only on Ctrl/⌘+Enter — plain Enter fights the IME's
    // confirm-conversion key (that was clearing the field mid-typing).
    if (e.isComposing) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); }
  });
}

// ─── LLM chat wiring: send button + Enter, scroll, focus ──────────
function wireChatHandlers() {
  const send = document.getElementById('chatSend');
  const input = document.getElementById('chatInput');
  const history = document.getElementById('chatHistory');
  if (history) history.scrollTop = history.scrollHeight;
  wireLlmLoadButton();
  if (!send || !input) return;
  if (send.dataset.wired) return;
  send.dataset.wired = '1';
  const doSend = async () => {
    const text = input.value.trim();
    if (!text || state.llm.pending) return;
    input.value = '';
    const npcName = state.llm.npcName;
    const hist = state.llm.history.slice();   // before pushing the user msg
    state = update({tag: 'llmSendUser', text: text}, state);
    persist(state);
    render();
    let done = false;
    // 1) in-browser WebLLM if loaded — no server LLM needed
    if (webllm.ready) {
      try {
        const reply = await runBrowserChat(npcName, hist, text);
        state = update({tag: 'llmReply', text: reply || '(空の応答)'}, state);
        done = true;
      } catch (e) { /* fall through to server */ }
    }
    // 2) server /api/ask
    if (!done) {
      try {
        const res = await fetch('/api/ask', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({ npcId: state.llm.npcId, sceneId: state.sceneId, history: hist, message: text })
        });
        const j = await res.json();
        if (j.error) state = update({tag: 'llmError', text: j.error}, state);
        else state = update({tag: 'llmReply', text: j.reply || '(空の応答)'}, state);
        done = true;
      } catch (e) { /* fall through */ }
    }
    // 3) no LLM yet → auto-load the in-browser model (the send is the
    //    player's consent), show progress, then retry — don't just error.
    if (!done && !webllm.ready && navigator.gpu) {
      await loadBrowserAI();
      if (webllm.ready) {
        try {
          const reply = await runBrowserChat(npcName, hist, text);
          state = update({tag: 'llmReply', text: reply || '(空の応答)'}, state);
          done = true;
        } catch (e) { /* fall through */ }
      }
    }
    if (!done) state = update({tag: 'llmError',
      text: (navigator.gpu ? 'AI モデルを読み込めませんでした。' : 'この端末は WebGPU 非対応です。') + ' サーバに LLM を接続すれば会話できます。'}, state);
    persist(state);
    render();
  };
  send.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); }
  });
  input.focus();
}

// ─── TRPG aiResolve wiring — same shape as chat: send button + Enter,
// fetch /api/resolve, dispatch resolveResult or resolveError. The
// outcome label + LLM reasoning then drives the branch when the player
// clicks the rendered 次へ button (handled by the regular click
// delegation since it's a `btn-primary` with data-msg).
function wireResolveHandlers() {
  const send = document.getElementById('resolveSend');
  const input = document.getElementById('resolveInput');
  wireLlmLoadButton();
  if (!send || !input) return;
  if (send.dataset.wired) return;
  send.dataset.wired = '1';
  const doSend = async () => {
    const text = input.value.trim();
    if (!text || state.resolve.pending) return;
    input.value = '';
    state = update({tag: 'resolveSubmit', text: text}, state);
    persist(state);
    render();
    let done = false;
    // 1) in-browser WebLLM if loaded
    if (webllm.ready) {
      try {
        const v = await runBrowserResolve(text);
        state = update({tag: 'resolveResult', outcome: v.outcome, reasoning: v.reasoning || '(no reasoning)'}, state);
        done = true;
      } catch (e) { /* fall through to server */ }
    }
    // 2) server /api/resolve
    if (!done) {
      try {
        const res = await fetch('/api/resolve', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({ kind: state.resolve.kind, sceneId: state.sceneId, char: state.char, action: text })
        });
        const j = await res.json();
        if (j.error) state = update({tag: 'resolveError', text: j.error}, state);
        else state = update({tag: 'resolveResult', outcome: j.outcome || 'ok', reasoning: j.reasoning || '(no reasoning)'}, state);
        done = true;
      } catch (e) { /* fall through */ }
    }
    // 3) auto-load the in-browser model on first use, then retry.
    if (!done && !webllm.ready && navigator.gpu) {
      await loadBrowserAI();
      if (webllm.ready) {
        try {
          const v = await runBrowserResolve(text);
          state = update({tag: 'resolveResult', outcome: v.outcome, reasoning: v.reasoning || '(no reasoning)'}, state);
          done = true;
        } catch (e) { /* fall through */ }
      }
    }
    if (!done) state = update({tag: 'resolveError',
      text: (navigator.gpu ? 'AI モデルを読み込めませんでした。' : 'この端末は WebGPU 非対応です。') + ' サーバに LLM を接続すれば判定できます。'}, state);
    persist(state);
    render();
  };
  send.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); }
  });
  input.focus();
}

// Pick an SFX from a button's .btn-KIND class. One table, one place to
// edit; adding a new button kind in Game.leanjs only needs an entry
// here (and a CSS variant) — no per-msg.tag plumbing.
// Button-kind → sfx-id mapping now lives in Game.leanjs as
// sfxForKind(kind) (compiled by LeanJs). This stays host-side because it
// walks the DOM element's classList.
function sfxForButton(btn) {
  if (!btn || !window.chuhanAudio) return;
  for (const cls of btn.classList) {
    if (cls.startsWith('btn-')) {
      const id = sfxForKind(cls.slice(4));
      if (id) { window.chuhanAudio.sfx(id); return; }
    }
  }
}

// Image 404 → loud .missing-asset placeholder so the gap is impossible
// to miss in-game. The server-side asset audit (Serve.lean) also lists
// these to MISSING_ASSETS.txt at boot.
stage.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.tagName === 'IMG') {
    const name = t.getAttribute('alt') || t.getAttribute('src') || 'asset';
    const div = document.createElement('div');
    div.className = 'missing-asset';
    div.dataset.name = name;
    div.title = 'MISSING_ASSET: ' + name;
    div.textContent = '? ' + name;
    t.replaceWith(div);
  }
}, true);

// Event delegation — every interactive element has a data-msg attr
// whose value is a JSON-encoded message we pass to update().
stage.addEventListener('click', (e) => {
  let t = e.target;
  while (t && t !== stage) {
    if (t.dataset && t.dataset.msg) {
      const msg = JSON.parse(t.dataset.msg);
      // Server-backed save slots + save-code entry are async host actions;
      // handle them here and skip the pure update() path.
      const sm = /^saveSlot([123])$/.exec(msg.tag || '');
      const lm = /^loadSlot([123])$/.exec(msg.tag || '');
      if (sm) { sfxForButton(t); serverSaveSlot(+sm[1]); return; }
      if (lm) { sfxForButton(t); serverLoadSlot(+lm[1]); return; }
      if (msg.tag === 'applySaveCode') { sfxForButton(t); applySaveCodeFromInput(); return; }
      if (msg.tag === 'openLeaderboard') { sfxForButton(t); openLeaderboard(); return; }
      const prevPhase = state.phase;
      sfxForButton(t);
      state = update(msg, state);
      // Opening the save menu → refresh slot previews from the server.
      if (msg.tag === 'toggleSaveMenu' && state.flags && state.flags._saveMenuOpen) {
        refreshServerSlots().then(render);
      }
      // A sandbox run just ended → record it on the leaderboard (once).
      if (state.phase === 'sbEnd' && prevPhase !== 'sbEnd') submitScore();
      if (prevPhase === 'sbEnd' && state.phase !== 'sbEnd') lastScoredEnd = '';
      // Chime once when a fresh ending unlocks.
      if (state.phase === 'ending' && prevPhase !== 'ending') {
        window.chuhanAudio && window.chuhanAudio.sfx('chime');
      }
      persist(state);
      render();
      return;
    }
    t = t.parentNode;
  }
});

// Keyboard: space/enter advances dialogue; arrow keys in battle.
document.addEventListener('keydown', (e) => {
  // Don't hijack Space/Enter while the player is typing in a field (the
  // free-text GM input etc.) or mid-IME-composition — that was resetting
  // the input on every space/enter. Let the field handle its own keys.
  const t = e.target;
  if (e.isComposing || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return;
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    const prevPhase = state.phase;
    window.chuhanAudio && window.chuhanAudio.sfx('page');
    state = update({tag: 'advance'}, state);
    if (state.phase === 'ending' && prevPhase !== 'ending') {
      window.chuhanAudio && window.chuhanAudio.sfx('chime');
    }
    persist(state);
    render();
  } else if (state.phase === 'battle') {
    if (e.key === 'ArrowUp' || e.key === 'w')    state = update({tag: 'move', dx: 0,  dy: -1}, state);
    if (e.key === 'ArrowDown' || e.key === 's')  state = update({tag: 'move', dx: 0,  dy: 1}, state);
    if (e.key === 'ArrowLeft' || e.key === 'a')  state = update({tag: 'move', dx: -1, dy: 0}, state);
    if (e.key === 'ArrowRight' || e.key === 'd') state = update({tag: 'move', dx: 1,  dy: 0}, state);
    if (e.key === 'z' || e.key === 'j') {
      window.chuhanAudio && window.chuhanAudio.sfx('clash');
      state = update({tag: 'attack'}, state);
    }
    persist(state);
    if (state.phase === 'battle') {
      renderBattle();
    } else {
      render();
    }
  }
});

// ─── Mini-game: jade_ring real-time tick loop ─────────────────────
let ringRafHandle = null;
let ringStartWallMs = 0;
function maybeStartRingLoop() {
  if (state.phase === 'minigame' && state.mini && state.mini.kind === 'jade_ring') {
    if (ringRafHandle !== null) return;
    ringStartWallMs = performance.now();
    function frame() {
      if (state.phase !== 'minigame' || !state.mini || state.mini.kind !== 'jade_ring' || state.mini.ringFinished) {
        ringRafHandle = null;
        // re-render once finished to show the result
        if (state.phase === 'minigame') render();
        return;
      }
      const now = performance.now() - ringStartWallMs;
      state = update({tag: 'miniRingTick', now: now}, state);
      // Re-render the jade-ring view inline (cheap — small DOM).
      // NB: the panel class is `.panel-mini` now, not the historical
      // `.mini-card`. Keep these two in sync with the panel helper.
      const card = stage.querySelector('.panel-mini');
      if (card) card.outerHTML = (function() {
        const fragHtml = view(state);
        const tmp = document.createElement('div');
        tmp.innerHTML = fragHtml;
        const c = tmp.querySelector('.panel-mini');
        return c ? c.outerHTML : fragHtml;
      })();
      ringRafHandle = requestAnimationFrame(frame);
    }
    ringRafHandle = requestAnimationFrame(frame);
  } else if (ringRafHandle !== null && (!state.mini || state.mini.kind !== 'jade_ring')) {
    cancelAnimationFrame(ringRafHandle);
    ringRafHandle = null;
  }
}

// ─── Battle render — separate from main DOM render so we can use
// requestAnimationFrame for smooth motion + tick the AI. ────────
let battleRafHandle = null;
function renderBattle() {
  render();  // emit canvas element via view()
  const c = document.getElementById('battleCanvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  function frame() {
    if (state.phase !== 'battle') { battleRafHandle = null; return; }
    state = update({tag: 'tick', ms: 16}, state);
    drawBattle(ctx, c.width, c.height, state.battle);
    battleRafHandle = requestAnimationFrame(frame);
  }
  if (battleRafHandle === null) battleRafHandle = requestAnimationFrame(frame);
}

// drawBattle(ctx, W, H, b) now lives in Game.leanjs — ported to LeanJs
// do / for loops over the grid + entities + fx, with the canvas calls
// as thin externs. renderBattle() below calls the compiled version.

// Subscribe to phase changes so the battle loop kicks in once we
// enter `phase === 'battle'` from a dialogue choice.
function maybeStartBattle() {
  if (state.phase === 'battle' && battleRafHandle === null) {
    requestAnimationFrame(() => renderBattle());
  }
}

// Wrap render so phase transitions to battle bootstrap the loop.
const origRender = render;
window.render = function() {
  origRender();
  maybeStartBattle();
};

render();
