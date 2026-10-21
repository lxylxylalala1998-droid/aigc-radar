// 生成网页：把 web/ 拷到 site/，并把数据预聚合成 24h / 3天 / 7天 / 30天 四份
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA, DAY, bjDate, readJSON, writeJSON, isMain } from './util.js';
import { loadWindow, slim } from './rank.js';

const SITE = path.join(ROOT, 'site');
const WINDOWS = [1, 3, 7, 30];
const LIMIT = { news: 400, video: 500, trend: 120, music: 50 };

function digestsIn(days, now) {
  const out = [];
  for (let i = 0; i < days + 1 && out.length < days; i++) {
    const d = readJSON(path.join(DATA, 'digests', `${bjDate(now - i * DAY)}.json`));
    if (d && d.generatedAt > now - (days + 1) * DAY) {
      out.push({ date: d.date, generatedAt: d.generatedAt, ai: d.ai, picks: d.picks, news: d.news });
    }
  }
  return out;
}

function windowData(days, now) {
  const all = loadWindow(days, now).map((x) => slim(x, now));
  const by = (cat) => all.filter((x) => x.cat === cat);

  const news = by('news').sort((a, b) => (b.pubAt || b.firstSeen) - (a.pubAt || a.firstSeen)).slice(0, LIMIT.news);

  // 24 小时看蹿升，更长的窗口看总播放；只要窗口内发布的
  const videos = by('video')
    .filter((x) => x.pubAt >= now - Math.max(days, 3) * DAY && x.ai?.type !== '非AIGC') // 没有发布时间的不展示，蹿升算不准
    .sort(days === 1 ? (a, b) => (b.vel || 0) - (a.vel || 0) : (a, b) => (b.heat || 0) - (a.heat || 0))
    .slice(0, LIMIT.video);

  const trends = ['weibo', 'douyin', 'bilibili'].flatMap((src) => by('trend')
    .filter((x) => x.src === src)
    .sort((a, b) => (a.peakRank || 99) - (b.peakRank || 99) || (b.daysSeen || 0) - (a.daysSeen || 0) || (b.heat || 0) - (a.heat || 0))
    .slice(0, LIMIT.trend));

  // 热歌：24 小时用最新一期榜单；更长窗口按「最高名次 + 在榜天数」
  const musicAll = by('music');
  const latest = Math.max(0, ...musicAll.map((x) => x.lastSeen));
  const musicPool = days === 1 ? musicAll.filter((x) => x.lastSeen >= latest - 6 * 3600e3) : musicAll;
  const music = Object.values(musicPool.reduce((g, x) => ((g[x.board] ||= []).push(x), g), {}))
    .flatMap((list) => list
      .sort(days === 1 ? (a, b) => (a.rank || 99) - (b.rank || 99) : (a, b) => (a.peakRank || 99) - (b.peakRank || 99) || (b.daysSeen || 0) - (a.daysSeen || 0))
      .slice(0, LIMIT.music));

  return { days, generatedAt: now, digests: digestsIn(days, now), news, videos, trends, music };
}

export function build(now = Date.now()) {
  fs.rmSync(SITE, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'web'), SITE, { recursive: true });
  for (const d of WINDOWS) {
    const w = windowData(d, now);
    writeJSON(path.join(SITE, 'data', `w${d}.json`), w);
    const kb = (fs.statSync(path.join(SITE, 'data', `w${d}.json`)).size / 1024).toFixed(0);
    console.log(`w${d}: 资讯 ${w.news.length} / 视频 ${w.videos.length} / 热搜 ${w.trends.length} / 热歌 ${w.music.length} / 日报 ${w.digests.length}  ${kb}KB`);
  }
  const st = readJSON(path.join(DATA, 'status.json'), { sources: {} });
  writeJSON(path.join(SITE, 'data', 'status.json'), st);
  fs.writeFileSync(path.join(SITE, '.nojekyll'), '');
}

if (isMain(import.meta.url)) build();
