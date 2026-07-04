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
  wireStoryImprov();
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
    "<div style='color:#9a8d73;font-size:12px;margin-top:6px'>← → / A D = 間合い ・ J / Space = 斬りかかる ・ K / S = 受け(ガード) ・ ESC = 退却</div>" +
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
    st.over ? (st.win ? '― 勝利！ 敵将を討ち取った' : '― 敗走…')
            : (st.pName + '  ' + Math.round(st.p.hp) + '  対  ' + Math.round(st.e.hp) + '  ' + st.eName);
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
  // 自軍将 × 敵将の名前を盤面から決める。
  let pName = '我が将', eName = '敵将';
  try {
    const pf = sbPlayerFaction(state.world.who);
    const ef = (pf === 'han') ? 'chu' : 'han';
    pName = state.world.who; eName = sbNotableLabel(ef);
  } catch (e) {}
  action.st = actionInitState(c.width, c.height, pName, eName);   // compiled LeanJs
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

// ─── In-browser scene illustration: Stable Diffusion 2.1-base txt2img on
// onnxruntime-web's WebGPU EP, straight from the locally-served /models.
// Opt-in, cached, non-blocking. We drive the ONNX sessions ourselves
// (CLIP tokenizer + Euler scheduler + classifier-free guidance + VAE) —
// the old @aislamov/diffusers.js wrapper is unusable on current Chrome:
// its bundled onnxruntime-web calls `new WebAssembly.Function(...)`, a
// WASM type-reflection API Chrome no longer provides, so its WebGPU
// backend can't init (verified via CDP on real Chrome + real GPU). The
// modern ort-web build below has no such dependency and loads the exact
// same model files. If WebGPU is absent or anything throws we just skip
// it; the shader/SVG/sim visuals carry the scene regardless.
const IMG_ORT_URL  = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.mjs';
const IMG_ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const IMG_BASE  = '/models/aislamov/stable-diffusion-2-1-base-onnx/';
const IMG_STEPS = 12;                          // ~1.3s/step on WebGPU (2 unet passes)
let imggen = { ort: null, enc: null, unet: null, vae: null, tok: null, ready: false, loading: false, busy: false };

function imgStatus(msg) {
  const s = document.getElementById('imgStatus');
  if (s) s.textContent = msg;
}

// scenePrompt logic now lives in Game.leanjs as sbScenePrompt(world) —
// compiled by LeanJs. This is only the host-side null guard.
function scenePrompt() {
  return state.world ? sbScenePrompt(state.world) : '';
}

// CLIP BPE tokenizer (vocab.json + merges.txt) → 77 int32 token ids.
function imgMakeTokenizer(vocab, mergesTxt) {
  const merges = mergesTxt.split('\n').slice(1).filter(l => l && !l.startsWith('#'));
  const ranks = new Map(merges.map((m, i) => [m, i]));
  const BOS = 49406, EOS = 49407, MAXLEN = 77;
  const pat = /'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;
  const getPairs = (w) => { const s = new Set(); for (let i = 0; i < w.length - 1; i++) s.add(w[i] + ' ' + w[i + 1]); return s; };
  function bpe(token) {
    let word = token.split('');
    word[word.length - 1] = word[word.length - 1] + '</w>';
    while (true) {
      const pairs = getPairs(word);
      let best = null, bestRank = Infinity;
      for (const p of pairs) { const r = ranks.get(p); if (r !== undefined && r < bestRank) { bestRank = r; best = p; } }
      if (best === null) break;
      const [a, b] = best.split(' ');
      const nw = []; let i = 0;
      while (i < word.length) {
        if (i < word.length - 1 && word[i] === a && word[i + 1] === b) { nw.push(a + b); i += 2; }
        else { nw.push(word[i]); i += 1; }
      }
      word = nw;
      if (word.length === 1) break;
    }
    return word;
  }
  return function encode(text) {
    const ids = [BOS];
    text = (text || '').toLowerCase().trim();
    for (const m of text.matchAll(pat)) for (const piece of bpe(m[0])) { const id = vocab[piece]; if (id !== undefined) ids.push(id); }
    ids.push(EOS);
    const out = ids.slice(0, MAXLEN);
    while (out.length < MAXLEN) out.push(EOS);
    return out;
  };
}

// EulerDiscrete schedule for scaled-linear betas (SD-2.1 base).
let imgSigmasFull = null;
function imgSigmaTable() {
  if (imgSigmasFull) return imgSigmasFull;
  const n = 1000, bS = 0.00085, bE = 0.012, out = [];
  let a = 1;
  for (let i = 0; i < n; i++) { const t = i / (n - 1); const beta = Math.pow(Math.sqrt(bS) + t * (Math.sqrt(bE) - Math.sqrt(bS)), 2); a *= (1 - beta); out.push(Math.sqrt((1 - a) / a)); }
  imgSigmasFull = out; return out;
}
function imgSetTimesteps(steps) {
  const full = imgSigmaTable(), n = full.length, sigmas = [], tsteps = [];
  for (let i = 0; i < steps; i++) {
    const t = (n - 1) * (1 - i / (steps - 1 || 1));
    const lo = Math.floor(t), hi = Math.min(lo + 1, n - 1), frac = t - lo;
    sigmas.push(full[lo] * (1 - frac) + full[hi] * frac);
    tsteps.push(t);
  }
  sigmas.push(0);
  return { sigmas, tsteps, initNoiseSigma: sigmas[0] };
}
// unet expects a discrete training timestep; map a sigma to nearest index.
function imgSigmaToT(sigma) {
  const full = imgSigmaTable(); let best = 0, bd = Infinity;
  for (let i = 0; i < full.length; i++) { const d = Math.abs(full[i] - sigma); if (d < bd) { bd = d; best = i; } }
  return best;
}

