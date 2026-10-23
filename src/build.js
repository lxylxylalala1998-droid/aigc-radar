// 生成网页：把 web/ 拷到 site/，并把数据预聚合成 24h / 3天 / 7天 / 30天 四份
// 往期：每天一份「当天最后一次扫描时」的 24 小时数据（site/data/d/日期.json），和那天打开网页看到的一样；
//       每天的早报原样存成一页（site/archive/日期.html），都保留 ARCHIVE_DAYS 天
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA, DAY, bjDate, readJSON, writeJSON, isMain } from './util.js';
import { loadWindow, slim } from './rank.js';
import { render as renderMail } from './mail.js';
import { AIGC_TYPES } from './curate.js';
import { ratioMedians, portrait, withFans, toolRank, bgmRank } from './insight.js';

const SITE = path.join(ROOT, 'site');
const WINDOWS = [1, 3, 7, 30];
const LIMIT = { news: 400, video: 500, trend: 120, music: 50 };
const ARCHIVE_DAYS = 30;

const readDigest = (date) => readJSON(path.join(DATA, 'digests', `${date}.json`));
// 网页只用得到日报里的选题、大事件
const webDigest = (d) => ({ date: d.date, generatedAt: d.generatedAt, ai: d.ai, picks: d.picks, news: d.news, trendKeywords: d.trendKeywords || [], gaps: d.gaps, review: d.review });

function digestsIn(days, now) {
  const out = [];
  for (let i = 0; i < days + 1 && out.length < days; i++) {
    const d = readDigest(bjDate(now - i * DAY));
    if (d && d.generatedAt > now - (days + 1) * DAY) out.push(webDigest(d));
  }
  return out;
}

// 网页上算 AIGC 作品：分了类、不是「非AIGC / 教程」，抖音还要有官方 AI 标
const OLD_TYPE = { AI剧情: 'AI影视', AI短片: 'AI影视' };
const isWork = (x) => x.cat === 'video' && AIGC_TYPES.includes(OLD_TYPE[x.ai?.type] || x.ai?.type) && (x.src !== 'douyin' || !!x.m?.aiLabel);

// ctx：{ fans: B站 UP 主粉丝数缓存, med: 互动率中位数 }，整次生成共用
function windowData(days, now, ctx) {
  const all = loadWindow(days, now).map((x) => slim(withFans(x, ctx.fans), now));
  const by = (cat) => all.filter((x) => x.cat === cat);

  const news = by('news').sort((a, b) => (b.pubAt || b.firstSeen) - (a.pubAt || a.firstSeen)).slice(0, LIMIT.news);

  // 24 小时看蹿升，更长的窗口看总播放；只要窗口内发布的
  // 抖音按点赞、B站按播放，量级差很多，必须分平台各自排序截断，否则抖音会被 B站挤掉
  // 窗口里出现过（还在热榜 / 搜索结果里）且近 31 天发布的都算；抖音只展示官方标了 AI 的
  const videos = ['douyin', 'bilibili'].flatMap((s) => by('video')
    .filter((x) => x.src === s && x.pubAt >= now - 31 * DAY && x.ai?.type !== '非AIGC' && (s !== 'douyin' || x.m?.aiLabel))
    .sort(days === 1 ? (a, b) => (b.vel || 0) - (a.vel || 0) : (a, b) => (b.heat || 0) - (a.heat || 0))
    .slice(0, LIMIT.video))
    // 数据画像标签：低粉爆款、分享率高……
    .map((x) => { const pt = portrait(x, ctx.med); return pt.length ? { ...x, pt } : x; });

  // 爆款工具榜（3 天 / 7 天窗口和上一期比）、爆款 BGM 榜（抖音）：都只看窗口内发布的 AIGC 作品
  // 3 天 / 7 天窗口和上一期比；数据要攒够两期才比（系统刚上线时上期不全）
  const compare = (days === 3 || days === 7) && ctx.history >= 2 * days;
  const tools = toolRank((compare ? loadWindow(days * 2, now) : loadWindow(days, now)).filter(isWork), now, days, { compare }).slice(0, 20);
  const bgms = bgmRank(all.filter((x) => isWork(x) && x.pubAt >= now - days * DAY)).slice(0, 20);

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

  return { days, generatedAt: now, digests: digestsIn(days, now), news, videos, trends, music, tools, bgms };
}

// 往期：最近 ARCHIVE_DAYS 天，每天一份当天数据 + 早报原样页，外加一个日期索引 days.json
function buildArchive(now, ctx) {
  const index = [];
  let bytes = 0;
  for (let i = 0; i < ARCHIVE_DAYS; i++) {
    const date = bjDate(now - i * DAY);
    const day = readJSON(path.join(DATA, 'days', `${date}.json`));
    if (!day) continue;
    const at = Math.min(day.updatedAt || now, now);
    const dg = readDigest(date);
    const w = { ...windowData(1, at, ctx), date, digests: dg ? [webDigest(dg)] : [] };
    const file = path.join(SITE, 'data', 'd', `${date}.json`);
    writeJSON(file, w);
    bytes += fs.statSync(file).size;
    if (dg) {
      fs.mkdirSync(path.join(SITE, 'archive'), { recursive: true });
      fs.writeFileSync(path.join(SITE, 'archive', `${date}.html`), renderMail(dg, { archive: true }));
    }
    index.push({ date, at, digest: !!dg });
  }
  writeJSON(path.join(SITE, 'data', 'days.json'), index);
  console.log(`往期：${index.length} 天（其中有早报 ${index.filter((x) => x.digest).length} 天），合计 ${(bytes / 1048576).toFixed(1)}MB`);
}

export function build(now = Date.now()) {
  fs.rmSync(SITE, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'web'), SITE, { recursive: true });
  const fans = Object.fromEntries(Object.entries(readJSON(path.join(DATA, 'bili-fans.json'), {})).map(([k, v]) => [k, v.f]));
  const history = fs.existsSync(path.join(DATA, 'days')) ? fs.readdirSync(path.join(DATA, 'days')).filter((f) => f.endsWith('.json')).length : 0;
  const ctx = { fans, history, med: ratioMedians(loadWindow(30, now).map((x) => withFans(x, fans))) };
  for (const d of WINDOWS) {
    const w = windowData(d, now, ctx);
    writeJSON(path.join(SITE, 'data', `w${d}.json`), w);
    const kb = (fs.statSync(path.join(SITE, 'data', `w${d}.json`)).size / 1024).toFixed(0);
    console.log(`w${d}: 资讯 ${w.news.length} / 视频 ${w.videos.length} / 热搜 ${w.trends.length} / 热歌 ${w.music.length} / 日报 ${w.digests.length}  ${kb}KB`);
  }
  buildArchive(now, ctx);
  const st = readJSON(path.join(DATA, 'status.json'), { sources: {} });
  writeJSON(path.join(SITE, 'data', 'status.json'), st);
  fs.writeFileSync(path.join(SITE, '.nojekyll'), '');
}

if (isMain(import.meta.url)) build();
