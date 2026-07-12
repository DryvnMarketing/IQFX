// GET /api/spot — real XAU/USD spot (bid/ask/mid) from Swissquote's public feed.
// Used by the client to calibrate the 24/7 PAXG tick stream to true forex gold.
const { getJson } = require('./_http');

module.exports = async (req, res) => {
  try {
    const data = await getJson('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD');
    // take the tightest (elite/prime) profile across platforms
    let best = null;
    for (const platform of data) {
      for (const p of platform.spreadProfilePrices || []) {
        if (!best || (p.ask - p.bid) < (best.ask - best.bid)) best = p;
      }
    }
    if (!best) throw new Error('no quotes in payload');
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=20');
    res.status(200).json({ bid: best.bid, ask: best.ask, mid: +((best.bid + best.ask) / 2).toFixed(3), ts: Date.now() });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: e.message });
  }
};
