// Paper trader server bot. Runs once per invocation (GitHub Actions calls it every 15 minutes).
// No dependencies. Needs Node 18 or newer.
import fs from 'node:fs';

const SYMBOLS = [
  {id:'BTCUSDT', label:'BTC/USDT', type:'crypto'},
  {id:'ETHUSDT', label:'ETH/USDT', type:'crypto'},
  {id:'SOLUSDT', label:'SOL/USDT', type:'crypto'},
  {id:'BNBUSDT', label:'BNB/USDT', type:'crypto'},
  {id:'XRPUSDT', label:'XRP/USDT', type:'crypto'},
  {id:'EURUSD', label:'EUR/USD', type:'forex', base:'EUR', quote:'USD'},
  {id:'GBPUSD', label:'GBP/USD', type:'forex', base:'GBP', quote:'USD'},
  {id:'USDJPY', label:'USD/JPY', type:'forex', base:'USD', quote:'JPY'},
  {id:'AUDUSD', label:'AUD/USD', type:'forex', base:'AUD', quote:'USD'},
  {id:'USDCAD', label:'USD/CAD', type:'forex', base:'USD', quote:'CAD'}
];
const META = Object.fromEntries(SYMBOLS.map(s => [s.id, s]));
const P = {fast:12, slow:26, trend:200, atrN:14, stopMult:3, tpMult:3, maxPos:0.2, trail:true,
           shorts:{crypto:false, forex:true}, fee:{crypto:0.001, forex:0.0002}};

