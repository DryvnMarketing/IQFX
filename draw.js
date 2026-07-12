/* Dryvn IQFX — drawing tools overlay.
 * Trendlines, order-block boxes and text anchored to (time, price), rendered on
 * a canvas above the lightweight-chart and re-projected every frame so they
 * track pan/zoom. Persisted to localStorage.
 */
(function () {
  'use strict';
  const HOST = window.IQFXChart;
  if (!HOST) return;
  const { chart, candles, container } = HOST;

  const NEON = { blue: '#00c3ff', yellow: '#ffee00', red: '#ff2e2e', green: '#39ff14' };
  const LS_KEY = 'iqfx.drawings.v1';
  const LINE_W = 1.5;

  let drawings = [];
  try { drawings = JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { drawings = []; }
  const save = () => localStorage.setItem(LS_KEY, JSON.stringify(drawings));

  let tool = 'cursor';           // cursor | line | box | text | eraser
  let color = NEON.blue;
  let pending = null;            // in-progress drawing {type, p1, p2}

  // ── overlay canvas ──
  const wrap = document.createElement('div');
  wrap.className = 'draw-layer';
  const canvas = document.createElement('canvas');
  wrap.appendChild(canvas);
  container.style.position = 'relative';
  container.appendChild(wrap);
  const ctx = canvas.getContext('2d');

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = container.clientWidth * dpr;
    canvas.height = container.clientHeight * dpr;
    canvas.style.width = container.clientWidth + 'px';
    canvas.style.height = container.clientHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(sizeCanvas).observe(container);
  sizeCanvas();

  // ── toolbar ──
  const bar = document.createElement('div');
  bar.className = 'draw-toolbar';
  bar.innerHTML = `
    <button data-tool="cursor" class="dt-btn active" title="Pan / select">✥</button>
    <button data-tool="line"   class="dt-btn" title="Trendline">╱</button>
    <button data-tool="box"    class="dt-btn" title="Order block / box">▭</button>
    <button data-tool="text"   class="dt-btn" title="Text">T</button>
    <button data-tool="eraser" class="dt-btn" title="Eraser — click a drawing">⌫</button>
    <div class="dt-sep"></div>
    ${Object.entries(NEON).map(([n, c], i) =>
      `<button data-color="${c}" class="dt-color ${i === 0 ? 'active' : ''}" title="${n}" style="--c:${c}"></button>`).join('')}
    <div class="dt-sep"></div>
    <button data-act="clear" class="dt-btn" title="Clear all drawings">🗑</button>`;
  container.appendChild(bar);

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) {
      tool = b.dataset.tool;
      bar.querySelectorAll('.dt-btn[data-tool]').forEach((x) => x.classList.toggle('active', x === b));
      const drawing = tool !== 'cursor';
      wrap.style.pointerEvents = drawing ? 'auto' : 'none';
      wrap.style.cursor = tool === 'eraser' ? 'not-allowed' : drawing ? 'crosshair' : 'default';
      chart.applyOptions({ handleScroll: !drawing, handleScale: !drawing });
    } else if (b.dataset.color) {
      color = b.dataset.color;
      bar.querySelectorAll('.dt-color').forEach((x) => x.classList.toggle('active', x === b));
    } else if (b.dataset.act === 'clear') {
      if (drawings.length && confirm('Remove all drawings?')) { drawings = []; save(); }
    }
  });

  // ── coordinate mapping (time,price) ⇄ pixels, with extrapolation past data ──
  const BAR_SEC = 900;
  function lastBar() { const b = HOST.getBars(); return b[b.length - 1]; }
  function firstBar() { return HOST.getBars()[0]; }

  function xForTime(t) {
    const ts = chart.timeScale();
    const x = ts.timeToCoordinate(t);
    if (x != null) return x;
    const lb = lastBar(), fb = firstBar();
    if (!lb) return null;
    const spacing = ts.options().barSpacing;
    if (t > lb.time) {
      const xl = ts.timeToCoordinate(lb.time);
      return xl == null ? null : xl + ((t - lb.time) / BAR_SEC) * spacing;
    }
    const xf = ts.timeToCoordinate(fb.time);
    return xf == null ? null : xf - ((fb.time - t) / BAR_SEC) * spacing;
  }
  function timeForX(x) {
    const ts = chart.timeScale();
    const t = ts.coordinateToTime(x);
    if (t != null) return t;
    const lb = lastBar(), fb = firstBar();
    if (!lb) return null;
    const spacing = ts.options().barSpacing;
    const xl = ts.timeToCoordinate(lb.time);
    if (xl != null && x > xl) return lb.time + Math.round((x - xl) / spacing) * BAR_SEC;
    const xf = ts.timeToCoordinate(fb.time);
    if (xf != null && x < xf) return fb.time - Math.round((xf - x) / spacing) * BAR_SEC;
    return null;
  }
  const yForPrice = (p) => candles.priceToCoordinate(p);
  const priceForY = (y) => candles.coordinateToPrice(y);

  function evPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function anchor(e) {
    const { x, y } = evPoint(e);
    const time = timeForX(x), price = priceForY(y);
    return (time == null || price == null) ? null : { time, price };
  }

  // ── pointer handling ──
  wrap.addEventListener('pointerdown', (e) => {
    if (tool === 'cursor') return;
    const a = anchor(e);
    if (!a) return;
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);

    if (tool === 'eraser') { eraseAt(evPoint(e)); return; }
    if (tool === 'text') {
      const txt = prompt('Label text:');
      if (txt && txt.trim()) { drawings.push({ type: 'text', p1: a, text: txt.trim(), color }); save(); }
      return;
    }
    pending = { type: tool, p1: a, p2: a, color };
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!pending) return;
    const a = anchor(e);
    if (a) pending.p2 = a;
  });
  wrap.addEventListener('pointerup', () => {
    if (!pending) return;
    const dx = Math.abs(xForTime(pending.p1.time) - xForTime(pending.p2.time));
    const dy = Math.abs(yForPrice(pending.p1.price) - yForPrice(pending.p2.price));
    if (dx > 3 || dy > 3) { drawings.push(pending); save(); }
    pending = null;
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (drawings.length) { drawings.pop(); save(); }
    }
  });

  // ── eraser hit-testing ──
  function distToSeg(p, a, b) {
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    if (!l2) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
  }
  function eraseAt(pt) {
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      const a = { x: xForTime(d.p1.time), y: yForPrice(d.p1.price) };
      if (a.x == null || a.y == null) continue;
      if (d.type === 'line') {
        const b = { x: xForTime(d.p2.time), y: yForPrice(d.p2.price) };
        if (b.x != null && distToSeg(pt, a, b) < 8) { drawings.splice(i, 1); save(); return; }
      } else if (d.type === 'box') {
        const b = { x: xForTime(d.p2.time), y: yForPrice(d.p2.price) };
        if (b.x != null && pt.x >= Math.min(a.x, b.x) - 4 && pt.x <= Math.max(a.x, b.x) + 4 &&
            pt.y >= Math.min(a.y, b.y) - 4 && pt.y <= Math.max(a.y, b.y) + 4) { drawings.splice(i, 1); save(); return; }
      } else if (d.type === 'text') {
        ctx.font = '12px sans-serif';
        const w = ctx.measureText(d.text).width;
        if (pt.x >= a.x - 4 && pt.x <= a.x + w + 4 && pt.y >= a.y - 14 && pt.y <= a.y + 4) { drawings.splice(i, 1); save(); return; }
      }
    }
  }

  // ── render loop ──
  function drawOne(d) {
    const a = { x: xForTime(d.p1.time), y: yForPrice(d.p1.price) };
    if (a.x == null || a.y == null) return;
    ctx.strokeStyle = d.color; ctx.fillStyle = d.color; ctx.lineWidth = LINE_W;
    ctx.shadowColor = d.color; ctx.shadowBlur = 6;
    if (d.type === 'line') {
      const b = { x: xForTime(d.p2.time), y: yForPrice(d.p2.price) };
      if (b.x == null || b.y == null) return;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (d.type === 'box') {
      const b = { x: xForTime(d.p2.time), y: yForPrice(d.p2.price) };
      if (b.x == null || b.y == null) return;
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      ctx.globalAlpha = 0.14; ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1; ctx.strokeRect(x, y, w, h);
    } else if (d.type === 'text') {
      ctx.shadowBlur = 4;
      ctx.font = '600 12px -apple-system, "Segoe UI", sans-serif';
      ctx.fillText(d.text, a.x, a.y);
    }
    ctx.shadowBlur = 0;
  }
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const d of drawings) drawOne(d);
    if (pending) drawOne(pending);
  }
  // rAF for smoothness where available, interval as a backstop (rAF is paused
  // in background tabs and some embedded renderers), chart events for snap.
  (function loop() { render(); requestAnimationFrame(loop); })();
  setInterval(render, 300);
  chart.timeScale().subscribeVisibleTimeRangeChange(render);
  wrap.addEventListener('pointermove', render);
  wrap.addEventListener('pointerup', render);
})();
