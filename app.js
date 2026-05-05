/* FinancialViz app.js — state, event bus, linked brushing, API */
"use strict";

// ── Palette ───────────────────────────────────────────────────────────────────
const C_CLUSTER = ["#00ccff","#f5a623","#1dd1a1","#a78bfa","#fb923c","#f472b6","#34d399","#60a5fa"];
const C_SECTOR  = {Tech:"#00ccff",Finance:"#a78bfa",Healthcare:"#1dd1a1",
                   Consumer:"#f5a623",Energy:"#fb923c",Industrials:"#f472b6","?":"#405070"};
const C_LABEL   = {outperform:"#1dd1a1",neutral:"#f5a623",underperform:"#ff6b6b"};

function getColor(d) {
  if (State.colorMode === "cluster") return C_CLUSTER[d.cluster % C_CLUSTER.length] || "#405070";
  if (State.colorMode === "sector")  return C_SECTOR[d.sector]  || "#405070";
  if (State.colorMode === "label")   return C_LABEL[d.label]    || "#405070";
  return "#405070";
}

// ── Global state ──────────────────────────────────────────────────────────────
const State = {
  colorMode: "cluster",   // cluster | sector | label
  k:         6,
  sector:    "All",
  brush:     new Set(),   // currently brushed ticker set (empty = all)
  snap:      [],          // latest snapshot per ticker
  mds:       [],
  features:  [],
  candleTicker: "AAPL",
  candleData:   null,
  elbowData:    null,
  correlData:   null,
  _listeners:   {},
};

// ── Event bus ─────────────────────────────────────────────────────────────────
const Bus = {
  on(e,fn) { (State._listeners[e]=State._listeners[e]||[]).push(fn); },
  emit(e,p){ (State._listeners[e]||[]).forEach(fn=>fn(p)); },
};

// ── Brushing helpers ──────────────────────────────────────────────────────────
function setBrush(tickerSet) {
  State.brush = tickerSet;
  Bus.emit("brush", tickerSet);
}
function clearBrush() { setBrush(new Set()); }

function isActive(ticker) {
  return State.brush.size === 0 || State.brush.has(ticker);
}

// ── API ───────────────────────────────────────────────────────────────────────
async function apiFetch(path, opts={}) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(path + " → " + r.status);
  return r.json();
}

// ── Data load ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  setStatus("loading");
  try {
    const d = await apiFetch(`/api/dashboard?k=${State.k}`);
    State.snap     = d.snapshot || [];
    State.mds      = d.mds      || [];
    State.features = d.features || [];
    setStatus("live");
    Bus.emit("data:ready", d);
  } catch(e) {
    console.error(e);
    setStatus("error");
  }
}

async function loadCandle(ticker) {
  State.candleTicker = ticker;
  const input = document.getElementById("ticker-input");
  if (input) input.value = ticker;
  try {
    State.candleData = await apiFetch(`/api/candlestick?ticker=${ticker}&limit=120`);
    Bus.emit("candle:ready");
  } catch(e) { console.error(e); }
}

async function loadElbow() {
  if (State.elbowData) { Bus.emit("elbow:ready"); return; }
  try {
    State.elbowData = await apiFetch("/api/elbow");
    Bus.emit("elbow:ready");
  } catch(e) { console.error(e); }
}