// ENGINE START
function emaArr(v, n){
  const out = new Array(v.length).fill(NaN);
  if (v.length < n) return out;
  const k = 2/(n+1);
  let e = 0; for (let i=0;i<n;i++) e += v[i];
  e /= n; out[n-1] = e;
  for (let i=n;i<v.length;i++){ e = v[i]*k + e*(1-k); out[i] = e; }
  return out;
}
function atrArr(c, n){
  const out = new Array(c.length).fill(NaN);
  if (c.length <= n) return out;
  const tr = c.map((x,i) => i===0 ? x.h-x.l :
    Math.max(x.h-x.l, Math.abs(x.h-c[i-1].c), Math.abs(x.l-c[i-1].c)));
  let a = 0; for (let i=1;i<=n;i++) a += tr[i];
  a /= n; out[n] = a;
  for (let i=n+1;i<c.length;i++){ a = (a*(n-1)+tr[i])/n; out[i] = a; }
  return out;
}
function compute(c){
  const cl = c.map(x => x.c);
  return {fast:emaArr(cl,P.fast), slow:emaArr(cl,P.slow), trend:emaArr(cl,P.trend), atr:atrArr(c,P.atrN)};
}
function cross(ind, i){
  if (i < 1 || !isFinite(ind.slow[i-1]) || !isFinite(ind.slow[i])) return 0;
  if (ind.fast[i-1] <= ind.slow[i-1] && ind.fast[i] > ind.slow[i]) return 1;
  if (ind.fast[i-1] >= ind.slow[i-1] && ind.fast[i] < ind.slow[i]) return -1;
  return 0;
}
function shortsOn(sym){ return P.shorts[META[sym].type] !== false; }
function entrySignal(ind, c, i, sym){
  const x = cross(ind, i);
  if (!x || !isFinite(ind.trend[i]) || !(ind.atr[i] > 0)) return 0;
  if (x === 1 && c[i].c > ind.trend[i]) return 1;
  if (x === -1 && c[i].c < ind.trend[i] && shortsOn(sym)) return -1;
  return 0;
}
function newAcct(eq){ return {cash:eq, start:eq, pos:{}, trades:[]}; }
function acctEquity(a, prices){
  let e = a.cash;
  for (const s in a.pos){
    const p = a.pos[s], px = (prices && prices[s] != null) ? prices[s] : p.entry;
    e += p.side * p.qty * px;
  }
  return e;
}
function openPos(a, sym, side, price, atr, time, eq, riskPct){
  const stopDist = P.stopMult * atr;
  if (!(stopDist > 0) || !(eq > 0)) return false;
  let qty = (eq * riskPct/100) / stopDist;
  qty = Math.min(qty, eq * P.maxPos / price);
  if (!(qty > 0)) return false;
  const fee = qty * price * P.fee[META[sym].type];
  a.cash += -side * qty * price - fee;
  a.pos[sym] = {side, qty, entry:price, stop:price - side*stopDist,
    tp: P.trail ? null : price + side*P.tpMult*atr, time, fee, atr, mult:P.stopMult, hi:price, lo:price};
  return true;
}
function closePos(a, sym, price, time, reason){
  const p = a.pos[sym]; if (!p) return;
  const fee = p.qty * price * P.fee[META[sym].type];
  a.cash += p.side * p.qty * price - fee;
  const pnl = p.side * (price - p.entry) * p.qty - p.fee - fee;
  a.trades.push({sym, side:p.side, qty:p.qty, entry:p.entry, exit:price, pnl, entryT:p.time, exitT:time, reason});
  delete a.pos[sym];
}
function trailStop(p, high, low){
  if (p.side === 1){ p.hi = Math.max(p.hi, high); p.stop = Math.max(p.stop, p.hi - p.mult*p.atr); }
  else { p.lo = Math.min(p.lo, low); p.stop = Math.min(p.stop, p.lo + p.mult*p.atr); }
}
function tickPos(a, sym, price, time){
  const p = a.pos[sym]; if (!p) return;
  const trailing = p.tp == null;
  if (trailing) trailStop(p, price, price);
  const label = trailing ? 'Trailing stop' : 'Stop';
  if (p.side === 1){
    if (price <= p.stop) closePos(a, sym, price, time, label);
    else if (!trailing && price >= p.tp) closePos(a, sym, p.tp, time, 'Target');
  } else {
    if (price >= p.stop) closePos(a, sym, price, time, label);
    else if (!trailing && price <= p.tp) closePos(a, sym, p.tp, time, 'Target');
  }
}
function processBar(a, sym, c, i, ind, riskPct, allowEntry, prices){
  const bar = c[i], p = a.pos[sym];
  if (p){
    const trailing = p.tp == null;
    if (trailing) trailStop(p, bar.h, bar.l);
    const hitStop = p.side === 1 ? bar.l <= p.stop : bar.h >= p.stop;
    const hitTp = !trailing && (p.side === 1 ? bar.h >= p.tp : bar.l <= p.tp);
    if (hitStop) closePos(a, sym, p.stop, bar.closeT, trailing ? 'Trailing stop' : 'Stop');
    else if (hitTp) closePos(a, sym, p.tp, bar.closeT, 'Target');
  }
  const x = cross(ind, i), q = a.pos[sym];
  if (q && x && x !== q.side) closePos(a, sym, bar.c, bar.closeT, 'Reversal');
  if (allowEntry && !a.pos[sym]){
    const s = entrySignal(ind, c, i, sym);
    if (s){
      const eq = acctEquity(a, Object.assign({}, prices, {[sym]: bar.c}));
      openPos(a, sym, s, bar.c, ind.atr[i], bar.closeT, eq, riskPct);
    }
  }
}
function backtest(sym, closed, startEq, riskPct){
  const a = newAcct(startEq), ind = compute(closed), first = P.trend;
  let peak = startEq, maxDD = 0;
  for (let i=first;i<closed.length;i++){
    processBar(a, sym, closed, i, ind, riskPct, true, {});
    const eq = acctEquity(a, {[sym]: closed[i].c});
    if (eq > peak) peak = eq;
    maxDD = Math.max(maxDD, (peak-eq)/peak);
  }
  const final = acctEquity(a, {[sym]: closed[closed.length-1].c});
  const gp = a.trades.filter(t => t.pnl > 0).reduce((s,t) => s+t.pnl, 0);
  const gl = -a.trades.filter(t => t.pnl <= 0).reduce((s,t) => s+t.pnl, 0);
  const hold = closed.length > first ? closed[closed.length-1].c / closed[first].c - 1 : 0;
  return {sym, bars:Math.max(0, closed.length-first), trades:a.trades.length,
          wins:a.trades.filter(t => t.pnl > 0).length, final, start:startEq, maxDD,
          gp, gl, hold, from:closed[first] ? closed[first].t : null, to:closed[closed.length-1].t};
}
// ENGINE END


