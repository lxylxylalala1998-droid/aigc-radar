import { http, clean, parseCount, sleep, HOUR, DAY } from '../util.js';
import { YT_QUERIES } from '../config.js';

// "3 days ago" / "5 hours ago" → 大概的发布时间
function agoToTs(s = '') {
  const m = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i);
  if (!m) return undefined;
  const unit = { second: 1e3, minute: 60e3, hour: HOUR, day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY }[m[2].toLowerCase()];
  return Date.now() - (+m[1]) * unit;
}

function findAll(node, key, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const x of node) findAll(x, key, out); return out; }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(v);
    else findAll(v, key, out);
  }
  return out;
}

const text = (t) => t?.simpleText ?? (t?.runs || []).map((r) => r.text).join('');

async function viaScrape(q) {
  // sp = 按播放量排序 + 本周上传 + 只要视频
  const html = await http(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=CAMSBAgDEAE%253D`, {
    type: 'text', headers: { 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
  });
  const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s) || html.match(/ytInitialData"\]\s*=\s*(\{.+?\});/s);
  if (!m) throw new Error('页面里找不到 ytInitialData');
  const data = JSON.parse(m[1]);
  return findAll(data, 'videoRenderer').map((v) => ({
    id: v.videoId,
    title: text(v.title),
    author: text(v.ownerText),
    views: parseCount(text(v.viewCountText)),
    pubAt: agoToTs(text(v.publishedTimeText)),
    cover: v.thumbnail?.thumbnails?.at(-1)?.url,
  }));
}

async function viaApi(q, key) {
  const after = new Date(Date.now() - 7 * DAY).toISOString();
  const s = await http(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=20&publishedAfter=${after}&q=${encodeURIComponent(q)}&key=${key}`);
  const ids = (s.items || []).map((x) => x.id.videoId).join(',');
  if (!ids) return [];
  const v = await http(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${ids}&key=${key}`);
  return (v.items || []).map((x) => ({
    id: x.id, title: x.snippet.title, author: x.snippet.channelTitle,
    views: +x.statistics.viewCount || 0, likes: +x.statistics.likeCount || 0,
    pubAt: Date.parse(x.snippet.publishedAt), cover: x.snippet.thumbnails?.medium?.url,
  }));
}

// YouTube AI 视频（本周上传，按播放量）。配了 YT_API_KEY 就走官方 API，否则解析搜索页
export async function youtube() {
  const key = process.env.YT_API_KEY;
  const out = [];
  const errors = [];
  for (const q of YT_QUERIES) {
    try {
      const list = key ? await viaApi(q, key) : await viaScrape(q);
      for (const v of list.slice(0, 20)) {
        out.push({
          id: `yt:${v.id}`,
          cat: 'video', src: 'youtube', board: `搜索·${q}`,
          title: clean(v.title), author: v.author,
          url: `https://www.youtube.com/watch?v=${v.id}`,
          cover: v.cover, heat: v.views, pubAt: v.pubAt,
          m: { play: v.views, like: v.likes || 0 },
        });
      }
    } catch (e) { errors.push(`${q}: ${e.message}`); }
    await sleep(800);
  }
  if (!out.length) throw new Error(errors.slice(0, 2).join('; ') || 'YouTube 无结果');
  out.warnings = errors;
  return out;
}
