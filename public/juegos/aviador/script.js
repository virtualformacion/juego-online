/* Aviador (Crash) integrado con saldo del usuario (DB del proyecto)
   - Usa la misma sesión (localStorage 'session') del sistema principal
   - Lee/actualiza saldo del usuario vía /.netlify/functions/db (igual que los otros juegos)
   - Apuesta descuenta inmediatamente
   - Cashout acredita inmediatamente
   - Si pierde, se mantiene descontado
   - Ciclo constante (30s apuestas -> vuelo -> 5s resultado) persistente con localStorage
   - Línea (trail) detrás del avión (canvas)
*/

const DB_ENDPOINT = "/.netlify/functions/db";
const $ = (id) => document.getElementById(id);

/* ---------- sesión + DB (copiado/compat con app.js) ---------- */
function setSession(obj){ localStorage.setItem('session', JSON.stringify(obj)); }
function getSession(){ try { return JSON.parse(localStorage.getItem('session')||'null'); } catch { return null; } }
function clearSession(){ localStorage.removeItem('session'); }

function requireRole(role){
  const s = getSession();
  if(!s){ location.href='/'; return null; }
  if(role && s.role !== role){ location.href='/'; return null; }
  return s;
}

async function loadDB(){
  try{
    const r = await fetch(DB_ENDPOINT);
    if(!r.ok) throw new Error(await r.text());
    return await r.json(); // { sha, data }
  }catch(e){
    // fallback local
    const r2 = await fetch('/data/db.json');
    if(!r2.ok) throw new Error('No se pudo cargar la base de datos.');
    const data = await r2.json();
    return { sha:null, data };
  }
}
async function saveDB(data, message){
  const r = await fetch(DB_ENDPOINT,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ data, message })
  });
  if(!r.ok) throw new Error(await r.text());
  return await r.json();
}

/* ---------- UI refs ---------- */
const balanceValue = $("balanceValue");
const statusText = $("statusText");
const roundId = $("roundId");
const multiplierEl = $("multiplier");
const planeEl = $("plane");
const explosionEl = $("explosion");
const crashBanner = $("crashBanner");
const crashBannerX = $("crashBannerX");

const betInput = $("betInput");
const autoCashoutInput = $("autoCashoutInput");
const betBtn = $("betBtn");
const cashoutBtn = $("cashoutBtn");
const resetBtn = $("resetBtn");
const halfBtn = $("halfBtn");
const doubleBtn = $("doubleBtn");

const inPlayEl = $("inPlay");
const potentialEl = $("potential");
const queuedEl = $("queued");
const forThisEl = $("forThis");

const historyEl = $("history");
const soundToggle = $("soundToggle");
const fastModeToggle = $("fastModeToggle");
const buildTag = $("buildTag");

const wrap = $("canvasWrap");
const trailCanvas = $("trailCanvas");
const ctx = trailCanvas.getContext("2d");

/* ---------- formato dinero ---------- */
function fmtMoney(amount, currency){
  try{
    return new Intl.NumberFormat(undefined, { style:'currency', currency }).format(Number(amount||0));
  }catch{
    return `$${Number(amount||0).toFixed(2)}`;
  }
}
function formatX(x){ return `${Number(x).toFixed(2)}×`; }
function clamp(n,a,b){ return Math.max(a, Math.min(b, n)); }

/* ---------- estado juego (SIN balance local) ---------- */
const STORAGE_KEY = "aviador_cycle_v1"; // solo para ciclo/colas

const PHASE = { BETTING:"BETTING", RUNNING:"RUNNING", RESULT:"RESULT" };

const game = {
  phase: PHASE.BETTING,
  phaseStartedAt: Date.now(),
  bettingSeconds: 30,
  resultSeconds: 5,
  crashPoint: 2.0,
  speed: 1.0,

  queuedBetNext: 0,
  betForThisRound: 0,

  inPlay: 0,
  hasBet: false,
  cashedOut: false,

  history: [], // local history (visual)
  round: 1
};

// DB state
const state = {
  db: null,
  me: null,
  session: null
};

function saveCycle(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    ...game,
    history: game.history.slice(0, 50)
  }));
}

