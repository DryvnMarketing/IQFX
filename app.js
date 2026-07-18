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
    $('biasVotes').innerHTML = S.bias.votes.map((v) =>
      `<div class="vote"><span>${v.name}</span><i class="${v.long ? 'v-long' : 'v-short'}">${v.long ? 'LONG' : 'SHORT'}</i></div>`
    ).join('');
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
      `Only <b>${b.confidence}%</b> of the 4H checks agree (60% needed).\n15m 50 EMA <b>${f1(d.ema50)}</b> · ATR <b>${f1(d.atr)}</b> · RSI <b>${f1(d.rsi)}</b>`,
      'Mixed bias is the system\'s single biggest filter — it stands aside for a reason.');

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

  async function switchSymbol() {
    const gold = S.sym === 'XAUUSD';
    const homework = S.sym === 'HOMEWORK';
    $('ctxBanner').hidden = gold || homework;
    $('chartLegend').style.display = gold ? '' : 'none';
    $('chart').hidden = homework;
    document.querySelector('.stats-strip').hidden = homework;
    $('homeworkView').hidden = !homework;
    $('chartTitle').innerHTML = gold
      ? 'GOLD SPOT <span>·</span> XAU/USD <span>·</span> 15M'
      : homework
      ? 'WEEKEND HOMEWORK <span>·</span> XAU/USD <span>·</span> week in review'
      : 'US30 <span>·</span> DOW JONES <span>·</span> 15M <span>·</span> context';
    if (gold) {
      candles.setData(S.bars15);
      const e = window.IQFX.ema(S.bars15.map((b) => b.close), 50);
      ema50Series.setData(S.bars15.map((b, i) => ({ time: b.time, value: e[i] })).filter((x) => x.value != null));
      document.querySelector('.ticker-label').textContent = 'XAU/USD';
      runEngine();
    } else if (homework) {
      neutralizeForHomework();   // clear gold panels FIRST — must not survive a fetch failure
      await loadHomework();
      return;                    // no chart on this tab
    } else {
      neutralizeForUs30();
      await loadUs30();
    }
    chart.timeScale().scrollToRealTime();
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

  function neutralizeForUs30() {
    clearGoldReadouts('US30');
    $('biasConf').textContent = 'context only — no validated edge';
    $('entryFoot').textContent = 'no signals on US30';
    $('stAsia').textContent = 'n/a (US30)';
    $('ideaGrade').textContent = 'N/A'; $('ideaGrade').className = 'idea-grade c';
    $('ideaHeadline').textContent = 'No trade ideas for US30';
    $('ideaBody').innerHTML = 'Trade Ideas are only generated for XAUUSD, where the strategy is validated. US30 failed both tests (gold rules −0.042R; US30-native strategy failed its holdout), so any US30 idea would be an opinion dressed as a signal.';
    $('ideaEdge').textContent = '📌 Switch to the XAU/USD tab for graded trade ideas.';
    $('takeVerdict').textContent = '📊 US30 — context only, no signals';
    $('tipBox').textContent = 'US30 discipline: if you trade it manually, respect the 14:00–16:00 UK window and the fact that it trends — fading it is how this instrument punishes gold habits.';
  }

  function neutralizeForHomework() {
    clearGoldReadouts('XAU/USD');
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

  async function loadUs30() {
    try {
      const j = await jget('/api/us30');
      S.us30 = j;
      candles.setData(j.bars);
      const e = window.IQFX.ema(j.bars.map((b) => b.close), 50);
      ema50Series.setData(j.bars.map((b, i) => ({ time: b.time, value: e[i] })).filter((x) => x.value != null));
      levelLines.forEach((l) => candles.removePriceLine(l)); levelLines = [];  // no signal levels on US30
      candles.setMarkers([]);
      renderUs30(j);
      $('chartSrc').textContent = `US30 (^DJI) 15m · context feed · ${new Date(j.fetched).toLocaleTimeString()}`;
    } catch (e) {
      $('chartSrc').textContent = 'US30 context feed unavailable — no data shown (gold panels cleared)';
    }
  }

  function renderUs30(j) {
    const bars = j.bars, last = bars[bars.length - 1];
    const px = j.price ?? last.close, ch = px - j.prevClose;
    $('tickerPrice').textContent = px.toFixed(0);
    $('tickerChange').textContent = `${ch >= 0 ? '+' : ''}${ch.toFixed(0)} (${(ch / j.prevClose * 100).toFixed(2)}%)`;
    $('tickerChange').className = 'delta ' + (ch >= 0 ? 'up' : 'down');
    document.querySelector('.ticker-label').textContent = 'US30';

    const today = ukParts(Date.now()).date;
    const td = bars.filter((b) => ukParts(b.time * 1000).date === today);
    const dHi = td.length ? Math.max(...td.map((b) => b.high)) : null;
    const dLo = td.length ? Math.min(...td.map((b) => b.low)) : null;
    const a = window.IQFX.atr(bars, 14), r = window.IQFX.rsi(bars.map((b) => b.close), 14);
    const mins = ukParts(Date.now()).min;
    const active = mins >= 840 && mins < 1020;   // 14:00–17:00 UK
    $('stSession').textContent = active ? 'US CASH — active' : 'outside active window';
    $('stAsia').textContent = 'n/a (US30)';
    $('stAtr').textContent = a[a.length - 1] ? `${a[a.length - 1].toFixed(0)} pts` : '—';
    $('stRsi').textContent = r[r.length - 1] ? r[r.length - 1].toFixed(0) : '—';
    $('stDay').textContent = (dHi && dLo) ? `${(dHi - dLo).toFixed(0)} pts` : '—';
    $('stNext').textContent = active ? 'Peak activity 14:00-16:00 UK' : 'Quiet — US30 moves 14:00-16:00 UK';

    $('takeBody').innerHTML = `
      <p><b>This system has no validated edge on US30.</b> Gold's rules tested <b>−0.042R</b> on it; a purpose-built US30 cash-open strategy passed development but <b>failed its holdout (+0.003R = breakeven)</b>. So: no entries, no levels, no bias here — awareness only.</p>
      <p><b>What the 2-year data says about US30:</b></p>
      <p>• It moves <b>almost only 14:00–16:00 UK</b> (~105 pts per 15m bar vs 34 the rest of the day). Outside that it's noise.</p>
      <p>• It <b>trends</b>: the first hour of US cash direction persists to the close <b>66%</b> of days — it rewards continuation, not the pullback logic gold uses.</p>
      <p>• <b>No overnight gaps</b> and a dead Asian session, so sweep setups can't form.</p>
      <p>• Cost is worse: RCG's spread ≈ <b>4.7 pts ≈ 14%</b> of a typical 15m bar (gold ≈ 9%).</p>
      <p>• Counterintuitive: US30 is <b>less</b> volatile than gold in % terms (1.00% vs 1.39% daily range).</p>
      <p>Anything you trade here is your own read — the agent is not backing it.</p>`;
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