/* ---------- Files ---------- */
const DIR = process.env.BOT_DIR || '.';
const F = {state:`${DIR}/state.json`, config:`${DIR}/config.json`, cache:`${DIR}/cache.json`};
const readJSON = (f, d) => { try{ return JSON.parse(fs.readFileSync(f, 'utf8')); }catch(e){ return d; } };
const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v));

const config = Object.assign({startEq:10000, risk:1, tf:'4h', stopMult:3, tpMult:3, maxPos:20, exitMode:'trail',
  shortsCrypto:false, shortsForex:true, enabled:{}}, readJSON(F.config, {}));
const isOn = id => config.enabled[id] !== false;
P.stopMult = config.stopMult; P.tpMult = config.tpMult; P.maxPos = config.maxPos/100; P.trail = config.exitMode === 'trail';
P.shorts = {crypto:config.shortsCrypto, forex:config.shortsForex};

let st = readJSON(F.state, null);
const firstRun = !st;
if (!st) st = {server:true, ver:2, acct:newAcct(config.startEq), lastBar:{}, curve:[], logs:[], running:true};
Object.assign(st, {server:true, running:true, tf:config.tf, risk:config.risk, startEq:st.acct.start, stopMult:config.stopMult, tpMult:config.tpMult,
  maxPos:config.maxPos, exitMode:config.exitMode, shortsCrypto:config.shortsCrypto, shortsForex:config.shortsForex, enabled:config.enabled});

/* ---------- Messages ---------- */
const stamp = () => new Date().toISOString();
const usd = n => (n<0?'-':'') + '$' + Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
function pxs(sym, v){
  if (META[sym].type === 'forex') return v.toFixed(sym === 'USDJPY' ? 3 : 5);
  return v >= 1000 ? v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : v >= 10 ? v.toFixed(3) : v.toFixed(4);
}
const pending = [];
function log(msg){ st.logs.unshift({t:Date.now(), msg}); st.logs = st.logs.slice(0, 80); pending.push(msg); console.log(msg); }
async function telegram(text){
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try{
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({chat_id:chat, text})});
  }catch(e){ console.log('Telegram failed: ' + e.message); }
}

/* ---------- Prices ---------- */
async function getJSON(url){
  const r = await fetch(url, {headers:{'user-agent':'paper-trader-bot'}});
  if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + new URL(url).host);
  return r.json();
}
const HOSTS = ['https://data-api.binance.vision','https://api.binance.com','https://api.binance.us'];
async function binance(sym, tf){
  let lastErr;
  for (const h of HOSTS){
    try{
      const rows = await getJSON(`${h}/api/v3/klines?symbol=${sym}&interval=${tf}&limit=1000`);
      return rows.map(x => ({t:x[0], o:+x[1], h:+x[2], l:+x[3], c:+x[4], closeT:x[6]}));
    }catch(e){ lastErr = e; }
  }
  throw lastErr;
}
const KRAKEN = {BTCUSDT:'XBTUSD', ETHUSDT:'ETHUSD', SOLUSDT:'SOLUSD', XRPUSDT:'XRPUSD'};
const KIV = {'15m':15, '1h':60, '4h':240};
async function kraken(sym, tf){
  const iv = KIV[tf];
  const j = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=${KRAKEN[sym]}&interval=${iv}`);
  if (j.error && j.error.length) throw new Error('Kraken: ' + j.error.join(' '));
  const key = Object.keys(j.result).find(k => k !== 'last');
  return j.result[key].map(r => ({t:r[0]*1000, o:+r[1], h:+r[2], l:+r[3], c:+r[4], closeT:(r[0]+iv*60)*1000-1}));
}
async function crypto(sym, tf){
  try{ return {candles:await binance(sym, tf), src:'Binance'}; }
  catch(e1){
    if (!KRAKEN[sym]) throw e1;
    try{ return {candles:await kraken(sym, tf), src:'Kraken'}; }
    catch(e2){ throw new Error(`${e1.message}; ${e2.message}`); }
  }
}
async function forexSeries(s){
  const step = 85, chunks = 6, now = Date.now(), f = ms => new Date(ms).toISOString().slice(0,10), reqs = [];
  for (let k=chunks-1;k>=0;k--){
    const from = now - (k+1)*step*864e5, to = k === 0 ? now : now - k*step*864e5 - 864e5;
    reqs.push(getJSON(`https://api.frankfurter.dev/v1/${f(from)}..${f(to)}?base=${s.base}&symbols=${s.quote}`));
  }
  const parts = await Promise.all(reqs);
  const rates = Object.assign({}, ...parts.map(p => p.rates));
  return Object.keys(rates).sort().map(d => {
    const v = rates[d][s.quote], t = Date.parse(d + 'T16:00:00Z');
    return {t, o:v, h:v, l:v, c:v, closeT:t};
  });
}

