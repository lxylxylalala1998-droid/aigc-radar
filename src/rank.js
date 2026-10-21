// 读取时间窗内的数据、算蹿升速度 —— curate / build / mail 共用
import fs from 'node:fs';
import path from 'node:path';
import { DATA, DAY, HOUR, bjDate, readJSON } from './util.js';

const dayFile = (d) => path.join(DATA, 'days', `${d}.json`);

// 把最近 n 天的日文件合并成 id → item（同一条跨天出现时取最新的那份，保留最早的 firstSeen）
export function loadWindow(days, now = Date.now()) {
  const map = new Map();
  for (let i = Math.ceil(days); i >= 0; i--) {
    const f = dayFile(bjDate(now - i * DAY));
    if (!fs.existsSync(f)) continue;
    for (const it of Object.values(readJSON(f).items)) {
      const had = map.get(it.id);
      map.set(it.id, had
        ? { ...it, firstSeen: Math.min(had.firstSeen, it.firstSeen), peakRank: Math.min(had.peakRank ?? 1e9, it.peakRank ?? 1e9), peakHeat: Math.max(had.peakHeat || 0, it.peakHeat || 0), ai: it.ai || had.ai, daysSeen: had.daysSeen + 1 }
        : { ...it, daysSeen: 1 });
    }
  }
  const since = now - days * DAY;
  return [...map.values()].filter((it) => it.lastSeen >= since).map((it) => (it.peakRank >= 1e9 ? { ...it, peakRank: undefined } : it));
}

// 视频蹿升：有历史采样就用「最近约 24 小时的增量 / 小时」，否则用「总播放 / 发布至今小时数」
export function velocity(it, now = Date.now()) {
  const cur = it.heat || 0;
  const old = (it.hist || []).filter((p) => p[0] <= now - 3 * HOUR);
  if (old.length) {
    const target = now - DAY;
    const ref = old.reduce((a, p) => (Math.abs(p[0] - target) < Math.abs(a[0] - target) ? p : a));
    const hrs = (now - ref[0]) / HOUR;
    return { perHour: Math.max(0, (cur - ref[1]) / hrs), basis: 'delta', hours: hrs };
  }
  const hrs = Math.max(1, (now - (it.pubAt || it.firstSeen)) / HOUR);
  return { perHour: cur / hrs, basis: 'avg', hours: hrs };
}

export const PLATFORM = {
  weibo: '微博', douyin: '抖音', bilibili: 'B站', youtube: 'YouTube', qqmusic: 'QQ音乐', netease: '网易云',
};

// 精简成网页 / 邮件需要的字段
export function slim(it, now = Date.now()) {
  const o = {
    id: it.id, cat: it.cat, src: it.src, board: it.board, title: it.title, url: it.url,
    author: it.author, cover: it.cover, desc: it.desc, heat: it.heat, rank: it.rank, peakRank: it.peakRank,
    label: it.label, pubAt: it.pubAt, daysSeen: it.daysSeen, firstSeen: it.firstSeen, lastSeen: it.lastSeen, m: it.m, ai: it.ai,
  };
  if (it.cat === 'video') o.vel = Math.round(velocity(it, now).perHour);
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '') delete o[k];
  return o;
}
