// 采集：跑所有数据源，合并进当天的数据文件 data/days/YYYY-MM-DD.json
// 每条内容记录首次/最近出现时间、最高排名、热度曲线（用来算蹿升速度）
import fs from 'node:fs';
import path from 'node:path';
import { DATA, DAY, bjDate, readJSON, writeJSON, loadEnv, isMain } from './util.js';
import { KEEP_DAYS } from './config.js';
import { weibo } from './sources/weibo.js';
import { douyinHot, douyinMusic } from './sources/douyin.js';
import { biliHot, biliAI, biliMusic } from './sources/bilibili.js';
import { youtube } from './sources/youtube.js';
import { qqMusic, netease } from './sources/music.js';
import { rss, hackerNews, hfTrending } from './sources/news.js';

export const SOURCES = [
  { key: 'weibo', name: '微博热搜', fn: weibo },
  { key: 'douyinHot', name: '抖音热榜', fn: douyinHot },
  { key: 'biliHot', name: 'B站热搜', fn: biliHot },
  { key: 'biliAI', name: 'B站 AI 稿件', fn: biliAI },
  { key: 'youtube', name: 'YouTube AI 视频', fn: youtube },
  { key: 'qqmusic', name: 'QQ音乐榜', fn: qqMusic },
  { key: 'netease', name: '网易云音乐榜', fn: netease },
  { key: 'douyinMusic', name: '抖音热歌榜', fn: douyinMusic },
  { key: 'biliMusic', name: 'B站音乐榜', fn: biliMusic },
  { key: 'rss', name: 'AI 资讯 RSS', fn: rss },
  { key: 'hn', name: 'Hacker News', fn: hackerNews },
  { key: 'hf', name: 'Hugging Face 热门模型', fn: hfTrending },
];

const dayFile = (d) => path.join(DATA, 'days', `${d}.json`);
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`超时 ${ms / 1000}s`)), ms))]);

async function runSources(only) {
  const list = only ? SOURCES.filter((s) => only.includes(s.key)) : SOURCES;
  const status = {};
  const items = [];
  await Promise.all(list.map(async (s) => {
    const t0 = Date.now();
    try {
      const got = await withTimeout(s.fn(), 240e3);
      items.push(...got);
      status[s.key] = { name: s.name, ok: true, count: got.length, ms: Date.now() - t0, warnings: got.warnings?.slice(0, 5) };
    } catch (e) {
      status[s.key] = { name: s.name, ok: false, count: 0, ms: Date.now() - t0, error: e.message.slice(0, 300) };
    }
    const st = status[s.key];
    console.log(`${st.ok ? '✓' : '✗'} ${s.name.padEnd(14)} ${String(st.count).padStart(4)} 条  ${(st.ms / 1000).toFixed(1)}s ${st.error || (st.warnings?.length ? `（${st.warnings.length} 个子请求失败）` : '')}`);
  }));
  return { items, status };
}

function merge(items, now) {
  const today = bjDate(now);
  const store = readJSON(dayFile(today), { date: today, items: {} });
  const prev = [1, 2, 3].map((n) => readJSON(dayFile(bjDate(now - n * DAY)), null)).filter(Boolean);
  const prior = (id) => store.items[id] || prev.find((p) => p.items[id])?.items[id];

  // 同一次采集里同一条内容可能被多个关键词搜到，合并成一条
  const run = new Map();
  for (const it of items) {
    const had = run.get(it.id);
    if (!had) { run.set(it.id, { ...it, boards: [it.board] }); continue; }
    if (!had.boards.includes(it.board)) had.boards.push(it.board);
    if ((it.heat || 0) > (had.heat || 0)) Object.assign(had, { ...it, board: had.board, boards: had.boards });
  }

  for (const it of run.values()) {
    const old = prior(it.id);
    const cur = store.items[it.id];
    const rec = {
      ...it,
      pubAt: old?.pubAt && it.src === 'youtube' ? old.pubAt : it.pubAt, // YouTube 只有「x 天前」，以第一次看到的为准
      boards: [...new Set([...(old?.boards || []), ...it.boards])],
      firstSeen: old?.firstSeen ?? now,
      lastSeen: now,
      seen: (cur?.seen || 0) + 1,
      peakRank: Math.min(old?.peakRank ?? Infinity, it.rank ?? Infinity),
      peakHeat: Math.max(old?.peakHeat ?? 0, it.heat ?? 0),
      hist: [...(old?.hist || []), [now, it.heat || 0, it.rank || 0]].slice(-16),
      ai: cur?.ai ?? old?.ai, // AI 标注跨天沿用，不重复花钱
    };
    if (!Number.isFinite(rec.peakRank)) delete rec.peakRank;
    for (const k of Object.keys(rec)) if (rec[k] === undefined || rec[k] === '') delete rec[k];
    store.items[it.id] = rec;
  }
  store.updatedAt = now;
  writeJSON(dayFile(today), store);
  return { today, total: Object.keys(store.items).length, added: run.size };
}

function prune(now) {
  const dir = path.join(DATA, 'days');
  const cutoff = bjDate(now - KEEP_DAYS * DAY);
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (f.endsWith('.json') && f.slice(0, 10) < cutoff) fs.unlinkSync(path.join(dir, f));
  }
}

export async function collect(only) {
  const now = Date.now();
  const { items, status } = await runSources(only);
  const r = merge(items, now);
  // 状态文件：记录每个源这次是否成功、上次成功是什么时候
  const old = readJSON(path.join(DATA, 'status.json'), { sources: {} });
  for (const [k, st] of Object.entries(status)) {
    st.lastOk = st.ok ? now : old.sources[k]?.lastOk;
  }
  writeJSON(path.join(DATA, 'status.json'), { runAt: now, sources: { ...old.sources, ...status } }, true);
  prune(now);
  const failed = Object.values(status).filter((s) => !s.ok).map((s) => s.name);
  console.log(`\n${r.today}：本次 ${r.added} 条，当天累计 ${r.total} 条${failed.length ? `；失败：${failed.join('、')}` : ''}`);
  return r;
}

if (isMain(import.meta.url)) {
  loadEnv();
  const only = process.argv[2]?.split(',');
  collect(only).catch((e) => { console.error(e); process.exit(1); });
}
