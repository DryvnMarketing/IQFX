/* Dryvn IQFX — strategy engine.
 * Pure functions, no I/O. Mirrors the local XAU Session Agent (monitor.cjs):
 * Setup A = London sweep & reclaim of the Asian range, Setup B = NY momentum
 * pullback to the 15m EMA50, 4H bias filter, 1R from structure, TP1 = +2R.
 * All session logic runs in Europe/London regardless of viewer timezone.
 */
(function (global) {
  'use strict';

  const P = {
    slBuffer: 2.5, atrMinMult: 0.75, rrTp1: 2.0, rrTp2Min: 3.0,
    minAsiaRange: 15, maxTradesPerDay: 2,
    asiaStart: 0, asiaEnd: 480,
    ldnStart: 480, ldnEnd: 690,
    nyStart: 795, nyEnd: 1020,
    flatAt: 1245,
  };

  // ── time helpers (Europe/London) ──
  const ukFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  function ukParts(ms) {
    const p = ukFmt.formatToParts(new Date(ms));
    const get = (t) => p.find((x) => x.type === t).value;
    return {
      dow: get('weekday'),
      date: `${get('year')}-${get('month')}-${get('day')}`,
      min: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10),
    };
  }
  function ukHm(ms) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  }

  // ── indicator math ──
  function ema(vals, len) {
    if (vals.length < len) return new Array(vals.length).fill(null);
    const k = 2 / (len + 1);
    let e = vals.slice(0, len).reduce((a, b) => a + b, 0) / len;
    const out = new Array(vals.length).fill(null); out[len - 1] = e;
    for (let i = len; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out[i] = e; }
    return out;
  }
  function rsi(closes, len = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= len) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= len; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
    let ag = g / len, al = l / len;
    out[len] = 100 - 100 / (1 + ag / (al || 1e-10));
    for (let i = len + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (len - 1) + Math.max(d, 0)) / len;
      al = (al * (len - 1) + Math.max(-d, 0)) / len;
      out[i] = 100 - 100 / (1 + ag / (al || 1e-10));
    }
    return out;
  }
  function atr(bars, len = 14) {
    const out = new Array(bars.length).fill(null);
    if (bars.length <= len) return out;
    const trs = bars.map((b, i) => i === 0 ? b.high - b.low :
      Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)));
    let a = trs.slice(1, len + 1).reduce((x, y) => x + y, 0) / len;
    out[len] = a;
    for (let i = len + 1; i < bars.length; i++) { a = (a * (len - 1) + trs[i]) / len; out[i] = a; }
    return out;
  }
  function macd(closes) {
    const e12 = ema(closes, 12), e26 = ema(closes, 26);
    const line = closes.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i] - e26[i] : null);
    const valid = line.filter((v) => v != null);
    const sig = ema(valid, 9); const off = line.length - valid.length;
    const signal = line.map((_, i) => (i - off >= 0 ? sig[i - off] : null));
    const hist = line.map((v, i) => (v != null && signal[i] != null) ? v - signal[i] : null);
    return { line, signal, hist };
  }

  // ── 4H bias + confidence (five independent votes) ──
  function biasReport(bars4h) {
    const c = bars4h.map((b) => b.close);
    const e50 = ema(c, 50), e200 = ema(c, 200), m = macd(c), r = rsi(c);
    const i = c.length - 1;

    // structure: compare last two swing lows / highs on 4H
    const sw = { hi: [], lo: [] };
    for (let j = 2; j < bars4h.length - 2; j++) {
      const b = bars4h[j];
      if (b.high > bars4h[j-1].high && b.high > bars4h[j-2].high && b.high > bars4h[j+1].high && b.high > bars4h[j+2].high) sw.hi.push(b.high);
      if (b.low < bars4h[j-1].low && b.low < bars4h[j-2].low && b.low < bars4h[j+1].low && b.low < bars4h[j+2].low) sw.lo.push(b.low);
    }
    const hlUp = sw.lo.length >= 2 && sw.lo[sw.lo.length - 1] > sw.lo[sw.lo.length - 2];
    const lhDown = sw.hi.length >= 2 && sw.hi[sw.hi.length - 1] < sw.hi[sw.hi.length - 2];

    const votes = [
      { name: 'Price vs 4H EMA50',   long: c[i] > e50[i],                       detail: `${c[i].toFixed(1)} vs ${e50[i]?.toFixed(1)}` },
      { name: 'EMA50 vs EMA200',     long: e200[i] != null ? e50[i] > e200[i] : c[i] > e50[i], detail: e200[i] ? `${e50[i].toFixed(1)} vs ${e200[i].toFixed(1)}` : 'EMA200 warming up' },
      { name: 'MACD momentum',       long: m.line[i] > m.signal[i],             detail: `line ${m.line[i]?.toFixed(2)} vs signal ${m.signal[i]?.toFixed(2)}` },
      { name: 'RSI regime',          long: r[i] > 50,                           detail: `RSI ${r[i]?.toFixed(1)}` },
      { name: 'Market structure',    long: hlUp && !lhDown,                     detail: hlUp ? 'higher lows' : lhDown ? 'lower highs' : 'mixed swings' },
    ];
    const longVotes = votes.filter((v) => v.long).length;
    const shortVotes = votes.length - longVotes;
    const dir = longVotes > shortVotes ? 'LONG' : 'SHORT';
    const confidence = Math.round(Math.max(longVotes, shortVotes) / votes.length * 100);
    return {
      dir, confidence, votes,
      long: longVotes >= 4, short: shortVotes >= 4,   // agent-equivalent strict filter
      tradeable: confidence >= 60,
      ema50: e50[i], ema200: e200[i], rsi: r[i],
    };
  }

  // weekly buy/sell pressure: per-4H-bar votes across the last ~5 trading days
  function weeklyBias(bars4h) {
    const c = bars4h.map((b) => b.close);
    const e50 = ema(c, 50), m = macd(c);
    const lastWeek = [];
    for (let i = Math.max(0, c.length - 30); i < c.length; i++) {
      if (e50[i] == null || m.hist[i] == null) continue;
      let v = 0;
      if (c[i] > e50[i]) v++; else v--;
      if (m.hist[i] > 0) v++; else v--;
      if (c[i] > (c[i - 6] ?? c[i])) v++; else v--;
      lastWeek.push(v);
    }
    if (!lastWeek.length) return { buy: 50, sell: 50 };
    const buyScore = lastWeek.filter((v) => v > 0).length + lastWeek.filter((v) => v === 0).length / 2;
    const buy = Math.round(buyScore / lastWeek.length * 100);
    return { buy, sell: 100 - buy };
  }

  // ── day analysis on 15m bars (bars: {time(sec), open, high, low, close}) ──
  function analyzeDay(bars15, bias, nowMs) {
    const now = ukParts(nowMs);
    const closed = bars15.filter((b) => (b.time + 900) * 1000 <= nowMs); // fully closed bars
    const todays = closed.filter((b) => ukParts(b.time * 1000).date === now.date);

    const closes = closed.map((b) => b.close);
    const r = rsi(closes), a = atr(closed), m = macd(closes), e50 = ema(closes, 50);
    const i = closed.length - 1;

    const res = {
      date: now.date, ukMin: now.min, dow: now.dow,
      atr: a[i], rsi: r[i], ema50: e50[i], macdHist: m.hist[i],
      asia: null, signal: null, signalState: 'waiting', dayHi: null, dayLo: null,
      sweep: { lo: false, hi: false },
    };
    if (!todays.length) return res;

    res.dayHi = Math.max(...todays.map((b) => b.high));
    res.dayLo = Math.min(...todays.map((b) => b.low));

    const asiaBars = todays.filter((b) => { const mm = ukParts(b.time * 1000).min; return mm >= P.asiaStart && mm < P.asiaEnd; });
    if (asiaBars.length >= 4) {
      const hi = Math.max(...asiaBars.map((b) => b.high));
      const lo = Math.min(...asiaBars.map((b) => b.low));
      res.asia = { hi, lo, range: hi - lo, ok: hi - lo >= P.minAsiaRange, done: now.min >= P.asiaEnd };
    }

    // replay today's London/NY bars through the same state machine as the agent
    let fired = null;
    let aLongDone = false, aShortDone = false, trades = 0;
    let sweepLoExt = null, sweepHiExt = null;

    for (let k = 0; k < todays.length; k++) {
      const b = todays[k];
      const mm = ukParts(b.time * 1000).min;
      const gi = closed.indexOf(b); // global index for indicator arrays
      if (gi < 1 || fired) continue;

      if (res.asia && mm >= P.ldnStart && mm < P.ldnEnd && res.asia.ok) {
        if (b.low < res.asia.lo) { res.sweep.lo = true; sweepLoExt = sweepLoExt == null ? b.low : Math.min(sweepLoExt, b.low); }
        if (b.high > res.asia.hi) { res.sweep.hi = true; sweepHiExt = sweepHiExt == null ? b.high : Math.max(sweepHiExt, b.high); }

        const rsiWin = r.slice(Math.max(0, gi - 5), gi + 1).filter((v) => v != null);
        const hookL = rsiWin.length && Math.min(...rsiWin) < 35 && r[gi] > r[gi - 1];
        const hookS = rsiWin.length && Math.max(...rsiWin) > 65 && r[gi] < r[gi - 1];
        const third = res.asia.range / 3;

        if (!aLongDone && res.sweep.lo && bias.long && b.close > res.asia.lo && b.close <= res.asia.lo + third && b.close > b.open && hookL) {
          aLongDone = true; trades++;
          fired = mkSignal('A', 'LONG', b, gi, { sweepExt: sweepLoExt, asia: res.asia, a, closedBars: closed });
        } else if (!aShortDone && res.sweep.hi && bias.short && b.close < res.asia.hi && b.close >= res.asia.hi - third && b.close < b.open && hookS) {
          aShortDone = true; trades++;
          fired = mkSignal('A', 'SHORT', b, gi, { sweepExt: sweepHiExt, asia: res.asia, a, closedBars: closed });
        }
      }

      if (!fired && mm >= P.nyStart && mm < P.nyEnd && trades < P.maxTradesPerDay) {
        const histOk = m.hist[gi] != null && m.hist[gi - 1] != null;
        if (bias.long && b.low <= e50[gi] && b.close > e50[gi] && b.close > b.open && r[gi] >= 40 && r[gi] <= 60 && histOk && m.hist[gi] > m.hist[gi - 1]) {
          trades++;
          fired = mkSignal('B', 'LONG', b, gi, { asia: res.asia, a, closedBars: closed, dayHi: res.dayHi, dayLo: res.dayLo });
        } else if (bias.short && b.high >= e50[gi] && b.close < e50[gi] && b.close < b.open && r[gi] >= 40 && r[gi] <= 60 && histOk && m.hist[gi] < m.hist[gi - 1]) {
          trades++;
          fired = mkSignal('B', 'SHORT', b, gi, { asia: res.asia, a, closedBars: closed, dayHi: res.dayHi, dayLo: res.dayLo });
        }
      }
    }

    res.signal = fired;
    if (fired) {
      // trade state vs subsequent price action
      const after = todays.filter((b) => b.time > fired.barTime);
      const isLong = fired.dir === 'LONG';
      let state = 'open', tp1Done = false, sl = fired.sl;
      let tp1At = null, tp2At = null, endAt = null, lastClose = fired.entry;
      for (const b of after) {
        lastClose = b.close;
        const hitTp1 = !tp1Done && (isLong ? b.high >= fired.tp1 : b.low <= fired.tp1);
        if (hitTp1) { tp1Done = true; sl = fired.entry; tp1At = b.time; }
        if (isLong ? b.low <= sl : b.high >= sl) { state = tp1Done ? 'closed-be' : 'stopped'; endAt = b.time; break; }
        if (isLong ? b.high >= fired.tp2 : b.low <= fired.tp2) { state = 'tp2'; tp2At = b.time; endAt = b.time; break; }
      }
      if (state === 'open' && now.min >= P.flatAt) state = 'flat-time';
      // realized R: 50% banked at TP1 (+2R), runner to TP2 / BE / day close
      const dirSign = isLong ? 1 : -1;
      const closeR = (lastClose - fired.entry) * dirSign / fired.risk;
      const tp2R = Math.abs(fired.tp2 - fired.entry) / fired.risk;
      let netR = null;
      if (state === 'stopped') netR = -1;
      else if (state === 'closed-be') netR = 0.5 * P.rrTp1;
      else if (state === 'tp2') netR = 0.5 * P.rrTp1 + 0.5 * tp2R;
      else if (state === 'flat-time') netR = tp1Done ? 0.5 * P.rrTp1 + 0.5 * closeR : closeR;
      res.signalState = state;
      Object.assign(res.signal, { tp1Done, liveSl: sl, tp1At, tp2At, endAt, netR });
    }
    return res;
  }

  // ── historical replay: run the day engine over each past trading day ──
  function backtest(bars15, bars4h) {
    const dates = [];
    const seen = new Set();
    for (const b of bars15) {
      const p = ukParts(b.time * 1000);
      if (!seen.has(p.date) && !['Sat', 'Sun'].includes(p.dow)) { seen.add(p.date); dates.push(p.date); }
    }
    const trades = [];
    for (const date of dates) {
      const dayBars = bars15.filter((b) => ukParts(b.time * 1000).date === date);
      if (dayBars.length < 40) continue; // partial day (history edge)
      const dayStartMs = dayBars[0].time * 1000;
      const biasCutoffMs = dayStartMs + 460 * 60 * 1000; // 07:40 UK
      const hist4h = bars4h.filter((b) => b.time * 1000 < biasCutoffMs);
      if (hist4h.length < 60) continue;
      const bias = biasReport(hist4h);
      // end-of-day instant: after the last bar closes but still within the same UK date
      const endMs = (dayBars[dayBars.length - 1].time + 899) * 1000;
      const upTo = bars15.filter((b) => b.time * 1000 <= endMs);
      const day = analyzeDay(upTo, bias, endMs);
      if (day.signal) trades.push({ date, ...day.signal, state: day.signalState });
    }

    function agg(list) {
      const done = list.filter((t) => t.state !== 'open');
      const tp1 = done.filter((t) => t.tp1At != null);
      const tp2 = done.filter((t) => t.state === 'tp2');
      const sl = done.filter((t) => t.state === 'stopped');
      const be = done.filter((t) => t.state === 'closed-be');
      const mins = (arr, key) => {
        const v = arr.filter((t) => t[key] != null).map((t) => (t[key] - t.barTime) / 60 + 15);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      };
      return {
        signals: done.length,
        tp1: tp1.length, tp2: tp2.length, sl: sl.length, be: be.length,
        flat: done.filter((t) => t.state === 'flat-time').length,
        tp1Pct: done.length ? Math.round(tp1.length / done.length * 100) : null,
        avgToTp1: mins(tp1, 'tp1At'),
        avgToTp2: mins(tp2, 'tp2At'),
        netR: done.reduce((a, t) => a + (t.netR || 0), 0),
      };
    }
    return {
      days: dates.length, trades,
      uk: agg(trades.filter((t) => t.setup === 'A')),
      ny: agg(trades.filter((t) => t.setup === 'B')),
      all: agg(trades),
    };
  }

  function mkSignal(setup, dir, b, gi, ctx) {
    const entry = b.close;
    const curAtr = ctx.a[gi] || 6;
    let sl;
    if (setup === 'A') {
      sl = dir === 'LONG'
        ? Math.min(ctx.sweepExt - P.slBuffer, entry - P.atrMinMult * curAtr)
        : Math.max(ctx.sweepExt + P.slBuffer, entry + P.atrMinMult * curAtr);
    } else {
      const gi0 = Math.max(0, gi - 5);
      const lo6 = Math.min(...ctx.closedBars.slice(gi0, gi + 1).map((x) => x.low));
      const hi6 = Math.max(...ctx.closedBars.slice(gi0, gi + 1).map((x) => x.high));
      sl = dir === 'LONG'
        ? Math.min(lo6 - P.slBuffer, entry - P.atrMinMult * curAtr)
        : Math.max(hi6 + P.slBuffer, entry + P.atrMinMult * curAtr);
    }
    const risk = Math.abs(entry - sl);
    const tp1 = dir === 'LONG' ? entry + P.rrTp1 * risk : entry - P.rrTp1 * risk;
    let tp2;
    if (setup === 'A') {
      tp2 = dir === 'LONG' ? Math.max(ctx.asia.hi, entry + P.rrTp2Min * risk) : Math.min(ctx.asia.lo, entry - P.rrTp2Min * risk);
    } else {
      tp2 = dir === 'LONG' ? Math.max(ctx.dayHi ?? entry, entry + P.rrTp2Min * risk) : Math.min(ctx.dayLo ?? entry, entry - P.rrTp2Min * risk);
    }
    return { setup, dir, entry, sl, tp1, tp2, risk, barTime: b.time };
  }

  // ── session / market clock ──
  function sessionInfo(nowMs) {
    const { dow, min } = ukParts(nowMs);
    const wk = !['Sat', 'Sun'].includes(dow);
    // XAUUSD CFD hours: Sun 23:00 → Fri 22:00 UK, daily break 22:00–23:00 UK
    let open = false;
    if (dow === 'Sun') open = min >= 1380;
    else if (dow === 'Fri') open = min < 1320;
    else if (wk) open = min < 1320 || min >= 1380;
    let phase, next;
    if (!wk && dow === 'Sat') { phase = 'WEEKEND'; next = 'Market reopens Sunday 23:00 UK'; }
    else if (dow === 'Sun' && !open) { phase = 'WEEKEND'; next = 'Market reopens 23:00 UK tonight'; }
    else if (min < P.asiaEnd) { phase = 'ASIA'; next = `London window opens 08:00 UK`; }
    else if (min < P.ldnEnd) { phase = 'LONDON'; next = 'Setup A window — sweep & reclaim'; }
    else if (min < P.nyStart) { phase = 'LUNCH'; next = 'NY window opens 13:15 UK'; }
    else if (min < P.nyEnd) { phase = 'NEW YORK'; next = 'Setup B window — momentum pullback'; }
    else if (min < P.flatAt) { phase = 'LATE NY'; next = 'Flat rule at 20:45 UK'; }
    else { phase = 'CLOSED-ISH'; next = 'No trading — flat until tomorrow'; }
    return { open, phase, next, dow, ukMin: min };
  }

  global.IQFX = { P, ema, rsi, atr, macd, biasReport, weeklyBias, analyzeDay, backtest, sessionInfo, ukParts, ukHm };
})(typeof window !== 'undefined' ? window : globalThis);
