// GET /api/news — Fed press + Investing.com commodities + FXStreet RSS,
// parsed to JSON with a gold-relevance "hot" flag. Mirrors the local agent.
const FEEDS = [
  { name: 'Fed', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { name: 'Investing', url: 'https://www.investing.com/rss/news_11.rss' },
  { name: 'FXStreet', url: 'https://www.fxstreet.com/rss/news' },
];
const HOT_RE = /fomc|federal reserve|powell|rate (cut|hike|decision)|interest rate|monetary policy|cpi|inflation|nonfarm|payroll|unemployment claims|tariff|sanction|geopolit|missile|nuclear|air ?strike|escalat|ceasefire|safe.?haven|gold (surge|plunge|soar|crash|rall)|emergency|breaking/i;
const FED_RE = /fomc|open market committee|statement|rate|monetary policy|implementation note|chair|intermeeting/i;

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).trim();
}
function parseRss(xml, source) {
  const items = [];
  for (const c of (xml.match(/<item[\s\S]*?<\/item>/g) || []).slice(0, 15)) {
    const pick = (tag) => {
      const m = c.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i'));
      return m ? decode(m[1]) : '';
    };
    const title = pick('title');
    if (!title) continue;
    items.push({
      source, title,
      link: pick('link') || pick('guid'),
      ts: Date.parse(pick('pubDate')) || 0,
      hot: source === 'Fed' ? FED_RE.test(title) : HOT_RE.test(title),
    });
  }
  return items;
}

const { get } = require('./_http');

module.exports = async (req, res) => {
  const results = await Promise.allSettled(FEEDS.map(async (f) => parseRss(await get(f.url), f.name)));
  const items = [].concat(...results.filter((r) => r.status === 'fulfilled').map((r) => r.value));
  items.sort((a, b) => b.ts - a.ts);
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
  res.status(200).json({ items: items.slice(0, 40), fetched: Date.now() });
};