function loadCycle(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return;
    const saved = JSON.parse(raw);
    Object.assign(game, saved);
    if(!Array.isArray(game.history)) game.history = [];
    if(!Object.values(PHASE).includes(game.phase)) game.phase = PHASE.BETTING;
  }catch(_){}
}

/* ---------- crash distribution (demo) ---------- */
function generateCrashPoint(){
  const r = Math.random();
  const raw = 1 / (1 - r);
  const capped = Math.min(raw, 200);
  const curved = Math.pow(capped, 0.85);
  return Math.max(1.01, curved);
}
function multiplierAt(tSeconds){
  const a = 0.06 * game.speed;
  return Math.exp(a * tSeconds);
}

/* ---------- trail canvas ---------- */
let trail = [];
function resizeCanvas(){
  const dpr = window.devicePixelRatio || 1;
  const r = wrap.getBoundingClientRect();
  trailCanvas.width = Math.max(1, Math.floor(r.width * dpr));
  trailCanvas.height = Math.max(1, Math.floor(r.height * dpr));
  trailCanvas.style.width = r.width + "px";
  trailCanvas.style.height = r.height + "px";
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener("resize", resizeCanvas);

function clearTrail(){
  trail = [];
  ctx.clearRect(0,0,wrap.clientWidth, wrap.clientHeight);
}
function pushTrail(){
  const wr = wrap.getBoundingClientRect();
  const pr = planeEl.getBoundingClientRect();
  const now = performance.now();
  trail.push({
    x: (pr.left - wr.left) + pr.width/2,
    y: (pr.top - wr.top) + pr.height/2,
    t: now
  });
  const cutoff = now - 3500;
  while(trail.length && trail[0].t < cutoff) trail.shift();
}
function drawTrail(){
  ctx.clearRect(0,0,wrap.clientWidth, wrap.clientHeight);
  if(trail.length < 2) return;

  const now = performance.now();
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for(let i=1;i<trail.length;i++){
    const age = (now - trail[i].t) / 3500;
    const alpha = clamp(1 - age, 0, 1) * 0.9;
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.beginPath();
    ctx.moveTo(trail[i-1].x, trail[i-1].y);
    ctx.lineTo(trail[i].x, trail[i].y);
    ctx.stroke();
  }
}

/* ---------- FX ---------- */
function placeExplosionOnPlane(){
  const wr = wrap.getBoundingClientRect();
  const pr = planeEl.getBoundingClientRect();
  const cx = (pr.left - wr.left) + pr.width/2;
  const cy = (pr.top - wr.top) + pr.height/2;
  explosionEl.style.left = `${cx}px`;
  explosionEl.style.top = `${cy}px`;
}
function showExplosion(){ placeExplosionOnPlane(); explosionEl.hidden = false; }
function hideExplosion(){ explosionEl.hidden = true; }
function showCrashBanner(x){ crashBannerX.textContent = formatX(x); crashBanner.hidden = false; }
function hideCrashBanner(){ crashBanner.hidden = true; }

/* ---------- render ---------- */
function render(mult){
  const cur = state.me?.currency || "USD";
  const bal = Number(state.me?.balance || 0);

  balanceValue.textContent = fmtMoney(bal, cur);
  roundId.textContent = `#${game.round}`;
  multiplierEl.textContent = formatX(mult);

  inPlayEl.textContent = fmtMoney(game.inPlay, cur);
  potentialEl.textContent = fmtMoney(game.hasBet ? (game.inPlay * mult) : 0, cur);

  queuedEl.textContent = fmtMoney(game.queuedBetNext, cur);
  forThisEl.textContent = fmtMoney(game.betForThisRound, cur);

  soundToggle.checked = !!game.sound;
  fastModeToggle.checked = !!game.fastMode;

  cashoutBtn.disabled = !(game.phase === PHASE.RUNNING && game.hasBet && !game.cashedOut);

  // history UI (local)
  historyEl.innerHTML = "";
  game.history.slice(0, 25).forEach((h) => {
    const div = document.createElement("div");
    div.className = "item";
    const left = document.createElement("div");
    left.innerHTML =
      `<div><strong>${formatX(h.crash)}</strong> <span style="color:rgba(159,176,208,.75);font-size:12px">(${h.when})</span></div>
       <div style="color:rgba(159,176,208,.75);font-size:12px;margin-top:2px">${h.note}</div>`;
    const tag = document.createElement("div");
    tag.className = `tag ${h.result === "cashout" ? "ok" : "bad"}`;
    tag.textContent = h.result === "cashout" ? "Cashout" : "Crash";
    div.appendChild(left);
    div.appendChild(tag);
    historyEl.appendChild(div);
  });

  saveCycle();
}

/* ---------- DB refresh ---------- */
async function refreshUser(){
  const { data } = await loadDB();
  state.db = data;
  state.me = data.users.find(u => u.id === state.session.id);
  if(!state.me){
    clearSession();
    location.href = '/';
  }
}

/* ---------- saldo ops ---------- */
async function debit(amount){
  if(!state.me) return;
  const a = Number(amount||0);
  if(!(a > 0)) return;

  if(Number(state.me.balance) < a) throw new Error("Saldo insuficiente.");
  state.me.balance = Number(state.me.balance) - a;
  await saveDB(state.db);
}
async function credit(amount){
  if(!state.me) return;
  const a = Number(amount||0);
  if(!(a > 0)) return;

  state.me.balance = Number(state.me.balance) + a;
  await saveDB(state.db);
}

/* ---------- phases ---------- */
function startBetting(){
  game.phase = PHASE.BETTING;
  game.phaseStartedAt = Date.now();
  game.crashPoint = generateCrashPoint();

  // pasa cola a "para esta ronda"
  if(game.queuedBetNext > 0){
    game.betForThisRound += game.queuedBetNext;
    game.queuedBetNext = 0;
  }

  game.inPlay = 0;
  game.hasBet = false;
  game.cashedOut = false;

  hideExplosion();
  hideCrashBanner();
  clearTrail();

  statusText.textContent = `Apuestas abiertas (${game.bettingSeconds}s)`;
  render(1);
}

function startRunning(){
  game.phase = PHASE.RUNNING;
  game.phaseStartedAt = Date.now();
  game.speed = (game.fastMode ? 1.65 : 1.0);

  if(game.betForThisRound > 0){
    game.inPlay = game.betForThisRound;
    game.betForThisRound = 0;
    game.hasBet = true;
    game.cashedOut = false;
    statusText.textContent = "Volando… ¡haz Cash Out a tiempo!";
  }else{
    game.inPlay = 0;
    game.hasBet = false;
    game.cashedOut = false;
    statusText.textContent = "Volando… (sin apuesta en este vuelo)";
  }

  hideExplosion();
  hideCrashBanner();
  clearTrail();
  render(1);
}

function startResult(){
  game.phase = PHASE.RESULT;
  game.phaseStartedAt = Date.now();

  showExplosion();
  showCrashBanner(game.crashPoint);

  if(game.hasBet && !game.cashedOut){
    game.history.unshift({
      crash: game.crashPoint,
      when: new Date().toLocaleTimeString(),
      result: "crash",
      note: `Perdiste ${fmtMoney(game.inPlay, state.me.currency)}`
    });
  }
  game.history = game.history.slice(0, 50);

  render(game.crashPoint);
}

/* ---------- loop ---------- */
async function loop(){
  const now = Date.now();

  try{
    // refrescar saldo a intervalos suaves (por si otro juego cambió el saldo)
    // sin spamear: solo si no estamos en medio de una operación
    if (!loop._lastRefresh || (now - loop._lastRefresh) > 2500){
      loop._lastRefresh = now;
      await refreshUser();
    }
  }catch(_){
    // ignore: si falla red, seguimos mostrando lo último
  }

  if(game.phase === PHASE.BETTING){
    const elapsed = (now - game.phaseStartedAt) / 1000;
    if(elapsed >= game.bettingSeconds){
      startRunning();
    }else{
      render(1);
    }
  }

  if(game.phase === PHASE.RUNNING){
    const t = (now - game.phaseStartedAt) / 1000;
    const m = multiplierAt(t);

    const x = Math.min(420, t * 95);
    const y = Math.min(140, Math.pow(t, 1.15) * 26);
    planeEl.style.transform = `translate(${x}px, ${-y}px)`;

    pushTrail();
    drawTrail();

    // auto cashout
    if(game.hasBet && !game.cashedOut){
      const ac = parseFloat(autoCashoutInput.value);
      if(Number.isFinite(ac) && ac >= 1.01 && m >= ac){
        await doCashout(m);
      }
    }

    if(m >= game.crashPoint){
      startResult();
    }else{
      render(m);
    }
  }

  if(game.phase === PHASE.RESULT){
    const elapsed = (now - game.phaseStartedAt) / 1000;
    if(elapsed >= game.resultSeconds){
      game.round += 1;
      startBetting();
    }else{
      placeExplosionOnPlane();
      render(game.crashPoint);
    }
  }

  requestAnimationFrame(loop);
}

/* ---------- actions ---------- */
async function placeBet(amount){
  const a = Number(amount||0);
  if(!(a > 0)) return;

  await refreshUser(); // saldo más reciente
  if(Number(state.me.balance) < a){
    statusText.textContent = "⚠️ Saldo insuficiente.";
    render(1);
    return;
  }

  // 1) descontar de inmediato del saldo real del usuario
  try{
    await debit(a);
  }catch(e){
    statusText.textContent = `⚠️ ${e?.message || 'No se pudo debitar.'}`;
    render(1);
    return;
  }

  // 2) ubicar apuesta según fase
  if(game.phase === PHASE.BETTING){
    game.betForThisRound += a;
    statusText.textContent = `Apuesta aceptada para ESTA ronda: ${fmtMoney(a, state.me.currency)}`;
  }else{
    game.queuedBetNext += a;
    statusText.textContent = `Apuesta en cola para PRÓXIMA ronda: ${fmtMoney(a, state.me.currency)}`;
  }

  render(1);
}

async function doCashout(multNow){
  if(!(game.phase === PHASE.RUNNING && game.hasBet && !game.cashedOut)) return;

  const win = game.inPlay * multNow;

  // acreditar al usuario de inmediato
  try{
    await credit(win);
    await refreshUser();
  }catch(e){
    statusText.textContent = "⚠️ No se pudo acreditar el premio (reintenta).";
    // NOTA: en producción harías compensación/tx. Aquí dejamos el historial igual.
  }

  game.cashedOut = true;

  game.history.unshift({
    crash: multNow,
    when: new Date().toLocaleTimeString(),
    result: "cashout",
    note: `Cobraste ${fmtMoney(win, state.me.currency)} en ${formatX(multNow)}`
  });
  game.history = game.history.slice(0, 50);

  // ya no queda apuesta en juego
  game.inPlay = 0;
  game.hasBet = false;

  statusText.textContent = `✅ Cashout: ${fmtMoney(win, state.me.currency)}`;
  render(multNow);
}

/* ---------- wire UI ---------- */
betBtn.addEventListener("click", async () => {
  await placeBet(Number(betInput.value));
});

cashoutBtn.addEventListener("click", async () => {
  if(game.phase !== PHASE.RUNNING) return;
  const t = (Date.now() - game.phaseStartedAt) / 1000;
  const m = multiplierAt(t);
  await doCashout(m);
});

resetBtn.addEventListener("click", () => {
  // solo reinicia ciclo local (NO toca saldo del usuario)
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
});

halfBtn.addEventListener("click", () => {
  const v = Math.max(1, Math.floor(Number(betInput.value || 0) / 2));
  betInput.value = String(v);
});
doubleBtn.addEventListener("click", () => {
  const v = Math.max(1, Math.floor(Number(betInput.value || 0) * 2));
  betInput.value = String(v);
});

soundToggle.addEventListener("change", (e) => {
  game.sound = !!e.target.checked;
  render(1);
});
fastModeToggle.addEventListener("change", (e) => {
  game.fastMode = !!e.target.checked;
  render(1);
});

/* ---------- init ---------- */
(async function init(){
  state.session = requireRole('user');
  if(!state.session) return;

  loadCycle();
  resizeCanvas();
  buildTag.textContent = `integrado ${new Date().toISOString().slice(0,10)}`;

  await refreshUser();

  // Si al recargar quedaste en un estado raro, normaliza:
  if(!Object.values(PHASE).includes(game.phase)) game.phase = PHASE.BETTING;
  if(typeof game.phaseStartedAt !== "number") game.phaseStartedAt = Date.now();

  // si pasó demasiado tiempo, el loop saltará de fase
  statusText.textContent = "Cargando…";
  requestAnimationFrame(loop);

  // si quieres arrancar siempre en betting al abrir, descomenta:
  // startBetting();
})();