/* ---------- Main ---------- */
async function main(){
  const now = Date.now(), data = {}, problems = [];
  const active = SYMBOLS.filter(s => isOn(s.id));
  const cache = readJSON(F.cache, {fetchedAt:0, pairs:{}});
  const needForex = active.some(s => s.type === 'forex') && now - cache.fetchedAt > 6*3600e3;
  let forexTouched = false;

  await Promise.all(active.map(async s => {
    try{
      if (s.type === 'crypto'){ const r = await crypto(s.id, config.tf); data[s.id] = r.candles; st.source = r.src; }
      else if (needForex){ cache.pairs[s.id] = await forexSeries(s); forexTouched = true; data[s.id] = cache.pairs[s.id]; }
      else if (cache.pairs[s.id]) data[s.id] = cache.pairs[s.id];
      else problems.push(s.label + ': no forex data yet');
    }catch(e){
      if (s.type === 'forex' && cache.pairs[s.id]) data[s.id] = cache.pairs[s.id];
      problems.push(`${s.label}: ${e.message}`);
    }
  }));
  if (forexTouched){ cache.fetchedAt = now; writeJSON(F.cache, cache); }
  if (!Object.keys(data).length) throw new Error('No price data could be loaded. ' + problems.join(' | '));
  for (const p of problems) console.log('Warning: ' + p);

  // open positions on pairs that are switched off still need a price
  const prices = {};
  for (const id in data){ const c = data[id]; prices[id] = c[c.length-1].c; }

  const a = st.acct;
  for (const s of SYMBOLS){
    const c = data[s.id]; if (!c) continue;
    const closed = c.filter(x => x.closeT < now); if (closed.length < 2) continue;
    const ind = compute(closed), n = closed.length, lastT = closed[n-1].t, on = isOn(s.id);
    const before = a.trades.length, hadPos = !!a.pos[s.id];
    tickPos(a, s.id, prices[s.id], now);
    if (st.lastBar[s.id] === undefined){ st.lastBar[s.id] = lastT; }
    else if (lastT > st.lastBar[s.id]){
      const idxs = [];
      for (let i=n-1;i>=0 && closed[i].t > st.lastBar[s.id];i--) idxs.unshift(i);
      for (const j of idxs) processBar(a, s.id, closed, j, ind, config.risk, on && j === n-1, prices);
      st.lastBar[s.id] = lastT;
    }
    for (let i=before;i<a.trades.length;i++){
      const t = a.trades[i];
      log(`Closed ${t.side===1?'long':'short'} ${s.label} at ${pxs(s.id,t.exit)} (${t.reason}): ${usd(t.pnl)}`);
    }
    if (!hadPos && a.pos[s.id]){
      const p = a.pos[s.id];
      log(`Opened ${p.side===1?'long':'short'} ${s.label} at ${pxs(s.id,p.entry)}, stop ${pxs(s.id,p.stop)}${p.tp == null ? ', trailing' : ', target ' + pxs(s.id,p.tp)}`);
    }
  }

  const eq = acctEquity(a, prices), lastPt = st.curve[st.curve.length-1];
  if (!lastPt || now - lastPt.t > 30*60e3){ st.curve.push({t:now, eq}); if (st.curve.length > 1500) st.curve = st.curve.slice(-1500); }
  st.lastRun = Math.floor(now / 3600e3) * 3600e3;   // rounded to the hour so quiet runs do not create a new commit
  if (firstRun) log(`Server bot started with ${usd(a.start)} on ${active.length} pair${active.length===1?'':'s'}. It acts on the next candle that closes.`);
  writeJSON(F.state, st);
  console.log(`Run finished. Equity ${usd(eq)}, ${Object.keys(a.pos).length} open position(s), ${a.trades.length} closed trade(s).`);
  for (const m of pending) await telegram('Paper trader: ' + m);
}
main().catch(e => { console.error('Run failed: ' + e.message); process.exit(1); });
