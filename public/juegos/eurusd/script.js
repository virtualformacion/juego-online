/* EUR/USD Binarias - integración con saldo del usuario */

const BET_SECONDS = 60;
const PAYOUT_MULT = 1.8;
const MAX_POINTS = 900;

const $ = (q)=>document.querySelector(q);

function toast(type, text){
  const el = $('#toast');
  if (!el) return;
  el.className = 'toast ' + (type||'');
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
}
function err(text){
  const el = $('#err');
  if (!el) return;
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
}

function fmtMoney(v, cur){
  try{ return new Intl.NumberFormat('es-CO', {style:'currency', currency:cur, maximumFractionDigits:0}).format(v); }
  catch{ return (cur||'')+' '+Math.round(v); }
}
function fmtPrice(v){ return Number(v).toFixed(5); }
function fmtTime(ms){
  const d = new Date(ms);
  return d.toLocaleTimeString('es-CO', {hour12:false});
}

function getSession(){ try { return JSON.parse(localStorage.getItem('session')||'null'); } catch { return null; } }
function clearSession(){ localStorage.removeItem('session'); }

async function loadDB(){
  const r = await fetch('/.netlify/functions/db');
  if(!r.ok) throw new Error('No se pudo cargar la DB');
  return await r.json();
}
async function saveDB(data, message){
  const r = await fetch('/.netlify/functions/db', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ data, message })
  });
  if(!r.ok) throw new Error('No se pudo guardar la DB');
  return await r.json();
}

// PRNG determinístico
function mulberry32(seed){
  let t = seed >>> 0;
  return {
    next(){
      t += 0x6D2B79F5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    },
    getState(){ return t >>> 0; },
    setState(v){ t = (v>>>0); }
  };
}

function nowSec(){ return Math.floor(Date.now()/1000); }
function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }

function pointsToCandlesInterval(points, intervalSec){
  const out = [];
  if(!points || !points.length) return out;
  let cur = null;
  for(const p of points){
    const bucket = p.t - (p.t % intervalSec);
    if(!cur || cur.time !== bucket){
      if(cur) out.push(cur);
      cur = { time: bucket, open: p.v, high: p.v, low: p.v, close: p.v };
    } else {
      cur.high = Math.max(cur.high, p.v);
      cur.low = Math.min(cur.low, p.v);
      cur.close = p.v;
    }
  }
  if(cur) out.push(cur);
  return out;
}

