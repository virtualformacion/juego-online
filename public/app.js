const DB_ENDPOINT = "/.netlify/functions/db";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const nowISO = () => new Date().toISOString();

function toast(el, type, text) {
  if (!el) return;
  el.innerHTML = `<div class="toast ${type==='err'?'err':type==='warn'?'warn':''}">${text}</div>`;
  setTimeout(()=>{ try{ el.innerHTML=''; }catch{} }, 5000);
}

function isValidUserOrPass(v){ return typeof v==='string' && /^[a-z0-9]{3,20}$/.test(v); }
function currencyForCountry(c){ return c==='CO' ? 'COP' : 'USD'; }
function bonusForCountry(c){ return c==='CO' ? 2000 : 2; }

function fmt(amount, currency){
  const n = Number(amount||0);
  if (currency==='USD') return new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:2}).format(n);
  return new Intl.NumberFormat('es-CO',{style:'currency',currency,maximumFractionDigits:0}).format(n);
}



function esc(str){
  return String(str ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

async function loadDB(){
  // Prefer Netlify function when available; fall back to static /data/db.json for local runs.
  try{
    const r = await fetch(DB_ENDPOINT);
    if(!r.ok) throw new Error(await r.text());
    return await r.json(); // { sha, data }
  }catch(e){
    const r2 = await fetch('/data/db.json');
    if(!r2.ok) throw new Error('No se pudo cargar la base de datos (Netlify function y fallback fallaron).');
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

function setSession(obj){ localStorage.setItem('session', JSON.stringify(obj)); }
function getSession(){ try { return JSON.parse(localStorage.getItem('session')||'null'); } catch { return null; } }
function clearSession(){ localStorage.removeItem('session'); }

function requireRole(role){
  const s = getSession();
  if(!s) { location.href='/'; return null; }
  if(role && s.role !== role){ location.href='/'; return null; }
  return s;
}

function uuid(){
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxyxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/* Draw (determinístico por ciclo de 3 minutos UTC) */
const CYCLE_MS = 3 * 60 * 1000;

function cycleIndex(date=new Date()){
  return Math.floor(date.getTime() / CYCLE_MS);
}
function cycleStartDate(idx){
  return new Date(idx * CYCLE_MS);
}
function drawForCycle(idx){
  const start = cycleStartDate(idx);
  const key = `cycle:${idx}`;
  // hash simple (FNV-1a)
  let seed = 2166136261;
  for (let i=0;i<key.length;i++){
    seed ^= key.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  let x = seed >>> 0;
  function rnd(){
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 4294967296;
  }
  const balls = Array.from({length:99},(_,i)=>String(i+1).padStart(2,'0'));
  for(let i=balls.length-1;i>0;i--){
    const j=Math.floor(rnd()*(i+1));
    [balls[i],balls[j]]=[balls[j],balls[i]];
  }
  return { cycle: idx, drawAt: start.toISOString(), balls: balls.slice(0,20), order: balls };
}



/* Balotera animator (canvas premium 2D) */

/* Balotera animator (canvas premium 2D) */
class BaloteraAnimator {
  constructor(canvas, extractedEl){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.extractedEl = extractedEl;

    this.raf = null;
    this.running = false;

    // modes: 'idle' | 'mix' | 'extract'
    this.mode = 'idle';

    // timing
    this.EXTRACT_EVERY_MS = 250; // 20 * 250 = 5s

    // visuals / physics
    this.balls = [];          // all 99 balls
    this.byNum = new Map();   // num -> ball
    this.selected = [];       // 20 selected (strings)
    this.extractedCount = 0;
    this.extracting = null;   // current extracting ball
    this.lastExtractAt = 0;

    // last result shown (cycle + balls)
    this.lastResult = null;

    this.lastFrame = 0;

    // handle resize for crispness
    this.resize();
    window.addEventListener('resize', ()=>this.resize(), { passive:true });
  }

  resize(){
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(320, Math.floor(rect.width || this.canvas.width));
    const cssH = Math.max(220, Math.floor(rect.height || this.canvas.height || 280));
    this.canvas.width = Math.floor(cssW * dpr);
    this.canvas.height = Math.floor(cssH * dpr);
    this.ctx.setTransform(dpr,0,0,dpr,0,0);
    this.w = cssW; this.h = cssH;

    // layout (2D "real" balotera)
    const globeMaxR = Math.min((this.w*0.48), (this.h*0.70));
    this.cx = Math.round(this.w*0.36);
    this.cy = Math.round(this.h*0.46);
    this.R  = Math.max(90, Math.round(globeMaxR));
    this.exit = { x: this.cx, y: this.cy + this.R + 18 };              // bottom outlet
    this.tray = { x: Math.round(this.w*0.70), y: Math.round(this.h*0.22) };
    this.trayW = Math.round(this.w*0.28);
    this.trayH = Math.round(this.h*0.58);
    this.trayPad = 12;
  }

  start(){
    if (this.running) return;
    this.running = true;
    if (!this.balls.length) this.initBalls();

    this.lastFrame = Date.now();

    const tick = ()=>{
      if (!this.running) return;

      const now = Date.now();
      const dt = Math.min(0.033, (now - this.lastFrame)/1000); // clamp
      this.lastFrame = now;

      this.step(dt, now);
      this.draw(now);

      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(){
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  isExtracting(){
    return this.mode === 'extract';
  }

  setIdleMode(){
    if (this.mode !== 'extract') this.mode = 'idle';
  }

  setMixMode(){
    if (this.mode === 'extract') return;

    // When we go back to mixing for the next cycle, "collect" any extracted balls
    // so the tray/globe feels reset for a new draw.
    if (this.mode !== 'mix'){
      const hasOut = (this.balls || []).some(b => b && b.state === 'out');
      if (hasOut || this.extractedCount > 0){
        // Rebuild the 99 balls inside the globe and clear the tray UI
        this.initBalls(true);
        this.extractedCount = 0;
        this.extracting = null;
        this.lastExtractAt = 0;
        if (this.extractedEl) this.extractedEl.innerHTML = '';
      } else if (!this.balls || !this.balls.length){
        this.initBalls(true);
      }
    }

    this.mode = 'mix';
  }

  startExtract(draw){
    if (!draw) return;
    // If already extracting, do not interrupt
    if (this.mode === 'extract') return;

    this.lastResult = { cycle: draw.cycle, drawAt: draw.drawAt, balls: draw.balls.slice(0,20) };
    this.selected = draw.balls.slice(0,20);

    // reset extracted UI
    if (this.extractedEl) this.extractedEl.innerHTML = '';

    // Ensure all balls are "in" again (fresh cycle feel)
    this.initBalls(true);

    this.extractedCount = 0;
    this.extracting = null;
    this.lastExtractAt = 0;

    this.mode = 'extract';
  }

  initBalls(keepSizing=false){
    // create 99 balls inside the globe
    this.balls = [];
    this.byNum = new Map();
    const baseR = Math.max(9, Math.min(14, Math.round(this.R/12)));
    const nums = Array.from({length:99}, (_,i)=>String(i+1).padStart(2,'0'));

    for (let i=0;i<nums.length;i++){
      const num = nums[i];
      const r = baseR + ((i % 7)===0 ? 1 : 0);
      let x,y,tries=0;
      do{
        const a = Math.random()*Math.PI*2;
        const rr = (Math.random() ** 0.6) * (this.R - r - 8);
        x = this.cx + Math.cos(a)*rr;
        y = this.cy + Math.sin(a)*rr;
        tries++;
      } while (tries < 40 && this.balls.some(b => ((b.x-x)**2 + (b.y-y)**2) < ((b.r+r+1)**2)));

      const b = {
        num,
        x, y,
        vx: (Math.random()-0.5)*180,
        vy: (Math.random()-0.5)*180,
        r,
        state: 'in',          // in | extract | out
        t: 0,
        from: null,
        toA: null,
        toB: null
      };
      this.balls.push(b);
      this.byNum.set(num, b);
    }

    // If we are in idle, keep very gentle motion
    if (!keepSizing){
      this.mode = this.mode || 'idle';
    }
  }

  // --- physics + extraction timeline ---
  step(dt, nowMs){
    // extraction scheduling
    if (this.mode === 'extract'){
      if (this.extractedCount >= 20){
        // finished extraction: go idle and keep the result visible
        this.mode = 'idle';
      } else if (!this.extracting){
        if (!this.lastExtractAt || (nowMs - this.lastExtractAt) >= this.EXTRACT_EVERY_MS){
          const num = this.selected[this.extractedCount];
          const b = this.byNum.get(num);
          if (b && b.state === 'in'){
            b.state = 'extract';
            b.t = 0;
            b.from = { x: b.x, y: b.y };
            b.toA = { x: this.exit.x, y: this.exit.y };
            b.toB = this.traySlot(this.extractedCount);
            this.extracting = b;
            this.lastExtractAt = nowMs;
          } else {
            // if missing for any reason, just skip (shouldn't happen)
            this.extractedCount++;
            this.lastExtractAt = nowMs;
          }
        }
      }
    }

    // forces by mode
    const mixing = this.mode === 'mix';
    const swirl = mixing ? 520 : 120;
    const jitter = mixing ? 240 : 40;
    const gravity = mixing ? 60 : 90;

    // ball-ball collisions (simple, good enough)
    for (let i=0;i<this.balls.length;i++){
      const a = this.balls[i];
      if (a.state !== 'in') continue;
      for (let j=i+1;j<this.balls.length;j++){
        const b = this.balls[j];
        if (b.state !== 'in') continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx*dx + dy*dy;
        const minD = a.r + b.r + 0.4;
        if (d2 > 0 && d2 < minD*minD){
          const d = Math.sqrt(d2);
          const nx = dx / d, ny = dy / d;
          const overlap = (minD - d);
          a.x -= nx * overlap * 0.5;
          a.y -= ny * overlap * 0.5;
          b.x += nx * overlap * 0.5;
          b.y += ny * overlap * 0.5;
          const avn = a.vx*nx + a.vy*ny;
          const bvn = b.vx*nx + b.vy*ny;
          const impulse = (bvn - avn) * 0.75;
          a.vx += impulse * nx;
          a.vy += impulse * ny;
          b.vx -= impulse * nx;
          b.vy -= impulse * ny;
        }
      }
    }

    for (const b of this.balls){
      if (b.state === 'in'){
        // swirl around center to mimic real mixing
        const dx = b.x - this.cx, dy = b.y - this.cy;
        const ang = Math.atan2(dy, dx);
        const tx = -Math.sin(ang), ty = Math.cos(ang);
        b.vx += tx * swirl * dt;
        b.vy += ty * swirl * dt;

        // random turbulence
        b.vx += (Math.random()-0.5) * jitter * dt;
        b.vy += (Math.random()-0.5) * jitter * dt;

        // slight gravity
        b.vy += gravity * dt;

        // integrate
        b.x += b.vx * dt;
        b.y += b.vy * dt;

        // damping (idle is calmer)
        const dampX = mixing ? 1.4 : 2.1;
        const dampY = mixing ? 1.2 : 2.0;
        b.vx *= (1 - dampX*dt);
        b.vy *= (1 - dampY*dt);

        // collide with globe boundary (circle)
        const ddx = b.x - this.cx, ddy = b.y - this.cy;
        const dist = Math.sqrt(ddx*ddx + ddy*ddy) || 1;
        const maxR = this.R - b.r - 4;
        if (dist > maxR){
          const nx = ddx / dist, ny = ddy / dist;
          b.x = this.cx + nx * maxR;
          b.y = this.cy + ny * maxR;
          const vn = b.vx*nx + b.vy*ny;
          b.vx -= 1.85 * vn * nx;
          b.vy -= 1.85 * vn * ny;
          b.vx *= 0.92;
          b.vy *= 0.92;
        }
      } else if (b.state === 'extract'){
        // animate along a smooth path: from -> exit -> tray slot
        const speed = 1 / Math.max(0.001, (this.EXTRACT_EVERY_MS/1000));
        b.t = Math.min(1, b.t + dt * speed);
        const t = this.easeOutCubic(b.t);

        const mid = b.toA;
        const end = b.toB;

        if (t < 0.55){
          const u = t / 0.55;
          const uu = this.easeInOut(u);
          const p = this.quad(b.from, { x: this.cx, y: this.cy + this.R*0.35 }, mid, uu);
          b.x = p.x; b.y = p.y;
        } else {
          const u = (t - 0.55) / 0.45;
          const uu = this.easeInOut(u);
          const p = this.quad(mid, { x: this.tray.x - 40, y: this.tray.y + 10 }, end, uu);
          b.x = p.x; b.y = p.y;
        }

        b.vx = 0; b.vy = 0;

        if (b.t >= 1){
          b.state = 'out';
          this.extracting = null;
          this.extractedCount++;

          if (this.extractedEl){
            const span = document.createElement('span');
            span.className = 'ball';
            span.textContent = b.num;
            const hue = (parseInt(b.num,10) * 3.6) % 360;
            span.style.setProperty('--ring', `hsla(${hue}, 75%, 55%, 0.70)`);
            this.extractedEl.appendChild(span);
          }
        }
      }
    }
  }

  traySlot(i){
    const cols = 5;
    const rows = 4;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cellW = (this.trayW - this.trayPad*2) / cols;
    const cellH = (this.trayH - this.trayPad*2) / rows;
    return {
      x: this.tray.x + this.trayPad + cellW*(col+0.5),
      y: this.tray.y + this.trayPad + cellH*(row+0.5)
    };
  }

  // --- drawing ---
  draw(nowMs){
    const ctx = this.ctx;
    ctx.clearRect(0,0,this.w,this.h);

    // background vignette
    const g = ctx.createRadialGradient(this.w*0.45, this.h*0.25, 40, this.w*0.45, this.h*0.45, this.w*0.85);
    g.addColorStop(0, 'rgba(255,255,255,0.08)');
    g.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = g;
    ctx.fillRect(0,0,this.w,this.h);

    // base / stand
    this.drawStand(ctx);

    // tray
    this.drawTray(ctx);

    // globe (glass)
    this.drawGlobe(ctx);

    const inside = this.balls.filter(b=>b.state==='in');
    const extracting = this.balls.filter(b=>b.state==='extract');
    const out = this.balls.filter(b=>b.state==='out');

    for (const b of inside) this.drawBall(ctx, b, true);
    for (const b of extracting) this.drawBall(ctx, b, false);
    for (const b of out) this.drawBall(ctx, b, false);

    // status label
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.70)';
    ctx.font = '600 12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    const label =
      this.mode === 'extract'
        ? `Extrayendo: ${Math.min(20, this.extractedCount + (this.extracting?1:0))}/20`
        : (this.mode === 'mix' ? 'Revolviendo balotas…' : 'En espera…');
    ctx.fillText(label, 16, this.h-14);
    ctx.restore();
  }

  drawStand(ctx){
    ctx.save();
    const x = this.cx - this.R*0.72;
    const y = this.cy + this.R*0.78;
    const w = this.R*1.44;
    const h = this.R*0.38;

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(this.cx, y + h*0.88, w*0.46, h*0.28, 0, 0, Math.PI*2);
    ctx.fill();

    const body = ctx.createLinearGradient(0, y, 0, y+h);
    body.addColorStop(0,'rgba(255,255,255,0.10)');
    body.addColorStop(1,'rgba(0,0,0,0.28)');
    ctx.fillStyle = body;
    this.roundRect(ctx, x, y, w, h, 18);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    this.roundRect(ctx, x+1, y+1, w-2, h-2, 18);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    this.roundRect(ctx, this.exit.x-26, this.exit.y-10, 52, 24, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.stroke();

    ctx.restore();
  }

  drawTray(ctx){
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(this.tray.x + this.trayW*0.5, this.tray.y + this.trayH*1.02, this.trayW*0.48, 16, 0, 0, Math.PI*2);
    ctx.fill();

    const body = ctx.createLinearGradient(this.tray.x, this.tray.y, this.tray.x, this.tray.y+this.trayH);
    body.addColorStop(0,'rgba(255,255,255,0.10)');
    body.addColorStop(1,'rgba(0,0,0,0.25)');
    ctx.fillStyle = body;
    this.roundRect(ctx, this.tray.x, this.tray.y, this.trayW, this.trayH, 18);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    const cols=5, rows=4;
    const cellW=(this.trayW - this.trayPad*2)/cols;
    const cellH=(this.trayH - this.trayPad*2)/rows;
    for(let c=1;c<cols;c++){
      const xx=this.tray.x + this.trayPad + cellW*c;
      ctx.beginPath();
      ctx.moveTo(xx, this.tray.y+this.trayPad);
      ctx.lineTo(xx, this.tray.y+this.trayH-this.trayPad);
      ctx.stroke();
    }
    for(let r=1;r<rows;r++){
      const yy=this.tray.y + this.trayPad + cellH*r;
      ctx.beginPath();
      ctx.moveTo(this.tray.x+this.trayPad, yy);
      ctx.lineTo(this.tray.x+this.trayW-this.trayPad, yy);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255,255,255,.70)';
    ctx.font = '700 12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.fillText('Balotas elegidas', this.tray.x+12, this.tray.y-8);

    ctx.restore();
  }

  drawGlobe(ctx){
    ctx.save();
    const glow = ctx.createRadialGradient(this.cx, this.cy, this.R*0.1, this.cx, this.cy, this.R*1.2);
    glow.addColorStop(0,'rgba(255,255,255,0.10)');
    glow.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, this.R*1.06, 0, Math.PI*2);
    ctx.fill();

    const glass = ctx.createRadialGradient(this.cx-this.R*0.25, this.cy-this.R*0.35, this.R*0.12, this.cx, this.cy, this.R);
    glass.addColorStop(0,'rgba(255,255,255,0.10)');
    glass.addColorStop(1,'rgba(255,255,255,0.03)');
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, this.R, 0, Math.PI*2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, this.R, 0, Math.PI*2);
    ctx.stroke();

    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(this.cx-this.R*0.08, this.cy-this.R*0.12, this.R*0.82, -1.7, -0.9);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.arc(this.cx, this.cy - this.R - 12, 10, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  }

  drawBall(ctx, b, clipped){
    ctx.save();

    if (clipped){
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, this.R-2, 0, Math.PI*2);
      ctx.clip();
    }

    const grad = ctx.createRadialGradient(b.x-b.r*0.35, b.y-b.r*0.35, b.r*0.2, b.x, b.y, b.r*1.25);
    grad.addColorStop(0,'rgba(255,255,255,0.98)');
    grad.addColorStop(1,'rgba(220,220,220,0.95)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI*2);
    ctx.fill();

    const hue = (parseInt(b.num,10) * 3.6) % 360;
    ctx.strokeStyle = `hsla(${hue}, 75%, 55%, 0.95)`;
    ctx.lineWidth = Math.max(2, b.r*0.28);
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r*0.68, 0, Math.PI*2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(b.x-b.r*0.28, b.y-b.r*0.28, b.r*0.22, 0, Math.PI*2);
    ctx.fill();

    ctx.fillStyle = 'rgba(10,10,10,0.92)';
    ctx.font = `${Math.max(10, Math.round(b.r*0.9))}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.num, b.x, b.y+0.5);

    if (!clipped){
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.ellipse(b.x+1, b.y+b.r*0.72, b.r*0.72, b.r*0.30, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.restore();
  }

  // --- helpers ---
  roundRect(ctx, x,y,w,h,r){
    ctx.beginPath();
    const rr = Math.min(r, w/2, h/2);
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y, x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x, y+h, rr);
    ctx.arcTo(x, y+h, x, y, rr);
    ctx.arcTo(x, y, x+w, y, rr);
    ctx.closePath();
  }

  quad(p0, p1, p2, t){
    const u = 1-t;
    return {
      x: u*u*p0.x + 2*u*t*p1.x + t*t*p2.x,
      y: u*u*p0.y + 2*u*t*p1.y + t*t*p2.y
    };
  }

  easeOutCubic(t){ return 1 - Math.pow(1-t, 3); }
  easeInOut(t){ return t<0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2; }
}


/* Page router */
const page = location.pathname.split('/').pop();

if (page === "" || page === "index.html") initLogin();
if (page === "admin.html") initAdmin();
if (page === "user.html") initUser();

/* Login */
async function initLogin(){
  const regBadge = $('#regBadge');
  const modeTitle = $('#modeTitle');
  const toggleMode = $('#toggleMode');
  const countryWrap = $('#countryWrap');
  const submitBtn = $('#submitBtn');
  const toastEl = $('#toast');

  // if session exists, redirect
  const s = getSession();
  if (s?.role === 'admin') location.href='/admin.html';
  if (s?.role === 'user') location.href='/user.html';

  let mode = 'login';

  async function refreshRegister(){
    try{
      const { data } = await loadDB();
      regBadge.textContent = `Registro: ${data.allowRegister ? 'HABILITADO' : 'DESHABILITADO'}`;
    }catch(e){
      regBadge.textContent = 'Registro: (error DB)';
    }
  }
  await refreshRegister();

  toggleMode.addEventListener('click', async ()=>{
    try{
      const { data } = await loadDB();
      if (mode === 'login'){
        if (!data.allowRegister) { toast(toastEl,'warn','El registro está deshabilitado por el admin.'); return; }
        mode = 'register';
        modeTitle.textContent = 'Registro';
        toggleMode.textContent = 'Ya tengo cuenta';
        countryWrap.style.display = '';
        submitBtn.textContent = 'Crear cuenta';
      } else {
        mode = 'login';
        modeTitle.textContent = 'Ingresar';
        toggleMode.textContent = 'Crear cuenta';
        countryWrap.style.display = 'none';
        submitBtn.textContent = 'Entrar';
      }
    }catch(e){
      toast(toastEl,'err', e.message);
    }
  });

  $('#form').addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    const username = ($('#username').value||'').trim();
    const password = ($('#password').value||'').trim();
    const country = ($('#country').value||'CO').trim();

    if (!isValidUserOrPass(username) || !isValidUserOrPass(password)){
      toast(toastEl,'err','Usuario/contraseña inválidos (solo minúsculas y números, 3-20).');
      return;
    }

    try{
      const { data } = await loadDB();

      if (mode === 'register'){
        if (!data.allowRegister) { toast(toastEl,'warn','Registro deshabilitado.'); return; }
        if (data.users.some(u=>u.username===username)) { toast(toastEl,'err','Ese usuario ya existe.'); return; }
        const c = country === 'CO' ? 'CO' : 'OT';
        const cur = currencyForCountry(c);
        const bonus = bonusForCountry(c);

        data.users.push({
          id: uuid(),
          username,
          password,
          role: 'user',
          country: c,
          currency: cur,
          balance: bonus,
          createdAt: nowISO(),
          payments: {},
          history: [],
          lastCreditNotice: { amount: bonus, currency: cur, at: nowISO(), seen: false, note: 'Bono de bienvenida' }
        });

        await saveDB(data, `Register user ${username}`);
        toast(toastEl,'','Usuario creado. Ya puedes ingresar.');
        // back to login
        mode = 'login';
        modeTitle.textContent = 'Ingresar';
        toggleMode.textContent = 'Crear cuenta';
        countryWrap.style.display = 'none';
        submitBtn.textContent = 'Entrar';
        $('#username').value=''; $('#password').value='';
        await refreshRegister();
        return;
      }

      // login
      const user = data.users.find(u=>u.username===username && u.password===password);
      if (!user){ toast(toastEl,'err','Credenciales incorrectas'); return; }
      setSession({ id:user.id, username:user.username, role:user.role, country:user.country, currency:user.currency, password:user.password });
      if (user.role === 'admin') location.href='/admin.html';
      else location.href='/user.html';
    }catch(e){
      toast(toastEl,'err', e.message);
    }
  });
}

/* Admin */
async function initAdmin(){
  const s = requireRole('admin');
  if (!s) return;

  $('#who').textContent = `ADMIN · ${s.username}`;
  $('#logout').addEventListener('click', ()=>{ clearSession(); location.href='/'; });

  const toastEl = $('#toast');
  const usersTbody = $('#usersTbody');
  const filterSel = $('#filter');

  let state = { db:null, selected:null };

  async function refresh(){
    const { data } = await loadDB();
    state.db = data;
    render();
  }

  function render(){
    $('#allowRegisterLine').innerHTML = `Registro: <b>${state.db.allowRegister ? 'HABILITADO' : 'DESHABILITADO'}</b>`;
    renderUsers();
    renderDetail();
  }

  function renderUsers(){
    const f = filterSel.value;
    const users = state.db.users.filter(u=>u.role==='user').filter(u=>{
      if (f==='all') return true;
      return u.country===f;
    });
    usersTbody.innerHTML = users.map(u=>`
      <tr>
        <td>${u.username}</td>
        <td>${u.country}</td>
        <td>${fmt(u.balance, u.currency)}</td>
        <td>${new Date(u.createdAt).toLocaleString()}</td>
        <td><button class="secondary" data-id="${u.id}">Ver</button></td>
      </tr>
    `).join('');

    usersTbody.querySelectorAll('button[data-id]').forEach(btn=>{
      btn.addEventListener('click', (ev)=>{
        const id = btn.getAttribute('data-id');
        state.selected = state.db.users.find(x=>x.id===id);
        renderDetail();
      });
    });
  }

  function renderDetail(){
    const d = state.selected;
    if (!d){
      $('#detail').style.display='none';
      $('#detailEmpty').style.display='';
      return;
    }
    $('#detailEmpty').style.display='none';
    $('#detail').style.display='';
    $('#detailHead').innerHTML = `
      <div><b>${d.username}</b> <span class="badge">${d.currency}</span></div>
      <div>Saldo: <b>${fmt(d.balance, d.currency)}</b></div>
      <small class="muted">País: ${d.country}</small>
    `;

    // medios de pago
    const payEl = $('#payDetail');
    if (payEl){
      const p = d.payments || {};
      const hasAny = Object.values(p).some(v => String(v||'').trim().length);
      if (!hasAny){
        payEl.innerHTML = '<small class="muted">Sin medios de pago guardados.</small>';
      } else if (d.country === 'CO'){
        payEl.innerHTML = `
          <table>
            <tbody>
              <tr><th style="text-align:left">Propietario</th><td>${p.owner||''}</td></tr>
              <tr><th style="text-align:left">Nequi</th><td>${p.nequi||''}</td></tr>
              <tr><th style="text-align:left">Daviplata</th><td>${p.daviplata||''}</td></tr>
              <tr><th style="text-align:left">Binance</th><td>${p.binance||''}</td></tr>
            </tbody>
          </table>
        `;
      } else {
        payEl.innerHTML = `
          <table>
            <tbody>
              <tr><th style="text-align:left">Binance</th><td>${p.binance||''}</td></tr>
            </tbody>
          </table>
        `;
      }
    }

    const hist = (d.history||[]).slice().reverse().slice(0,20);
    $('#histTbody').innerHTML = hist.map(h=>`
      <tr>
        <td>${new Date(h.at).toLocaleString()}</td>
        <td>${(h.pick||[]).join(', ')}</td>
        <td>${h.bet}</td>
        <td>${h.matches}</td>
        <td>${h.payout}</td>
      </tr>
    `).join('');
  }

  filterSel.addEventListener('change', renderUsers);

  $('#toggleRegister').addEventListener('click', async ()=>{
    try{
      state.db.allowRegister = !state.db.allowRegister;
      await saveDB(state.db, `Toggle allowRegister=${state.db.allowRegister}`);
      toast(toastEl,'', 'Configuración actualizada');
      await refresh();
    }catch(e){ toast(toastEl,'err', e.message); }
  });

  $('#saveAdminPass').addEventListener('click', async ()=>{
    try{
      const np = ($('#adminNewPass').value||'').trim();
      if (!isValidUserOrPass(np)) { toast(toastEl,'err','Clave inválida (minúsculas+numeros 3-20).'); return; }
      const admin = state.db.users.find(u=>u.role==='admin' && u.username==='admin');
      admin.password = np;
      await saveDB(state.db, 'Admin changed admin password');
      // update session password too
      const ss = getSession();
      setSession({ ...ss, password: np });
      toast(toastEl,'', 'Clave admin actualizada');
      $('#adminNewPass').value='';
      await refresh();
    }catch(e){ toast(toastEl,'err', e.message); }
  });

  $('#addBal').addEventListener('click', async ()=>{
    try{
      if (!state.selected) return;
      const amount = Number(($('#delta').value||'0'));
      if (!(amount>0)) { toast(toastEl,'err','Monto debe ser > 0'); return; }
      state.selected.balance += Math.trunc(amount);
      state.selected.lastCreditNotice = { amount: Math.trunc(amount), currency: state.selected.currency, at: nowISO(), seen:false, note:'Ajuste admin (suma)' };
      await saveDB(state.db, `Admin add balance ${amount} to ${state.selected.username}`);
      toast(toastEl,'', 'Saldo actualizado');
      $('#delta').value='';
      await refresh();
    }catch(e){ toast(toastEl,'err', e.message); }
  });

  $('#subBal').addEventListener('click', async ()=>{
    try{
      if (!state.selected) return;
      const amount = Number(($('#delta').value||'0'));
      if (!(amount>0)) { toast(toastEl,'err','Monto debe ser > 0'); return; }
      if (state.selected.balance < amount) { toast(toastEl,'err','No puedes restar más que el saldo'); return; }
      state.selected.balance -= Math.trunc(amount);
      state.selected.lastCreditNotice = { amount: -Math.trunc(amount), currency: state.selected.currency, at: nowISO(), seen:false, note:'Ajuste admin (resta)' };
      await saveDB(state.db, `Admin sub balance ${amount} to ${state.selected.username}`);
      toast(toastEl,'', 'Saldo actualizado');
      $('#delta').value='';
      await refresh();
    }catch(e){ toast(toastEl,'err', e.message); }
  });

  $('#saveUserPass').addEventListener('click', async ()=>{
    try{
      if (!state.selected) return;
      const np = ($('#userNewPass').value||'').trim();
      if (!isValidUserOrPass(np)) { toast(toastEl,'err','Clave inválida (minúsculas+numeros 3-20).'); return; }
      state.selected.password = np;
      await saveDB(state.db, `Admin changed password ${state.selected.username}`);
      toast(toastEl,'', 'Contraseña actualizada');
      $('#userNewPass').value='';
      await refresh();
    }catch(e){ toast(toastEl,'err', e.message); }
  });

  $('#delUser').addEventListener('click', async ()=>{
    try{
      if (!state.selected) return;
      const id = state.selected.id;
      state.db.users = state.db.users.filter(u=>u.id!==id);
      state.selected = null;
      await saveDB(state.db, `Admin deleted user ${id}`);
      toast(toastEl,'', 'Usuario eliminado');
      await refresh();
    }catch(e){ toast(toastEl,'err', e.message); }
  });

  await refresh();
}

/* User */
async function initUser(){
  const s = requireRole('user');
  if (!s) return;

  $('#who').textContent = `USUARIO · ${s.username}`;
  $('#logout').addEventListener('click', ()=>{ clearSession(); location.href='/'; });

  const toastEl = $('#toast');
  const saldoLine = $('#saldoLine');
  const noticeEl = $('#notice');
  const grid = $('#grid99');
  const histEl = $('#hist');
  const playBtn = $('#play');
  const pendingLine = $('#pendingLine');
  const balCanvas = $('#baloteraCanvas');
  const extractedLine = $('#extractedLine');
  const animator = (balCanvas && extractedLine) ? new BaloteraAnimator(balCanvas, extractedLine) : null;

  // ===== RULETA (nuevo UI circular + mesa completa, no altera Balotas) =====
  const btnShowBalotas = $('#btnShowBalotas');
  const btnShowRuleta = $('#btnShowRuleta');
  const btnShowFrutas = $('#btnShowFrutas');
  const btnGoAviador = $('#btnGoAviador');
  const btnGoEURUSD = $('#btnGoEURUSD');
  const balotasSection = $('#balotasSection');
  const ruletaSection = $('#ruletaSection');
  const frutasSection = $('#frutasSection');

  const rouletteCanvas = $('#rouletteCanvas');
  const wheelFrame = $('#wheelFrame');
  const rouletteResult = $('#rouletteResult');
  const roulettePickLine = $('#roulettePickLine');
  const rouletteHist = $('#rouletteHist');
  const spinRouletteBtn = $('#spinRoulette');
  const rouletteBetTable = $('#rouletteBetTable');
  const rouletteClear = $('#rouletteClear');

  const betRed = $('#betRed');
  const betBlack = $('#betBlack');
  const betZero = $('#betZero');
  const betNumberBtn = $('#betNumber');
  const rNumber = $('#rNumber');

    let rouletteSpinning = false;

  const WHEEL_ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
  const RED_SET = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

  function numColor(n){
    if (n===0) return 'green';
    return RED_SET.has(n) ? 'red' : 'black';
  }

  function setGame(view){
    if (!balotasSection || !ruletaSection || !frutasSection) return;
    const showBalotas = (view === 'balotas');
    const showRuleta = (view === 'ruleta');
    const showFrutas = (view === 'frutas');

    balotasSection.style.display = showBalotas ? '' : 'none';
    ruletaSection.style.display = showRuleta ? '' : 'none';
    frutasSection.style.display = showFrutas ? '' : 'none';

    if (btnShowBalotas) btnShowBalotas.classList.toggle('secondary', !showBalotas);
    if (btnShowRuleta) btnShowRuleta.classList.toggle('secondary', !showRuleta);
    if (btnShowFrutas) btnShowFrutas.classList.toggle('secondary', !showFrutas);

    if (showRuleta){
      buildRouletteTable();
      drawRouletteWheel(wheelAngle, null);
      updateRoulettePickLine();
    }
    if (showFrutas){
      initFruitMachineOnce();
      renderFruitBets();
    }
  }

  if (btnShowBalotas) btnShowBalotas.addEventListener('click', ()=>setGame('balotas'));
  if (btnShowRuleta) btnShowRuleta.addEventListener('click', ()=>setGame('ruleta'));
  if (btnShowFrutas) btnShowFrutas.addEventListener('click', ()=>setGame('frutas'));


function clearActiveBets(){
    document.querySelectorAll('.betChip.active, .rtCell.active, .rtOutside.active').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.pickCount').forEach(s=>s.remove());
  }

  // Selecciones múltiples: cada clic suma 1 "ticket" (unidad) a esa apuesta. Shift+clic resta 1.
  const rouletteSelections = new Map(); // key -> {kind,value,label,count, el}
  function selKey(kind, value){ return `${kind}:${value}`; }

  function ensureCountBadge(el, count){
    if (!el) return;
    let badge = el.querySelector('.pickCount');
    if (count<=0){
      if (badge) badge.remove();
      el.classList.remove('active');
      return;
    }
    if (!badge){
      badge = document.createElement('span');
      badge.className = 'pickCount';
      el.appendChild(badge);
    }
    badge.textContent = `x${count}`;
    el.classList.add('active');
  }

  function selectionsSummary(unitBet){
    const parts = [];
    let totalCount = 0;
    rouletteSelections.forEach(s=>{
      totalCount += s.count;
      parts.push(`${s.label} x${s.count}`);
    });

  // Ir al Aviador (ruta estática dentro de /public/juegos/aviador/)
  if (btnGoAviador) {
    btnGoAviador.addEventListener('click', () => {
      window.location.href = '/juegos/aviador/';
    });
    if (btnGoEURUSD) btnGoEURUSD.addEventListener('click', () => {
      window.location.href = '/juegos/eurusd/';
    });
  }

    const totalStake = totalCount * unitBet;
    return { parts, totalCount, totalStake };
  }

  function updateRoulettePickLine(){
    if (!roulettePickLine || !spinRouletteBtn) return;
    const unitBet = Number($('#rBet')?.value || 0);
    const { parts, totalCount, totalStake } = selectionsSummary(unitBet);
    roulettePickLine.textContent = totalCount
      ? `Selecciones: ${parts.join(' + ')}  ·  Total: ${fmt(totalStake, (state?.me?.currency||'COP'))}`
      : 'Selecciona una o varias apuestas.';
    spinRouletteBtn.disabled = totalCount===0 || rouletteSpinning;
  }

  function addSelection(pick, el, delta){
    const unitBet = Number($('#rBet')?.value || 0);
    const key = selKey(pick.kind, pick.value);
    const cur = rouletteSelections.get(key) || { ...pick, count:0, el:null };
    cur.count += delta;
    cur.el = el || cur.el;
    if (cur.count <= 0){
      // limpiar
      ensureCountBadge(cur.el, 0);
      rouletteSelections.delete(key);
    } else {
      rouletteSelections.set(key, cur);
      ensureCountBadge(cur.el, cur.count);
    }
    updateRoulettePickLine();
  }

  function clearSelections(){
    rouletteSelections.forEach(s=>ensureCountBadge(s.el, 0));
    rouletteSelections.clear();
    updateRoulettePickLine();
  }

  // ----- Mesa de apuestas (estilo casino) -----
  function buildRouletteTable(){
    if (!rouletteBetTable || rouletteBetTable.dataset.built === '1') return;

    // estructura: 0 vertical + grid 12x3
    const wrap = document.createElement('div');
    wrap.className = 'rtWrap';

    const zero = document.createElement('button');
    zero.className = 'rtZero rtCell green';
    zero.textContent = '0';
    zero.dataset.num='0';
    zero.addEventListener('click', (ev)=>addSelection({kind:'number', value:0, label:'Número 0 (35:1)'}, zero, ev.shiftKey?-1:1));
    wrap.appendChild(zero);

    const grid = document.createElement('div');
    grid.className = 'rtGrid';

    // filas de arriba (34-36) hacia abajo (1-3)
    for (let row=12; row>=1; row--){
      const rowEl = document.createElement('div');
      rowEl.className = 'rtRow';
      for (let col=1; col<=3; col++){
        const n = (row-1)*3 + col;
        const btn = document.createElement('button');
        btn.className = `rtCell ${numColor(n)}`;
        btn.textContent = String(n);
        btn.dataset.num = String(n);
        btn.addEventListener('click', (ev)=>addSelection({kind:'number', value:n, label:`Número ${n} (35:1)`}, btn, ev.shiftKey?-1:1));
        rowEl.appendChild(btn);
      }
      grid.appendChild(rowEl);
    }
    wrap.appendChild(grid);

    // columnas (2:1)
    const colBets = document.createElement('div');
    colBets.className = 'rtCols';
    const cols = [
      {k:'col1', label:'2:1', txt:'2:1'},
      {k:'col2', label:'2:1', txt:'2:1'},
      {k:'col3', label:'2:1', txt:'2:1'},
    ];
    cols.forEach((c,i)=>{
      const b=document.createElement('button');
      b.className='rtOutside';
      b.textContent=c.txt;
      b.addEventListener('click', (ev)=>addSelection({kind:c.k, value:c.k, label:`Col ${i+1} (2:1)`}, b, ev.shiftKey?-1:1));
      colBets.appendChild(b);
    });
    rouletteBetTable.appendChild(wrap);
    rouletteBetTable.appendChild(colBets);
    rouletteBetTable.dataset.built = '1';
  }

  // ----- Dibujo y animación del plato (circular) -----
  let wheelAngle = 0; // radianes
  const pointerAngle = -Math.PI/2; // arriba

  function indexOfNumber(n){
    return WHEEL_ORDER.indexOf(n);
  }

  function angleForIndex(i){
    const seg = (Math.PI*2) / WHEEL_ORDER.length;
    return i*seg + seg/2; // centro del segmento
  }

  function drawRouletteWheel(angle, highlightNumber){
    if (!rouletteCanvas) return;
    const ctx = rouletteCanvas.getContext('2d');
    const w = rouletteCanvas.width;
    const h = rouletteCanvas.height;
    const cx = w/2, cy = h/2;

    ctx.clearRect(0,0,w,h);

    const seg = (Math.PI*2)/WHEEL_ORDER.length;
    const rOuter = Math.min(w,h)*0.48;
    const rInner = rOuter*0.72;
    const rText = (rOuter+rInner)/2;

    // plato exterior
    ctx.beginPath();
    ctx.arc(cx,cy,rOuter+10,0,Math.PI*2);
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.stroke();

    // segmentos
    for (let i=0;i<WHEEL_ORDER.length;i++){
      const n = WHEEL_ORDER[i];
      const a0 = angle + i*seg;
      const a1 = a0 + seg;

      ctx.beginPath();
      ctx.moveTo(cx,cy);
      ctx.arc(cx,cy,rOuter,a0,a1);
      ctx.closePath();

      const c = numColor(n);
      ctx.fillStyle =
        c==='green' ? 'rgba(34,197,94,.45)' :
        c==='red' ? 'rgba(239,68,68,.40)' :
        'rgba(15,23,42,.72)';
      ctx.fill();

      // borde
      ctx.lineWidth = (highlightNumber===n) ? 6 : 2;
      ctx.strokeStyle = (highlightNumber===n) ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.12)';
      ctx.stroke();

      // texto
      ctx.save();
      ctx.translate(cx,cy);
      const at = a0 + seg/2;
      ctx.rotate(at);
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.fillStyle='rgba(255,255,255,.92)';
      ctx.font='900 18px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      ctx.fillText(String(n), rText, 0);
      ctx.restore();
    }

    // centro
    ctx.beginPath();
    ctx.arc(cx,cy,rInner,0,Math.PI*2);
    ctx.fillStyle='rgba(0,0,0,.35)';
    ctx.fill();
    ctx.lineWidth=2;
    ctx.strokeStyle='rgba(255,255,255,.10)';
    ctx.stroke();

    // marcador/puntero arriba
    ctx.save();
    ctx.translate(cx,cy);
    ctx.rotate(pointerAngle);
    ctx.beginPath();
    ctx.moveTo(rOuter+16,0);
    ctx.lineTo(rOuter-8,-10);
    ctx.lineTo(rOuter-8,10);
    ctx.closePath();
    ctx.fillStyle='rgba(255,255,255,.92)';
    ctx.fill();
    ctx.restore();

    // bolita (dibujada cerca del puntero)
    ctx.save();
    ctx.translate(cx,cy);
    const ballR = 8;
    const ballDist = rOuter+2;
    ctx.rotate(pointerAngle);
    ctx.beginPath();
    ctx.arc(ballDist,0,ballR,0,Math.PI*2);
    const g = ctx.createRadialGradient(ballDist-2,-2,1, ballDist,0, ballR+5);
    g.addColorStop(0,'rgba(255,255,255,.95)');
    g.addColorStop(1,'rgba(190,190,190,.9)');
    ctx.fillStyle=g;
    ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.35)';
    ctx.lineWidth=1;
    ctx.stroke();
    ctx.restore();
  }

  function animateWheelToResult(result){
    if (!wheelFrame) { drawRouletteWheel(wheelAngle, result); return Promise.resolve(); }

    const idx = indexOfNumber(result);
    const targetCenter = angleForIndex(idx);
    // Queremos que el centro del segmento ganador quede bajo el puntero
    // angleEnd + targetCenter == pointerAngle (mod 2pi)
    let baseEnd = pointerAngle - targetCenter;

    // añadir varias vueltas para efecto casino
    const spins = 8 + Math.floor(Math.random()*4); // 8-11 vueltas
    const end = baseEnd - spins*(Math.PI*2);

    const start = wheelAngle;
    const duration = 4800 + Math.floor(Math.random()*700);

    return new Promise(resolve=>{
      const t0 = performance.now();

      function easeOutQuint(t){ return 1 - Math.pow(1-t,5); }

      function frame(now){
        const t = Math.min(1,(now-t0)/duration);
        const eased = easeOutQuint(t);

        // zoom en la parte final
        if (wheelFrame){
          const z = (t<0.78) ? 1 : (1 + (eased - easeOutQuint(0.78)) / (1 - easeOutQuint(0.78)) * 0.35);
          wheelFrame.style.transform = `scale(${Math.min(1.35, z)})`;
        }

        wheelAngle = start + (end-start)*eased;
        drawRouletteWheel(wheelAngle, t>0.88 ? result : null);

        if (t<1) requestAnimationFrame(frame);
        else {
          // deja resaltado y zoom final suave
          if (wheelFrame){
            wheelFrame.style.transform = 'scale(1.35)';
          }
          drawRouletteWheel(wheelAngle, result);
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  function payoutFor(pick, result){
    const n = result;
    switch(pick.kind){
      case 'color':
        if (n===0) return 0;
        return (pick.value === numColor(n)) ? 2 : 0; // 1:1
      case 'zero':
        return (n===0) ? 36 : 0; // 35:1
      case 'even':
        return (n!==0 && n%2===0) ? 2 : 0;
      case 'odd':
        return (n%2===1) ? 2 : 0;
      case 'low':
        return (n>=1 && n<=18) ? 2 : 0;
      case 'high':
        return (n>=19 && n<=36) ? 2 : 0;
      case 'dozen1':
        return (n>=1 && n<=12) ? 3 : 0; // 2:1
      case 'dozen2':
        return (n>=13 && n<=24) ? 3 : 0;
      case 'dozen3':
        return (n>=25 && n<=36) ? 3 : 0;
      case 'col1':
        return (n!==0 && ((n-1)%3===0)) ? 3 : 0;
      case 'col2':
        return (n!==0 && ((n-2)%3===0)) ? 3 : 0;
      case 'col3':
        return (n!==0 && ((n-3)%3===0)) ? 3 : 0;
      case 'number':
        return (n===pick.value) ? 36 : 0;
      default:
        return 0;
    }
  }

  function randomRouletteNumber(){
    // Aleatorio real por jugada (0-36). Usa crypto si está disponible.
    try{
      if (typeof crypto !== 'undefined' && crypto.getRandomValues){
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return buf[0] % 37;
      }
    }catch(e){}
    return Math.floor(Math.random()*37);
  }

  function seededRouletteNumber(){
    // (Legacy) determinístico por ciclo y usuario. Ya no se usa porque ruleta ahora es aleatoria.
    const idx = cycleIndex(new Date());
    const key = `${s.username}|${idx}`;
    let seed = 2166136261;
    for (let i=0;i<key.length;i++){
      seed ^= key.charCodeAt(i);
      seed = Math.imul(seed, 16777619);
    }
    let x = seed >>> 0;
    function rnd(){
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      return (x >>> 0) / 4294967296;
    }
    return Math.floor(rnd()*37);
  }

  function renderRouletteHistory(){
    if (!rouletteHist) return;
    const rows = (state.me.rouletteHistory || []).slice().reverse().slice(0,50);
    rouletteHist.innerHTML = rows.map(r=>{
      const resColor = numColor(r.result);
      const badge = `<span class="badge">${resColor.toUpperCase()}</span>`;
      return `<tr>
        <td>${new Date(r.at).toLocaleString()}</td>
        <td>${esc(r.bet)}</td>
        <td>${fmt(r.amount, state.me.currency)}</td>
        <td><b>${r.result}</b> ${badge}</td>
        <td>${r.payout>0 ? `<b>${fmt(r.payout, state.me.currency)}</b>` : '—'}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="5" class="muted">Sin jugadas aún.</td></tr>`;
  }

  
async function spinRoulette(){
    if (rouletteSpinning) return;
    const unitBet = Number($('#rBet')?.value || 0);
    const { totalCount, totalStake } = selectionsSummary(unitBet);
    if (!totalCount || totalStake<=0) return;

    // cierre de apuestas cerca del cambio de ciclo (misma regla que balotas, para consistencia)
    if (typeof isBettingClosed === 'function' && isBettingClosed()){
      toast(toastEl,'warn','Apuestas cerradas: espera el siguiente ciclo.');
      return;
    }

    if (state.me.balance < totalStake){
      toast(toastEl,'warn','Saldo insuficiente.');
      return;
    }

    rouletteSpinning = true;
    updateRoulettePickLine();

    try{
      // 1) descontar de inmediato
      state.me.balance -= totalStake;
      await saveDB(state.db);
      renderMe();

      // 2) generar resultado aleatorio
      const result = randomRouletteNumber();

      // 3) animación (plato)
      await animateWheelToResult(result);

      // 4) evaluar todas las selecciones
      let payoutTotal = 0;
      rouletteSelections.forEach(sel=>{
        const stake = unitBet * sel.count;
        const won = checkRouletteWin(sel, result);
        if (!won) return;

        const mult = roulettePayoutMultiplier(sel); // incluye devolución de apuesta
        payoutTotal += stake * mult;
      });

      // 5) acreditar si gana
      if (payoutTotal > 0){
        state.me.balance += payoutTotal;
        await saveDB(state.db);
        renderMe();
      }

      // 6) historial
      const summary = selectionsSummary(unitBet).parts.join(' + ');
      state.me.rouletteHistory = state.me.rouletteHistory || [];
      state.me.rouletteHistory.push({
        at: Date.now(),
        bet: summary || '(sin detalle)',
        amount: totalStake,
        result,
        payout: payoutTotal
      });
      await saveDB(state.db);
      renderRouletteHistory();

      // 7) UI result
      const c = numColor(result).toUpperCase();
      if (rouletteResult){
        rouletteResult.innerHTML = `Resultado: <span class="big"><b>${result}</b></span> <span class="badge">${c}</span> · ${payoutTotal>0?`Ganaste <b>${fmt(payoutTotal, state.me.currency)}</b>`:'No ganaste esta vez.'}`;
      }

      // opcional: limpiar selecciones después de jugar
      clearSelections();

    }catch(e){
      toast(toastEl,'err', e.message);
    }finally{
      rouletteSpinning = false;
      updateRoulettePickLine();
    }
  }

  function roulettePayoutMultiplier(sel){
    // multiplicador de pago (incluye devolución de apuesta)
    if (sel.kind === 'number') return 36; // 35:1 + apuesta
    if (sel.kind === 'color' || sel.kind === 'even' || sel.kind === 'odd' || sel.kind === 'low' || sel.kind === 'high') return 2;
    if (sel.kind === 'dozen1' || sel.kind === 'dozen2' || sel.kind === 'dozen3' || sel.kind === 'col1' || sel.kind === 'col2' || sel.kind === 'col3') return 3;
    return 0;
  }

  function checkRouletteWin(sel, result){
    const n = result;
    switch(sel.kind){
      case 'number': return n === Number(sel.value);
      case 'color': return n!==0 && numColor(n) === sel.value;
      case 'even': return n!==0 && (n%2===0);
      case 'odd': return n!==0 && (n%2===1);
      case 'low': return n>=1 && n<=18;
      case 'high': return n>=19 && n<=36;
      case 'dozen1': return n>=1 && n<=12;
      case 'dozen2': return n>=13 && n<=24;
      case 'dozen3': return n>=25 && n<=36;
      case 'col1': return n!==0 && ((n-1)%3===0);
      case 'col2': return n!==0 && ((n-2)%3===0);
      case 'col3': return n!==0 && ((n-3)%3===0);
      default: return false;
    }
  }


  if (betRed) betRed.addEventListener('click', (ev)=>addSelection({kind:'color', value:'red', label:'Rojo (1:1)'}, betRed, ev.shiftKey?-1:1));
  if (betBlack) betBlack.addEventListener('click', (ev)=>addSelection({kind:'color', value:'black', label:'Negro (1:1)'}, betBlack, ev.shiftKey?-1:1));
  if (betZero) betZero.addEventListener('click', (ev)=>addSelection({kind:'number', value:0, label:'Número 0 (35:1)'}, rouletteBetTable?.querySelector('[data-num="0"]') || betZero, ev.shiftKey?-1:1));

  document.querySelectorAll('[data-bet]').forEach(btn=>{
    btn.addEventListener('click', (ev)=>{
      const k = btn.dataset.bet;
      const labels = {
        even:'Par (1:1)', odd:'Impar (1:1)', low:'1-18 (1:1)', high:'19-36 (1:1)',
        dozen1:'1-12 (2:1)', dozen2:'13-24 (2:1)', dozen3:'25-36 (2:1)',
        col1:'Col 1 (2:1)', col2:'Col 2 (2:1)', col3:'Col 3 (2:1)'
      };
      addSelection({kind:k, value:k, label:labels[k]||k}, btn, ev.shiftKey?-1:1);
    });
  });

  if (betNumberBtn) betNumberBtn.addEventListener('click', ()=>{
    const n = Number(rNumber?.value);
    if (!(n>=0 && n<=36)){ toast(toastEl,'warn','Número debe ser 0-36'); return; }
    const cell = rouletteBetTable?.querySelector(`[data-num="${n}"]`);
    addSelection({kind:'number', value:n, label:`Número ${n} (35:1)`}, cell || betNumberBtn, 1);
  });

  if (rouletteClear) rouletteClear.addEventListener('click', clearSelections);

  if (spinRouletteBtn) spinRouletteBtn.addEventListener('click', spinRoulette);


  let state = { db:null, me:null, pick:[] };
  const BET_CLOSE_SECONDS = 10; // se cierra la recepción de apuestas 10s antes del siguiente ciclo
  function msToNextCycle(){
    const idx = cycleIndex(new Date());
    const nextAt = cycleStartDate(idx+1);
    return nextAt.getTime() - Date.now();
  }
  function isBettingClosed(){
    return msToNextCycle() <= (BET_CLOSE_SECONDS * 1000);
  }


  function renderMe(){
    saldoLine.innerHTML = `Saldo: <b>${fmt(state.me.balance, state.me.currency)}</b> <span class="badge">${state.me.currency}</span>`;

    // withdraw hint
    const withdrawHintEl = $('#withdrawHint');
    if (withdrawHintEl){
      const minW = state.me.country === 'CO' ? 20000 : 20;
      const curW = state.me.country === 'CO' ? 'COP' : 'USD';
      withdrawHintEl.textContent = `Monto mínimo: ${fmt(minW, curW)}. El monto no puede superar tu saldo actual.`;
    }

    // notice
    noticeEl.innerHTML = '';
    if (state.me.lastCreditNotice && state.me.lastCreditNotice.seen === false){
      const amt = state.me.lastCreditNotice.amount;
      noticeEl.innerHTML = `<div class="toast">Se acreditó tu saldo con: <b>${fmt(Math.abs(amt), state.me.currency)}</b></div>`;
    }

    // payments UI
    const payWrap = $('#payWrap');
    const p = state.me.payments || {};
    if (state.me.country === 'CO'){
      payWrap.innerHTML = `
        <label>Nombre del propietario</label>
        <input id="p_owner" value="${(p.owner||'')}" placeholder="Nombre completo"/>
        <div style="height:10px"></div>
        <label>Nequi</label>
        <input id="p_nequi" value="${(p.nequi||'')}" placeholder="Número"/>
        <div style="height:10px"></div>
        <label>Daviplata</label>
        <input id="p_daviplata" value="${(p.daviplata||'')}" placeholder="Número"/>
        <div style="height:10px"></div>
        <label>Binance (ID o correo)</label>
        <input id="p_binance" value="${(p.binance||'')}" placeholder="correo/ID"/>
      `;
    } else {
      payWrap.innerHTML = `
        <label>Binance (ID o correo)</label>
        <input id="p_binance" value="${(p.binance||'')}" placeholder="correo/ID"/>
      `;
    }

    // history
    const hist = (state.me.history||[]).slice().reverse().slice(0,12);
    histEl.innerHTML = hist.map(h=>`
      <tr>
        <td>${new Date(h.at).toLocaleString()}</td>
        <td>${(h.pick||[]).join(', ')}</td>
        <td>${h.bet}</td>
        <td>${h.matches}</td>
        <td>${h.payout}</td>
      </tr>
    `).join('');

    renderPending();
  }


  // ===== MAQUINA DE FRUTAS (luces alrededor) =====
  const FRUIT_BET_UNIT = 200;
  const fruitBoard = $('#fruitBoard');
  const fruitBetButtons = $('#fruitBetButtons');
  const fruitTotalEl = $('#fruitTotal');
  const fruitPlayBtn = $('#fruitPlay');
  const fruitClearBtn = $('#fruitClear');
  const fruitMsg = $('#fruitMsg');

  const fruitItems = [
    { id:'cherry',     name:'Cereza',     icon:'assets/fruits/cherry.svg',     mult:2 },
    { id:'lemon',      name:'Limón',      icon:'assets/fruits/lemon.svg',      mult:2 },
    { id:'orange',     name:'Naranja',    icon:'assets/fruits/orange.svg',     mult:2 },
    { id:'grape',      name:'Uvas',       icon:'assets/fruits/grape.svg',      mult:3 },
    { id:'banana',     name:'Banano',     icon:'assets/fruits/banana.svg',     mult:4 },
    { id:'watermelon', name:'Sandía',     icon:'assets/fruits/watermelon.svg', mult:5 },
    { id:'bell',       name:'Campana',    icon:'assets/fruits/bell.svg',       mult:8 },
    { id:'diamond',    name:'Diamante',   icon:'assets/fruits/diamond.svg',    mult:10 },
    { id:'crown',      name:'Corona',     icon:'assets/fruits/crown.svg',      mult:12 },
    { id:'star',       name:'Estrella',   icon:'assets/fruits/star.svg',       mult:15 },

    // especiales estilo “tienda”
    { id:'barbar',     name:'BAR BAR',    icon:'assets/fruits/barbar.svg',     mult:100 },
    { id:'seven77',    name:'77',         icon:'assets/fruits/seven77.svg',    mult:30 },
    { id:'once_more',  name:'ONCE MORE',  icon:'assets/fruits/once_more.svg',  mult:null, special:'once_more' },
  ];
  const fruitById = Object.fromEntries(fruitItems.map(it=>[it.id,it]));
  function fruitPayLabel(it){
    if (it?.special === 'once_more') return 'BONUS (2 chances)';
    if (it?.mult == null) return '';
    return `Paga x${it.mult}`;
  }

  function fruitMultShort(it){
    if (it?.special === 'once_more') return 'BONUS';
    if (it?.mult == null) return '';
    return `x${it.mult}`;
  }


  // Secuencia alrededor del tablero (24 casillas). Se repiten símbolos como en las máquinas reales.
  const fruitRing = [
    // 24 casillas alrededor (perímetro). Conteos y posiciones tipo máquina de tienda.
    // Índices (0..23) siguen el perímetro: fila superior (0-6), lateral derecho (7-11), fila inferior (12-18), lateral izquierdo (19-23).
    // BAR BAR centrado arriba (pos 3). ONCE MORE en centros laterales (pos 9 y 21).
    /*00*/ 'bell',
    /*01*/ 'cherry',
    /*02*/ 'lemon',
    /*03*/ 'barbar',   // centro arriba
    /*04*/ 'orange',
    /*05*/ 'cherry',
    /*06*/ 'star',
    /*07*/ 'lemon',
    /*08*/ 'grape',
    /*09*/ 'once_more',// centro derecha
    /*10*/ 'orange',
    /*11*/ 'cherry',
    /*12*/ 'crown',
    /*13*/ 'grape',
    /*14*/ 'lemon',
    /*15*/ 'seven77',
    /*16*/ 'orange',
    /*17*/ 'cherry',
    /*18*/ 'diamond',
    /*19*/ 'watermelon',
    /*20*/ 'banana',
    /*21*/ 'once_more',// centro izquierda
    /*22*/ 'cherry',
    /*23*/ 'cherry',
  ];
  const FRUIT_POS_COUNT = fruitRing.length;


  let fruitReady = false;
  let fruitBets = {};      // { id: count(1..9) }
  let fruitCurrentPos = 0; // 0..(FRUIT_POS_COUNT-1)
  let fruitSpinning = false;

  function money(v){ return fmt(v, state.me?.currency || 'COP'); }

  // Escapa texto para insertar en HTML de forma segura
  function escapeHtml(s){
    return String(s ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#039;');
  }
  function fruitTotalBet(){
    return Object.values(fruitBets).reduce((a,b)=>a + (b||0), 0) * FRUIT_BET_UNIT;
  }
  function fruitBetCount(id){ return fruitBets[id] || 0; }

  function initFruitMachineOnce(){
    if (fruitReady) return;
    if (!fruitBoard || !fruitBetButtons) return;

    // Pintar tablero
    fruitBoard.querySelectorAll('.fruitCell').forEach(cell=>{
      const pos = Number(cell.getAttribute('data-pos'));
      const symbolId = fruitRing[pos % FRUIT_POS_COUNT];
      const it = fruitById[symbolId];
      cell.innerHTML = `
        <span class="fruitBetCount">0</span>
        <img alt="${escapeHtml(it.name)}" src="${it.icon}"/>
        <div class="fruitName">${escapeHtml(it.name)}</div>
        <div class="fruitPay">${escapeHtml(fruitPayLabel(it))}</div>
      `;
    });

    // Botonera de apuestas
    fruitBetButtons.innerHTML = fruitItems.filter(it=>it.special!=='once_more').map(it=>{
      return `
        <div class="fruitBetBtn" data-id="${it.id}" role="button" tabindex="0" title="Apostar 200 a ${escapeHtml(it.name)}">
          <img alt="${escapeHtml(it.name)}" src="${it.icon}"/>
          <div class="meta">
            <div class="t">${escapeHtml(it.name)}</div>
            <div class="s">${escapeHtml(fruitMultShort(it))}</div>
          </div>
          <div class="chip" data-chip="${it.id}">0</div>
        </div>
      `;
    }).join('');

    fruitBetButtons.addEventListener('click', (e)=>{
      const btn = e.target.closest('.fruitBetBtn');
      if (!btn) return;
      addFruitBet(btn.getAttribute('data-id'));
    });

    fruitBetButtons.addEventListener('keydown', (e)=>{
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const btn = e.target.closest('.fruitBetBtn');
      if (!btn) return;
      e.preventDefault();
      addFruitBet(btn.getAttribute('data-id'));
    });

    if (fruitClearBtn){
      fruitClearBtn.addEventListener('click', ()=>{
        if (fruitSpinning) return;
        fruitBets = {};
        renderFruitBets();
        if (fruitMsg) fruitMsg.textContent = '';
      });
    }

    if (fruitPlayBtn){
      fruitPlayBtn.addEventListener('click', async ()=>{
        if (fruitSpinning) return;

        const total = fruitTotalBet();
        if (total <= 0){
          toast(toastEl,'warn','Selecciona al menos 1 apuesta (200).');
          return;
        }
        if ((state.me.balance||0) < total){
          toast(toastEl,'err','Saldo insuficiente para esa apuesta.');
          return;
        }

        // descontar al dar Play
        fruitSpinning = true;
        try{
          state.me.balance -= total;
          await saveDB(state.db);
          renderMe();

          if (fruitMsg) fruitMsg.textContent = 'Girando...';

          const winnerPos = await spinFruitBoard();
          const winner = fruitById[fruitRing[winnerPos % FRUIT_POS_COUNT]];

          // calcular payout
          function payoutForSymbol(symbolId){
            const it = fruitById[symbolId];
            if (!it || it.mult == null) return 0; // sin pago (ej: once_more)
            const c = fruitBetCount(symbolId);
            return c > 0 ? (c * FRUIT_BET_UNIT * it.mult) : 0;
          }

          let payout = 0;
          let outcomes = [];      // ids resultantes (1 normal, 2 en ONCE MORE)
          let mainWinnerId = winner.id;
          let isOnceMore = winner?.special === 'once_more';

          if (isOnceMore){
            if (fruitMsg) fruitMsg.innerHTML = `Salió <b>${escapeHtml(winner.name)}</b> · Activando <b>2 oportunidades</b>...`;
            // Bonus: dos luces / dos resultados
            const [bpos1, bpos2] = await spinFruitBoardBonusTwo();
            const b1 = fruitById[fruitRing[bpos1 % FRUIT_POS_COUNT]];
            const b2 = fruitById[fruitRing[bpos2 % FRUIT_POS_COUNT]];
            outcomes = [b1.id, b2.id];

            const p1 = payoutForSymbol(b1.id);
            const p2 = payoutForSymbol(b2.id);
            payout = p1 + p2;

            // registrar en historial
            state.me.fruitHistory = (state.me.fruitHistory || []);
            state.me.fruitHistory.push({
              at: nowISO(),
              bets: { ...fruitBets },
              total,
              winner: mainWinnerId,
              bonus: {
                outcomes: outcomes,
                payouts: [p1, p2]
              },
              payout
            });
            if (state.me.fruitHistory.length > 200) state.me.fruitHistory = state.me.fruitHistory.slice(-200);

            if (payout > 0){
              state.me.balance += payout;
              await saveDB(state.db);
              renderMe();
              if (fruitMsg){
                const n1 = escapeHtml(fruitById[outcomes[0]]?.name || outcomes[0]);
                const n2 = escapeHtml(fruitById[outcomes[1]]?.name || outcomes[1]);
                fruitMsg.innerHTML = `ONCE MORE → Resultados: <b>${n1}</b> y <b>${n2}</b> · Cobraste <b>${money(payout)}</b>`;
              }
              toast(toastEl,'ok',`¡Ganaste ${money(payout)}!`);
            }else{
              await saveDB(state.db);
              if (fruitMsg){
                const n1 = escapeHtml(fruitById[outcomes[0]]?.name || outcomes[0]);
                const n2 = escapeHtml(fruitById[outcomes[1]]?.name || outcomes[1]);
                fruitMsg.innerHTML = `ONCE MORE → Resultados: <b>${n1}</b> y <b>${n2}</b> · No tenías apuesta en esos símbolos.`;
              }
              toast(toastEl,'warn','No ganaste esta vez.');
            }

          } else {
            outcomes = [winner.id];
            payout = payoutForSymbol(winner.id);

            // registrar en historial
            state.me.fruitHistory = (state.me.fruitHistory || []);
            state.me.fruitHistory.push({
              at: nowISO(),
              bets: { ...fruitBets },
              total,
              winner: winner.id,
              mult: winner.mult,
              payout
            });
            if (state.me.fruitHistory.length > 200) state.me.fruitHistory = state.me.fruitHistory.slice(-200);

            if (payout > 0){
              state.me.balance += payout;
              await saveDB(state.db);
              renderMe();
              if (fruitMsg) fruitMsg.innerHTML = `Ganó <b>${escapeHtml(winner.name)}</b> · Cobraste <b>${money(payout)}</b>`;
              toast(toastEl,'ok',`¡Ganaste ${money(payout)}!`);
            }else{
              await saveDB(state.db);
              if (fruitMsg) fruitMsg.innerHTML = `Ganó <b>${escapeHtml(winner.name)}</b> · No tenías apuesta en ese símbolo.`;
              toast(toastEl,'warn','No ganaste esta vez.');
            }
          }

// limpiar apuestas después de la tirada (como la mayoría de máquinas)
          fruitBets = {};
          renderFruitBets();
        }catch(err){
          console.error(err);
          toast(toastEl,'err', (err?.message||'Error inesperado'));
          // si algo falló tras descontar, no intentamos "revertir" automático aquí
        }finally{
          fruitSpinning = false;
        }
      });
    }

    // estado inicial
    fruitReady = true;
    renderFruitBets();
    highlightFruitPos(fruitCurrentPos);
  }

  function renderFruitBets(){
    if (fruitTotalEl) fruitTotalEl.textContent = money(fruitTotalBet());

    // actualizar chips y estado max
    if (fruitBetButtons){
      fruitBetButtons.querySelectorAll('.fruitBetBtn').forEach(btn=>{
        const id = btn.getAttribute('data-id');
        const c = fruitBetCount(id);
        const chip = btn.querySelector(`[data-chip="${id}"]`);
        if (chip) chip.textContent = String(c);
        btn.classList.toggle('maxed', c >= 9);
      });
    }

    // actualizar tablero (conteo por casilla)
    if (fruitBoard){
      fruitBoard.querySelectorAll('.fruitCell').forEach(cell=>{
        const pos = Number(cell.getAttribute('data-pos'));
        const symbolId = fruitRing[pos % FRUIT_POS_COUNT];
      const it = fruitById[symbolId];
        const c = fruitBetCount(it.id);
        const badge = cell.querySelector('.fruitBetCount');
        if (badge) badge.textContent = String(c);
        cell.classList.toggle('hasBet', c > 0);
      });
    }
  }

  function addFruitBet(id){
    if (fruitSpinning) return;
    const c = fruitBetCount(id);
    if (c >= 9){
      toast(toastEl,'warn','Máximo 9 fichas por símbolo.');
      return;
    }
    fruitBets[id] = c + 1;
    renderFruitBets();
  }

  function highlightFruitPosSet(mainPos, bonus1Pos, bonus2Pos){
    if (!fruitBoard) return;
    fruitBoard.querySelectorAll('.fruitCell').forEach(cell=>{
      const p = Number(cell.getAttribute('data-pos'));
      cell.classList.toggle('active', p === mainPos);
      cell.classList.toggle('bonus1', bonus1Pos != null && p === bonus1Pos);
      cell.classList.toggle('bonus2', bonus2Pos != null && p === bonus2Pos);
    });
  }

  function highlightFruitPos(pos){
    highlightFruitPosSet(pos, null, null);
  }

  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

  async function spinFruitBoard(){
    // ganador al azar basado en el anillo (al repetirse símbolos, aumenta su probabilidad)
    const winnerPos = randInt(FRUIT_POS_COUNT);

    // 3..5 vueltas extra para animación
    const extra = (FRUIT_POS_COUNT*3) + randInt(FRUIT_POS_COUNT*2);
    const delta = (winnerPos - fruitCurrentPos + FRUIT_POS_COUNT) % FRUIT_POS_COUNT;
    let steps = extra + delta;

    while (steps > 0){
      fruitCurrentPos = (fruitCurrentPos + 1) % FRUIT_POS_COUNT;
      highlightFruitPos(fruitCurrentPos);

      // desaceleración tipo máquina
      let delay;
      if (steps > 40) delay = 35;
      else if (steps > 25) delay = 50;
      else if (steps > 15) delay = 75;
      else if (steps > 8)  delay = 105;
      else delay = 140;

      await sleep(delay);
      steps--;
    }

    await sleep(180);
    highlightFruitPos(fruitCurrentPos);
    return fruitCurrentPos;
  }

  async function spinFruitBoardBonusTwo(){
    // ONCE MORE: dos luces / dos resultados.
    // 1er resultado SIEMPRE cae en una casilla de cereza. 2do es aleatorio (pero NO ONCE MORE).
    const cherryPositions = [];
    for (let i=0;i<FRUIT_POS_COUNT;i++){
      if (fruitRing[i] === 'cherry') cherryPositions.push(i);
    }
    const w1 = cherryPositions[randInt(cherryPositions.length)];

    const forbidden = new Set(['once_more']);
    const allowed = [];
    for (let i=0;i<FRUIT_POS_COUNT;i++){
      if (!forbidden.has(fruitRing[i])) allowed.push(i);
    }
    const w2 = allowed[randInt(allowed.length)];

    // ambas luces salen desde donde quedó la luz principal
    let p1 = fruitCurrentPos;
    let p2 = fruitCurrentPos;

    const extra1 = (FRUIT_POS_COUNT*2) + randInt(FRUIT_POS_COUNT*2);
    const extra2 = (FRUIT_POS_COUNT*2) + randInt(FRUIT_POS_COUNT*2);
    const delta1 = (w1 - p1 + FRUIT_POS_COUNT) % FRUIT_POS_COUNT;
    const delta2 = (w2 - p2 + FRUIT_POS_COUNT) % FRUIT_POS_COUNT;
    const steps1 = extra1 + delta1;
    const steps2 = extra2 + delta2;
    let steps = Math.max(steps1, steps2);

    while (steps > 0){
      if (steps <= steps1) p1 = (p1 + 1) % FRUIT_POS_COUNT;
      if (steps <= steps2) p2 = (p2 + 1) % FRUIT_POS_COUNT;
      highlightFruitPosSet(null, p1, p2);

      let delay;
      if (steps > 35) delay = 35;
      else if (steps > 22) delay = 55;
      else if (steps > 12) delay = 80;
      else delay = 120;

      await sleep(delay);
      steps--;
    }

    await sleep(220);
    // dejar la luz principal en el segundo resultado
    fruitCurrentPos = w2;
    highlightFruitPos(w2);
    return [w1, w2];
  }



  async function refresh(){
    const { data } = await loadDB();
    state.db = data;
    state.me = data.users.find(u=>u.id===s.id);
    if (!state.me){ clearSession(); location.href='/'; return; }

    // mark notice seen
    if (state.me.lastCreditNotice && state.me.lastCreditNotice.seen === false){
      state.me.lastCreditNotice.seen = true;
      await saveDB(state.db, `Mark notice seen ${state.me.username}`);
    }

    renderMe();
    renderRouletteHistory();
    // si el usuario está viendo ruleta, asegurar que esté lista
    if (ruletaSection && ruletaSection.style.display !== 'none') buildRouletteTrack();
  }

  // WhatsApp: recargar / retirar (con formulario)
  const WA_NUMBER = '573206199480';

  const topupForm = $('#topupForm');
  const topupAmount = $('#topupAmount');
  const topupErr = $('#topupErr');
  const withdrawBtn = $('#withdraw');
  const withdrawForm = $('#withdrawForm');
  const withdrawAmount = $('#withdrawAmount');
  const withdrawErr = $('#withdrawErr');

  function openWA(message){
    const url = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
  }

  function parseAmt(v){
    if (v==null) return NaN;
    const s = String(v).trim().replace(',', '.');
    return Number(s);
  }

  function hide(el){ if (el) el.style.display='none'; }
  function show(el){ if (el) el.style.display='block'; }
  function toggle(el){ if (!el) return; el.style.display = (el.style.display==='none' || !el.style.display) ? 'block' : 'none'; }

  $('#topup').addEventListener('click', ()=>{
    // Mostrar/ocultar form de recarga
    if (topupErr) topupErr.textContent = '';
    toggle(topupForm);
    hide(withdrawForm);
  });

  $('#topupNow').addEventListener('click', ()=>{
    if (topupErr) topupErr.textContent = '';
    const amt = parseAmt(topupAmount?.value);

    // ✅ Mínimo de recarga: 5.000 COP (Colombia) o 5 USD (otros países)
    const minTopup = state.me.country === 'CO' ? 5000 : 5;
    const cur = state.me.country === 'CO' ? 'COP' : 'USD';

    if (!Number.isFinite(amt) || amt <= 0){
      if (topupErr) topupErr.textContent = 'Escribe un monto válido para recargar.';
      return;
    }

    if (amt < minTopup){
      if (topupErr) topupErr.textContent = `El monto mínimo para recargar es ${fmt(minTopup, cur)} (${cur}).`;
      return;
    }

    const msg = `Deseo recargar saldo a mi cuenta. Usuario: ${state.me.username}. Monto: ${fmt(amt, cur)} (${cur})`;
    openWA(msg);
  });

  if (withdrawBtn){
    withdrawBtn.addEventListener('click', ()=>{
      if (withdrawErr) withdrawErr.textContent = '';
      toggle(withdrawForm);
      hide(topupForm);
    });
  }

  $('#withdrawNow').addEventListener('click', ()=>{
    if (withdrawErr) withdrawErr.textContent = '';
    const amt = parseAmt(withdrawAmount?.value);
    const min = state.me.country === 'CO' ? 20000 : 20;
    const cur = state.me.country === 'CO' ? 'COP' : 'USD';

    if (!Number.isFinite(amt) || amt <= 0){
      if (withdrawErr) withdrawErr.textContent = 'Escribe un monto válido para retirar.';
      return;
    }
    if (amt < min){
      if (withdrawErr) withdrawErr.textContent = `El monto mínimo para retirar es ${fmt(min, cur)} (${cur}).`;
      return;
    }
    if (amt > Number(state.me.balance||0)){
      if (withdrawErr) withdrawErr.textContent = 'El monto no puede superar tu saldo actual.';
      return;
    }
    const msg = `Deseo retirar de mi cuenta. Usuario: ${state.me.username}. Monto: ${fmt(amt, cur)} (${cur})`;
    openWA(msg);
  });

  $('#savePass').addEventListener('click', async ()=>{
    try{
      const np = ($('#newPass').value||'').trim();
      if (!isValidUserOrPass(np)) { toast(toastEl,'err','Clave inválida (minúsculas+numeros 3-20).'); return; }
      state.me.password = np;
      await saveDB(state.db, `User changed password ${state.me.username}`);
      // update session stored password
      const ss = getSession();
      setSession({ ...ss, password: np });
      $('#newPass').value='';
      toast(toastEl,'', 'Contraseña actualizada');
      await refresh();
    }catch(e){ toast(toastEl,'err', e.message); }
  });

  $('#savePay').addEventListener('click', async ()=>{
    try{
      const payments = {};
      const bin = $('#p_binance')?.value || '';
      payments.binance = String(bin).slice(0,80);
      if (state.me.country === 'CO'){
        payments.owner = String($('#p_owner')?.value||'').slice(0,80);
        payments.nequi = String($('#p_nequi')?.value||'').slice(0,30);
        payments.daviplata = String($('#p_daviplata')?.value||'').slice(0,30);
      }
      state.me.payments = payments;
      await saveDB(state.db, `User updated payments ${state.me.username}`);
      toast(toastEl,'', 'Medios de pago guardados');
      await refresh();
    }catch(e){ toast(toastEl,'err', e.message); }
  });

  // grid 01-99
  const nums = Array.from({length:99},(_,i)=>String(i+1).padStart(2,'0'));
  grid.innerHTML = nums.map(n=>`<button class="secondary" data-n="${n}" type="button">${n}</button>`).join('');
  function renderPick(){
    grid.querySelectorAll('button[data-n]').forEach(b=>{
      const n=b.getAttribute('data-n');
      b.className = state.pick.includes(n) ? '' : 'secondary';
    });
    playBtn.disabled = (state.pick.length < 3) || isBettingClosed();
  }
  grid.querySelectorAll('button[data-n]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const n=b.getAttribute('data-n');
      if (state.pick.includes(n)) state.pick = state.pick.filter(x=>x!==n);
      else {
        if (state.pick.length>=5) return;
        state.pick = [...state.pick, n];
      }
      renderPick();
    });
  });
  renderPick();

  function renderPending(){
    if (!pendingLine) return;

    const idx = cycleIndex(new Date());
    const nextAt = cycleStartDate(idx+1);
    const msLeft = nextAt.getTime() - Date.now();
    const sec = Math.max(0, Math.ceil(msLeft / 1000));

    const closed = isBettingClosed();
    const pbs = (state.me?.pendingBets || []).filter(b=>b && typeof b.targetCycle==='number');

    const header = `
      <small class="muted">
        Próximo ciclo (3 min): <b>${new Date(nextAt).toLocaleString()}</b> · Falta: <b>${sec}s</b>
        ${closed ? ' · <b style="color:#b00">APUESTAS CERRADAS</b>' : ''}
      </small>
    `;

    if (!pbs.length){
      pendingLine.innerHTML = header + '<div style="height:6px"></div><small class="muted">Sin apuestas pendientes.</small>';
      return;
    }

    const rows = pbs
      .slice()
      .sort((a,b)=>a.targetCycle-b.targetCycle || String(a.createdAt||'').localeCompare(String(b.createdAt||'')))
      .slice(0, 20)
      .map(b=>{
        const tAt = cycleStartDate(b.targetCycle);
        return `
          <tr>
            <td>${new Date(tAt).toLocaleString()}</td>
            <td>${(b.pick||[]).join(' · ')}</td>
            <td>${b.bet}</td>
          </tr>
        `;
      }).join('');

    pendingLine.innerHTML = `
      ${header}
      <div style="height:8px"></div>
      <div class="toast warn">
        <b>Apuestas pendientes:</b> ${pbs.length}
        <div style="height:8px"></div>
        <table style="width:100%; font-size:13px">
          <thead><tr><th align="left">Sorteo</th><th align="left">Números</th><th align="left">Monto</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  async function maybeResolvePending(){
    const current = cycleIndex(new Date());
    const pbsLocal = (state.me?.pendingBets || []);
    if (!pbsLocal.length) return;

    // solo resolvemos si ya empezó el ciclo objetivo
    const hasDue = pbsLocal.some(b=>b && typeof b.targetCycle==='number' && b.targetCycle <= current);
    if (!hasDue) return;

    try{
      // recargar para resolver sobre la última DB (evita conflictos si el admin editó algo)
      const { data } = await loadDB();
      state.db = data;
      state.me = data.users.find(u=>u.id===s.id);
      if (!state.me) return;

      const nowCycle = cycleIndex(new Date());
      const all = (state.me.pendingBets || []).filter(b=>b && typeof b.targetCycle==='number');
      const due = all.filter(b=>b.targetCycle <= nowCycle);
      if (!due.length) return;

      const keep = all.filter(b=>b.targetCycle > nowCycle);

      const d = drawForCycle(nowCycle);
      const set = new Set(d.balls);

      let wins = 0;
      let totalCredited = 0;

      state.me.history = state.me.history || [];

      for (const b of due){
        const bet = Math.trunc(b.bet||0);
        const matches = (b.pick||[]).filter(n=>set.has(n)).length;

        // El saldo ya fue descontado al registrar la apuesta.
        // Si gana: se acredita apuesta + ganancia.
        let credited = 0;
        let net = -bet;

        if (matches >= 3){
          const profit = bet * matches;
          credited = bet + profit;
          net = profit; // neto (la apuesta ya estaba descontada)
          state.me.balance = Math.trunc(state.me.balance) + credited;
          wins++;
          totalCredited += credited;
        }

        state.me.history.push({
          id: b.id,
          at: nowISO(),
          pick: (b.pick||[]).slice(),
          bet,
          matches,
          payout: net,
          credited,
          cycle: b.targetCycle,
          drawAt: d.drawAt
        });
      }

      state.me.pendingBets = keep;

      await saveDB(state.db, `Resolve ${due.length} bets ${state.me.username} cycle=${nowCycle} wins=${wins}`);

      if (wins){
        toast(toastEl,'', `Ciclo resuelto (${due.length} apuestas). Ganaste ${wins}. Acreditado total: +${totalCredited}`);
      } else {
        toast(toastEl,'warn', `Ciclo resuelto (${due.length} apuestas). No hubo premios.`);
      }

      await refresh();
    }catch(e){
      console.warn(e);
    }
  }

  const MIX_START_SECONDS_LEFT = 60; // desde el minuto 2 (faltan 60s)
  let lastExtractedPrevIdx = null;

  function updateBalotera(secLeft, msIntoCycle, idx){
    if (!animator) return;

    // mantener el canvas vivo siempre
    animator.start();

    // si estamos extrayendo, NO interrumpir (debe terminar aunque ya haya empezado el siguiente ciclo)
    if (animator.isExtracting()) return;

    // al iniciar un nuevo ciclo (primer ~1s), extraemos las 20 del ciclo anterior
    if (msIntoCycle >= 0 && msIntoCycle < 900){
      const prevIdx = idx - 1;
      if (prevIdx >= 0 && lastExtractedPrevIdx !== prevIdx){
        animator.startExtract(drawForCycle(prevIdx));
        lastExtractedPrevIdx = prevIdx;
        return;
      }
    }

    // guion del ciclo:
    // - min 0..2 (faltan >60s): idle
    // - min 2..fin: mix (incluye los últimos 10s de apuestas cerradas)
    if (secLeft > MIX_START_SECONDS_LEFT) animator.setIdleMode();
    else animator.setMixMode();
  }

  function renderDraw(){
    const now = Date.now();
    const idx = cycleIndex(new Date());
    const cycleStart = cycleStartDate(idx).getTime();
    const msIntoCycle = now - cycleStart;

    const nextAt = cycleStartDate(idx+1);
    const msLeft = nextAt.getTime() - now;
    const secLeft = Math.max(0, Math.ceil(msLeft / 1000));

    // controla la balotera (idle/mix/extract)
    updateBalotera(secLeft, msIntoCycle, idx);

    const closed = isBettingClosed();
    const isExtracting = animator && animator.isExtracting();
    const last = animator && animator.lastResult ? animator.lastResult : null;

    let middle = '';
    if (isExtracting){
      middle = `<span class="badge">Extracción en curso…</span><br/>`;
    } else if (last && last.cycle === (idx - 1)){
      middle = `Resultado último ciclo (${new Date(last.drawAt).toLocaleString()}): <b>${last.balls.join(' · ')}</b><br/>`;
    } else {
      middle = `<span class="badge">El sorteo se revela al finalizar el ciclo</span><br/>`;
    }

    $('#drawLine').innerHTML = `
      <small class="muted">Ciclo actual (3 min): ${new Date(cycleStart).toLocaleString()}</small><br/>
      ${middle}
      <small class="muted">Próximo ciclo en: ${secLeft}s ${closed ? ' · <b style="color:#b00">APUESTAS CERRADAS</b>' : ''}</small>
    `;

    // devuelve el último resultado si existe, si no, el ciclo actual (para mantener compatibilidad)
    return last ? { cycle: last.cycle, drawAt: last.drawAt, balls: last.balls } : drawForCycle(idx);
  }
  renderDraw();
  renderPending();
  // actualiza UI y resuelve apuestas pendientes cuando cambia el ciclo
  setInterval(()=>{ renderDraw(); renderPending(); maybeResolvePending(); }, 1000);

  playBtn.addEventListener('click', async ()=>{
    try{
      if (isBettingClosed()){
        toast(toastEl,'warn',`Apuestas cerradas. Intenta de nuevo cuando falten más de ${BET_CLOSE_SECONDS}s para el próximo ciclo.`);
        return;
      }

      if (state.pick.length < 3) { toast(toastEl,'warn','Elige mínimo 3 números.'); return; }

      const bet = Number($('#bet').value||'0');
      if (!(bet>=100 && bet<=4000)) { toast(toastEl,'err','Apuesta debe ser 100-4000'); return; }

      if (state.me.balance < bet) { toast(toastEl,'err','Saldo insuficiente'); return; }

      const target = cycleIndex(new Date()) + 1;
      const targetAt = cycleStartDate(target);

      state.me.pendingBets = state.me.pendingBets || [];
      // límite suave para evitar abusos/errores
      if (state.me.pendingBets.length >= 50){
        toast(toastEl,'warn','Tienes demasiadas apuestas pendientes. Espera a que se resuelvan algunas.');
        return;
      }

      // ✅ Descontar saldo inmediatamente
      state.me.balance = Math.trunc(state.me.balance) - Math.trunc(bet);

      state.me.pendingBets.push({
        id: uuid(),
        createdAt: nowISO(),
        targetCycle: target,
        pick: state.pick.slice(),
        bet: Math.trunc(bet)
      });

      await saveDB(state.db, `Place bet ${state.me.username} cycle=${target} bet=${Math.trunc(bet)}`);

      toast(toastEl,'', `Apuesta registrada (saldo descontado). Se jugará en: ${new Date(targetAt).toLocaleString()}`);
      state.pick = [];
      renderPick();
      renderPending();
      await refresh();
    }catch(e){ toast(toastEl,'err', e.message); }
  });

  await refresh();
}

// entero aleatorio en [0, n)
function randInt(n){
  return Math.floor(Math.random() * n);
}
