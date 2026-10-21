import { XMLParser } from 'fast-xml-parser';
import { http, clean, isAI, DAY } from '../util.js';
import { RSS_FEEDS } from '../config.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const txt = (x) => (typeof x === 'object' && x ? x['#text'] ?? '' : x ?? '');

function linkOf(e) {
  if (typeof e.link === 'string') return e.link;
  const ls = arr(e.link);
  return (ls.find((l) => l['@rel'] === 'alternate') || ls[0])?.['@href'] || txt(e.guid);
}

async function feed(f) {
  const xml = await http(f.url, { type: 'text', retries: 1 });
  const doc = parser.parse(xml);
  const entries = doc.rss ? arr(doc.rss.channel?.item) : arr(doc.feed?.entry);
  const since = Date.now() - 3 * DAY;
  return entries
    .map((e) => ({
      title: clean(txt(e.title)),
      url: String(linkOf(e) || '').trim(),
      pubAt: Date.parse(e.pubDate || e.published || e.updated || e['dc:date'] || '') || undefined,
      desc: clean(txt(e.description || e.summary || e['content:encoded'] || '')).slice(0, 160),
    }))
    .filter((e) => e.title && e.url && (!e.pubAt || e.pubAt > since) && (!f.filter || isAI(e.title)))
    .map((e) => ({ id: `news:${e.url}`, cat: 'news', src: f.name, board: 'AI资讯', ...e }));
}

// RSS 资讯：各源独立，失败的记下来不影响其它
export async function rss() {
  const out = [];
  const errors = [];
  const res = await Promise.allSettled(RSS_FEEDS.map(feed));
  res.forEach((r, i) => (r.status === 'fulfilled' ? out.push(...r.value) : errors.push(`${RSS_FEEDS[i].name}: ${r.reason.message}`)));
  if (!out.length) throw new Error(errors.join('; '));
  out.warnings = errors;
  return out;
}

// Hacker News 上热度高的 AI 帖（海外行业大事件的风向标）
export async function hackerNews() {
  const since = Math.floor((Date.now() - 2 * DAY) / 1000);
  const j = await http(`https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=300&numericFilters=created_at_i>${since},points>100`);
  return (j.hits || [])
    .filter((h) => isAI(h.title))
    .map((h) => ({
      id: `news:hn:${h.objectID}`, cat: 'news', src: 'Hacker News', board: 'AI资讯',
      title: clean(h.title),
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      pubAt: h.created_at_i * 1000,
      heat: h.points, m: { comments: h.num_comments, hn: `https://news.ycombinator.com/item?id=${h.objectID}` },
    }));
}

// Hugging Face 热门模型（新模型发布最直接的信号）
export async function hfTrending() {
  const list = await http('https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=25');
  return list.map((x, i) => ({
    id: `hf:${x.id}`, cat: 'news', src: 'Hugging Face', board: 'HF 热门模型',
    title: x.id, url: `https://huggingface.co/${x.id}`,
    pubAt: x.createdAt ? Date.parse(x.createdAt) : undefined,
    heat: x.likes || 0, rank: i + 1,
    desc: [x.pipeline_tag, x.downloads ? `下载 ${x.downloads}` : ''].filter(Boolean).join(' · '),
    m: { likes: x.likes, downloads: x.downloads },
  }));
}