let imggenLoadPromise = null;   // shared so a 2nd genScene() awaits the same load
async function loadImgGen() {
  if (imggen.ready) return true;
  // Load already running: await it and report the resulting readiness,
  // rather than early-returning false (the "1st click does nothing" bug).
  if (imggen.loading) { if (imggenLoadPromise) { try { await imggenLoadPromise; } catch (_) {} } return imggen.ready; }
  if (!navigator.gpu) { imgStatus('この端末は WebGPU 非対応（絵はスキップ）'); return false; }
  imggen.loading = true;
  imgStatus('画家を読み込み中…（サーバの /models から。初回のみ）');
  imggenLoadPromise = (async () => {
  try {
    const base = location.origin + IMG_BASE;
    const buf = async (u) => { const r = await fetch(base + u); if (!r.ok) throw new Error('fetch ' + r.status + ' ' + u); return r.arrayBuffer(); };
    imgStatus('画家 読み込み: runtime');
    imggen.ort = await import(IMG_ORT_URL);
    imggen.ort.env.wasm.wasmPaths = IMG_ORT_WASM;
    const opt = { executionProviders: ['webgpu'] };
    imgStatus('画家 読み込み: tokenizer');
    imggen.tok = imgMakeTokenizer(await (await fetch(base + 'tokenizer/vocab.json')).json(),
                                  await (await fetch(base + 'tokenizer/merges.txt')).text());
    imgStatus('画家 読み込み: text_encoder');
    imggen.enc = await imggen.ort.InferenceSession.create(await buf('text_encoder/model.onnx'), opt);
    imgStatus('画家 読み込み: unet（~1.75GB）');
    imggen.unet = await imggen.ort.InferenceSession.create(await buf('unet/model.onnx'), opt);
    imgStatus('画家 読み込み: vae');
    const vaeData = new Uint8Array(await buf('vae_decoder/model.onnx_data'));  // external weights
    imggen.vae = await imggen.ort.InferenceSession.create(await buf('vae_decoder/model.onnx'),
      { executionProviders: ['webgpu'], externalData: [{ path: 'model.onnx_data', data: vaeData }] });
    imggen.ready = true;
    imgStatus('画家 起動済み');
  } catch (e) {
    const em = (e && e.message ? e.message : String(e));
    imgStatus('画像生成の起動に失敗しました（' + em.slice(0, 70) + '）。進行には影響しません。');
  } finally {
    imggen.loading = false;
  }
  })();
  await imggenLoadPromise;
  return imggen.ready;
}

async function imgEmbed(text) {
  const ids = imggen.tok(text);
  const out = await imggen.enc.run({ input_ids: new imggen.ort.Tensor('int32', Int32Array.from(ids), [1, 77]) });
  return out[imggen.enc.outputNames[0]];   // last_hidden_state [1,77,1024]
}

// Core WebGPU txt2img: prompt → 512x512 ImageData. Assumes imggen.ready.
// Shared by the sandbox scene (#sbScene) and the story background painter.
async function imgGenerate(prompt) {
  const Tensor = imggen.ort.Tensor;
  const H = 512, W = 512, LH = 64, LW = 64, C = 4, n = C * LH * LW, guidance = 7.5;
  const condE = await imgEmbed(prompt);
  const uncondE = await imgEmbed('lowres, blurry, ugly, deformed, text, watermark');
  const { sigmas, initNoiseSigma } = imgSetTimesteps(IMG_STEPS);
  const lat = new Float32Array(n);
  let seed = ((Date.now() & 0xffff) ^ 0x9e37) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; const u1 = (seed >>> 8) / 16777216; seed = (seed * 1664525 + 1013904223) >>> 0; const u2 = (seed >>> 8) / 16777216; return Math.sqrt(-2 * Math.log(u1 + 1e-9)) * Math.cos(6.283185 * u2); };
  for (let i = 0; i < n; i++) lat[i] = rnd() * initNoiseSigma;
  for (let s = 0; s < IMG_STEPS; s++) {
    const sigma = sigmas[s], cIn = 1 / Math.sqrt(sigma * sigma + 1);
    const scaled = new Float32Array(n); for (let i = 0; i < n; i++) scaled[i] = lat[i] * cIn;
    const sample = new Tensor('float32', scaled, [1, C, LH, LW]);
    const ts = new Tensor('float32', Float32Array.from([imgSigmaToT(sigma)]), [1]);
    const rc = await imggen.unet.run({ sample, timestep: ts, encoder_hidden_states: condE });
    const ru = await imggen.unet.run({ sample, timestep: ts, encoder_hidden_states: uncondE });
    const nc = rc[imggen.unet.outputNames[0]].data, nu = ru[imggen.unet.outputNames[0]].data;
    const dt = sigmas[s + 1] - sigma;
    for (let i = 0; i < n; i++) {
      const noise = nu[i] + guidance * (nc[i] - nu[i]);
      const denoised = lat[i] - sigma * noise;            // x0 prediction
      lat[i] = lat[i] + ((lat[i] - denoised) / sigma) * dt; // Euler step
    }
    imgStatus('描画 ' + (s + 1) + '/' + IMG_STEPS);
  }
  const dl = new Float32Array(n); for (let i = 0; i < n; i++) dl[i] = lat[i] / 0.18215;
  const dec = await imggen.vae.run({ latent_sample: new Tensor('float32', dl, [1, C, LH, LW]) });
  const px = dec[imggen.vae.outputNames[0]].data;          // [1,3,512,512] in [-1,1]
  const out = new Uint8ClampedArray(W * H * 4), plane = W * H;
  for (let i = 0; i < plane; i++) {
    out[i * 4] = (px[i] * 0.5 + 0.5) * 255;
    out[i * 4 + 1] = (px[plane + i] * 0.5 + 0.5) * 255;
    out[i * 4 + 2] = (px[2 * plane + i] * 0.5 + 0.5) * 255;
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, W, H);
}

