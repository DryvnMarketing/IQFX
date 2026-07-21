/* Dryvn IQFX — app wiring.
 * Data: Binance PAXGUSDT (24/7 tokenized gold) for candles + WebSocket ticks,
 * continuously calibrated to true XAU/USD via /api/spot (Swissquote). All
 * displayed prices are basis-adjusted, i.e. real forex-gold terms.
 */
(function () {
  'use strict';
  const { P, biasReport, weeklyBias, analyzeDay, sessionInfo, ukParts, ukHm } = window.IQFX;

  const COLORS = { entry: '#3d8fe8', sl: '#ef5350', tp: '#26a68a', asia: '#b8811b', up: '#26a68a', down: '#ef5350' };
  const NEWS_COUNTRIES = ['USD'];
  const BLACKOUT_MIN = 15;

  const S = {
    sym: 'XAUUSD',        // active tab: 'XAUUSD' (full strategy) | 'US30' (context only)
    us30: null,
    basis: null,          // XAUUSD spot mid − PAXG last (EMA-smoothed)
    paxgLast: null,
    bars15: [],           // adjusted bars (sec timestamps)
    bars4h: [],
    rawLast15: null,
    bias: null, weekly: null, day: null,
    calendar: [], news: [],
    dayOpenPrice: null,
    prevPrice: null,
  };

  const $ = (id) => document.getElementById(id);
  const f1 = (n) => n == null ? '—' : Number(n).toFixed(1);
  const f2 = (n) => n == null ? '—' : Number(n).toFixed(2);

  // ── chart ──
  const chartEl = $('chart');
  const chart = LightweightCharts.createChart(chartEl, {
    layout: { background: { color: 'transparent' }, textColor: '#9aa7ba', fontSize: 11 },
    grid: { vertLines: { color: 'rgba(29,38,53,.55)' }, horzLines: { color: 'rgba(29,38,53,.55)' } },
    rightPriceScale: { borderColor: '#1d2635' },
    timeScale: { borderColor: '#1d2635', timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { priceFormatter: (p) => p.toFixed(1) },
  });
  const candles = chart.addCandlestickSeries({
    upColor: COLORS.up, downColor: COLORS.down, borderUpColor: COLORS.up, borderDownColor: COLORS.down,
    wickUpColor: COLORS.up, wickDownColor: COLORS.down, priceLineVisible: true,
  });
  const ema50Series = chart.addLineSeries({ color: 'rgba(61,143,232,.55)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  let levelLines = [];
  new ResizeObserver(() => chart.applyOptions({ width: chartEl.clientWidth, height: chartEl.clientHeight })).observe(chartEl);
  // expose for the drawing-tools overlay (draw.js)
  window.IQFXChart = { chart, candles, container: chartEl, getBars: () => S.bars15 };

  // KPI labels are gold-flavoured in the HTML ("ENTRY/TP1/TP2/STOP LOSS"). The
  // US30 tab repurposes the same tiles, so capture the gold defaults once and
  // swap them per symbol — a stale "ENTRY" label under US30 was exactly the
  // gold bleed to avoid.
  const _kpiDefaults = {}, _kpiFootDefaults = {};
  document.querySelectorAll('.kpi').forEach((k) => {
    _kpiDefaults[k.id] = k.querySelector('.kpi-label').innerHTML;
    const f = k.querySelector('.kpi-foot'); if (f) _kpiFootDefaults[k.id] = f.innerHTML;
  });
  function setKpiFoot(id, text) { const f = document.querySelector(`#${id} .kpi-foot`); if (f) f.textContent = text; }
  const _statAsiaDefault = document.querySelector('#stAsia')?.closest('.stat')?.querySelector('.stat-l')?.textContent;
  function setKpiLabels(map) {
    for (const [id, html] of Object.entries(map)) {
      const el = document.getElementById(id); if (el) el.querySelector('.kpi-label').innerHTML = html;
    }
  }
  function restoreGoldLabels() {
    const tp = document.getElementById('trackPanel'); if (tp) tp.hidden = false;
    setKpiLabels(_kpiDefaults);
    const sl = document.querySelector('#stAsia')?.closest('.stat')?.querySelector('.stat-l');
    if (sl && _statAsiaDefault) sl.textContent = _statAsiaDefault;
    const bt = document.getElementById('biasPanelTitle');
    if (bt) bt.textContent = '📊 Weekly Bias — XAUUSD';
    for (const [id, html] of Object.entries(_kpiFootDefaults)) {
      const f = document.querySelector(`#${id} .kpi-foot`); if (f) f.innerHTML = html;
    }
  }

  function setLevels(day) {
    levelLines.forEach((l) => candles.removePriceLine(l));
    levelLines = [];
    const add = (price, color, title, style = 0, width = 2) => {
      if (price == null) return;
      levelLines.push(candles.createPriceLine({ price, color, title, lineStyle: style, lineWidth: width, axisLabelVisible: true }));
    };
    if (day.asia) {
      add(day.asia.hi, COLORS.asia, 'ASIA HIGH', 2, 1);
      add(day.asia.lo, COLORS.asia, 'ASIA LOW', 2, 1);
    }
    const s = day.signal;
    if (s) {
      add(s.entry, COLORS.entry, `ENTRY ${s.setup} ${s.dir}`, 0, 2);
      add(s.tp1Done ? s.entry : s.sl, COLORS.sl, s.tp1Done ? 'SL → BE' : 'STOP LOSS', 1, 2);
      add(s.tp1, COLORS.tp, 'TP1 (+2R)', 3, 2);
      add(s.tp2, COLORS.tp, 'TP2', 3, 1);
      candles.setMarkers([{
        time: s.barTime, position: s.dir === 'LONG' ? 'belowBar' : 'aboveBar',
        color: s.dir === 'LONG' ? COLORS.tp : COLORS.sl,
        shape: s.dir === 'LONG' ? 'arrowUp' : 'arrowDown', text: `Setup ${s.setup}`,
      }]);
    } else {
      candles.setMarkers([]);
    }
  }

  // ── data ──
  async function jget(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.json();
  }
  const mapK = (k) => ({ time: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4] });

  async function calibrateBasis() {
    // Only calibrate while XAUUSD is actually trading — when the forex market is
    // closed the spot quote is frozen and would swallow legitimate PAXG movement.
    if (!sessionInfo(Date.now()).open && S.basis != null) return;
    if (!sessionInfo(Date.now()).open) {
      const saved = parseFloat(localStorage.getItem('iqfx.basis'));
      S.basis = Number.isFinite(saved) ? saved : 6;
      $('chartSrc').textContent = `market closed — PAXG proxy + last basis (${S.basis >= 0 ? '+' : ''}${f2(S.basis)})`;
      return;
    }
    try {
      const spot = await jget('/api/spot');
      const px = await jget('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT');
      const paxg = parseFloat(px.price);
      const b = spot.mid - paxg;
      S.basis = S.basis == null ? b : S.basis * 0.7 + b * 0.3;
      localStorage.setItem('iqfx.basis', String(S.basis));
      $('chartSrc').textContent = `live feed: PAXG ⇄ XAU/USD calibrated (basis ${S.basis >= 0 ? '+' : ''}${f2(S.basis)})`;
      $('footFeed').textContent = `spot ${f2(spot.mid)} · basis ${f2(S.basis)} · ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      if (S.basis == null) { S.basis = 6; $('chartSrc').textContent = 'live feed: PAXG proxy (spot calibration unavailable)'; }
    }
  }

  const adj = (b) => ({ time: b.time, open: b.open + S.basis, high: b.high + S.basis, low: b.low + S.basis, close: b.close + S.basis });
  // PAXG trades 24/7 but XAUUSD doesn't — drop UK-weekend bars so indicators,
  // sessions and the chart match the forex market the way the agent sees it.
  const isWeekendBar = (sec) => ['Sat', 'Sun'].includes(ukParts(sec * 1000).dow);

  async function loadBars() {
    const [k15, k4] = await Promise.all([
      jget('https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=15m&limit=600'),
      jget('https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=4h&limit=500'),
    ]);
    S.bars15 = k15.map(mapK).filter((b) => !isWeekendBar(b.time)).map(adj);
    S.bars4h = k4.map(mapK).filter((b) => !isWeekendBar(b.time)).map(adj);
    if (S.sym !== 'XAUUSD') return;   // don't clobber the US30 chart on the periodic refresh
    candles.setData(S.bars15);
    const closes = S.bars15.map((b) => b.close);
    const e = window.IQFX.ema(closes, 50);
    ema50Series.setData(S.bars15.map((b, i) => ({ time: b.time, value: e[i] })).filter((x) => x.value != null));
    chart.timeScale().scrollToRealTime();
  }

  // ── engine run ──
  function runEngine() {
    if (!S.bars15.length || !S.bars4h.length) return;
    S.bias = biasReport(S.bars4h);
    S.weekly = weeklyBias(S.bars4h);
    S.day = analyzeDay(S.bars15, S.bias, Date.now());
    renderBiasPanel(); renderCalendar();
    // Gold-only rendering — never paint gold signals/levels onto the US30 context view
    if (S.sym !== 'XAUUSD') return;
    renderKpis(); renderIdea(); renderTake(); renderStats(); renderTip();
    setLevels(S.day);
  }

  // ── renderers ──
  function renderKpis() {
    const d = S.day, b = S.bias;
    const biasEl = $('biasValue');
    if (!b.tradeable) {
      biasEl.textContent = 'SIT OUT'; biasEl.className = 'kpi-value sitout';
      $('biasConf').textContent = `only ${b.confidence}% alignment — below 60% threshold`;
    } else {
      biasEl.textContent = b.dir; biasEl.className = 'kpi-value ' + b.dir.toLowerCase();
      $('biasConf').textContent = `${b.confidence}% confidence · 4H timeframe`;
    }
    const s = d && d.signal;
    const set = (id, v, on) => { $(id).textContent = v; $(id).closest('.kpi').classList.toggle('active', !!on); };
    if (s) {
      set('entryValue', f1(s.entry), true);
      set('tp1Value', f1(s.tp1), true);
      set('tp2Value', f1(s.tp2), true);
      set('slValue', f1(s.tp1Done ? s.entry : s.sl), true);
      $('entryFoot').textContent = `Setup ${s.setup} ${s.dir} @ ${ukHm(s.barTime * 1000)} UK — ${stateText(d.signalState)}`;
      $('slFoot').textContent = s.tp1Done ? 'moved to breakeven ✔' : 'never widened';
    } else {
      set('entryValue', '—', false); set('tp1Value', '—', false); set('tp2Value', '—', false); set('slValue', '—', false);
      $('entryFoot').textContent = waitingText();
      $('slFoot').textContent = 'never widened';
    }
  }
  function stateText(st) {
    return { open: 'LIVE', 'closed-be': 'closed at breakeven', stopped: 'stopped out', tp2: 'TP2 hit ✔', 'flat-time': 'closed by flat rule' }[st] || st;
  }
  function waitingText() {
    const ses = sessionInfo(Date.now());
    if (!ses.open) return 'market closed';
    if (ses.phase === 'ASIA') return 'building Asian range — levels arm at 08:00 UK';
    if (ses.phase === 'LONDON') return 'hunting Setup A — sweep & reclaim';
    if (ses.phase === 'LUNCH') return 'between windows — no entries';
    if (ses.phase === 'NEW YORK') return 'hunting Setup B — momentum pullback';
    return 'trading windows closed for today';
  }

  function renderBiasPanel() {
    const w = S.weekly;
    $('biasBuyBar').style.width = w.buy + '%';
    $('biasSellBar').style.width = w.sell + '%';
    $('biasBuyPct').textContent = w.buy >= 12 ? `${w.buy}% BUY` : '';
    $('biasSellPct').textContent = w.sell >= 12 ? `${w.sell}% SELL` : '';
    const b = S.bias;
    // Surface the divergence rather than hiding it. The votes are a useful read
    // of the wider picture, but only the agent's EMA50+MACD rule is validated,
    // and only it may license a trade. When they disagree, say so plainly —
    // otherwise the page looks like the agent should have fired when it shouldn't.
    const banner = b.mixed
      ? `<div class="bias-note bias-mixed">⚖️ <b>Agent bias: MIXED — standing aside.</b><br>${b.agentDetail || ''}
         ${b.voteDisagrees ? `<br><span class="muted">The ${b.voteShort >= 4 ? b.voteShort : b.voteLong}/5 vote read says ${b.voteDir}, but the validated rule needs price-vs-EMA50 and MACD to agree. Votes are context; only the agent's rule trades.</span>` : ''}</div>`
      : `<div class="bias-note bias-ok">✅ <b>Agent bias: ${b.long ? 'LONG' : 'SHORT'}</b> — setups armed.<br><span class="muted">${b.agentDetail || ''}</span></div>`;
    $('biasVotes').innerHTML = banner + b.votes.map((v) =>
      `<div class="vote"><span>${v.name}</span><i class="${v.long ? 'v-long' : 'v-short'}">${v.long ? 'LONG' : 'SHORT'}</i></div>`
    ).join('') + `<div class="bias-foot muted">Vote tally ${b.voteLong}L/${b.voteShort}S is context only — it does not gate signals.</div>`;
  }

  function calAnalysis(ev) {
    const t = ev.title.toLowerCase();
    if (/fomc|fed funds|rate decision/.test(t)) return 'Highest-volatility event for gold. Flat into it, no exceptions. Trade the post-statement structure only after a 15m candle closes.';
    if (/cpi|inflation/.test(t)) return 'Hot print → yields up → gold down (usually). Expect 1–2x ATR spike at 13:30 UK. Blackout ±15 min, then trade the re-formed structure.';
    if (/nonfarm|non-farm|payroll/.test(t)) return 'NFP whipsaws both directions before picking one. Never hold through it. The 14:30–15:30 UK move after NFP is often the cleanest of the month.';
    if (/unemployment claims/.test(t)) return 'Moderate mover. Blackout applies; usually tradeable 15 min after.';
    if (/gdp/.test(t)) return 'Growth surprise moves the dollar first, gold second. Respect the blackout.';
    if (/pmi|ism/.test(t)) return 'Sentiment data — sharp first reaction that often fades. Wait for the retrace before joining.';
    if (/ppi/.test(t)) return 'Inflation pipeline data — same playbook as CPI at reduced intensity.';
    if (/minutes/.test(t)) return 'FOMC Minutes at 19:00 UK — outside trading windows, but if holding a runner, flatten before it.';
    if (/powell|speaks|testimony/.test(t)) return 'Unscripted Fed speech risk — headlines can hit at any moment during it.';
    return 'Red-folder event — entries blocked ±15 min. Let the market show its hand first.';
  }

  function renderCalendar() {
    const now = Date.now();
    const todayUk = ukParts(now).date;
    const todays = S.calendar.filter((e) => NEWS_COUNTRIES.includes(e.country) && ['High'].includes(e.impact) && ukParts(e.ts).date === todayUk);
    const box = $('calendarList');
    $('newsBadge').textContent = `${todays.length} red`;
    if (!todays.length) {
      box.innerHTML = '<div class="muted">No high-impact USD events today — clean session. 🎯</div>';
      return;
    }
    box.innerHTML = todays.map((e) => {
      const dt = e.ts - now;
      const imminent = dt > 0 && dt < BLACKOUT_MIN * 60000;
      const done = dt < -BLACKOUT_MIN * 60000;
      const inWin = Math.abs(dt) <= BLACKOUT_MIN * 60000;
      return `<div class="cal-item hi ${done ? 'done' : ''} ${imminent || inWin ? 'imminent' : ''}">
        <div class="cal-time">${ukHm(e.ts)} UK ${inWin ? '· ⛔ BLACKOUT ACTIVE' : imminent ? '· ⚠ approaching' : done ? '· passed' : ''}</div>
        <div class="cal-title">${e.title}</div>
        <div class="cal-meta">forecast ${e.forecast || 'n/a'} · previous ${e.previous || 'n/a'}</div>
        <div class="cal-analysis">${calAnalysis(e)}</div>
      </div>`;
    }).join('');
  }

  function renderNews() {
    const box = $('newsList');
    if (!S.news.length) { box.innerHTML = '<div class="muted">No headlines loaded.</div>'; return; }
    box.innerHTML = S.news.slice(0, 14).map((n) => `
      <div class="news-item ${n.hot ? 'hot' : ''}">
        <span class="news-src">${n.source}</span><a href="${n.link}" target="_blank" rel="noopener">${n.hot ? '🔥 ' : ''}${n.title}</a>
        <span class="news-time">${n.ts ? ukHm(n.ts) : ''}</span>
      </div>`).join('');
  }

  // ── TRADE IDEA: continuous mentor read 07:00-17:00 UK, honestly graded ──
  // A = validated setup fired · B = forming (not yet an edge) · C = no validated edge.
  // Risk is the user's; never imply B/C carry the measured +0.168R edge.
  function buildIdea() {
    const uk = ukParts(Date.now()), ses = sessionInfo(Date.now());
    const d = S.day, b = S.bias;
    const price = S.paxgLast ?? (S.bars15.length ? S.bars15[S.bars15.length - 1].close : null);
    const mk = (grade, dir, headline, body, edge) => ({ grade, dir, headline, body, edge });
    if (!d || !b) return mk('C', null, 'Analyzing…', '', '');

    if (d.signal) {
      const s = d.signal;
      return mk('A', s.dir, `LIVE ${s.dir} — Setup ${s.setup}`,
        `Entry <b>${f1(s.entry)}</b> · SL <b>${f1(s.tp1Done ? s.entry : s.sl)}</b> · TP1 <b>${f1(s.tp1)}</b> · TP2 <b>${f1(s.tp2)}</b>\nStatus: ${stateText(d.signalState)}`,
        'VALIDATED setup — +0.168R/trade, 50% win, PF 1.42 across 2 years. The agent takes this one.');
    }
    if (!ses.open) return mk('C', null, 'Market closed', ses.next, 'No read until the session opens.');
    if (uk.min < 420 || uk.min >= 1020) return mk('C', null, 'Outside the 07:00–17:00 UK read window',
      'Windows: London 08:00–11:30 · NY 13:15–17:00 UK.', 'No new entries — review, don\'t trade.');

    const dir = b.long ? 'LONG' : b.short ? 'SHORT' : null;
    if (!dir || !b.tradeable) return mk('C', null, 'STAND ASIDE — 4H bias mixed',
      `${b.agentDetail || ''}\nThe validated rule needs price-vs-EMA50 <b>and</b> MACD to agree; they don't.`
      + (b.voteDisagrees ? `\n<b>Note:</b> the 5-check tally reads ${b.voteDir} ${Math.max(b.voteLong, b.voteShort)}/5, but that tally is context only — it was never the validated filter.` : '')
      + `\n15m 50 EMA <b>${f1(d.ema50)}</b> · ATR <b>${f1(d.atr)}</b> · RSI <b>${f1(d.rsi)}</b>`,
      'Mixed bias is the system\'s single biggest filter — the agent is standing aside, and so should the page.');

    const a = d.asia;
    if (uk.min < 480) return mk('C', dir, `PREPARING — bias ${dir}, London opens 08:00 UK`,
      a ? `Asian range <b>${f1(a.lo)} – ${f1(a.hi)}</b> (${f1(a.range)} pts)${!a.ok ? ' — TOO SMALL, Setup A off' : ''}\nWatch: ${dir === 'SHORT' ? `a sweep ABOVE <b>${f1(a.hi)}</b> that fails` : `a sweep BELOW <b>${f1(a.lo)}</b> that reclaims`}` : 'Asian range still forming.',
      'Preparation only — no trade before the London window.');

    if (uk.min < 690 && a && a.ok) {
      if (dir === 'SHORT' && d.sweep.hi) {
        const sl = price + Math.max(2.5, 0.75 * d.atr), risk = sl - price;
        return mk('B', 'SHORT', 'SETUP A FORMING — liquidity taken above',
          `Asian high <b>${f1(a.hi)}</b> was swept. Need a 15m candle to CLOSE back inside.\nIF it closes below <b>${f1(a.hi)}</b> (above ~${f1(a.hi - a.range / 3)}):\n➡️ SHORT ~<b>${f1(price)}</b> · 🛑 SL <b>${f1(sl)}</b> · 🎯 TP1 <b>${f1(price - 2 * risk)}</b> · TP2 <b>${f1(a.lo)}</b>`,
          'Becomes the validated setup ONLY when that candle closes. Not an edge yet.');
      }
      if (dir === 'LONG' && d.sweep.lo) {
        const sl = price - Math.max(2.5, 0.75 * d.atr), risk = price - sl;
        return mk('B', 'LONG', 'SETUP A FORMING — liquidity taken below',
          `Asian low <b>${f1(a.lo)}</b> was swept. Need a 15m candle to CLOSE back inside.\nIF it closes above <b>${f1(a.lo)}</b> (below ~${f1(a.lo + a.range / 3)}):\n➡️ LONG ~<b>${f1(price)}</b> · 🛑 SL <b>${f1(sl)}</b> · 🎯 TP1 <b>${f1(price + 2 * risk)}</b> · TP2 <b>${f1(a.hi)}</b>`,
          'Becomes the validated setup ONLY when that candle closes. Not an edge yet.');
      }
      return mk('C', dir, `WAITING — London, bias ${dir}, no sweep yet`,
        `Asian range <b>${f1(a.lo)} – ${f1(a.hi)}</b> · price <b>${f1(price)}</b>\nTrigger: ${dir === 'SHORT' ? `sweep ABOVE <b>${f1(a.hi)}</b> then close back inside` : `sweep BELOW <b>${f1(a.lo)}</b> then close back inside`}`,
        'No liquidity grab = no Setup A. Chasing here is how the edge gets given back.');
    }
    if (uk.min < 795) return mk('C', dir, 'STAND ASIDE — lunch chop (11:30–13:15 UK)',
      `Bias <b>${dir}</b>. NY opens 13:15 UK.\n15m 50 EMA <b>${f1(d.ema50)}</b> · ATR <b>${f1(d.atr)}</b> · RSI <b>${f1(d.rsi)}</b>`,
      'Dead zone — the validated system takes nothing here.');

    const gap = price - d.ema50, near = Math.abs(gap) <= 1.2 * d.atr;
    const sl = dir === 'SHORT' ? price + Math.max(2.5, 0.75 * d.atr) : price - Math.max(2.5, 0.75 * d.atr);
    const risk = Math.abs(sl - price);
    return mk(near ? 'B' : 'C', dir, near ? 'SETUP B FORMING — at the 50 EMA' : 'WAITING — NY, price away from the 50 EMA',
      `Price <b>${f1(price)}</b> is <b>${f1(Math.abs(gap))}</b> pts ${gap > 0 ? 'above' : 'below'} the 15m 50 EMA (<b>${f1(d.ema50)}</b>) · RSI <b>${f1(d.rsi)}</b>\n`
      + `Trigger: pull back ${dir === 'SHORT' ? 'UP' : 'DOWN'} to ~<b>${f1(d.ema50)}</b>, then a ${dir === 'SHORT' ? 'bearish candle CLOSES below' : 'bullish candle HOLDS above'} it with RSI 40–60.\n`
      + `IF it fires: ➡️ ${dir} ~<b>${f1(d.ema50)}</b> · 🛑 SL ~<b>${f1(sl)}</b> · 🎯 TP1 ~<b>${f1(dir === 'SHORT' ? price - 2 * risk : price + 2 * risk)}</b>`,
      near ? 'Close to the trigger — still needs the confirming close.' : 'Not a trade until price returns to the EMA and confirms.');
  }

  function renderIdea() {
    const idea = buildIdea();
    if (!idea) return;
    const g = $('ideaGrade');
    g.textContent = idea.grade === 'A' ? 'A · VALIDATED' : idea.grade === 'B' ? 'B · FORMING' : 'C · NO EDGE';
    g.className = 'idea-grade ' + idea.grade.toLowerCase();
    const h = $('ideaHeadline');
    h.textContent = idea.headline;
    h.className = 'idea-headline' + (idea.grade === 'A' && idea.dir ? ' ' + idea.dir.toLowerCase() : '');
    $('ideaBody').innerHTML = idea.body;
    $('ideaEdge').textContent = idea.edge ? '📌 ' + idea.edge : '';
  }

  function renderTake() {
    const b = S.bias, d = S.day, ses = sessionInfo(Date.now());
    const v = $('takeVerdict'), body = $('takeBody');
    const paras = [];

    if (ses.phase === 'WEEKEND') {
      v.textContent = '🌙 Weekend — markets closed'; v.className = 'take-verdict';
      paras.push(`<p>Chart shows the 24/7 gold proxy so you can watch weekend drift. ${ses.next}.</p>`);
      paras.push(`<p>Current weekly pressure: <b>${S.weekly.buy}% buy / ${S.weekly.sell}% sell</b>. Re-assess Sunday night before the open.</p>`);
    } else if (!b.tradeable) {
      v.textContent = '⏸ SIT OUT — wait for tomorrow'; v.className = 'take-verdict sitout';
      paras.push(`<p>Only <b>${b.confidence}%</b> of the 4H checks agree (threshold 60%). When the timeframes argue, the market is ranging or repricing — the edge isn't there. <b>No trade is a position.</b></p>`);
      paras.push(`<p>What would change my mind: ${b.votes.filter((x) => x.long !== (b.dir === 'LONG')).map((x) => x.name).join(', ')} flipping into alignment.</p>`);
    } else {
      v.textContent = (b.dir === 'LONG' ? '🟢 Trade LONGS only today' : '🔴 Trade SHORTS only today');
      v.className = 'take-verdict ' + b.dir.toLowerCase();
      paras.push(`<p>4H bias is <b>${b.dir}</b> at <b>${b.confidence}%</b> confidence. Take only ${b.dir === 'LONG' ? 'long' : 'short'} setups; skip counter-trend signals no matter how tempting.</p>`);
      if (d.asia) {
        paras.push(`<p>Asian range: <b>${f1(d.asia.lo)} – ${f1(d.asia.hi)}</b> (${f1(d.asia.range)} wide). ${d.asia.ok
          ? (b.dir === 'LONG' ? `Watch for a sweep <b>below ${f1(d.asia.lo)}</b> that closes back inside — that's the Setup A long.` : `Watch for a sweep <b>above ${f1(d.asia.hi)}</b> that fails — that's the Setup A short.`)
          : 'Range is too narrow (<15) — <b>Setup A is OFF today</b>; NY pullback only.'}</p>`);
      } else if (ses.phase === 'ASIA') {
        paras.push('<p>Asian range still forming — levels arm at 08:00 UK.</p>');
      }
      if (d.signal) {
        const s = d.signal;
        paras.push(`<p><b>Setup ${s.setup} ${s.dir} fired at ${ukHm(s.barTime * 1000)} UK</b> — status: <b>${stateText(d.signalState)}</b>. Risk exactly 1%; TP1 pays 2R, then the stop goes to breakeven and the trade can't hurt you.</p>`);
      }
      paras.push(`<p>Windows: London <b>08:00–11:30</b>, NY <b>13:15–17:00</b> UK. Flat by <b>20:45 UK</b>. Max 2 trades; two losses = done for the day.</p>`);
    }
    body.innerHTML = paras.join('');
  }

  function renderStats() {
    const d = S.day, ses = sessionInfo(Date.now());
    $('stSession').textContent = ses.phase;
    $('stAsia').textContent = d.asia ? `${f1(d.asia.lo)}–${f1(d.asia.hi)}` : '—';
    $('stAtr').textContent = d.atr ? `${f1(d.atr)} pts` : '—';
    $('stRsi').textContent = d.rsi ? f1(d.rsi) : '—';
    $('stDay').textContent = (d.dayHi && d.dayLo) ? `${f1(d.dayHi - d.dayLo)} pts` : '—';
    $('stNext').textContent = ses.next;
    $('sessionPhase').textContent = `${ses.phase} · ${ukHm(Date.now())} UK`;
    const pill = $('marketPill');
    pill.className = 'pill ' + (ses.open ? 'open' : 'closed');
    $('marketText').textContent = ses.open ? 'MARKET OPEN' : 'MARKET CLOSED';
  }

  const TIPS = {
    ASIA: 'Never trade the Asian session. Your only job right now: note where the range high and low form — that is where London will hunt liquidity.',
    LONDON: 'The London open loves a fake-out: the first push beyond the Asian range is usually the trap, the close back inside is the trade. Patience beats prediction.',
    LUNCH: 'The 11:30–13:15 UK lunch chop has ended more good weeks than bad entries. The market is deciding — let it.',
    'NEW YORK': 'In NY, trade WITH London\'s direction, not against it. The pullback to the 15m EMA50 that holds is your entry; the one that slices through is your warning.',
    'LATE NY': 'Past 17:00 UK the edge decays fast. Manage what you hold; open nothing new. 20:45 UK = flat, always.',
    'CLOSED-ISH': 'The best traders finish their day reviewing, not trading. What did today\'s levels teach you about tomorrow\'s?',
    WEEKEND: 'Weekend homework: mark last week\'s high/low, the untested levels, and Friday\'s close. Monday\'s Asian range will tell you who\'s in control.',
  };
  function renderTip() { $('tipBox').textContent = TIPS[sessionInfo(Date.now()).phase] || TIPS.WEEKEND; }

  // ── live ticks ──
  let lastWsMsg = 0;

  function showPrice(price) {
    S.prevPrice = S.paxgLast;
    S.paxgLast = price;
    if (S.sym !== 'XAUUSD') return;   // US30 tab owns the ticker while active
    const el = $('tickerPrice');
    el.textContent = price.toFixed(2);
    el.classList.remove('tick-up', 'tick-down');
    if (S.prevPrice != null && price !== S.prevPrice) {
      el.classList.add(price >= S.prevPrice ? 'tick-up' : 'tick-down');
      setTimeout(() => el.classList.remove('tick-up', 'tick-down'), 350);
    }
    if (S.dayOpenPrice != null) {
      const ch = price - S.dayOpenPrice;
      const dEl = $('tickerChange');
      dEl.textContent = `${ch >= 0 ? '+' : ''}${ch.toFixed(2)} (${(ch / S.dayOpenPrice * 100).toFixed(2)}%)`;
      dEl.className = 'delta ' + (ch >= 0 ? 'up' : 'down');
    }
  }

  function applyKline(k) {
    const barSec = k.t / 1000;
    if (isWeekendBar(barSec)) return; // market closed — never append weekend bars
    const bar = { time: barSec, open: +k.o + S.basis, high: +k.h + S.basis, low: +k.l + S.basis, close: +k.c + S.basis };
    const last = S.bars15[S.bars15.length - 1];
    const onGold = S.sym === 'XAUUSD';   // only touch the chart when the gold tab is showing
    if (last && barSec === last.time) { S.bars15[S.bars15.length - 1] = bar; if (onGold) candles.update(bar); }
    else if (!last || barSec > last.time) { S.bars15.push(bar); if (onGold) candles.update(bar); }
    if (k.x) runEngine(); // bar just closed — re-evaluate signals
  }

  function connectWs() {
    const ws = new WebSocket('wss://stream.binance.com:9443/stream?streams=paxgusdt@kline_15m/paxgusdt@bookTicker/paxgusdt@aggTrade');
    ws.onmessage = (ev) => {
      lastWsMsg = Date.now();
      const { stream, data } = JSON.parse(ev.data);
      if (stream.endsWith('@kline_15m')) applyKline(data.k);
      else if (stream.endsWith('@bookTicker')) showPrice((parseFloat(data.b) + parseFloat(data.a)) / 2 + (S.basis ?? 6));
      else if (stream.endsWith('@aggTrade')) showPrice(parseFloat(data.p) + (S.basis ?? 6));
    };
    ws.onclose = () => setTimeout(connectWs, 3000);
    ws.onerror = () => ws.close();
  }

  // REST fallback so the ticker never freezes when PAXG goes quiet
  setInterval(async () => {
    if (Date.now() - lastWsMsg < 15_000) return;
    try {
      const px = await jget('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT');
      showPrice(parseFloat(px.price) + (S.basis ?? 6));
    } catch (e) { /* transient */ }
  }, 12_000);

  // ── track record: replay the rules over ~30 days of history ──
  function fmtDur(min) {
    if (min == null) return '—';
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  }
  async function loadTrackRecord() {
    try {
      let raw = [];
      let endTime;
      for (let i = 0; i < 3; i++) {
        const url = 'https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=15m&limit=1000' + (endTime ? `&endTime=${endTime}` : '');
        const k = await jget(url);
        if (!k.length) break;
        raw = k.concat(raw);
        endTime = k[0][0] - 1;
      }
      const hist15 = raw.map(mapK).filter((b) => !isWeekendBar(b.time)).map(adj);
      const k4 = await jget('https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=4h&limit=1000');
      const hist4h = k4.map(mapK).filter((b) => !isWeekendBar(b.time)).map(adj);
      const bt = window.IQFX.backtest(hist15, hist4h);
      renderTrack(bt);
    } catch (e) {
      $('trackBadge').textContent = 'unavailable';
      $('trackBody').innerHTML = '<div class="muted">Could not load history for the replay.</div>';
    }
  }
  function renderTrack(bt) {
    $('trackBadge').textContent = `${bt.days} trading days`;
    const col = (label, a) => `
      <div class="tr-col">
        <div class="tr-head">${label}</div>
        <div class="tr-row"><span>Signals</span><b>${a.signals}</b></div>
        <div class="tr-row"><span>TP1 hit</span><b class="tr-good">${a.tp1}${a.tp1Pct != null ? ` (${a.tp1Pct}%)` : ''}</b></div>
        <div class="tr-row"><span>TP2 hit</span><b class="tr-good">${a.tp2}</b></div>
        <div class="tr-row"><span>Stopped</span><b class="tr-bad">${a.sl}</b></div>
        <div class="tr-row"><span>Breakeven</span><b>${a.be}</b></div>
        <div class="tr-row"><span>⌀ → TP1</span><b>${fmtDur(a.avgToTp1)}</b></div>
        <div class="tr-row"><span>⌀ → TP2</span><b>${fmtDur(a.avgToTp2)}</b></div>
        <div class="tr-row tr-net"><span>Net result</span><b class="${a.netR >= 0 ? 'tr-good' : 'tr-bad'}">${a.netR >= 0 ? '+' : ''}${a.netR.toFixed(1)}R</b></div>
      </div>`;
    const recent = bt.trades.slice(-4).reverse().map((t) => {
      const icon = { tp2: '🟢', 'closed-be': '🟡', stopped: '🔴', 'flat-time': '⏰', open: '▶' }[t.state] || '·';
      return `<div class="tr-trade">${icon} ${t.date.slice(5)} · ${t.setup} ${t.dir} → ${t.state === 'tp2' ? 'TP2' : t.state === 'closed-be' ? 'BE (TP1 banked)' : t.state === 'stopped' ? 'SL' : t.state}${t.netR != null ? ` (${t.netR >= 0 ? '+' : ''}${t.netR.toFixed(1)}R)` : ''}</div>`;
    }).join('');
    $('trackBody').innerHTML = `
      <div class="tr-grid">${col('UK · Setup A', bt.uk)}${col('NY · Setup B', bt.ny)}</div>
      <div class="tr-trades">${recent || '<div class="muted">No signals in the window.</div>'}</div>
      <div class="tr-note">Rule replay on the calibrated feed — first signal/day, no spread/slippage. Validation, not a promise.</div>`;
  }

  // ── symbol tabs: XAUUSD (full strategy) ⇄ US30 (context only) ──
  document.querySelectorAll('.sym-tab').forEach((b) => b.addEventListener('click', () => {
    if (S.sym === b.dataset.sym) return;
    document.querySelectorAll('.sym-tab').forEach((x) => x.classList.toggle('active', x === b));
    S.sym = b.dataset.sym;
    switchSymbol();
  }));

  // Tabs that replace the chart with a data panel. Each has a view div, a title,
  // and a loader. Treated uniformly so adding one can't half-wire the guards.
  const PANELS = {
    HOMEWORK: { view: 'homeworkView', title: 'WEEKEND HOMEWORK <span>·</span> XAU/USD <span>·</span> week in review', load: () => loadHomework() },
    SUNDAY:   { view: 'sundayView',   title: 'SUNDAY BRIEF <span>·</span> XAU/USD <span>·</span> fundamentals',       load: () => loadSunday() },
    GKO:      { view: 'gkoView',      title: 'GKO FOLLOWER <span>·</span> forward-test scoreboard',                   load: () => loadGko() },
    HEALTH:   { view: 'healthView',   title: 'AGENT HEALTH <span>·</span> last published snapshot',                   load: () => loadHealth() },
  };

  async function switchSymbol() {
    const gold = S.sym === 'XAUUSD';
    const panel = PANELS[S.sym] || null;
    $('ctxBanner').hidden = gold || !!panel;
    $('chartLegend').style.display = gold ? '' : 'none';
    $('chart').hidden = !!panel;
    document.querySelector('.stats-strip').hidden = !!panel;
    for (const p of Object.values(PANELS)) $(p.view).hidden = true;
    $('chartTitle').innerHTML = gold
      ? 'GOLD SPOT <span>·</span> XAU/USD <span>·</span> 15M'
      : panel ? panel.title
      : 'US30 <span>·</span> DOW JONES <span>·</span> 15M <span>·</span> context';
    if (gold) {
      restoreGoldLabels();
      candles.setData(S.bars15);
      const e = window.IQFX.ema(S.bars15.map((b) => b.close), 50);
      ema50Series.setData(S.bars15.map((b, i) => ({ time: b.time, value: e[i] })).filter((x) => x.value != null));
      document.querySelector('.ticker-label').textContent = 'XAU/USD';
      runEngine();
    } else if (panel) {
      neutralizeForHomework();   // clear gold panels FIRST — must not survive a fetch failure
      $(panel.view).hidden = false;
      await panel.load();
      return;                    // no chart on these tabs
    } else {
      neutralizeForUs30();
      await loadUs30();
    }
    chart.timeScale().scrollToRealTime();
  }

  // ── shared helpers for the data panels ──
  const F1 = (n) => Number(n).toFixed(1);
  const SGN = (n) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}`;
  function ageStr(iso) {
    const m = (Date.now() - Date.parse(iso)) / 60000;
    if (!isFinite(m)) return 'unknown';
    if (m < 60) return `${Math.round(m)} min ago`;
    if (m < 48 * 60) return `${(m / 60).toFixed(1)} h ago`;
    return `${Math.round(m / 1440)} days ago`;
  }
  async function getJson(name, box, whatIsIt) {
    $(box).innerHTML = '<div class="muted">Loading…</div>';
    try {
      const r = await fetch(`/data/${name}?t=${Date.now()}`);
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } catch (e) {
      $(box).innerHTML = `<div class="hw-empty"><h3>Nothing published yet</h3>
        <p>${whatIsIt}</p>
        <p class="muted">The dashboard is static — it can't reach the laptop. It shows the last snapshot the agents pushed.</p></div>`;
      return null;
    }
  }

  // ── 🌍 Sunday fundamental brief ──
  async function loadSunday() {
    const b = await getJson('sunday-brief.json', 'sundayView', 'The agent publishes this every Sunday at 20:30 SA, before the 23:00 UK open.');
    if (!b) return;
    const w = b.week, g = b.gap;
    const stale = (Date.now() - Date.parse(b.generatedAt)) / 86400000 > 7
      ? `<div class="hw-stale">⚠️ This brief is from ${b.today} — the agent hasn't published since.</div>` : '';
    const heads = (b.headlines || []);
    const hot = heads.filter((h) => h.hot).slice(0, 6), rest = heads.filter((h) => !h.hot).slice(0, 8);
    const ev = (b.calendar && b.calendar.events) || [];
    const evRows = ev.slice(0, 14).map((e) => {
      const d = new Date(e.ms);
      const uk = d.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
      const sa = d.toLocaleTimeString('en-GB', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit' });
      const day = d.toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'short' });
      const m = +uk.slice(0, 2) * 60 + +uk.slice(3);
      const clash = (m >= 465 && m < 690) ? '<b class="hw-clash">SETUP A</b>'
        : (m >= 780 && m < 1020) ? '<b class="hw-clash">SETUP B</b>' : '';
      return `<tr><td>${day} ${uk}</td><td class="muted">${sa} SA</td><td>${e.country}</td>
        <td>${e.title}</td><td>${e.impact === 'High' ? '<b class="hw-hi">HIGH</b>' : 'med'} ${clash}</td></tr>`;
    }).join('');
    $('sundayView').innerHTML = `${stale}
      <div class="hw-head"><h2>Sunday brief — ${b.today}</h2>
        <div class="hw-verdict ${w.net >= 0 ? 'up' : 'down'}">${w.net >= 0 ? '📈' : '📉'} ${SGN(w.net)} pts last week</div></div>
      <div class="hw-warnbox">GRADE C — balance of risks, not a signal. No weekly directional edge is validated in this system.</div>
      <div class="hw-grid">
        <div class="hw-stat hw-hi"><span>PROJECTED OPEN</span><b>${g ? F1(g.projected) : '—'}</b></div>
        <div class="hw-stat"><span>WEEKEND GAP</span><b>${g ? SGN(g.pts) + ' pts' : '—'}</b></div>
        <div class="hw-stat"><span>FRI CLOSE</span><b>${g ? F1(g.friClose) : F1(w.close)}</b></div>
        <div class="hw-stat"><span>WEEK RANGE</span><b>${F1(w.range)} pts</b></div>
        <div class="hw-stat"><span>DAILY 20 EMA</span><b>${F1(b.emas.d20)}</b></div>
        <div class="hw-stat"><span>DAILY 50 EMA</span><b>${F1(b.emas.d50)}</b></div>
      </div>
      <p class="hw-note">Last week ${w.monday} → ${w.friday}: ${F1(w.open)} → ${F1(w.close)}, range ${F1(w.low)}–${F1(w.high)}.
        Structure: <b>${b.structure}</b>.</p>
      <h3>What moved it</h3>
      ${hot.length ? `<ul class="hw-cal">${hot.map((h) => `<li>🔥 ${h.title} <span class="muted">${h.src}</span></li>`).join('')}</ul>` : ''}
      ${rest.length ? `<ul class="hw-cal">${rest.map((h) => `<li>${h.title} <span class="muted">${h.src}</span></li>`).join('')}</ul>` : '<p class="muted">No headlines captured.</p>'}
      <p class="hw-note">Read these as two competing channels: <b>safe-haven demand</b> pushes gold up; <b>inflation → hawkish Fed → higher real rates</b> pushes it down. Whichever the tape obeyed is the one in control.</p>
      <h3>The week ahead</h3>
      ${b.calendar && b.calendar.partial ? `<div class="hw-warn">⚠️ Calendar feed was incomplete: ${b.calendar.partial}</div>` : ''}
      ${ev.length ? `<div class="hw-scroll"><table class="hw-table">${evRows}</table></div>` : '<p class="muted">No forward-dated events.</p>'}
      <p class="muted hw-foot">Published ${new Date(b.generatedAt).toLocaleString()} · ${ageStr(b.generatedAt)}</p>`;
  }

  // ── Weekend Homework: the weekly review the agent publishes every Saturday ──
  async function loadHomework() {
    const box = $('homeworkView');
    box.innerHTML = '<div class="muted">Loading the weekly review…</div>';
    let j;
    try {
      const res = await fetch(`/data/weekly-brief.json?t=${Date.now()}`);
      if (!res.ok) throw new Error(String(res.status));
      j = await res.json();
    } catch (e) {
      box.innerHTML = `<div class="hw-empty"><h3>No weekly review published yet</h3>
        <p>The agent writes this every <b>Saturday at 09:00</b> from the week that just closed. If it's mid-week, you're seeing the gap before the next one — that's expected.</p>
        <p class="muted">If it's Saturday afternoon and this is still empty, the agent didn't run: check that the laptop was awake and that <code>XAU Weekly Brief</code> fired.</p></div>`;
      return;
    }
    renderHomework(j);
    $('chartSrc').textContent = `weekly review · published ${new Date(j.generatedAt).toLocaleString()}`;
  }

  function renderHomework(r) {
    const w = r.week;
    const f1 = (n) => Number(n).toFixed(1);
    const sgn = (n) => `${n >= 0 ? '+' : ''}${f1(n)}`;
    const ageDays = (Date.now() - Date.parse(r.generatedAt)) / 86400000;
    const stale = ageDays > 8
      ? `<div class="hw-stale">⚠️ This review is ${Math.floor(ageDays)} days old — it covers the week of ${r.weekOf.monday}, not the current one. The agent has not published since.</div>`
      : '';

    const dayRows = r.days.map((d) => d.traded
      ? `<tr><td>${d.dow}</td><td>${f1(d.low)}–${f1(d.high)}</td><td>${f1(d.range)}</td>
         <td class="${d.net >= 0 ? 'up' : 'down'}">${sgn(d.net)}</td></tr>`
      : `<tr class="muted"><td>${d.dow}</td><td colspan="3">no data</td></tr>`).join('');

    const lvlRow = (l, dir) => `<tr><td class="hw-arrow ${dir}">${dir === 'up' ? '▲' : '▼'}</td>
      <td class="hw-px">${f1(l.price)}</td><td>${f1(l.dist)} pts away</td>
      <td class="muted">left ${l.dow} ${l.date.slice(8)}/${l.date.slice(5, 7)}${l.thisWeek ? '' : ' · earlier week'}</td></tr>`;
    const above = r.untested.above.length
      ? r.untested.above.map((l) => lvlRow(l, 'up')).join('')
      : '<tr><td colspan="4" class="muted">Nothing untested above — the week closed at its own highs.</td></tr>';
    const below = r.untested.below.length
      ? r.untested.below.map((l) => lvlRow(l, 'down')).join('')
      : '<tr><td colspan="4" class="muted">Nothing untested below — the week closed at its own lows.</td></tr>';

    const cal = r.calendar.published
      ? `<ul class="hw-cal">${r.calendar.events.slice(0, 10).map((e) =>
          `<li><b>${e.dow} ${e.uk}</b> ${e.title}${e.forecast ? ` <span class="muted">f/c ${e.forecast}</span>` : ''}</li>`).join('')}</ul>`
      : `<p class="hw-warn">⚠️ Next week's calendar isn't published yet. The feed only ever carries one week and still shows the week just gone — Sunday's gap check will have it. Treat the schedule as unknown until then.</p>`;

    const acc = r.accounts.length
      ? `<table class="hw-table"><tr><th>Account</th><th>Signals</th><th>Closed</th><th>W/L</th><th>Net</th></tr>${
          r.accounts.map((a) => `<tr><td>${a.data.label}</td><td>${a.data.signals_opened}</td>
            <td>${a.data.summary.legs_closed}</td><td>${a.data.summary.wins}W/${a.data.summary.losses}L</td>
            <td class="${a.data.summary.net_profit >= 0 ? 'up' : 'down'}">${sgn(a.data.summary.net_profit)} ${a.data.currency}</td></tr>`).join('')
        }</table>`
      : '<p class="muted">No account history available for that week.</p>';

    $('homeworkView').innerHTML = `
      ${stale}
      <div class="hw-head">
        <h2>Week of ${r.weekOf.monday} → ${r.weekOf.friday}</h2>
        <div class="hw-verdict ${w.direction}">${w.direction === 'up' ? '📈' : w.direction === 'down' ? '📉' : '➖'} ${w.direction.toUpperCase()} ${sgn(w.net)} pts (${sgn(w.netPct)}%)</div>
      </div>

      <div class="hw-grid">
        <div class="hw-stat"><span>WEEK OPEN</span><b>${f1(w.open)}</b></div>
        <div class="hw-stat"><span>HIGH</span><b>${f1(w.high)}</b></div>
        <div class="hw-stat"><span>LOW</span><b>${f1(w.low)}</b></div>
        <div class="hw-stat hw-hi"><span>FRIDAY CLOSE</span><b>${f1(w.close)}</b></div>
        <div class="hw-stat"><span>RANGE</span><b>${f1(w.range)} pts</b></div>
        <div class="hw-stat"><span>CLOSED AT</span><b>${f1(w.closePosPct)}% of range</b></div>
      </div>
      <p class="hw-note">${w.closePosPct > 70 ? 'Buyers held control into the close.' : w.closePosPct < 30 ? 'Sellers held control into the close.' : 'Mid-range close — neither side finished in control.'}
        ${r.rangeVsTypical ? ` The week spanned <b>${f1(r.rangeVsTypical)}%</b> of a typical week (~${f1(r.typicalRange)} pts over the last ${r.pastRangeWeeks}) — ${r.rangeVsTypical < 75 ? 'a quiet one' : r.rangeVsTypical > 125 ? 'a busy one' : 'about average'}.` : ''}
        Structure: price is <b>${r.trend.label}</b>.</p>

      <h3>Day by day <span class="muted">(UK dates)</span></h3>
      <table class="hw-table"><tr><th>Day</th><th>Range</th><th>Pts</th><th>Net</th></tr>${dayRows}</table>
      <p class="hw-note">Busiest ${r.biggestDay.dow} (${f1(r.biggestDay.range)} pts) · quietest ${r.quietestDay.dow} (${f1(r.quietestDay.range)} pts).</p>

      <h3>Untested levels</h3>
      <p class="hw-note">Swing highs and lows price walked away from and never came back to challenge. Distances are from Friday's close ${f1(w.close)} — apply them as <b>point-distances from your own broker's fill</b>, not as absolute prices.</p>
      <table class="hw-table hw-levels">${above}${below}</table>
      <p class="hw-note">${r.prior ? `Prior week ranged ${f1(r.prior.low)}–${f1(r.prior.high)}. ` : ''}Round numbers either side: ${f1(r.round50[1])} / ${f1(r.round50[0])}.</p>

      <h3>The week ahead <span class="hw-grade">GRADE C</span></h3>
      <div class="hw-warnbox">No validated weekly edge exists in this system — no pre-trade feature tested here predicts outcome. What follows is context to watch, <b>not a signal and not a forecast</b>. The only validated edge remains Setup A and Setup B.</div>
      ${cal}
      <div class="hw-grid">
        <div class="hw-stat"><span>1H 50 EMA</span><b>${f1(r.emas.h1_50)}</b></div>
        <div class="hw-stat"><span>1H 200 EMA</span><b>${f1(r.emas.h1_200)}</b></div>
        <div class="hw-stat"><span>DAILY 20 EMA</span><b>${f1(r.emas.d_20)}</b></div>
        <div class="hw-stat"><span>DAILY 50 EMA</span><b>${f1(r.emas.d_50)}</b></div>
      </div>
      ${r.typicalRange ? `<p class="hw-note">If next week is ordinary (~${f1(r.typicalRange)} pts), that's roughly <b>${f1(w.close - r.typicalRange / 2)}–${f1(w.close + r.typicalRange / 2)}</b> around Friday's close. That is an envelope of likely <b>size</b> — it says nothing about direction.</p>` : ''}
      <p class="hw-note">Untested levels are where reactions are most likely, simply because nobody has traded them yet. A clean break through one is information; a rejection off it is information. Neither is an entry on its own.</p>

      <h3>Your agent's week</h3>
      ${acc}
      <p class="hw-note">Base rates: the validated edge is <b>+0.168R</b> per trade at ~50% win, about <b>1.56 trades a week</b> — only 28% of days produce a trade at all. A quiet week is the system working, not the system broken.</p>
      <p class="muted hw-foot">Published ${new Date(r.generatedAt).toLocaleString()} by the XAU Session Agent.</p>`;
  }

  // Wipe every gold-specific readout the moment we leave the gold tab. Runs even if
  // the destination feed dies, so a stale gold idea/price can never sit under another
  // symbol's header. Shared by the US30 and Homework tabs.
  function clearGoldReadouts(tickerLabel) {
    for (const id of ['entryValue', 'tp1Value', 'tp2Value', 'slValue']) {
      $(id).textContent = '—'; $(id).closest('.kpi').classList.remove('active');
    }
    $('biasValue').textContent = 'n/a'; $('biasValue').className = 'kpi-value';
    $('entryFoot').textContent = '—'; $('slFoot').textContent = '—';
    $('tickerPrice').textContent = '—'; $('tickerChange').textContent = '—';
    $('tickerChange').className = 'delta';
    document.querySelector('.ticker-label').textContent = tickerLabel;
    for (const id of ['stSession', 'stAtr', 'stRsi', 'stDay', 'stNext']) $(id).textContent = '—';
    $('ideaHeadline').className = 'idea-headline';
    $('takeVerdict').className = 'take-verdict';
  }

  // Clear the panels to a neutral US30 loading state — NO gold text. renderUs30()
  // fills everything in a moment; this is only what shows if the feed is slow or
  // fails, so it must never leave gold copy on screen under the US30 header.
  function neutralizeForUs30() {
    clearGoldReadouts('US30');
    const tp = $('trackPanel'); if (tp) tp.hidden = true;   // gold-only replay, hide on US30
    setKpiLabels({ kpiBias: 'US30 BIAS', kpiEntry: 'RESISTANCE', kpiTp1: 'SUPPORT', kpiTp2: 'PREV CLOSE', kpiSl: 'DAY RANGE' });
    $('biasConf').textContent = 'analysing…';
    $('ideaGrade').textContent = 'US30'; $('ideaGrade').className = 'idea-grade c';
    $('ideaHeadline').textContent = 'Analysing US30…';
    $('ideaBody').innerHTML = '<span class="muted">Building the technical read from the ^DJI feed.</span>';
    $('ideaEdge').textContent = '';
    $('takeVerdict').textContent = '📊 US30 analysis';
    $('takeBody').innerHTML = '<p class="muted">Loading structure, levels and fundamentals…</p>';
    $('tipBox').textContent = 'US30 — full technical & fundamental read, US30 only.';
    const bt = $('biasPanelTitle'); if (bt) bt.textContent = '📊 Directional Checks — US30';
    $('biasVotes').innerHTML = '';
  }

  function neutralizeForHomework() {
    clearGoldReadouts('XAU/USD');
    const tp = $('trackPanel'); if (tp) tp.hidden = false;
    $('biasConf').textContent = 'review of the week just gone';
    $('entryFoot').textContent = 'no live signals on this tab';
    $('stAsia').textContent = '—';
    $('ideaGrade').textContent = 'C'; $('ideaGrade').className = 'idea-grade c';
    $('ideaHeadline').textContent = 'Weekend review — not a live signal';
    $('ideaBody').innerHTML = 'This tab is a retrospective on the week that just closed, plus the levels it left untested. Nothing here is a graded setup. Live A/B ideas resume on the XAU/USD tab when London opens.';
    $('ideaEdge').textContent = '📌 Switch to XAU/USD for live graded ideas.';
    $('takeVerdict').textContent = '📚 Weekend homework';
    $('takeBody').innerHTML = '<p>The week that just closed, reviewed on the right — what it did, and which levels it walked away from without testing.</p>'
      + '<p>No live chart or signals on this tab. Market reopens <b>Sunday 23:00 UK</b>; the London brief lands ~07:55 UK Monday.</p>';
    $('tipBox').textContent = 'Weekend work is about preparation, not prediction. Mark the untested levels, know which economic events land, then let the setups come to you.';
  }

  // ── 📡 GKO follower forward-test scoreboard ──
  async function loadGko() {
    const g = await getJson('gko-scoreboard.json', 'gkoView', 'The follower publishes its scoreboard alongside the agent status snapshot.');
    if (!g) return;
    const a = g.account || {}, b = g.benchmark || {};
    const s = g.stats || {};
    const wk = a.week || {};
    $('gkoView').innerHTML = `
      <div class="hw-head"><h2>GKO follower — forward test</h2>
        <div class="hw-verdict ${g.halted ? 'down' : 'up'}">${g.halted ? '🛑 HALTED' : '▶️ running'}</div></div>
      <div class="hw-warnbox"><b>This is not a validated strategy.</b> It mirrors a third party's discretionary calls.
        Reverse-engineering showed his zone placement is mechanical (spot snapped to the nearest round-5) but his
        BUY/SELL choice is <b>not reproducible</b> — a classifier scored 49.4% against a 61.4% majority baseline.
        Running on <b>demo</b> to build tamper-proof evidence that scraped history can't provide.</div>
      <div class="hw-grid">
        <div class="hw-stat"><span>SIGNALS JOURNALLED</span><b>${s.signals ?? 0}</b></div>
        <div class="hw-stat"><span>TAKEN</span><b>${s.taken ?? 0}</b></div>
        <div class="hw-stat"><span>DECLINED</span><b>${s.skipped ?? 0}</b></div>
        <div class="hw-stat"><span>CLOSED</span><b>${s.closed ?? 0}${s.winRate != null ? ` · ${s.winRate}% win` : ''}</b></div>
        <div class="hw-stat hw-hi"><span>LIVE EXPECTANCY</span><b>${s.expectancy != null ? SGN(s.expectancy) + 'R' : '—'}</b></div>
        <div class="hw-stat"><span>TOTAL R</span><b class="${(s.totalR ?? 0) >= 0 ? 'up' : 'down'}">${s.totalR != null ? SGN(s.totalR) : '—'}</b></div>
        <div class="hw-stat"><span>OPEN NOW</span><b>${a.openPositions ?? '—'}</b></div>
        <div class="hw-stat"><span>EQUITY</span><b>${a.equity != null ? a.equity + ' ' + (a.currency || '') : '—'}</b></div>
      </div>
      ${s.closed ? `<p class="hw-note">Live expectancy is over <b>${s.closed}</b> closed trade${s.closed === 1 ? '' : 's'} —
        far too few to mean anything yet. The holdout ran to 83 and still couldn't separate itself from zero.</p>` : ''}
      <h3>What it's being measured against</h3>
      <table class="hw-table">
        <tr><th>Sample</th><th>Expectancy</th><th>Meaning</th></tr>
        <tr><td>Dev (53 signals, in-sample)</td><td class="up">+${b.dev}R</td><td class="muted">where the model was built — expect regression</td></tr>
        <tr><td><b>Holdout (83, out-of-sample)</b></td><td class="up">+${b.holdout}R</td><td class="muted">the honest number</td></tr>
        <tr><td>Your gold agent</td><td class="up">+${b.goldAgent}R</td><td class="muted">validated over 662 days</td></tr>
      </table>
      <p class="hw-note">⚠️ ${b.note}</p>
      <h3>Trade journal <span class="muted">every signal, taken or not</span></h3>
      ${journalTable(g.journal || [])}
      ${(g.skipReasons || []).length ? `<h3>Why signals were declined</h3>
        <table class="hw-table"><tr><th>Reason</th><th>Count</th></tr>
        ${g.skipReasons.map(([k, n]) => `<tr><td>${k}</td><td>${n}</td></tr>`).join('')}</table>` : ''}
      <p class="hw-note">Skips matter as much as fills: his TP1 is often reached within minutes of posting, so a signal
        that arrives stale is one a human would likely have chased at a worse price. Quantifying that gap is part of the test.</p>
      <p class="muted hw-foot">Published ${new Date(g.generatedAt).toLocaleString()} · ${ageStr(g.generatedAt)}</p>`;
  }

  // Full journal table. Newest first, because that is what you check.
  function journalTable(rows) {
    if (!rows.length) {
      return `<p class="muted">No signals journalled yet. The follower only acts 07:00–17:00 UK on weekdays,
        and records every signal it sees — including ones it declines.</p>`;
    }
    const badge = (s) => {
      const map = { CLOSED: 'up', PLACED: 'warn', SKIPPED: '', DRY_RUN: '', ERROR: 'down' };
      return `<span class="hlt-pill hlt-${map[s] ?? ''}">${s || '—'}</span>`;
    };
    const body = rows.slice().reverse().map((r) => {
      const t = r.ts ? new Date(r.ts) : null;
      const when = t ? t.toLocaleString('en-GB', { day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit' }) : '—';
      const rcell = r.r != null
        ? `<b class="${r.r >= 0 ? 'up' : 'down'}">${SGN(r.r)}R</b>`
        : (r.status === 'PLACED' ? '<span class="muted">open</span>' : '<span class="muted">—</span>');
      const cash = r.profit != null ? `<span class="${r.profit >= 0 ? 'up' : 'down'}">${SGN(r.profit)}</span>` : '';
      const detail = r.status === 'SKIPPED' ? `<span class="muted">${r.reason || ''}</span>`
        : r.fill != null ? `filled ${F1(r.fill)}${r.exit != null ? ` → ${F1(r.exit)}` : ''} ${cash}`
        : r.intended_entry != null ? `<span class="muted">@${F1(r.intended_entry)} · ${r.lots ?? '—'} lots</span>` : '';
      return `<tr>
        <td>${when}</td>
        <td><b class="${r.dir === 'BUY' ? 'up' : 'down'}">${r.dir || '—'}</b></td>
        <td>${r.zone_lo != null ? `${F1(r.zone_lo)}–${F1(r.zone_hi)}` : '—'}</td>
        <td class="muted">${r.tp1 != null ? F1(r.tp1) : '—'} / ${r.sl != null ? F1(r.sl) : '—'}</td>
        <td>${badge(r.status)}</td>
        <td>${rcell}</td>
        <td>${detail}</td></tr>`;
    }).join('');
    return `<div class="hw-scroll"><table class="hw-table hw-journal">
      <tr><th>When</th><th>Dir</th><th>Zone</th><th>TP1/SL</th><th>Status</th><th>R</th><th>Detail</th></tr>
      ${body}</table></div>`;
  }

  // ── 🩺 Agent health ──
  async function loadHealth() {
    const h = await getJson('agent-status.json', 'healthView', 'The publisher pushes a snapshot every 30 minutes while the laptop is on.');
    if (!h) return;
    const age = (Date.now() - Date.parse(h.generatedAt)) / 60000;
    const snapStale = age > 90;
    const cards = (h.agents || []).map((a) => {
      const ac = a.account || {};
      const bad = !a.running || a.stale || ac.error || ac.algoTrading === false;
      const state = !a.running ? 'DOWN' : a.stale ? 'QUIET' : 'OK';
      const cls = !a.running ? 'down' : a.stale ? 'warn' : 'up';
      return `<div class="hlt-card ${bad ? 'hlt-bad' : ''}">
        <div class="hlt-top"><b>${a.label}</b>
          <span class="hlt-pill hlt-${cls}">${state}</span>
          ${a.live ? '<span class="hlt-pill hlt-live">REAL MONEY</span>' : '<span class="hlt-pill">demo</span>'}</div>
        <div class="hlt-rows">
          <div><span>heartbeat</span><b>${a.heartbeatMin != null ? a.heartbeatMin + ' min' : '—'}</b></div>
          <div><span>pid</span><b>${a.pid ?? '—'}</b></div>
          <div><span>equity</span><b>${ac.equity != null ? ac.equity + ' ' + (ac.currency || '') : (ac.error || '—')}</b></div>
          <div><span>algo trading</span><b class="${ac.algoTrading === false ? 'down' : ''}">${ac.algoTrading == null ? '—' : ac.algoTrading ? 'on' : 'OFF'}</b></div>
          <div><span>spread</span><b>${ac.spread ?? '—'}</b></div>
          <div><span>open</span><b>${ac.openPositions ?? '—'}</b></div>
        </div>
        <div class="hlt-log">${a.lastLog ? a.lastLog.replace(/[<>]/g, '') : 'no log'}</div>
      </div>`;
    }).join('');
    const cal = h.calendar || {};
    $('healthView').innerHTML = `
      ${snapStale ? `<div class="hw-stale">⚠️ This snapshot is ${ageStr(h.generatedAt)} — the laptop may be asleep or the publisher stopped. Everything below is that old.</div>` : ''}
      <div class="hw-head"><h2>Agent health</h2>
        <div class="hw-verdict ${snapStale ? 'down' : 'up'}">${ageStr(h.generatedAt)}</div></div>
      <p class="hw-note">A process being <b>up</b> is not the same as it <b>working</b> — three silent failures on 2026-07-19
        all looked like normal operation. "QUIET" means the process is alive but hasn't written a heartbeat recently.</p>
      <div class="hlt-grid">${cards}</div>
      <h3>Calendar feed</h3>
      ${cal.error ? `<div class="hw-warn">⚠️ ${cal.error}</div>` :
        `<div class="hw-grid">
          <div class="hw-stat"><span>EVENTS CACHED</span><b>${cal.events}</b></div>
          <div class="hw-stat"><span>FORWARD-DATED</span><b>${cal.forwardDated}</b></div>
          <div class="hw-stat ${cal.highForward ? '' : 'hw-hi'}"><span>HIGH IMPACT AHEAD</span><b>${cal.highForward}</b></div>
        </div>
        <p class="hw-note">A low forward count can mean a genuinely quiet week — or a partial feed. The blackout only
          protects against events it can actually see.</p>`}
      <p class="muted hw-foot">Snapshot ${new Date(h.generatedAt).toLocaleString()}. The dashboard is static and cannot
        poll the laptop; this is the last state the agents published.</p>`;
  }

  async function loadUs30() {
    try {
      const [j, cal] = await Promise.all([
        jget('/api/us30'),
        jget('/api/calendar').catch(() => ({ events: [] })),
      ]);
      S.us30 = j;
      candles.setData(j.bars);
      const a = analyzeUs30(j);
      // trend line: EMA on 15m ≈ 12.5h swing trend, US30 blue
      const e = window.IQFX.ema(j.bars.map((b) => b.close), 50);
      ema50Series.setData(j.bars.map((b, i) => ({ time: b.time, value: e[i] })).filter((x) => x.value != null));
      markUs30Chart(a);
      renderUs30(a, cal.events || []);
      $('chartSrc').textContent = `US30 (^DJI) · ${a.days.length}-day structure · updated ${new Date(j.fetched).toLocaleTimeString()}`;
    } catch (e) {
      $('chartSrc').textContent = 'US30 feed unavailable — analysis needs the ^DJI data feed.';
      $('takeVerdict').textContent = '📊 US30 — feed unavailable';
      $('takeBody').innerHTML = '<p class="muted">Could not reach the ^DJI data feed. The analysis rebuilds automatically once it returns.</p>';
    }
  }

  // Self-contained US30 technical read, computed entirely from the ^DJI cash feed
  // so every level sits exactly on the drawn chart. NOTE: Yahoo's meta.prevClose is
  // unreliable (it read 51,564 vs the true prior-session close 52,159) — the prior
  // day is taken from grouped sessions instead.
  function analyzeUs30(j) {
    const bars = j.bars;
    const nyDate = (t) => new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const byDay = new Map();
    for (const b of bars) { const d = nyDate(b.time); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(b); }
    const days = [...byDay.entries()].map(([date, bs]) => ({
      date, open: bs[0].open, close: bs[bs.length - 1].close,
      high: Math.max(...bs.map((x) => x.high)), low: Math.min(...bs.map((x) => x.low)),
    }));
    const today = days[days.length - 1], prev = days[days.length - 2] || today;
    const px = j.price ?? today.close;
    const wk = days.slice(-5);
    const weekHigh = Math.max(...wk.map((d) => d.high)), weekLow = Math.min(...wk.map((d) => d.low));

    const dc = days.map((d) => d.close);
    const e10 = window.IQFX.ema(dc, 10), e20 = window.IQFX.ema(dc, 20);
    const dEma10 = e10[e10.length - 1], dEma20 = e20[e20.length - 1];
    const chg5 = px - (dc[dc.length - 6] ?? dc[0]);

    // H1 aggregation for intraday trend + RSI
    const h1 = []; let cur = null, key = null;
    for (const b of bars) { const k = Math.floor(b.time / 3600); if (k !== key) { if (cur) h1.push(cur); cur = { high: b.high, low: b.low, close: b.close }; key = k; } else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; } }
    if (cur) h1.push(cur);
    const h1c = h1.map((x) => x.close);
    const h1Ema20 = window.IQFX.ema(h1c, 20).slice(-1)[0];
    const h1Ema50 = window.IQFX.ema(h1c, 50).slice(-1)[0];
    const rsi = window.IQFX.rsi(h1c, 14).slice(-1)[0];

    // daily ATR14
    let tr = [];
    for (let i = 1; i < days.length; i++) tr.push(Math.max(days[i].high - days[i].low, Math.abs(days[i].high - days[i - 1].close), Math.abs(days[i].low - days[i - 1].close)));
    const atr = tr.slice(-14).reduce((s, v) => s + v, 0) / Math.min(14, tr.length);

    // structure: last two swing highs / lows on the daily series
    const sh = [], sl = [];
    for (let i = 2; i < days.length - 2; i++) {
      const d = days[i];
      if (d.high > days[i - 1].high && d.high > days[i - 2].high && d.high > days[i + 1].high && d.high > days[i + 2].high) sh.push(d.high);
      if (d.low < days[i - 1].low && d.low < days[i - 2].low && d.low < days[i + 1].low && d.low < days[i + 2].low) sl.push(d.low);
    }
    const hh = sh.length >= 2 && sh[sh.length - 1] > sh[sh.length - 2];
    const ll = sl.length >= 2 && sl[sl.length - 1] < sl[sl.length - 2];
    const structure = hh && !ll ? 'higher highs & higher lows (up)' : ll && !hh ? 'lower highs & lower lows (down)' : 'mixed / ranging';

    // untested swing levels on H1
    const un = [];
    for (let i = 3; i < h1.length - 3; i++) {
      const w = h1.slice(i - 3, i + 4);
      if (h1[i].high === Math.max(...w.map((x) => x.high)) && !h1.slice(i + 1).some((x) => x.high >= h1[i].high)) un.push({ t: 'R', p: h1[i].high });
      if (h1[i].low === Math.min(...w.map((x) => x.low)) && !h1.slice(i + 1).some((x) => x.low <= h1[i].low)) un.push({ t: 'S', p: h1[i].low });
    }
    const resAbove = un.filter((x) => x.t === 'R' && x.p > px).sort((a, b) => a.p - b.p).map((x) => x.p).slice(0, 3);
    const supBelow = un.filter((x) => x.t === 'S' && x.p < px).sort((a, b) => b.p - a.p).map((x) => x.p).slice(0, 3);

    // directional lean — a weighted read, framed as probability tilt, not a signal.
    // Each check carries a signed vote (+1 bull / 0 neutral / -1 bear) so a "mixed"
    // structure counts as neutral, not bearish.
    const sv = (b) => (b ? 1 : -1);
    const votes = [
      { k: 'Price vs 20-day EMA', v: sv(px > dEma20), why: `${px.toFixed(0)} vs ${dEma20.toFixed(0)}` },
      { k: '20-day EMA slope', v: sv(dEma10 > dEma20), why: dEma10 > dEma20 ? 'rising' : 'rolling over' },
      { k: '5-day momentum', v: sv(chg5 > 0), why: `${chg5 >= 0 ? '+' : ''}${chg5.toFixed(0)} pts` },
      { k: 'Intraday (H1 EMA50)', v: sv(px > h1Ema50), why: `${px.toFixed(0)} vs ${h1Ema50.toFixed(0)}` },
      { k: 'Market structure', v: hh && !ll ? 1 : ll && !hh ? -1 : 0, why: structure },
    ];
    const score = votes.reduce((s, x) => s + x.v, 0);
    const lean = score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL';
    const strength = Math.abs(score) >= 4 ? 'strong' : Math.abs(score) >= 2 ? 'moderate' : 'slight';
    const stretched = rsi <= 32 ? 'oversold' : rsi >= 68 ? 'overbought' : null;

    return {
      px, prevClose: prev.close, prevHigh: prev.high, prevLow: prev.low,
      todayHigh: today.high, todayLow: today.low, weekHigh, weekLow,
      dEma20, dEma10, h1Ema20, h1Ema50, rsi, atr, chg5, structure, days,
      votes, score, lean, strength, stretched, resAbove, supBelow,
      dayRange: today.high - today.low,
    };
  }

  function markUs30Chart(a) {
    levelLines.forEach((l) => candles.removePriceLine(l)); levelLines = [];
    candles.setMarkers([]);
    const add = (price, color, title, style = 0, width = 1) =>
      levelLines.push(candles.createPriceLine({ price, color, title, lineStyle: style, lineWidth: width, axisLabelVisible: true }));
    add(a.prevHigh, COLORS.sl, 'PREV HIGH', 0, 1);
    add(a.prevClose, COLORS.asia, 'PREV CLOSE', 2, 2);
    add(a.prevLow, COLORS.tp, 'PREV LOW', 0, 1);
    add(a.weekHigh, 'rgba(239,83,80,.45)', 'WK HIGH', 3, 1);
    add(a.weekLow, 'rgba(38,166,138,.45)', 'WK LOW', 3, 1);
  }

  function renderUs30(a, calEvents) {
    const px = a.px, ch = px - a.prevClose, pct = (ch / a.prevClose) * 100;
    $('tickerPrice').textContent = px.toFixed(0);
    $('tickerChange').textContent = `${ch >= 0 ? '+' : ''}${ch.toFixed(0)} (${pct.toFixed(2)}%)`;
    $('tickerChange').className = 'delta ' + (ch >= 0 ? 'up' : 'down');
    document.querySelector('.ticker-label').textContent = 'US30';

    // KPI row — US30 levels
    setKpiLabels({ kpiBias: 'US30 BIAS', kpiEntry: 'RESISTANCE', kpiTp1: 'SUPPORT', kpiTp2: 'PREV CLOSE', kpiSl: 'DAY RANGE' });
    const leanCls = a.lean === 'BULLISH' ? 'up' : a.lean === 'BEARISH' ? 'down' : '';
    $('biasValue').textContent = a.lean; $('biasValue').className = 'kpi-value ' + leanCls;
    $('biasConf').textContent = `${a.strength} lean · ${a.score >= 0 ? '+' : ''}${a.score}/5 checks`;
    $('entryValue').textContent = a.resAbove[0] ? a.resAbove[0].toFixed(0) : '—';
    $('entryFoot').textContent = a.resAbove[1] ? `then ${a.resAbove[1].toFixed(0)}` : 'no untested level above';
    $('tp1Value').textContent = a.supBelow[0] ? a.supBelow[0].toFixed(0) : '—';
    setKpiFoot('kpiTp1', a.supBelow[1] ? `then ${a.supBelow[1].toFixed(0)}` : 'prev low ' + a.prevLow.toFixed(0));
    $('tp2Value').textContent = a.prevClose.toFixed(0);
    setKpiFoot('kpiTp2', `prev day ${a.prevLow.toFixed(0)}–${a.prevHigh.toFixed(0)}`);
    $('slValue').textContent = `${a.dayRange.toFixed(0)} pts`;
    $('slFoot').textContent = `ATR ${a.atr.toFixed(0)}`;

    // stats strip
    const mins = ukParts(Date.now()).min;
    const active = mins >= 840 && mins < 960;   // 14:00–16:00 UK, the active window
    $('stSession').textContent = active ? 'US CASH — active' : 'outside cash hours';
    $('stAsia').textContent = `${a.prevLow.toFixed(0)}–${a.prevHigh.toFixed(0)}`;
    document.querySelector('#stAsia').closest('.stat').querySelector('.stat-l').textContent = 'PREV DAY';
    $('stAtr').textContent = `${a.atr.toFixed(0)} pts`;
    $('stRsi').textContent = a.rsi.toFixed(0);
    $('stDay').textContent = `${a.dayRange.toFixed(0)} pts`;
    $('stNext').textContent = active ? 'peak 14:00–16:00 UK' : 'active 14:00–16:00 UK';

    // ── left sidebar: US30 bias card (idea panel) ──
    $('ideaGrade').textContent = 'ANALYSIS'; $('ideaGrade').className = 'idea-grade ' + (leanCls || 'c');
    $('ideaHeadline').textContent = `${a.lean} — ${a.strength} lean`;
    $('ideaHeadline').className = 'idea-headline ' + (a.lean === 'BULLISH' ? 'long' : a.lean === 'BEARISH' ? 'short' : '');
    const votesHtml = a.votes.map((v) => {
      const tag = v.v > 0 ? 'BULL' : v.v < 0 ? 'BEAR' : 'FLAT';
      const cls = v.v > 0 ? 'v-long' : v.v < 0 ? 'v-short' : 'v-flat';
      return `<div class="vote"><span>${v.k}</span><i class="${cls}" title="${v.why}">${tag}</i></div>`;
    }).join('');
    $('ideaBody').innerHTML = `Price <b>${px.toFixed(0)}</b> · ${ch >= 0 ? '+' : ''}${ch.toFixed(0)} (${pct.toFixed(2)}%) on the session.\n`
      + `Structure: <b>${a.structure}</b>.\n${votesHtml}`
      + (a.stretched ? `<div class="bias-note bias-mixed">⚠️ Momentum is <b>${a.stretched}</b> (H1 RSI ${a.rsi.toFixed(0)}). ${a.stretched === 'oversold' ? 'A relief bounce is elevated risk — the higher-odds short is a retest of resistance, not chasing a breakdown here.' : 'A pullback is elevated risk — chasing strength into resistance is where continuation traps form.'}</div>` : '');
    $('ideaEdge').textContent = 'Discretionary read — reasoned, not a mechanically back-tested signal. You size and manage it.';

    // ── Agent's Take: the full analysis ──
    const nearSup = a.supBelow[0], nearRes = a.resAbove[0];
    const bearPrimary = a.lean === 'BEARISH';
    const scenarios = a.lean === 'BULLISH'
      ? `<p><b>Primary — continuation up.</b> Holding above the 20-day EMA (${a.dEma20.toFixed(0)}) keeps momentum higher. A push through <b>${nearRes ? nearRes.toFixed(0) : a.prevHigh.toFixed(0)}</b> opens ${a.resAbove[1] ? a.resAbove[1].toFixed(0) : a.weekHigh.toFixed(0)} → ${a.weekHigh.toFixed(0)}. Invalidated on a close back below <b>${a.prevClose.toFixed(0)}</b>.</p>
         <p><b>Alternate — failure.</b> Lose ${nearSup ? nearSup.toFixed(0) : a.prevLow.toFixed(0)} and the up-lean is done; ${a.supBelow[1] ? a.supBelow[1].toFixed(0) : a.weekLow.toFixed(0)} comes into play.</p>`
      : a.lean === 'BEARISH'
      ? `<p><b>Primary — pressure lower</b>, but price is ${a.stretched === 'oversold' ? '<b>oversold and sitting on support</b>' : 'below its 20-day EMA'}. The higher-probability sell is a <b>bounce into resistance</b> — a retest of ${a.prevClose.toFixed(0)} / the 20-day EMA ${a.dEma20.toFixed(0)} that rejects — rather than chasing a fresh break. A clean break of <b>${nearSup ? nearSup.toFixed(0) : a.prevLow.toFixed(0)}</b> opens ${a.supBelow[1] ? a.supBelow[1].toFixed(0) : a.weekLow.toFixed(0)} → ${a.weekLow.toFixed(0)}.</p>
         <p><b>Alternate — reclaim.</b> Back above <b>${a.prevClose.toFixed(0)}</b> and holding flips the near-term odds neutral-up toward the 20-day EMA ${a.dEma20.toFixed(0)} and ${nearRes ? nearRes.toFixed(0) : a.prevHigh.toFixed(0)}.</p>`
      : `<p><b>No clear edge — ranging.</b> Checks are split (${a.score >= 0 ? '+' : ''}${a.score}/5). Trade the edges: fade toward ${nearRes ? nearRes.toFixed(0) : a.prevHigh.toFixed(0)} on the top, ${nearSup ? nearSup.toFixed(0) : a.prevLow.toFixed(0)} on the bottom, and wait for a decisive break of one for direction.</p>`;

    // fundamentals — US events only, computed from the live calendar
    const usdFwd = (calEvents || []).filter((e) => e.country === 'USD' && e.ts >= Date.now());
    const usdHigh = usdFwd.filter((e) => e.impact === 'High');
    const fundText = usdHigh.length === 0
      ? `<p><b>Light US data week.</b> No high-impact USD releases scheduled ahead. With no macro catalyst on the board, US30 is driven by <b>Q2 earnings and positioning</b> — expect technically-led moves and lower scheduled-event risk.${usdFwd.length ? ` Next US item: ${usdFwd[0].title} (${new Date(usdFwd[0].ts).toLocaleDateString('en-GB', { weekday: 'short' })}, ${usdFwd[0].impact.toLowerCase()}).` : ''}</p>`
      : `<p><b>${usdHigh.length} high-impact US release${usdHigh.length > 1 ? 's' : ''} ahead</b> — expect volatility around: ${usdHigh.slice(0, 4).map((e) => `${e.title} (${new Date(e.ts).toLocaleDateString('en-GB', { weekday: 'short' })})`).join(', ')}. Index direction can turn on these regardless of the technical picture.</p>`;

    $('takeVerdict').textContent = `📊 US30 — ${a.lean.toLowerCase()} lean, ${a.strength}`;
    $('takeVerdict').className = 'take-verdict ' + leanCls;
    $('takeBody').innerHTML = `
      <h4 class="us30-h">Technical read</h4>
      <p>Price <b>${px.toFixed(0)}</b> is ${px > a.dEma20 ? 'above' : 'below'} the 20-day EMA (${a.dEma20.toFixed(0)}) and ${px > a.h1Ema50 ? 'above' : 'below'} the intraday H1 EMA50 (${a.h1Ema50.toFixed(0)}). 5-day change <b>${a.chg5 >= 0 ? '+' : ''}${a.chg5.toFixed(0)}</b>. Daily ATR ${a.atr.toFixed(0)}.</p>
      <h4 class="us30-h">Levels on the chart</h4>
      <p>Prev day <b>${a.prevLow.toFixed(0)}–${a.prevHigh.toFixed(0)}</b>, close <b>${a.prevClose.toFixed(0)}</b>. Week <b>${a.weekLow.toFixed(0)}–${a.weekHigh.toFixed(0)}</b>. Untested above: ${a.resAbove.map((p) => p.toFixed(0)).join(' · ') || 'none'}. Untested below: ${a.supBelow.map((p) => p.toFixed(0)).join(' · ') || 'none'}.</p>
      <h4 class="us30-h">Scenarios <span class="muted">probability-weighted</span></h4>
      ${scenarios}
      <h4 class="us30-h">Fundamentals</h4>
      ${fundText}
      <h4 class="us30-h">Know the instrument</h4>
      <p>US30 is 30 US mega-caps — it moves on <b>earnings, rates and risk sentiment</b>. It's most active <b>14:00–16:00 UK</b> (US cash open); outside that, moves are thin. It tends to <b>trend intraday</b> — the cash-open direction often carries into the close, so it rewards continuation over fading. As a cash index it has no weekend gaps and a quiet pre-open.</p>`;

    // session tip + weekly-pressure bar repurposed for US30
    $('tipBox').textContent = a.stretched
      ? `RSI ${a.rsi.toFixed(0)} — ${a.stretched}. Best trades come from the reaction at a level, not from chasing the move into it.`
      : 'US30 rewards patience at the 14:00–16:00 UK window. Mark the prev day levels, wait for price to react at one.';
    const nBull = a.votes.filter((v) => v.v > 0).length, nBear = a.votes.filter((v) => v.v < 0).length;
    const nFlat = a.votes.length - nBull - nBear;
    const bull = Math.round((nBull / a.votes.length) * 100);
    $('biasBuyBar').style.width = bull + '%'; $('biasSellBar').style.width = (100 - bull) + '%';
    $('biasBuyPct').textContent = bull >= 12 ? `${bull}% BULL` : '';
    $('biasSellPct').textContent = (100 - bull) >= 12 ? `${100 - bull}% BEAR` : '';
    $('biasVotes').innerHTML = `<div class="bias-foot muted">US30 checks: ${nBull} bullish / ${nBear} bearish${nFlat ? ` / ${nFlat} neutral` : ''}. Discretionary read.</div>`;
    const bt = $('biasPanelTitle'); if (bt) bt.textContent = '📊 Directional Checks — US30';
  }

  async function refreshCalendar() {
    try { S.calendar = (await jget('/api/calendar')).events; renderCalendar(); } catch (e) { /* keep old */ }
  }
  async function refreshNews() {
    try { S.news = (await jget('/api/news')).items; renderNews(); } catch (e) { /* keep old */ }
  }

  // ── boot ──
  (async function boot() {
    await calibrateBasis();
    await loadBars();
    // day open = first bar of the UK day
    const todayUk = ukParts(Date.now()).date;
    const firstToday = S.bars15.find((b) => ukParts(b.time * 1000).date === todayUk);
    S.dayOpenPrice = firstToday ? firstToday.open : S.bars15[S.bars15.length - 1].close;
    runEngine();
    connectWs();
    refreshCalendar(); refreshNews();
    loadTrackRecord();
    setInterval(loadTrackRecord, 60 * 60_000);
    setInterval(calibrateBasis, 60_000);
    setInterval(refreshCalendar, 10 * 60_000);
    setInterval(refreshNews, 3 * 60_000);
    setInterval(runEngine, 60_000);           // clock-driven re-render (sessions, countdowns)
    setInterval(loadBars, 30 * 60_000);       // periodic full refresh to heal any drift
    setInterval(() => { if (S.sym === 'US30') loadUs30(); }, 60_000);  // US30 context refresh
  })();
})();