(async function main(){
  try{
    const s = getSession();
    if(!s){ location.href='/'; return; }

    $('#btnBack').addEventListener('click', ()=> location.href='/user.html');
    $('#btnLogout').addEventListener('click', ()=>{ clearSession(); location.href='/'; });

    // Estado usuario + reglas por país
    const { data } = await loadDB();
    const me = data.users.find(u=>u.id===s.id);
    if(!me){ clearSession(); location.href='/'; return; }

    const isCO = me.country === 'CO';
    const currency = isCO ? 'COP' : 'USD';
    const STAKE_STEP = isCO ? 1000 : 1;
    const MIN_STAKE = isCO ? 1000 : 1;
    const MAX_STAKE = isCO ? 20000 : 20;

    function snapStake(n){
      if(!Number.isFinite(n)) return MIN_STAKE;
      const c = clamp(n, MIN_STAKE, MAX_STAKE);
      const snapped = Math.round(c / STAKE_STEP) * STAKE_STEP;
      return clamp(snapped, MIN_STAKE, MAX_STAKE);
    }

    // UI stake config
    const stakeInput = $('#stakeInput');
    stakeInput.min = String(MIN_STAKE);
    stakeInput.max = String(MAX_STAKE);
    stakeInput.step = String(STAKE_STEP);
    let stake = snapStake(isCO ? 1000 : 1);
    stakeInput.value = String(stake);
    $('#stakeHint').textContent = `Mín: ${fmtMoney(MIN_STAKE, currency)} · Máx: ${fmtMoney(MAX_STAKE, currency)} · Paso: ${fmtMoney(STAKE_STEP, currency)}`;

    let balance = me.balance;
    const renderSaldo = ()=> $('#saldoLine').innerHTML = `Saldo: <b>${fmtMoney(balance, currency)}</b> <span class="badge">${currency}</span>`;
    renderSaldo();

    // Persistencia local por usuario
    const STORAGE_KEY = `eurusd_state_${me.id}`;
    const loadState = ()=>{
      try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)||'null'); }catch{ return null; }
    };
    const saveState = (st)=>{
      try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(st)); }catch{}
    };

    // market state
    const rng = mulberry32( (Math.random()*2**32)>>>0 );
    let lastTime = nowSec();
    let points = [];
    let price = 1.10;

    // game state
    let viewMode = 'candles'; // candles default
    let activeBet = null;
    let history = [];

    // restore
    const saved = loadState();
    if(saved){
      if(typeof saved.rngState==='number') rng.setState(saved.rngState);
      if(typeof saved.lastTime==='number') lastTime = saved.lastTime;
      if(Array.isArray(saved.points)) {
        points = saved.points.filter(p=>p && typeof p.t==='number' && typeof p.v==='number').slice(-MAX_POINTS);
        if(points.length){ price = points[points.length-1].v; }
      }
      if(saved.viewMode==='line' || saved.viewMode==='candles') viewMode = saved.viewMode;
      if(Array.isArray(saved.history)) history = saved.history.slice(0,20);
      if(saved.activeBet && saved.activeBet.id) activeBet = saved.activeBet;
    }

    // Ensure we have seed
    function seedIfEmpty(){
      const t = nowSec();
      if(points.length) return;
      for(let i=90;i>=1;i--){
        points.push({ t: t-i, v: price });
      }
      lastTime = t;
    }
    seedIfEmpty();

    function nextPrice(prev){
      const shock = (rng.next()-0.5)*2*0.00055;
      const drift = (1.10 - prev)*0.02;
      return Math.max(0.0001, prev + drift + shock);
    }
    function pushPoint(t, v){
      points.push({t, v});
      if(points.length > MAX_POINTS) points = points.slice(-MAX_POINTS);
    }
    function fastForwardTo(target){
      let t = lastTime;
      let p = price;
      let steps = 0;
      while(t < target && steps < 3600){
        t += 1;
        p = nextPrice(p);
        pushPoint(t, p);
        steps++;
      }
      lastTime = t;
      price = p;
    }

    // Chart init
    const chart = LightweightCharts.createChart($('#chart'), {
      width: $('#chart').clientWidth || 900,
      height: 520,
      layout: { background: { color: '#0b0f14' }, textColor: '#e6edf6' },
      grid: { vertLines: { color: 'rgba(148,163,184,0.08)' }, horzLines: { color: 'rgba(148,163,184,0.08)' } },
      timeScale: { timeVisible: true, secondsVisible: true },
      rightPriceScale: { borderColor: 'rgba(148,163,184,0.18)' },
    });
    const LineSeries = LightweightCharts.LineSeries;
    const CandlestickSeries = LightweightCharts.CandlestickSeries;

    let lineSeries = null;
    let candleSeries = null;
    function setView(mode){
      viewMode = mode;
      $('#viewModeLabel').textContent = mode==='candles' ? 'Velas' : 'Línea';
      $('#btnToggleView').textContent = mode==='candles' ? '🔁 Ver LÍNEA' : '🔁 Ver VELAS';
      // remove series
      if(lineSeries){ chart.removeSeries(lineSeries); lineSeries = null; }
      if(candleSeries){ chart.removeSeries(candleSeries); candleSeries = null; }
      if(mode === 'candles'){
        candleSeries = chart.addSeries(CandlestickSeries, {
          upColor:'#22c55e', downColor:'#ef4444',
          borderUpColor:'#22c55e', borderDownColor:'#ef4444',
          wickUpColor:'#22c55e', wickDownColor:'#ef4444',
        });
        candleSeries.setData(pointsToCandlesInterval(points, 60));
      } else {
        lineSeries = chart.addSeries(LineSeries, { lineWidth: 2 });
        lineSeries.setData(points.map(p=>({time:p.t, value:p.v})));
      }
      chart.timeScale().fitContent();
      redrawBet();
      updateOverlays();
      saveLocal();
    }

    function saveLocal(){
      saveState({
        rngState: rng.getState(),
        lastTime,
        points,
        viewMode,
        activeBet,
        history
      });
    }

    function currentSeries(){ return viewMode==='candles' ? candleSeries : lineSeries; }

    // overlays
    const overlayRange = $('#overlayRange');
    const overlayWhite = $('#overlayWhite');
    const overlayTimer = $('#overlayTimer');
    const overlayMeta = $('#overlayMeta');

    let entryPriceLine = null;

    function clearBetDrawings(){
      try{
        const srs = currentSeries();
        if(srs) srs.setMarkers([]);
      }catch{}
      try{
        const srs = currentSeries();
        if(entryPriceLine && srs){
          srs.removePriceLine(entryPriceLine);
        }
      }catch{}
      entryPriceLine = null;

      // hide overlays
      overlayMeta.style.left = `-9999px`;
      overlayRange.style.left = `-9999px`;
      overlayRange.style.width = `0px`;
      overlayWhite.style.left = `-9999px`;
      overlayWhite.style.width = `0px`;
      overlayTimer.textContent = '';
    }


