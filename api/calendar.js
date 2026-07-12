// GET /api/calendar — ForexFactory + MetalsMine weekly calendars, merged and
// de-duplicated. Same feeds and filter philosophy as the local XAU Session Agent.
const FEEDS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/mm_calendar_thisweek.json',
];

const { getJson } = require('./_http');

module.exports = async (req, res) => {
  const results = await Promise.allSettled(FEEDS.map((u) => getJson(u)));
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: results.map((r) => String(r.reason)).join('; ') });
  }
  const seen = new Set();
  const merged = [];
  for (const e of [].concat(...ok)) {
    const key = `${e.title}|${e.country}|${e.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ts = Date.parse(e.date);
    if (Number.isNaN(ts)) continue;
    merged.push({ title: e.title, country: e.country, impact: e.impact, forecast: e.forecast || '', previous: e.previous || '', ts });
  }
  merged.sort((a, b) => a.ts - b.ts);
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
  res.status(200).json({ events: merged, fetched: Date.now() });
};