async function genScene() {
  if (imggen.busy) return;
  if (!imggen.ready) { const ok = await loadImgGen(); if (!ok) return; }
  imggen.busy = true;
  imgStatus('筆を執っている…');
  try {
    const img = await imgGenerate(scenePrompt());
    imggen.lastImg = img;
    const canvas = document.getElementById('sbScene');
    if (canvas) {
      canvas.width = 512; canvas.height = 512;
      canvas.getContext('2d').putImageData(img, 0, 0);
      canvas.style.display = 'block';
      const det = canvas.closest('details'); if (det) det.open = true;
      imgStatus('（情景 更新）');
    } else imgStatus('（キャンバス未検出）');
  } catch (e) {
    imgStatus('描画失敗: ' + (e && e.message ? e.message : e));
  } finally {
    imggen.busy = false;
  }
}

// ─── Story improv: the player takes the brush and the MAIN story continues
// by improvisation — same dialogue box, same background, one flow. The LLM
// narrates the next beat from the running history; the scene image repaints.
let storyImprov = { bg: null, history: [], seeded: false, busy: false };

// 史記(公有原文断片)を寄る辺に。/assets/shiji.json を一度だけ読み、場面に
// 合う断片を選んで LLM プロンプトへ差し込み、地の文・台詞を史実へ寄せる。
let shiji = { list: null, loading: null };
async function loadShiji() {
  if (shiji.list) return;
  if (!shiji.loading) shiji.loading = fetch('/assets/shiji.json')
    .then(r => r.json()).then(j => { shiji.list = j.fragments || []; })
    .catch(() => { shiji.list = []; });
  await shiji.loading;
}
function shijiFor(charId, text) {
  if (!shiji.list || !shiji.list.length) return null;
  const cand = shiji.list.filter(f => !f.chars || f.chars.indexOf(charId) >= 0);
  const pool = cand.length ? cand : shiji.list;
  const hit = pool.find(f => f.match && new RegExp(f.match).test(text || ''));
  return hit || pool[Math.floor(Math.random() * pool.length)];
}

// Continue the story: given the running history + the player's action, write
// the next narrative beat (地の文), keeping character + period voice.
async function runBrowserStoryContinue(ctx, action) {
  const frag = shijiFor(ctx.charId, (ctx.history || []).map(h => h.content).join(' ') + ' ' + action);
  const beats = Math.floor(((ctx.history || []).length) / 2);   // how far in we are
  const climax = beats >= 4;                                    // start converging on the milestone
  const sys = 'あなたは楚漢戦争(紀元前3世紀の中国)を舞台にした対話型歴史小説の語り手。' +
    'プレイヤーは' + (ctx.char || '主人公') + '。その行動・台詞を受け、物語を次の一段へ確かに進める。' +
    '地の文だけでなく、その場に居る人物には「」で肉声を語らせよ(項羽は誇り高く、范増は老獪、韓信は野心的、呂雉は冷徹…性格を守れ)。' +
    (ctx.persona ? ('関わる人物: ' + ctx.persona + '。') : '') +
    (frag ? ('この物語はやがて史記の一場面へ向かう――「' + frag.han + '」(' + frag.gloss + ')。'
             + (climax ? 'そろそろその核心へ雪崩れ込ませ、緊張を高めよ。' : 'そこへ緩やかに引き寄せつつ、性急にはしない。')) : '') +
    '厳守: 日本語で2〜4文・80〜180字。情景・人物の台詞・反応を描き、次の緊張や選択の余韻で締める。' +
    '説明・箇条書き・JSON・同じ表現の繰り返しは禁止。';
  const msgs = [{ role: 'system', content: sys }];
  for (const h of (ctx.history || []).slice(-8)) msgs.push(h);
  msgs.push({ role: 'user', content: (ctx.char || '主人公') + 'は――' + action });
  const r = await webllm.engine.chat.completions.create({ messages: msgs, temperature: 0.85, max_tokens: 260 });
  let t = (r.choices[0].message.content || '').trim();
  const parts = t.split(/(?<=。|」)/).filter(x => x.trim());
  t = parts.slice(0, 4).join('').trim();
  return (t.length > 220 ? t.slice(0, 218) + '…' : t) || '（沈黙が流れた）';
}