async function loadCorr() {
  if (State.correlData) { Bus.emit("corr:ready"); return; }
  try {
    State.correlData = await apiFetch("/api/correlation");
    Bus.emit("corr:ready");
  } catch(e) { console.error(e); }
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(s) {
  const dot  = document.querySelector(".dot");
  const txt  = document.querySelector(".status-text");
  if (!txt) return;
  const map  = {live:"Data live",loading:"Loading …",error:"Error"};
  txt.textContent = map[s] || s;
  if (dot) {
    dot.style.background   = s==="live"?"var(--green)":s==="error"?"var(--red)":"var(--amber)";
    dot.style.boxShadow    = `0 0 5px ${s==="live"?"var(--green)":s==="error"?"var(--red)":"var(--amber)"}`;
  }
}

// ── Controls ──────────────────────────────────────────────────────────────────
function setColorMode(m) {
  State.colorMode = m;
  document.querySelectorAll("[data-cm]").forEach(b => b.classList.toggle("act", b.dataset.cm===m));
  Bus.emit("recolor");
}

function setK(v) {
  State.k = +v;
  document.getElementById("k-val").textContent = v;
}

async function applyK() {
  State.elbowData = null;   // invalidate elbow
  await loadDashboard();
  loadElbow();
}

function setSector(v) {
  State.sector = v;
  Bus.emit("sector", v);
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
const TT = {
  el: null,
  show(d, x, y) {
    if (!this.el) return;
    const prob = d.prob != null ? (d.prob*100).toFixed(1)+"%" : "—";
    const clsColor = C_LABEL[d.label]||"var(--t1)";
    this.el.innerHTML = `
      <div class="tt-head">${d.ticker||d.Ticker||"?"}</div>
      <div class="tt-row"><span class="tt-lbl">Sector</span><span class="tt-val">${d.sector||"?"}</span></div>
      <div class="tt-row"><span class="tt-lbl">Cluster</span><span class="tt-val">${d.cluster??0}</span></div>
      <div class="tt-row"><span class="tt-lbl">1Y Return</span><span class="tt-val">${pct(d.ret_252d)}</span></div>
      <div class="tt-row"><span class="tt-lbl">Volatility</span><span class="tt-val">${pct(d.vol_252)}</span></div>
      <div class="tt-row"><span class="tt-lbl">Sharpe</span><span class="tt-val">${num(d.sharpe_252,2)}</span></div>
      <div class="tt-row"><span class="tt-lbl">RSI</span><span class="tt-val">${num(d.rsi,1)}</span></div>
      <div class="tt-row"><span class="tt-lbl">Signal</span><span class="tt-val" style="color:${clsColor}">${d.label||"—"}</span></div>
      <div class="tt-row"><span class="tt-lbl">P(outperform)</span><span class="tt-val">${prob}</span></div>`;
    this.el.classList.add("on");
    this.move(x,y);
  },
  move(x,y) {
    if (!this.el) return;
    const W=190, vw=innerWidth, vh=innerHeight, off=12;
    this.el.style.left = (x+off+W>vw ? x-W-off : x+off)+"px";
    this.el.style.top  = (y+180>vh  ? y-180    : y+off)+"px";
  },
  hide() { if(this.el) this.el.classList.remove("on"); },
};

// ── Number helpers ────────────────────────────────────────────────────────────
function pct(v,d=1) {
  if (v==null||isNaN(v)) return "—";
  return (v>=0?"+":"")+((v*100).toFixed(d))+"%";
}
function num(v,d=2) {
  if (v==null||isNaN(v)) return "—";
  return (v>=0?"+":"")+(+v).toFixed(d);
}

// ── Filtered data helper ──────────────────────────────────────────────────────
function filteredSnap() {
  if (State.sector === "All") return State.snap;
  return State.snap.filter(d => d.sector === State.sector);
}
function filteredMds() {
  if (State.sector === "All") return State.mds;
  return State.mds.filter(d => d.sector === State.sector);
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  TT.el = document.getElementById("tooltip");

  // color-mode buttons
  document.querySelectorAll("[data-cm]").forEach(b =>
    b.addEventListener("click", () => setColorMode(b.dataset.cm)));

  // K slider — only re-queries on Enter / button click
  const ks = document.getElementById("k-slider");
  if (ks) ks.addEventListener("input", e => setK(e.target.value));
  const kb = document.getElementById("k-apply");
  if (kb) kb.addEventListener("click", applyK);

  // sector
  const ss = document.getElementById("sector-sel");
  if (ss) ss.addEventListener("change", e => setSector(e.target.value));

  // ticker input
  const ti = document.getElementById("ticker-input");
  if (ti) ti.addEventListener("keydown", e => {
    if (e.key==="Enter") loadCandle(ti.value.trim().toUpperCase());
  });

  // refresh
  const rb = document.getElementById("btn-refresh");
  if (rb) rb.addEventListener("click", async () => {
    setStatus("loading");
    try { await apiFetch("/api/refresh",{method:"POST"}); State.correlData=null; State.elbowData=null; await loadDashboard(); loadElbow(); loadCorr(); }
    catch(e) { setStatus("error"); }
  });

  // clear brush on Escape
  document.addEventListener("keydown", e => { if(e.key==="Escape") clearBrush(); });

  // kick off loads
  loadDashboard().then(() => {
    loadCandle(State.candleTicker);
    loadElbow();
    loadCorr();
  });
});