function redrawBet(){
  // Re-dibuja markers y línea horizontal al cambiar vista o al restaurar una apuesta activa
  clearBetDrawings();
  if(!activeBet) return;

  const srs = currentSeries();
  if(!srs) return;

  // Marker entrada con monto
  try{
    srs.setMarkers([{
      time: activeBet.entrySec,
      position: 'inBar',
      color: activeBet.side==='buy' ? '#22c55e' : '#ef4444',
      shape: 'circle',
      text: `${activeBet.side==='buy' ? 'BUY' : 'SELL'} ${fmtPrice(activeBet.entryPrice)} · ${fmtMoney(activeBet.stake, currency)}`
    }]);
  }catch{}

  // Línea horizontal verde/roja (entrada)
  try{
    entryPriceLine = srs.createPriceLine({
      price: activeBet.entryPrice,
      color: activeBet.side==='buy' ? '#22c55e' : '#ef4444',
      lineWidth: 2,
      lineStyle: 2,
      axisLabelVisible: true,
      title: activeBet.side==='buy' ? 'BUY' : 'SELL'
    });
  }catch{}

  // overlays (meta/rango/linea blanca/timer)
  try{ updateOverlays(); }catch{}
}

function updateOverlays(){
      if(!activeBet) return;

      // coordinate conversion: allow future time by extrapolating with barSpacing
      const ts = chart.timeScale();
      const opts = ts.options();
      const barSpacing = (opts && opts.barSpacing) ? opts.barSpacing : 6;

      const coordForTime = (tSec)=>{
        const direct = ts.timeToCoordinate(tSec);
        if(direct != null && !Number.isNaN(direct)) return direct;
        const xNow = ts.timeToCoordinate(lastTime);
        if(xNow == null || Number.isNaN(xNow)) return null;
        return xNow + (tSec - lastTime) * barSpacing;
      };

      const xStart = coordForTime(activeBet.entrySec);
      const xEnd = coordForTime(activeBet.endSec);
      const srs = currentSeries();
      if(xStart==null || xEnd==null || !srs) return;

      // price coordinate for entry price
      const yEntry = srs.priceToCoordinate(activeBet.entryPrice);
      if(yEntry==null) return;

      const left = Math.min(xStart,xEnd);
      const right = Math.max(xStart,xEnd);

      overlayMeta.style.left = `${xEnd}px`;
      overlayRange.style.left = `${left}px`;
      overlayRange.style.width = `${Math.max(2, right-left)}px`;

      overlayWhite.style.left = `${left}px`;
      overlayWhite.style.width = `${Math.max(2, right-left)}px`;
      overlayWhite.style.top = `${yEntry}px`;

      const sec = Math.max(0, Math.ceil((activeBet.endMs - Date.now())/1000));
      overlayTimer.style.left = `${left + (right-left)/2}px`;
      overlayTimer.textContent = `⏳ ${sec}s`;
    }

    // history render
    function renderHist(){
      const tbody = $('#histBody');
      if(!history.length){
        tbody.innerHTML = '<tr><td class="muted" colspan="6">Sin historial aún.</td></tr>';
        return;
      }
      tbody.innerHTML = history.slice(0,20).map(h=>{
        const sideLabel = h.side==='buy' ? 'BUY' : 'SELL';
        const sideColor = h.side==='buy' ? '#22c55e' : '#ef4444';
        const res = h.win ? `<span class="badge" style="border-color:rgba(34,197,94,.45);color:#a7f3d0">GANÓ · ${fmtMoney(h.payout, currency)}</span>`
                          : `<span class="badge" style="border-color:rgba(239,68,68,.45);color:#fecaca">PERDIÓ</span>`;
        return `<tr>
          <td>${fmtTime(h.entryMs)}</td>
          <td style="font-weight:900;color:${sideColor}">${sideLabel}</td>
          <td>${fmtMoney(h.stake, currency)}</td>
          <td>${fmtPrice(h.entryPrice)}</td>
          <td>${fmtPrice(h.finalPrice)}</td>
          <td>${res}</td>
        </tr>`;
      }).join('');
    }
    renderHist();

    // controls
    function setControlsDisabled(dis){
      $('#btnBuy').disabled = dis;
      $('#btnSell').disabled = dis;
      $('#btnPlus').disabled = dis;
      $('#btnMinus').disabled = dis;
      $('#stakeInput').disabled = dis;
    }

    $('#btnToggleView').addEventListener('click', ()=>{
      setView(viewMode==='candles' ? 'line' : 'candles');
    });

    $('#stakeInput').addEventListener('change', ()=>{
      stake = snapStake(Number(stakeInput.value));
      stakeInput.value = String(stake);
    });
    $('#btnPlus').addEventListener('click', ()=>{
      stake = snapStake(stake + STAKE_STEP);
      stakeInput.value = String(stake);
    });
    $('#btnMinus').addEventListener('click', ()=>{
      stake = snapStake(stake - STAKE_STEP);
      stakeInput.value = String(stake);
    });

    function placeBet(side){
      err('');
      toast('', '');
      if(activeBet) return;

      stake = snapStake(Number(stakeInput.value));
      stakeInput.value = String(stake);

      if(stake > balance){
        toast('lose', 'Saldo insuficiente.');
        return;
      }

      const entryMs = Date.now();
      const entrySec = Math.floor(entryMs/1000);
      const endMs = entryMs + BET_SECONDS*1000;
      const endSec = Math.floor(endMs/1000);

      activeBet = {
        id: crypto.randomUUID(),
        side,
        stake,
        entryPrice: price,
        entryMs, entrySec,
        endMs, endSec
      };

      // descontar y persistir en DB
      balance = balance - stake;
      renderSaldo();
      setControlsDisabled(true);
      $('#activeInfo').textContent = `Apuesta activa: ${side.toUpperCase()} @ ${fmtPrice(activeBet.entryPrice)} · ${Math.ceil((endMs-Date.now())/1000)}s`;

      // Guardar en DB (saldo)
      (async ()=>{
        try{
          const { data: db2 } = await loadDB();
          const u = db2.users.find(x=>x.id===me.id);
          if(!u) return;
          u.balance = (u.balance - stake);
          await saveDB(db2, `EURUSD bet placed ${me.username}`);
        }catch(e){
          // si falla, revertimos local (para no desincronizar)
          balance = balance + stake;
          renderSaldo();
          activeBet = null;
          setControlsDisabled(false);
          toast('lose', 'No se pudo registrar la apuesta. Intenta de nuevo.');
          return;
        }
        // draw
        redrawBet();
        updateOverlays();
        saveLocal();
      })();

      // schedule settle (local, backed by reload logic)
      scheduleSettle();
    }

    $('#btnBuy').addEventListener('click', ()=>placeBet('buy'));
    $('#btnSell').addEventListener('click', ()=>placeBet('sell'));

    let settleTimer = null;
    let settleInProgress = false;
    let settledBetId = null;
    function scheduleSettle(){
      if(!activeBet) return;
      if(settleInProgress) return;
      if(settledBetId && activeBet.id === settledBetId) return;
      if(settleTimer) clearTimeout(settleTimer);
      const delay = Math.max(0, activeBet.endMs - Date.now());
      settleTimer = setTimeout(()=> settle(activeBet), delay);
    }

    function priceAtTimeSec(t){
      if(t > lastTime) fastForwardTo(t);
      // best effort: return last point <= t
      for(let i=points.length-1;i>=0;i--){
        if(points[i].t <= t) return points[i].v;
      }
      return price;
    }

    async function settle(bet){
      if(!activeBet || !bet || bet.id !== activeBet.id) return;
      if(settleInProgress) return;
      if(settledBetId && bet.id === settledBetId) return;
      settleInProgress = true;
      settledBetId = bet.id;
      if(settleTimer){ clearTimeout(settleTimer); settleTimer = null; }
      const finalPrice = priceAtTimeSec(bet.endSec);
      const win = (bet.side==='buy' && finalPrice > bet.entryPrice) || (bet.side==='sell' && finalPrice < bet.entryPrice);
      const payout = win ? bet.stake * PAYOUT_MULT : 0;

      // update DB balance (add payout if win)
      try{
        const { data: db2 } = await loadDB();
        const u = db2.users.find(x=>x.id===me.id);
        if(!u) throw new Error('Usuario no encontrado');
        if(win) u.balance = u.balance + payout;
        await saveDB(db2, `EURUSD bet settle ${me.username} ${win?'WIN':'LOSE'}`);
        // sync local
        if(win) balance = balance + payout;
        renderSaldo();
      }catch(e){
        // if DB fail, keep local but inform
        toast('lose', 'No se pudo guardar el resultado en el servidor. Recarga e intenta nuevamente.');
      }

      history.unshift({
        ...bet,
        finalPrice,
        win,
        payout,
        settledMs: Date.now()
      });
      history = history.slice(0, 20);
      renderHist();

      toast(win?'win':'lose', win
        ? `GANASTE ✅ Entrada ${fmtPrice(bet.entryPrice)} → Final ${fmtPrice(finalPrice)} · Pago ${fmtMoney(payout, currency)}`
        : `PERDISTE ❌ Entrada ${fmtPrice(bet.entryPrice)} → Final ${fmtPrice(finalPrice)} · Pérdida ${fmtMoney(bet.stake, currency)}`
      );

      // cleanup drawings after 2s
      setTimeout(()=>{ clearBetDrawings(); }, 2000);

      activeBet = null;
      settleInProgress = false;
      setControlsDisabled(false);
      $('#activeInfo').textContent = 'Sin apuesta';
      saveLocal();
    }

    // restore bet if active
    if(activeBet){
      // disable and redraw
      setControlsDisabled(true);
      redrawBet();
      scheduleSettle();
    } else {
      setControlsDisabled(false);
    }

    // set view
    setView(viewMode);

    // loop
    function tick(){
      const tNow = nowSec();
      if(tNow > lastTime){
        fastForwardTo(tNow);
      }
      // update UI price
      $('#priceNow').textContent = fmtPrice(price);
      // update chart
      if(viewMode === 'candles'){
        const candles = pointsToCandlesInterval(points, 60);
        // for performance, just update last candle
        const last = candles[candles.length-1];
        candleSeries.update(last);
      } else {
        lineSeries.update({ time: lastTime, value: price });
      }

      // overlays and countdown
      if(activeBet){
        updateOverlays();
        const sec = Math.max(0, Math.ceil((activeBet.endMs - Date.now())/1000));
        $('#activeInfo').textContent = `Apuesta activa: ${activeBet.side.toUpperCase()} · ${sec}s`;
        if(sec <= 0){
          // seguridad: ejecutar settle una sola vez
          if(!settleInProgress && activeBet && (!settledBetId || settledBetId !== activeBet.id)){
            settle(activeBet);
          }
        }
      }

      // persist throttle
      if(Math.random() < 0.05) saveLocal();
      requestAnimationFrame(()=> setTimeout(tick, 250));
    }

    window.addEventListener('resize', ()=>{
      chart.applyOptions({ width: $('#chart').clientWidth || 900 });
      updateOverlays();
    });

    window.addEventListener('beforeunload', ()=> saveLocal());

    tick();

  }catch(e){
    err(String(e && (e.stack||e.message||e)));
  }
})();