// Close the improvised arc with a resonant ending, weighted by 史記.
async function runBrowserStoryEnding(ctx) {
  const frag = shijiFor(ctx.charId, (ctx.history || []).map(h => h.content).join(' '));
  const sys = 'あなたは楚漢戦争の講談師。これまでのアドリブ物語に、余韻ある結末を与えよ。' +
    (ctx.char || '主人公') + 'のこの道行きがどこへ辿り着いたかを、史実の重み' +
    (frag ? ('(「' + frag.han + '」――' + frag.gloss + ')') : '') + 'を踏まえて描く。' +
    '大団円でも悲劇でもよい。厳守: 日本語で3〜4文・100〜200字、地の文と肉声、余韻で締める。JSON・箇条書き禁止。';
  const msgs = [{ role: 'system', content: sys }];
  for (const h of (ctx.history || []).slice(-8)) msgs.push(h);
  msgs.push({ role: 'user', content: 'この物語をここで結べ。' });
  const r = await webllm.engine.chat.completions.create({ messages: msgs, temperature: 0.9, max_tokens: 320 });
  let t = (r.choices[0].message.content || '').trim();
  const parts = t.split(/(?<=。|」)/).filter(x => x.trim());
  t = parts.slice(0, 5).join('').trim();
  return (t.length > 240 ? t.slice(0, 238) + '…' : t) || '物語は、静かに幕を下ろした。';
}

// Paint a story background from a prompt and pin it behind the scene.
async function genStoryBg(promptText) {
  if (!webllm && false) return;
  if (imggen.busy) return;
  if (!imggen.ready) { const ok = await loadImgGen(); if (!ok) return; }
  imggen.busy = true;
  try {
    storyImprov.bg = await imgGenerate('sumi-e ink wash painting, ' + promptText + ', Chu-Han war era China 200 BCE, muted ink tones, atmospheric, cinematic');
    applyStoryBg();
  } catch (e) { /* leave the static bg */ } finally { imggen.busy = false; }
}

// Re-apply the painted background after a re-render (render() rebuilds #stage).
function applyStoryBg() {
  if (!storyImprov.bg) return;
  const el = document.querySelector('.scene-bg');
  if (!el) return;
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
  cv.getContext('2d').putImageData(storyImprov.bg, 0, 0);
  el.style.backgroundImage = 'url(' + cv.toDataURL('image/jpeg', 0.85) + ')';
  el.style.backgroundSize = 'cover';
  el.style.backgroundPosition = 'center';
}

const IMPROV_PERSONA_BY_NAME = { '妙容': 'miaorong', '蕭何': 'xiaohe', '范増': 'fanzeng', '黄石公': 'huangshi', '項伯': 'xiangbo', '蒯通': 'kuaitong' };
const IMPROV_CHAR_NAME = { liubang: '劉邦', xiangyu: '項羽', hanxin: '韓信', zhangliang: '張良', xiaohe: '蕭何', fanzeng: '范増' };

