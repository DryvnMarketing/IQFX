// GET /api/us30 — Dow Jones (^DJI) 15m bars + quote, for the CONTEXT-ONLY US30 tab.
// NOTE: US30 has NO validated edge in this system — this route feeds market context
// (chart, ranges, session state) only. It must never be used to emit trade signals.
const { get } = require('./_http');

module.exports = async (req, res) => {
  try {
    const raw = await get('https://query1.finance.yahoo.com/v8/finance/chart/%5EDJI?interval=15m&range=1mo');
    const r = JSON.parse(raw).chart.result[0];
    const q = r.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      if (q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
      bars.push({ time: r.timestamp[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] });
    }
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({
      symbol: 'US30 (^DJI)',
      price: r.meta.regularMarketPrice,
      prevClose: r.meta.chartPreviousClose,
      bars,
      fetched: Date.now(),
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: e.message });
  }
};
