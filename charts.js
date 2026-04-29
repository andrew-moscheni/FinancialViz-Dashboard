/* FinSight charts.js — all D3 visualisations, single-screen, linked brushing */
"use strict";

// ── Chart registry: each chart re-renders itself on brush/recolor events ──────
const Charts = {};

// ── Tiny helpers ──────────────────────────────────────────────────────────────
function dims(id) {
  const el = document.getElementById(id);
  if (!el) return {w:0,h:0};
  const r = el.getBoundingClientRect();
  return {w: Math.floor(r.width), h: Math.floor(r.height)};
}

function clearSvg(id) {
  const el = document.getElementById(id);
  if (el) d3.select(el).selectAll("*").remove();
  return el;
}

function gridlines(g, xScale, yScale, w, h) {
  g.selectAll(".gl-y").data(yScale.ticks(4)).enter()
    .append("line").attr("class","gridline")
    .attr("x1",0).attr("x2",w).attr("y1",d=>yScale(d)).attr("y2",d=>yScale(d));
  g.selectAll(".gl-x").data(xScale.ticks(5)).enter()
    .append("line").attr("class","gridline")
    .attr("x1",d=>xScale(d)).attr("x2",d=>xScale(d)).attr("y1",0).attr("y2",h);
}

// ── 1. Scatter: Risk vs Return ─────────────────────────────────────────────────
Charts.scatter = function() {
  const svgEl = clearSvg("svg-scatter");
  if (!svgEl) return;
  const data = filteredSnap();
  if (!data.length) return;

  const m = {t:6,r:6,b:28,l:36};
  const {w:W, h:H} = dims("svg-scatter");
  const w = W-m.l-m.r, h = H-m.t-m.b;
  if (w<=0||h<=0) return;

  const svg = d3.select(svgEl).attr("width",W).attr("height",H);
  const g   = svg.append("g").attr("transform",`translate(${m.l},${m.t})`);

  const x = d3.scaleLinear().domain(d3.extent(data,d=>d.ret_252d)).nice().range([0,w]);
  const y = d3.scaleLinear().domain([0,d3.max(data,d=>d.vol_252)*1.05]).range([h,0]);
  const r = d3.scaleSqrt().domain([0,d3.max(data,d=>Math.abs(d.sharpe_252))||1]).range([3,11]);

  gridlines(g,x,y,w,h);
  // zero-return line
  g.append("line").attr("class","zero-line")
    .attr("x1",x(0)).attr("x2",x(0)).attr("y1",0).attr("y2",h);

  g.append("g").attr("class","axis").attr("transform",`translate(0,${h})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(d=>(d*100).toFixed(0)+"%"));
  g.append("g").attr("class","axis")
    .call(d3.axisLeft(y).ticks(4).tickFormat(d=>(d*100).toFixed(0)+"%"));

  // axis labels
  g.append("text").attr("x",w/2).attr("y",h+25)
    .attr("text-anchor","middle").attr("font-size",8).attr("fill","var(--t2)").text("1-Year Return →");
  g.append("text").attr("transform","rotate(-90)").attr("x",-h/2).attr("y",-28)
    .attr("text-anchor","middle").attr("font-size",8).attr("fill","var(--t2)").text("↑ Volatility");

  const dots = g.selectAll(".dot").data(data, d=>d.ticker).enter()
    .append("circle").attr("class","dot")
    .attr("cx",d=>x(d.ret_252d)).attr("cy",d=>y(d.vol_252))
    .attr("r",d=>r(Math.abs(d.sharpe_252)))
    .attr("fill",d=>getColor(d))
    .attr("opacity",d=>isActive(d.ticker)?0.82:0.06)
    .on("mousemove",(ev,d)=>TT.show(d,ev.clientX,ev.clientY))
    .on("mouseleave",()=>TT.hide())
    .on("click",(ev,d)=>{
      loadCandle(d.ticker);
      const s = new Set([d.ticker]);
      setBrush(State.brush.has(d.ticker)&&State.brush.size===1 ? new Set() : s);
    });

  // brush overlay
  const brush = d3.brush()
    .extent([[0,0],[w,h]])
    .on("end", function({selection}) {
      if (!selection) { clearBrush(); return; }
      const [[x0,y0],[x1,y1]] = selection;
      const sel = new Set(data.filter(d =>
        x(d.ret_252d)>=x0 && x(d.ret_252d)<=x1 &&
        y(d.vol_252)>=y0  && y(d.vol_252)<=y1
      ).map(d=>d.ticker));
      setBrush(sel);
      d3.select(this).call(brush.move, null);
    });
  g.append("g").attr("class","brush").call(brush);

  // ticker labels for active dots
  function renderLabels() {
    g.selectAll(".dot-lbl").remove();
    const active = data.filter(d=>isActive(d.ticker));
    if (active.length <= 12) {
      active.forEach(d => {
        g.append("text").attr("class","dot-lbl")
          .attr("x",x(d.ret_252d)+r(Math.abs(d.sharpe_252))+2)
          .attr("y",y(d.vol_252)+3)
          .attr("font-size",8).attr("font-family","var(--font-mono)")
          .attr("fill","var(--t0)").attr("pointer-events","none")
          .text(d.ticker);
      });
    }
  }
  renderLabels();

  Bus.on("brush",    () => { dots.attr("opacity",d=>isActive(d.ticker)?0.82:0.06); renderLabels(); });
  Bus.on("recolor",  () => dots.attr("fill",d=>getColor(d)));
  Bus.on("sector",   () => Charts.scatter());
};

// ── 2. MDS: Asset Similarity Map ──────────────────────────────────────────────
Charts.mds = function() {
  const svgEl = clearSvg("svg-mds");
  if (!svgEl) return;
  const data = filteredMds();
  if (!data.length) return;

  const m = {t:6,r:6,b:22,l:22};
  const {w:W,h:H} = dims("svg-mds");
  const w=W-m.l-m.r, h=H-m.t-m.b;
  if(w<=0||h<=0) return;

  const svg = d3.select(svgEl).attr("width",W).attr("height",H);
  const g   = svg.append("g").attr("transform",`translate(${m.l},${m.t})`);

  const x = d3.scaleLinear().domain(d3.extent(data,d=>d.x)).nice().range([0,w]);
  const y = d3.scaleLinear().domain(d3.extent(data,d=>d.y)).nice().range([h,0]);

  // Cluster convex hulls
  const byCluster = d3.group(data,d=>d.cluster);
  byCluster.forEach((pts,cl)=>{
    if(pts.length<3) return;
    const hull = d3.polygonHull(pts.map(p=>[x(p.x),y(p.y)]));
    if(!hull) return;
    const col = C_CLUSTER[cl%C_CLUSTER.length];
    const path = "M"+hull.join("L")+"Z";
    g.append("path").attr("class","hull-fill").attr("d",path).attr("fill",col);
    g.append("path").attr("class","hull-stroke").attr("d",path).attr("stroke",col);
  });

  const dots = g.selectAll(".dot").data(data,d=>d.ticker).enter()
    .append("circle").attr("class","dot")
    .attr("cx",d=>x(d.x)).attr("cy",d=>y(d.y)).attr("r",5)
    .attr("fill",d=>getColor(d))
    .attr("opacity",d=>isActive(d.ticker)?0.85:0.06)
    .on("mousemove",(ev,d)=>TT.show(d,ev.clientX,ev.clientY))
    .on("mouseleave",()=>TT.hide())
    .on("click",(ev,d)=>{
      loadCandle(d.ticker);
      setBrush(State.brush.has(d.ticker)&&State.brush.size===1 ? new Set() : new Set([d.ticker]));
    });

  // Axis labels (just show "MDS 1" / "MDS 2")
  g.append("text").attr("x",w/2).attr("y",h+18)
    .attr("text-anchor","middle").attr("font-size",8).attr("fill","var(--t2)").text("MDS 1");
  g.append("text").attr("transform","rotate(-90)").attr("x",-h/2).attr("y",-14)
    .attr("text-anchor","middle").attr("font-size",8).attr("fill","var(--t2)").text("MDS 2");

  // Labels on active dots
  function renderLabels() {
    g.selectAll(".dot-lbl").remove();
    const active = data.filter(d=>isActive(d.ticker));
    if(active.length<=14) active.forEach(d=>{
      g.append("text").attr("class","dot-lbl")
        .attr("x",x(d.x)+6).attr("y",y(d.y)+3)
        .attr("font-size",8).attr("font-family","var(--font-mono)")
        .attr("fill","var(--t0)").attr("pointer-events","none").text(d.ticker);
    });
  }
  renderLabels();

  Bus.on("brush",   ()=>{ dots.attr("opacity",d=>isActive(d.ticker)?0.85:0.06); renderLabels(); });
  Bus.on("recolor", ()=>dots.attr("fill",d=>getColor(d)));
  Bus.on("sector",  ()=>Charts.mds());
};

// ── 3. Parallel Coordinates ────────────────────────────────────────────────────
Charts.parallel = function() {
  const svgEl = clearSvg("svg-parallel");
  if (!svgEl) return;
  const raw = filteredSnap();
  if (!raw.length) return;

  const DIMS = ["ret_252d","vol_252","sharpe_252","rsi","drawdown_63d","trend_slope","price_to_sma200"];
  const LABS = {ret_252d:"1Y Ret",vol_252:"Vol",sharpe_252:"Sharpe",rsi:"RSI",
                drawdown_63d:"Drawdn",trend_slope:"Trend",price_to_sma200:"P/SMA200"};

  const m = {t:22,r:8,b:8,l:8};
  const {w:W,h:H} = dims("svg-parallel");
  const w=W-m.l-m.r, h=H-m.t-m.b;
  if(w<=0||h<=0) return;

  const svg = d3.select(svgEl).attr("width",W).attr("height",H);
  const g   = svg.append("g").attr("transform",`translate(${m.l},${m.t})`);

  const xPos = d3.scalePoint().domain(DIMS).range([0,w]).padding(0.05);
  const yScales = {};
  DIMS.forEach(dim=>{
    yScales[dim] = d3.scaleLinear()
      .domain(d3.extent(raw,d=>+d[dim]||0)).nice().range([h,0]);
  });

  const brushExtents = {};

  function active(d) {
    const passPC = Object.entries(brushExtents).every(([dim,[lo,hi]])=>{
      const v=+d[dim]||0; return v>=lo&&v<=hi;
    });
    return passPC && isActive(d.ticker);
  }

  const lineFn = d => d3.line()(DIMS.map(p=>[xPos(p), yScales[p](+d[p]||0)]));

  const lines = g.append("g").selectAll(".pc-line").data(raw,d=>d.ticker).enter()
    .append("path").attr("class","pc-line")
    .attr("d",lineFn)
    .attr("stroke",d=>getColor(d))
    .attr("opacity",d=>active(d)?0.5:0.04)
    .on("mousemove",(ev,d)=>TT.show(d,ev.clientX,ev.clientY))
    .on("mouseleave",()=>TT.hide())
    .on("click",(ev,d)=>{
      loadCandle(d.ticker);
      setBrush(new Set([d.ticker]));
    });

  function refreshLines() {
    lines.attr("opacity",d=>active(d)?0.55:0.04)
         .attr("stroke",d=>getColor(d));
    // propagate PC brush to global brush
    const passing = new Set(raw.filter(d=>Object.entries(brushExtents)
      .every(([dim,[lo,hi]])=>{ const v=+d[dim]||0; return v>=lo&&v<=hi; }))
      .map(d=>d.ticker));
    // only push if there are active PC brushes
    if(Object.keys(brushExtents).length>0) setBrush(passing);
  }

  // Axes + brushes
  const axGrps = g.selectAll(".pc-ax").data(DIMS).enter()
    .append("g").attr("class","pc-ax").attr("transform",d=>`translate(${xPos(d)},0)`);

  axGrps.append("g").attr("class","axis")
    .each(function(d){ d3.select(this).call(d3.axisLeft(yScales[d]).ticks(4)); });

  axGrps.append("text").attr("y",-10).attr("text-anchor","middle")
    .attr("font-size",8).attr("fill","var(--t1)").text(d=>LABS[d]||d);

  axGrps.append("g").attr("class","pc-brush")
    .each(function(dim){
      const br = d3.brushY().extent([[-8,0],[8,h]])
        .on("brush end",function({selection}){
          if(selection){ const [y0,y1]=selection;
            brushExtents[dim]=[yScales[dim].invert(y1),yScales[dim].invert(y0)];
          } else { delete brushExtents[dim]; }
          refreshLines();
        });
      d3.select(this).call(br);
    });

  Bus.on("brush",  ()=> lines.attr("opacity",d=>active(d)?0.55:0.04));
  Bus.on("recolor",()=> lines.attr("stroke",d=>getColor(d)));
  Bus.on("sector", ()=> Charts.parallel());
};

// ── 4. Candlestick + RSI ───────────────────────────────────────────────────────
Charts.candle = function() {
  const svgEl = clearSvg("svg-candle");
  if (!svgEl) return;
  const data = State.candleData;
  if (!data||!data.length) return;

  const parseDt = d3.timeParse("%Y-%m-%d");
  const raw = data.map(d=>({...d,
    dt:parseDt(d.Date),
    O:+d.Open, H:+d.High, L:+d.Low, C:+d.Close,
    V:+d.Volume, rsi:+d.rsi||50
  })).filter(d=>d.dt);

  const m = {t:6,r:40,b:16,l:42};
  const {w:W,h:H} = dims("svg-candle");
  const w=W-m.l-m.r;
  const mainH = Math.floor((H-m.t-m.b)*0.72);
  const rsiH  = Math.floor((H-m.t-m.b)*0.20);
  const gap   = Math.floor((H-m.t-m.b)*0.08);
  const rsiY  = m.t + mainH + gap;

  if(w<=0||mainH<=0) return;

  const svg = d3.select(svgEl).attr("width",W).attr("height",H);
  const gMain = svg.append("g").attr("transform",`translate(${m.l},${m.t})`);
  const gRsi  = svg.append("g").attr("transform",`translate(${m.l},${rsiY})`);

  const xT  = d3.scaleTime().domain(d3.extent(raw,d=>d.dt)).range([0,w]);
  const xB  = d3.scaleBand().domain(raw.map(d=>d.Date)).range([0,w]).padding(0.18);
  const bw  = Math.max(1, xB.bandwidth());

  const y = d3.scaleLinear()
    .domain([d3.min(raw,d=>d.L)*0.993, d3.max(raw,d=>d.H)*1.007]).range([mainH,0]);
  const yRsi = d3.scaleLinear().domain([0,100]).range([rsiH,0]);

  // gridlines
  gMain.selectAll(".gl").data(y.ticks(4)).enter().append("line").attr("class","gridline")
    .attr("x1",0).attr("x2",w).attr("y1",d=>y(d)).attr("y2",d=>y(d));
  // RSI bands
  [30,70].forEach(lv=>{
    gRsi.append("line").attr("class","gridline")
      .attr("stroke",lv===70?"rgba(255,107,107,.25)":"rgba(29,209,161,.25)")
      .attr("x1",0).attr("x2",w).attr("y1",yRsi(lv)).attr("y2",yRsi(lv));
  });

  // axes
  gMain.append("g").attr("class","axis").attr("transform",`translate(0,${mainH})`)
    .call(d3.axisBottom(xT).ticks(5).tickFormat(d3.timeFormat("%b %y")));
  gMain.append("g").attr("class","axis").attr("transform",`translate(${w},0)`)
    .call(d3.axisRight(y).ticks(4).tickFormat(d=>d>=1000?d3.format(".2s")(d):d.toFixed(0)));

  // wicks
  gMain.selectAll(".wick").data(raw).enter().append("line")
    .attr("class",d=>d.C>=d.O?"w-up":"w-down")
    .attr("x1",d=>xT(d.dt)).attr("x2",d=>xT(d.dt))
    .attr("y1",d=>y(d.H)).attr("y2",d=>y(d.L));

  // bodies
  gMain.selectAll(".body").data(raw).enter().append("rect")
    .attr("class",d=>d.C>=d.O?"c-up":"c-down")
    .attr("x",d=>xT(d.dt)-bw/2)
    .attr("y",d=>y(Math.max(d.O,d.C)))
    .attr("width",bw)
    .attr("height",d=>Math.max(1,Math.abs(y(d.O)-y(d.C))))
    .on("mousemove",(ev,d)=>{
      TT.el.innerHTML=`
        <div class="tt-head">${State.candleTicker} · ${d.Date}</div>
        <div class="tt-row"><span class="tt-lbl">Open</span><span class="tt-val">${d.O.toFixed(2)}</span></div>
        <div class="tt-row"><span class="tt-lbl">High</span><span class="tt-val">${d.H.toFixed(2)}</span></div>
        <div class="tt-row"><span class="tt-lbl">Low</span><span class="tt-val">${d.L.toFixed(2)}</span></div>
        <div class="tt-row"><span class="tt-lbl">Close</span><span class="tt-val">${d.C.toFixed(2)}</span></div>
        <div class="tt-row"><span class="tt-lbl">Volume</span><span class="tt-val">${d3.format(".2s")(d.V)}</span></div>
        <div class="tt-row"><span class="tt-lbl">RSI</span><span class="tt-val">${d.rsi.toFixed(1)}</span></div>`;
      TT.el.classList.add("on"); TT.move(ev.clientX,ev.clientY);
    })
    .on("mouseleave",()=>TT.hide());

  // ticker label + signal
  const snap = State.snap.find(s=>s.ticker===State.candleTicker);
  const sigColor = snap ? C_LABEL[snap.label]||"var(--t1)" : "var(--t1)";
  gMain.append("text").attr("class","candle-ticker").attr("x",4).attr("y",16).text(State.candleTicker);
  if(snap) gMain.append("text")
    .attr("x",4).attr("y",30).attr("font-size",9).attr("font-family","var(--font-mono)")
    .attr("fill",sigColor).text(`${snap.label} · P=${(snap.prob*100).toFixed(1)}%`);

  // RSI line
  const rsiLine = d3.line().x(d=>xT(d.dt)).y(d=>yRsi(d.rsi)).curve(d3.curveMonotoneX);
  gRsi.append("path").attr("class","rsi-line").attr("d",rsiLine(raw));
  gRsi.append("text").attr("x",2).attr("y",10)
    .attr("font-size",8).attr("fill","var(--t2)").attr("font-family","var(--font-mono)").text("RSI");
};

// ── 5. Elbow Plot ──────────────────────────────────────────────────────────────
Charts.elbow = function() {
  const svgEl = clearSvg("svg-elbow");
  if (!svgEl) return;
  const data = State.elbowData;
  if (!data||!data.length) return;

  const m = {t:8,r:8,b:26,l:38};
  const {w:W,h:H} = dims("svg-elbow");
  const w=W-m.l-m.r, h=H-m.t-m.b;
  if(w<=0||h<=0) return;

  const svg = d3.select(svgEl).attr("width",W).attr("height",H);
  const g   = svg.append("g").attr("transform",`translate(${m.l},${m.t})`);

  const x = d3.scaleLinear().domain([1,d3.max(data,d=>d.k)]).range([0,w]);
  const y = d3.scaleLinear().domain([0,data[0].inertia*1.05]).range([h,0]);

  gridlines(g,x,y,w,h);
  g.append("g").attr("class","axis").attr("transform",`translate(0,${h})`)
    .call(d3.axisBottom(x).tickFormat(d3.format("d")).ticks(data.length));
  g.append("g").attr("class","axis").call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(".2s")));

  // Detect elbow
  const ins = data.map(d=>d.inertia);
  let elbowK = State.k;
  for(let i=1;i<ins.length-1;i++){
    const curv = ins[i-1]-2*ins[i]+ins[i+1];
    if(curv > (ins[0]-ins[ins.length-1])*0.03) { elbowK=data[i].k; break; }
  }

  // Elbow marker
  g.append("line").attr("class","e-mark")
    .attr("x1",x(elbowK)).attr("x2",x(elbowK)).attr("y1",0).attr("y2",h);
  g.append("text").attr("x",x(elbowK)+3).attr("y",10)
    .attr("font-size",8).attr("fill","var(--amber)").attr("font-family","var(--font-mono)")
    .text(`K=${elbowK}`);

  // Animated line
  const line = d3.line().x(d=>x(d.k)).y(d=>y(d.inertia)).curve(d3.curveMonotoneX);
  const path = g.append("path").attr("class","e-line").attr("d",line(data));
  const len  = path.node().getTotalLength();
  path.attr("stroke-dasharray",len).attr("stroke-dashoffset",len)
    .transition().duration(700).ease(d3.easeQuadOut).attr("stroke-dashoffset",0);

  // Dots
  g.selectAll(".e-dot").data(data).enter().append("circle").attr("class","e-dot")
    .attr("cx",d=>x(d.k)).attr("cy",d=>y(d.inertia))
    .attr("r",d=>d.k===State.k?6:3.5)
    .attr("fill",d=>d.k===State.k?"var(--amber)":d.k===elbowK?"var(--amber)":"var(--cyan)")
    .attr("opacity",d=>d.k===State.k?1:0.7)
    .on("click",(_,d)=>{
      setK(d.k);
      document.getElementById("k-slider").value = d.k;
      applyK();
    })
    .on("mousemove",(ev,d)=>{
      TT.el.innerHTML=`<div class="tt-head">K = ${d.k}</div>
        <div class="tt-row"><span class="tt-lbl">Inertia</span><span class="tt-val">${d3.format(".3s")(d.inertia)}</span></div>`;
      TT.el.classList.add("on"); TT.move(ev.clientX,ev.clientY);
    })
    .on("mouseleave",()=>TT.hide());

  // axis labels
  g.append("text").attr("x",w/2).attr("y",h+22)
    .attr("text-anchor","middle").attr("font-size",8).attr("fill","var(--t2)").text("K (clusters)");
};

// ── 6. Feature Importance bars ─────────────────────────────────────────────────
Charts.features = function() {
  const svgEl = clearSvg("svg-feat");
  if (!svgEl) return;
  const data = State.features;
  if (!data||!data.length) return;

  const top = data.slice(0,10);
  const m = {t:4,r:40,b:4,l:84};
  const {w:W,h:H} = dims("svg-feat");
  const w=W-m.l-m.r, h=H-m.t-m.b;
  if(w<=0||h<=0) return;

  const svg = d3.select(svgEl).attr("width",W).attr("height",H);
  const g   = svg.append("g").attr("transform",`translate(${m.l},${m.t})`);

  const x = d3.scaleLinear().domain([0,d3.max(top,d=>d.importance)]).range([0,w]);
  const y = d3.scaleBand().domain(top.map(d=>d.feature)).range([0,h]).padding(0.22);

  // bg bars
  g.selectAll(".fb-bg").data(top).enter().append("rect").attr("class","fb-bg")
    .attr("x",0).attr("y",d=>y(d.feature)).attr("width",w).attr("height",y.bandwidth()).attr("rx",3);

  // filled bars
  g.selectAll(".fb-fill").data(top).enter().append("rect").attr("class","fb-fill")
    .attr("x",0).attr("y",d=>y(d.feature)).attr("height",y.bandwidth()).attr("rx",3)
    .attr("width",0)
    .transition().duration(550).delay((_,i)=>i*35)
    .attr("width",d=>x(d.importance));

  // labels
  const FLABS = {ret_252d:"1Y Return",ret_63d:"3M Return",ret_21d:"1M Return",ret_5d:"1W Return",
    vol_252:"Volatility 1Y",vol_63:"Volatility 3M",vol_21:"Volatility 1M",
    sharpe_252:"Sharpe 1Y",sharpe_63:"Sharpe 3M",sharpe_21:"Sharpe 1M",
    rsi:"RSI",trend_slope:"Trend",price_to_sma200:"P/SMA200",
    price_to_sma20:"P/SMA20",drawdown_63d:"Drawdown",vol_ratio:"Vol Ratio"};

  g.selectAll(".fb-lbl").data(top).enter().append("text").attr("class","fb-lbl")
    .attr("x",-4).attr("y",d=>y(d.feature)+y.bandwidth()/2)
    .attr("text-anchor","end").attr("dominant-baseline","middle")
    .text(d=>FLABS[d.feature]||d.feature.replace(/_/g," "));

  g.selectAll(".fb-val").data(top).enter().append("text").attr("class","fb-val")
    .attr("x",d=>x(d.importance)+3).attr("y",d=>y(d.feature)+y.bandwidth()/2)
    .attr("dominant-baseline","middle")
    .text(d=>(d.importance*100).toFixed(1)+"%");
};

// ── 7. Correlation Heatmap ────────────────────────────────────────────────────
Charts.heatmap = function() {
  const svgEl = clearSvg("svg-heatmap");
  if (!svgEl) return;
  const cd = State.correlData;
  if (!cd) return;

  const {w:W,h:H} = dims("svg-heatmap");
  const n = cd.tickers.length;
  const cellSz = Math.min(Math.floor(Math.min(W,H)/n)-1, 18);
  const plotSz = cellSz * n;
  const mL = Math.max(38, W - plotSz - 4);
  const mT = 4;

  const svg = d3.select(svgEl).attr("width",W).attr("height",H);
  const g   = svg.append("g").attr("transform",`translate(${mL},${mT})`);

  const col = d3.scaleSequential(d3.interpolateRdYlGn).domain([-1,1]);

  // cells
  g.selectAll(".hm-cell")
    .data(cd.tickers.flatMap((t1,i)=>cd.tickers.map((t2,j)=>({t1,t2,i,j,v:cd.matrix[i][j]}))))
    .enter().append("rect").attr("class","hm-cell")
    .attr("x",d=>d.j*cellSz).attr("y",d=>d.i*cellSz)
    .attr("width",cellSz-1).attr("height",cellSz-1).attr("rx",1)
    .attr("fill",d=>col(d.v))
    .attr("opacity",d=>isActive(d.t1)&&isActive(d.t2)?1:0.2)
    .on("mousemove",(ev,d)=>{
      TT.el.innerHTML=`
        <div class="tt-head">${d.t1} × ${d.t2}</div>
        <div class="tt-row"><span class="tt-lbl">Corr</span>
          <span class="tt-val" style="color:${col(d.v)}">${d.v.toFixed(3)}</span></div>`;
      TT.el.classList.add("on"); TT.move(ev.clientX,ev.clientY);
    })
    .on("mouseleave",()=>TT.hide())
    .on("click",(_,d)=>setBrush(new Set([d.t1,d.t2])));

  // row labels
  const fs = Math.min(9, cellSz*0.65);
  g.selectAll(".hm-rl").data(cd.tickers).enter().append("text")
    .attr("x",-3).attr("y",(_,i)=>i*cellSz+cellSz/2)
    .attr("text-anchor","end").attr("dominant-baseline","middle")
    .attr("font-family","var(--font-mono)").attr("font-size",fs)
    .attr("fill","var(--t1)").text(d=>d);

  Bus.on("brush",()=>{
    g.selectAll(".hm-cell")
      .attr("opacity",d=>isActive(d.t1)&&isActive(d.t2)?1:0.15);
  });
};

// ── Wire up data events ────────────────────────────────────────────────────────
Bus.on("data:ready", () => {
  Charts.scatter();
  Charts.mds();
  Charts.parallel();
  Charts.features();
  updateLegend();
  updateMetrics();
});

Bus.on("candle:ready",  () => Charts.candle());
Bus.on("elbow:ready",   () => Charts.elbow());
Bus.on("corr:ready",    () => Charts.heatmap());

// ── Legend + metrics ──────────────────────────────────────────────────────────
function updateLegend() {
  const el = document.getElementById("legend");
  if (!el) return;
  const clusters = [...new Set(State.snap.map(d=>d.cluster))].sort();
  el.innerHTML = clusters.map(k=>`
    <div class="li"><div class="ld" style="background:${C_CLUSTER[k%C_CLUSTER.length]}"></div>
    <span class="ll">K${k}</span></div>`).join("");
}

function updateMetrics() {
  const d = State.snap;
  if (!d.length) return;
  const n   = d.length;
  const ret = (d.reduce((a,x)=>a+(x.ret_252d||0),0)/n*100).toFixed(1);
  const vol = (d.reduce((a,x)=>a+(x.vol_252||0),0)/n*100).toFixed(1);
  const out = d.filter(x=>x.label==="outperform").length;
  const und = d.filter(x=>x.label==="underperform").length;
  setText("m-n",    n+"");
  setText("m-ret",  (ret>=0?"+":"")+ret+"%");
  setText("m-vol",  vol+"%");
  setText("m-out",  out+"");
  setText("m-und",  und+"");
  const retEl = document.getElementById("m-ret");
  if(retEl) retEl.style.color = +ret>=0?"var(--green)":"var(--red)";
}

function setText(id,v) {
  const el = document.getElementById(id); if(el) el.textContent=v;
}

// ── Resize: re-render all charts when window resizes ─────────────────────────
let _resizeTimer;
window.addEventListener("resize",()=>{
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(()=>{
    if(State.snap.length) { Charts.scatter(); Charts.mds(); Charts.parallel(); Charts.features(); }
    if(State.candleData)  Charts.candle();
    if(State.elbowData)   Charts.elbow();
    if(State.correlData)  Charts.heatmap();
  }, 120);
});