// Wired every scene render. When improv has taken over (state.improv.on), the
// dialogue box IS the story: the player's action → LLM continues the main
// narrative (improvBeat) → repaint the background. Same box, one flow.
function wireStoryImprov() {
  if (state.phase !== 'scene') return;
  const on = state.improv && state.improv.on;
  if (!on) { storyImprov.seeded = false; return; }
  applyStoryBg();                                  // keep the painted bg pinned
  if (!storyImprov.seeded) {                        // entering improv: seed history from the current line
    storyImprov.history = [{ role: 'assistant', content: state.improv.text || '' }];
    storyImprov.seeded = true;
    loadShiji();                                    // pull the 史記 fragments for grounding
  }
  const input = document.getElementById('improvGo');
  const go = document.getElementById('improvGoBtn');
  const st = document.getElementById('improvStatus');
  const step = (typeof stepAt === 'function') ? stepAt(sceneOf(state.sceneId), state.beat) : {};
  const who = step.who || '';
  const ctx = { char: IMPROV_CHAR_NAME[state.char] || state.char, charId: state.char, persona: NPC_PERSONA[IMPROV_PERSONA_BY_NAME[who]] || '' };
  // ▣ 物語を結ぶ: give the improvised arc a payoff (a coherent ending beat).
  const fin = document.getElementById('improvFinish');
  if (fin && !fin.dataset.wired) {
    fin.dataset.wired = '1';
    fin.addEventListener('click', async () => {
      if (storyImprov.busy) return;
      if (!webllm.ready && navigator.gpu) { if (st) st.textContent = 'AI 読み込み中…'; await loadBrowserAI(); }
      if (!webllm.ready) { if (st) st.textContent = 'AI 起動が必要（WebGPU）'; return; }
      storyImprov.busy = true;
      if (st) st.textContent = '……物語が結ばれる';
      try {
        ctx.history = storyImprov.history;
        const end = await runBrowserStoryEnding(ctx);
        storyImprov.history.push({ role: 'assistant', content: end });
        state = update({ tag: 'improvBeat', text: '― 結 ―\n' + end }, state);
        persist(state); render();
        const bgp = (typeof sbSceneEn === 'function') ? sbSceneEn(end) : 'an epic finale, ink wash';
        genStoryBg(bgp).then(() => render());
      } catch (e) { if (st) st.textContent = '（結末生成に失敗）'; }
      storyImprov.busy = false;
    });
  }
  if (!input || !go || go.dataset.wired) return;
  go.dataset.wired = '1';
  const step2 = async () => {
    const text = input.value.trim();
    if (!text || storyImprov.busy) return;
    input.value = '';
    if (!webllm.ready && navigator.gpu) { if (st) st.textContent = 'AI 読み込み中…'; await loadBrowserAI(); }
    if (!webllm.ready) { if (st) st.textContent = 'AI 起動が必要（WebGPU）'; return; }
    storyImprov.busy = true;
    if (st) st.textContent = '……物語が動く';
    try {
      ctx.history = storyImprov.history;
      const beat = await runBrowserStoryContinue(ctx, text);
      storyImprov.history.push({ role: 'user', content: text });
      storyImprov.history.push({ role: 'assistant', content: beat });
      state = update({ tag: 'improvBeat', text: beat }, state);  // the new beat IS the story now
      persist(state); render();
      const bgp = (typeof sbSceneEn === 'function') ? sbSceneEn(beat + ' ' + text) : 'an ancient Chinese scene, banners';
      genStoryBg(bgp).then(() => render());
    } catch (e) { if (st) st.textContent = '（応答に失敗）'; }
    storyImprov.busy = false;
  };
  go.addEventListener('click', step2);
  input.addEventListener('keydown', (e) => { if (e.isComposing) return; if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); step2(); } });
}

// render() rebuilds #stage, so the freshly-created #sbScene canvas is blank
// after every game action — re-draw the last generated image so there's no
// blank gap while a fresh scene image is (re)painting.
function restoreScene() {
  if (!imggen.lastImg) return;
  const cv = document.getElementById('sbScene');
  if (!cv) return;
  cv.width = imggen.lastImg.width; cv.height = imggen.lastImg.height;
  cv.getContext('2d').putImageData(imggen.lastImg, 0, 0);
  cv.style.display = 'block';
  const det = cv.closest('details'); if (det) det.open = true;
}

// The illustration should follow the story: when the scene advances, repaint
// it to match — in the background, and only once the painter is loaded (the
// player opted in by generating at least once). This is the TRPG beat.
function refreshScene() {
  if (imggen.ready && !imggen.busy) genScene();   // fire-and-forget; genScene reads the new world
}

