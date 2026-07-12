# DRYVN IQFX — XAUUSD Session Intelligence

Personal trading mentor and live decision-support dashboard for gold (XAU/USD),
built around a London/NY 15-minute session strategy.

## What it shows

- **Live XAUUSD chart (15m)** — candles stream in real time from the 24/7 PAXG
  gold feed, continuously calibrated to true forex XAU/USD via a Swissquote spot
  anchor. The agent's levels are drawn straight on the chart: Asian range,
  Entry, Stop Loss, TP1 (+2R), TP2.
- **KPI row** — today's bias (or SIT OUT below 60% confidence), Entry, TP1, TP2
  and SL as prices.
- **Agent's Take** — plain-language plan for the day: which side to trade, what
  to wait for, and when the honest answer is to do nothing.
- **Weekly bias** — buy/sell pressure percentage for the week with the five 4H
  votes behind it.
- **Today's events** — high-impact USD calendar (ForexFactory + MetalsMine)
  with per-event trading analysis and live blackout status.
- **Live headlines** — Fed press releases, Investing.com commodities and
  FXStreet, with gold-relevant stories flagged.

## Strategy (same engine as the local XAU Session Agent)

- **Setup A** — London sweep & reclaim of the Asian range (08:00–11:30 UK)
- **Setup B** — NY momentum pullback to the 15m EMA50 (13:15–17:00 UK)
- 4H bias filter (EMA50/EMA200, MACD, RSI, structure — 5 votes, 60% threshold)
- 1R from structure, TP1 = +2R then breakeven, max 2 trades/day, flat 20:45 UK

## Stack

Zero-build static site + Vercel serverless functions.

```
index.html / styles.css / app.js   UI
engine.js                          strategy engine (pure functions)
api/spot.js                        XAU/USD spot (Swissquote) — basis calibration
api/calendar.js                    ForexFactory + MetalsMine merged calendar
api/news.js                        Fed / Investing / FXStreet RSS → JSON
dev-server.js                      local dev: node dev-server.js → :3210
```

## Deploy

Import this repo in Vercel (no build settings needed) — static files serve as-is
and `api/` becomes serverless functions.

---
*Rule-based analysis, not financial advice. Execution and risk are always yours.*
