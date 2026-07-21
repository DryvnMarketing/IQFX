// GET /api/news — Fed press + Investing.com commodities + FXStreet RSS,
// parsed to JSON with a gold-relevance "hot" flag. Mirrors the local agent.
const FEEDS = [
  { name: 'Fed', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { name: 'Investing', url: 'https://www.investing.com/rss/news_11.rss' },
  { name: 'FXStreet', url: 'https://www.fxstreet.com/rss/news' },
];
const HOT_RE = /fomc|federal reserve|powell|rate (cut|hike|decision)|interest rate|monetary policy|cpi|inflation|nonfarm|payroll|unemployment claims|tariff|sanction|geopolit|missile|nuclear|air ?strike|escalat|ceasefire|safe.?haven|gold (surge|plunge|soar|crash|rall)|emergency|breaking/i;
const FED_RE = /fomc|open market committee|statement|rate|monetary policy|implementation note|chair|intermeeting/i;

// ── RELEVANCE GATE — only headlines that plausibly move XAUUSD (gold) or US30 (Dow).
// Gold: USD / rates / inflation / jobs / safe-haven. US30: US equities / risk sentiment.
// Shared: Fed, macro data, tariffs, and MAJOR geopolitical shocks (Shaun: keep the big
// safe-haven headlines, drop the routine noise). NEWS_NOISE kills FX crosses, crypto,
// single non-Dow names and sector commodities (oil-price chatter, gas, silver, copper)
// even when they brush a relevant word. Mirrored in agent monitor.cjs.
const NEWS_RELEVANT = /\b(fed|fomc|powell|rate ?(cut|hike|decision|path)|interest rate|monetary policy|hawkish|dovish|beige book|balance sheet|quantitative|\bqt\b|cpi|inflation|\bppi\b|\bpce\b|deflation|non-?farm|payrolls?|\bnfp\b|jobless|unemployment|jobs report|labou?r market|\bgdp\b|recession|\bism\b|\bpmi\b|retail sales|consumer confidence|durable goods|dollar|\bdxy\b|greenback|treasur(y|ies)|bond yields?|\byields?\b|real rate|gold|\bxau\b|bullion|precious metal|dow jones|\bdow\b|wall street|s ?& ?p|nasdaq|u\.?s\.? stocks|equit(y|ies)|stock market|risk[- ]o(n|ff)|sell-?off|tariffs?|trade war|trade deal|export control|\becb\b|bank of england|\bboe\b|bank of japan|\bboj\b|wars?|missiles?|air ?strikes?|military strike|strikes? (on|against|hit)|drone strikes?|warplanes?|bombing|bombard|retaliat|nuclear|sanctions?|escalat|ceasefire|invasion|\bopec\b|safe[- ]haven|geopolit)\b/i;
const NEWS_NOISE = /\b(yuan|renminbi|peso|rupee|rupiah|\blira\b|roubles?|rubles?|\brand\b|forint|zloty|ringgit|\bbaht\b|krona|krone|\bwon\b|shekel|bitcoins?|ethereum|crypto|\bbtc\b|\beth\b|solana|\bxrp\b|dogecoin|silver|\bxag\b|copper|natural gas|nat ?gas|gas prices|lumber|wheat|\bcorn\b|coffee|cocoa|iron ore|lithium|uranium|\bcoal\b)\b/i;
const FED_POLICY = /fomc|open market committee|monetary policy|rate ?(cut|hike|decision|move|path)|interest rate|policy (statement|decision)|dot plot|economic projections|powell|beige book|balance sheet|quantitative|\bqt\b/i;
function impactsGoldOrDow(source, title) {
  if (source === 'Fed') return FED_POLICY.test(title);       // Fed feed carries admin/regulatory noise — policy only
  return NEWS_RELEVANT.test(title) && !NEWS_NOISE.test(title);
}

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
  const all = [].concat(...results.filter((r) => r.status === 'fulfilled').map((r) => r.value));
  // Only surface headlines that plausibly move gold or the Dow — the panel is a
  // trading tool, not a general news feed.
  const items = all.filter((i) => impactsGoldOrDow(i.source, i.title));
  items.sort((a, b) => b.ts - a.ts);
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
  res.status(200).json({ items: items.slice(0, 40), fetched: Date.now(), scanned: all.length, kept: items.length });
};