function wireImgGen() {
  const b = document.getElementById('imgGen');
  restoreScene();                       // re-apply the last scene after a re-render
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
// Qwen2.5-3B: ~3B, strong Japanese/Chinese (fits this Chu-Han setting far
// better than the 2B Gemma) and in WebLLM's prebuilt list. ~2GB first DL,
// then cached in the browser. Swap here for a 7B if you want more.
const WEBLLM_MODEL = 'Qwen2.5-3B-Instruct-q4f16_1-MLC';
const GM_SYSTEM =
  'あなたは紀元前206年、楚漢戦争サンドボックスの冷徹なゲームマスター。プレイヤーの自由な行動に、' +
  '世界がどう応じるかを劇的かつ非情に裁く。人物の性格（項羽=誇り高い武人、韓信=野心家、' +
  '呂雉=冷徹、范増=老獪）と力関係、そして【差し迫る事態】に照らして結果を描け。' +
  '行動がその危機に触れるなら和らげる/悪化させるかを明示し、触れないなら危機が刻々と迫ると匂わせよ。' +
  '成功にも失敗にも代償を伴わせ、緊張を絶やすな。\n' +
  '重要: 行動が功臣を宥める/褒賞/領地→その功臣の忠誠を上げよ(loyalty +)。冷遇/疑う/兵を削ぐ→下げよ(-)。' +
  '兵糧を確保/略奪→supply +、浪費/長征→-。行動に応じて必ず action を返し、盤面と危機を実際に動かせ。\n' +
  '地域ID: guanzhong xianyang hanzhong bashu pengcheng wei zhao qi / 勢力ID: han chu qin lords\n' +
  '返答は必ず次のJSON1行のみ（前後に何も付けない）:\n' +
  '{"narration":"日本語60-160字。結果を描き、最後に次の緊張を一言",' +
  '"deltas":[{"region":"地域ID","dCtrl":-25〜25の整数,"owner":"勢力ID(領有が変わる時だけ)"}],' +
  '"action": null または {"type":"loyalty","who":"功臣名","d":-30〜30} / {"type":"supply","d":-30〜30} / {"type":"expedition","target":"地名"} / {"type":"rebellion","who":"功臣名"}}';

// Proactive scene narrator: given the board + recent events + the looming
// threat, paints the moment and ends on "どうする?" — turns 季を進める into
// an LLM-authored event beat (情景描写) instead of a flat table line.
const GM_SCENE_SYSTEM =
  'あなたは楚漢戦争の講談師。今の盤面と差し迫る事態から、情景を簡潔に描く。' +
  '厳守: 日本語で1〜2文・合計80字以内。難語・外国語・過剰な比喩を避け、平易に。' +
  '最後は必ず「――さあ、どうする？」で締める。説明・箇条書き・JSON・繰り返しは禁止。';

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

let webllmLoadPromise = null;   // shared so concurrent callers await the SAME load
async function loadBrowserAI() {
  if (webllm.ready) return;
  // A load is already running (e.g. kicked off by a chat send): AWAIT it,
  // don't early-return — otherwise `await loadBrowserAI()` resolves before
  // the model is ready and the caller sees ready===false (the "1st press
  // fails, 2nd works" bug on the 決着 button).
  if (webllm.loading) { if (webllmLoadPromise) { try { await webllmLoadPromise; } catch (_) {} } return; }
  if (!navigator.gpu) { gmAiStatus('この端末は WebGPU 非対応（サーバ/ローカルで進行）'); return; }
  webllm.loading = true;
  gmAiStatus('AI 軍師を読み込み中…（初回のみ ~1GB DL・以後キャッシュ）');
  webllmLoadPromise = (async () => {
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
  })();
  await webllmLoadPromise;
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

// Proactive event beat: after the mechanical tick, let the LLM narrate the
// new situation (weaving the last log lines + the looming threat) and end on
// "どうする?" — plain prose, no JSON to parse. Returns '' on any failure.
async function runBrowserGMScene(world, boardSnap) {
  const recent = (world.log || []).slice(-3).join(' / ');
  const t = world.court && world.court.threat;
  const threatLine = t ? ('\n【差し迫る事態】' + t.label + '（猶予' + t.turnsLeft + 'ターン）') : '';
  try {
    const r = await webllm.engine.chat.completions.create({
      messages: [
        { role: 'system', content: GM_SCENE_SYSTEM },
        { role: 'user', content: '【盤面】\n' + (boardSnap || '') + '\n【直近の動き】\n' + recent + threatLine + '\n\nこの局面の情景を描け。' }
      ],
      temperature: 0.6, max_tokens: 130
    });
    return trimScene(r.choices[0].message.content || '');
  } catch (e) { return ''; }
}

// The 3B model tends to ramble; clamp to ~2 sentences and guarantee the
// "どうする?" hook so the beat stays a tight prompt-for-improvisation.
function trimScene(s) {
  let t = (s || '').trim();
  const cut = t.indexOf('さあ、どうする');
  if (cut >= 0) t = t.slice(0, cut).trim();       // drop anything after the hook
  const parts = t.split(/(?<=。)/).filter(x => x.trim());
  t = parts.slice(0, 2).join('').trim();
  if (t.length > 110) t = t.slice(0, 108) + '…';
  return t + '　――さあ、どうする？';
}

// Compact world summary fed to the GM (board + date + supply/fame + threat).
function sbSnapshot() {
  const w = state.world;
  if (!w) return '';
  const c = w.court || {}, t = c.threat;
  const roster = (c.retainers || []).filter(r => r.alive)
    .map(r => r.name + '(忠' + r.loyalty + '/兵' + r.troops + ')').join(' ');
  return w.regions.map(r => r.id + '(' + r.ja + '):' + r.owner + ' ' + r.ctrl + '%').join(', ')
    + ' / BCE ' + w.year + ' ' + '春夏秋冬'[w.season]
    + ' / 兵糧' + c.supply + ' 名声' + c.fame
    + ' / 功臣: ' + roster
    + (t ? (' / ⚠差し迫る事態:' + t.label + '(猶予' + t.turnsLeft + ')') : '');
}

// Deterministic fallback: infer a structured action from the player's free
// text (retainer names + placate/punish/supply verbs). The 3B model rarely
// emits the `action` field reliably, so this guarantees an improvised move
// actually moves the crisis. Mirrors sbExpeditionIntent's keyword approach.
function inferGmAction(text) {
  const w = state.world;
  if (!w || !w.court) return null;
  // Build a monument → leave a mark on the world map (the "ピラミッドをつくる" beat).
  const bm = text.match(/(ピラミッド|万里の長城|長城|宮殿|城郭|城|要塞|大仏|寺院|寺|廟|港|運河|大運河|塔|灯台|陵|霊廟|新都|都)/);
  if (bm && /(築|建て|建設|造|作|興|据|営|普請)/.test(text)) {
    const icons = { 'ピラミッド':'▲','万里の長城':'🧱','長城':'🧱','宮殿':'🏯','城郭':'🏯','城':'🏯','要塞':'🏯','大仏':'🗿','寺院':'⛩','寺':'⛩','廟':'⛩','霊廟':'⛩','港':'⚓','運河':'🌊','大運河':'🌊','塔':'🗼','灯台':'🗼','陵':'⛰','新都':'🏙','都':'🏙' };
    const ja = bm[1];
    const fid = (typeof sbFrontierNamed === 'function') ? sbFrontierNamed(text) : '';
    const reg = (w.regions || []).find(r => text.includes(r.ja));
    const target = fid || (reg ? reg.id : w.loc);
    return { type: 'landmark', ja: ja, icon: icons[ja] || '◆', target: target };
  }
  const rs = (w.court.retainers || []).filter(r => r.alive);
  const who = rs.map(r => r.name).find(n => text.includes(n)) || '';
  const punish  = /(疑|削ぐ|兵を奪|奪っ|罷免|抑え|冷遇|警戒|遠ざけ|粛清|処断|誅|斬|殺)/.test(text);
  const placate = /(褒賞|恩賞|領地|封じ|封ずる|厚遇|繋ぎ|宥|懐柔|報い|与え|任じ|重用|信頼|慰労|労い|盟)/.test(text);
  if (who && punish)  return { type: 'loyalty', who: who, d: -25 };
  if (who && placate) return { type: 'loyalty', who: who, d: 30 };
  if (/(浪費|散財|放蕩|蕩尽)/.test(text)) return { type: 'supply', d: -20 };
  if (/(兵糧|兵站|糧秣|糧食|補給|徴発|屯田|略奪|蓄え|兵を養|備蓄)/.test(text)) return { type: 'supply', d: 20 };
  return null;
}

// 季を進める with an LLM event beat: run the mechanical tick (threat
// countdown + table event), then — if the browser AI is loaded — let the
// GM narrate the new 情景 and prompt the player's next move.
async function advanceWithGM() {
  state = update({ tag: 'sbAdvance' }, state);   // mechanical tick
  persist(state); render();
  if (!webllm.ready || !state.world) return;
  gmAiStatus('……講談師が筆を執っている');
  const narr = await runBrowserGMScene(state.world, sbSnapshot());
  if (narr) { state = update({ tag: 'gmResult', narration: narr, deltas: [], action: null }, state); persist(state); render(); }
  gmAiStatus('AI 軍師 起動済み（行動を書けば即興で応答）');
  refreshScene();   // repaint the illustration to match the new scene
}

// Short personas so the small model actually stays in character.
const NPC_PERSONA = {
  miaorong: '蕭何の妻・妙容。聡明で芯が強く、夫が劉邦に賭けているのを見抜いている。静かだが鋭い。',
  xiaohe:   '劉邦の宰相格・蕭何。律儀で実務に長け、己を抑え民政に尽くす。慎重で誠実。',
  fanzeng:  '項羽の軍師・范増。老獪で先を読む。劉邦を早く除くべきと説くが容れられず苛立つ。',
  huangshi: '張良に兵法を授けた隠者・黄石公。超然として謎めき、禅問答のように語る。',
  xiangbo:  '項羽の叔父・項伯。情に厚く、鴻門で劉邦を庇った。義理と情に揺れる。',
  kuaitong: '弁士・蒯通。韓信に天下三分を説く策士。野心を焚きつけ、雄弁に語る。'
};

// In-browser (WebLLM) NPC chat — same role as /api/ask, no server needed.
async function runBrowserChat(npcId, npcName, history, message) {
  const persona = NPC_PERSONA[npcId] || ('楚漢戦争の登場人物「' + (npcName || '登場人物') + '」');
  const sys = 'あなたは' + persona
    + ' 舞台は紀元前209〜202年の中国、乱世。この人物に成りきり、自分が誰かを忘れず、'
    + '相手の言葉に具体的に反応して、日本語で必ず1〜3文で答える（空の返答は禁止）。'
    + '同じ話の繰り返しや、現代語の説明・メタ発言はしないこと。';
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

// ─── 決着をつける: turn a free chat into a GENERATED consequence, so the
// player's words can actually change history (persuade → assassination,
// defection, rupture, reconciliation…). LLM-authored on the fly. ───────
async function runBrowserConclude(npcName, history) {
  const convo = (history || [])
    .filter(m => m && m.text && m.text.trim() && m.text !== '(空の応答)')
    .map(m => (m.role === 'user' ? 'あなた' : npcName) + '「' + m.text + '」').join('\n');
  const sys = 'あなたは楚漢戦争（紀元前3世紀の中国）の講談師。次の会話の"結末"を描け。'
    + 'プレイヤーの言葉が' + npcName + 'をどれだけ動かしたかを冷徹に見極め、その帰結を一場面として書く。'
    + '会話が真に説得的なら、史実を覆す大胆な帰結（暗殺・寝返り・決裂・和睦など）も起こしてよい。'
    + '凡庸・無策・失礼なら、何も変わらぬまま終わる。'
    + '返答は必ず次のJSON1行のみ: {"title":"結末の題(8字以内)","text":"帰結の描写(80-160字・日本語)","changed":true or false}';
  const ask = async (extra) => {
    const r = await webllm.engine.chat.completions.create({
      messages: [{ role: 'system', content: sys + (extra || '') },
        { role: 'user', content: '【会話】\n' + convo + '\n\nこの会話の結末を判定し、JSONだけで答えよ。' }],
      temperature: 0.8, max_tokens: 320
    });
    return (r.choices[0].message.content) || '';
  };
  // Small models often wrap the JSON in prose/fences — extract the {...}
  // span and, if that still fails, retry once with a firmer instruction.
  const parse = (s) => {
    const t = stripFence(s);
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    return JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t);
  };
  let j;
  try { j = parse(await ask('')); }
  catch (_) { j = parse(await ask(' 前置き・説明・コードフェンスは一切禁止。JSONオブジェクトのみを返せ。')); }
  return { title: j.title || 'その後', text: j.text || '', changed: !!j.changed };
}

function ensureConcludeOverlay() {
  let ov = document.getElementById('concludeOverlay');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = 'concludeOverlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:1600;background:rgba(0,0,0,0.92);display:none;align-items:center;justify-content:center;padding:20px';
  ov.innerHTML =
    "<div style='background:#161009;border:1px solid #6a4a2f;border-radius:12px;padding:26px;max-width:520px;width:92vw;color:#f0e6d2;text-align:center'>" +
    "<div id='concludeBadge' style='font-size:12px;color:#c8a86a;letter-spacing:2px;margin-bottom:8px'></div>" +
    "<h2 id='concludeTitle' style='margin:0 0 12px;font-size:22px'></h2>" +
    "<p id='concludeText' style='color:#d8cbb0;line-height:2;font-size:15px;margin:0 0 20px'></p>" +
    "<div style='display:flex;gap:10px;justify-content:center;flex-wrap:wrap'>" +
    "<button id='concludeCont' class='btn btn-primary'>この後を続ける</button>" +
    "<button id='concludeTitleBtn' class='btn btn-ghost'>タイトルへ</button></div></div>";
  document.body.appendChild(ov);
  const leave = (tag) => {
    ov.style.display = 'none';               // always hide first, so we never trap the UI
    try { state = update({tag}, state); persist(state); render(); }
    catch (e) { try { render(); } catch (_) {} }
  };
  ov.querySelector('#concludeCont').addEventListener('click', () => leave('llmEnd'));
  ov.querySelector('#concludeTitleBtn').addEventListener('click', () => leave('toTitle'));
  // Backdrop click = escape hatch (never get stuck behind the overlay).
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.style.display = 'none'; });
  return ov;
}

