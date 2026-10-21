// 临时调试：看 YouTube 搜索页里视频条目的真实字段结构
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
function findAll(node, key, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const x of node) findAll(x, key, out); return out; }
  for (const [k, v] of Object.entries(node)) { if (k === key) out.push(v); else findAll(v, key, out); }
  return out;
}
const text = (t) => t?.simpleText ?? (t?.runs || []).map((r) => r.text).join('');
for (const [name, sp] of [['按播放量+本周', 'CAMSBAgDEAE%253D'], ['相关性+本周', 'EgQIAxAB'], ['相关性+今天', 'EgQIAhAB']]) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent('AI music video')}&sp=${sp}&hl=en&gl=US`;
  const html = await (await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' } })).text();
  const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  console.log(`\n===== ${name} | html ${html.length}B | ytInitialData ${!!m}`);
  if (!m) continue;
  const data = JSON.parse(m[1]);
  const vr = findAll(data, 'videoRenderer');
  console.log('videoRenderer 数量', vr.length, '| lockupViewModel 数量', findAll(data, 'lockupViewModel').length);
  if (vr[0]) console.log('字段:', Object.keys(vr[0]).join(','));
  if (vr[0]) console.log('publishedTimeText:', JSON.stringify(vr[0].publishedTimeText), '| viewCountText:', JSON.stringify(vr[0].viewCountText)?.slice(0, 120));
  for (const v of vr.slice(0, 8)) console.log(`  - ${text(v.title).slice(0, 60)} | ${text(v.viewCountText)} | ${text(v.publishedTimeText)}`);
}
