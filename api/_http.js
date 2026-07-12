// Shared https getter for the API routes (underscore file = not exposed as an endpoint).
// Uses node:https rather than fetch/undici for maximum environment compatibility.
'use strict';
const https = require('https');

function get(url, hop = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 DryvnIQFX/1.0' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && hop < 2) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, hop + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`timeout for ${url}`)));
  });
}
async function getJson(url) { return JSON.parse(await get(url)); }

module.exports = { get, getJson };