async function concludeChat() {
  const st = document.getElementById('llmAiStatus');
  if (!webllm.ready && navigator.gpu) {
    if (st) st.textContent = '結末を思案するため AI を読み込み中…';
    await loadBrowserAI();
  }
  if (!webllm.ready) { saveToast('結末の生成には「🧠 ブラウザAI起動」が必要です'); return; }
  const npcName = state.llm.npcName, hist = state.llm.history.slice();
  if (st) st.textContent = '……結末を描いている';
  try {
    const c = await runBrowserConclude(npcName, hist);
    const ov = ensureConcludeOverlay();
    ov.querySelector('#concludeBadge').textContent = c.changed ? '― 歴史は、揺れた ―' : '― 会話の果て ―';
    ov.querySelector('#concludeTitle').textContent = c.title;
    ov.querySelector('#concludeText').textContent = c.text;
    ov.style.display = 'flex';
  } catch (e) { saveToast('結末生成に失敗しました。もう一度お試しを'); }
  if (st) st.textContent = '';
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
  const snapshot = sbSnapshot;
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
      refreshScene();   // the frontier expedition is a whole new scene — repaint
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
        state = update({tag: 'gmResult', narration: r.narration, deltas: r.deltas, action: r.action || inferGmAction(text)}, state);
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
        else state = update({tag: 'gmResult', narration: j.narration || '（天は沈黙している）', deltas: j.deltas || [], action: j.action || inferGmAction(text)}, state);
        done = true;
      } catch (e) { /* 3) offline fallback */ }
    }
    if (!done) state = update({tag: 'gmError', text: ''}, state);
    persist(state); render();
    refreshScene();   // repaint to match what just unfolded
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
    const npcId = state.llm.npcId;
    const npcName = state.llm.npcName;
    const hist = state.llm.history.slice();   // before pushing the user msg
    state = update({tag: 'llmSendUser', text: text}, state);
    persist(state);
    render();
    let done = false;
    // 1) in-browser WebLLM if loaded — no server LLM needed
    if (webllm.ready) {
      try {
        const reply = await runBrowserChat(npcId, npcName, hist, text);
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
          const reply = await runBrowserChat(npcId, npcName, hist, text);
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
      if (msg.tag === 'concludeChat') { sfxForButton(t); concludeChat(); return; }
      if (msg.tag === 'sbAdvance') { sfxForButton(t); advanceWithGM(); return; }
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
