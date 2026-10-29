// 生成网页：把 web/ 拷到 site/，并把数据预聚合成 24h / 3天 / 7天 / 30天 四份
// 往期：每天一份「当天最后一次扫描时」的 24 小时数据（site/data/d/日期.json），和那天打开网页看到的一样；
//       每天的早报原样存成一页（site/archive/日期.html），都保留 ARCHIVE_DAYS 天
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA, DAY, bjDate, readJSON, writeJSON, isMain } from './util.js';
import { WEB_WINDOWS, WEB_VIDEO_LIMIT } from './config.js';
import { loadWindow, slim, labelOk } from './rank.js';
import { render as renderMail } from './mail.js';
import { renderWeekly } from './weekly.js';
import { AIGC_TYPES } from './curate.js';
import { ratioMedians, portrait, withFans, toolRank, bgmRank } from './insight.js';

const SITE = path.join(ROOT, 'site');
const WINDOWS = WEB_WINDOWS;
const LIMIT = { news: 400, video: WEB_VIDEO_LIMIT, trend: 120, music: 50 };
const ARCHIVE_DAYS = 30;

const readDigest = (date) => readJSON(path.join(DATA, 'digests', `${date}.json`));
// 网页只用得到日报里的选题、大事件
// 选题的主要依据补上封面：旧日报没有 main；抖音封面约 14 天过期，用数据里最新抓到的封面（build 开始时建好索引）
let coverIdx = new Map();
// heic 格式的封面浏览器显示不了（旧数据里有），当作没有封面
const okCover = (u) => !!u && !/\.heic/i.test(u);
const withCovers = (picks) => (!picks || Array.isArray(picks) ? picks : Object.fromEntries(Object.entries(picks).map(([s, list]) => [s, list.map((p) => {
  const mv = p.main?.url ? p.main : p.refs?.find((r) => r.kind === 'video');
  if (!mv) return p;
  const hit = coverIdx.get(mv.url);
  return { ...p, main: { url: mv.url, src: hit?.src || mv.src || s, title: mv.title || hit?.title, heat: hit?.heat ?? mv.heat, cover: [hit?.cover, mv.cover].find(okCover) } };
})])));
// 「还在涨」「信息差」里的作品封面也换成数据里最新的（日报里存的抖音封面两周后就过期了）
const fresher = (x) => (x?.url && okCover(coverIdx.get(x.url)?.cover) ? { ...x, cover: coverIdx.get(x.url).cover } : x);
const freshLists = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).map(([k, l]) => [k, Array.isArray(l) ? l.map(fresher) : l])) : o);
const webDigest = (d) => ({ date: d.date, generatedAt: d.generatedAt, ai: d.ai, picks: withCovers(d.picks), news: d.news, trendKeywords: d.trendKeywords || [], gaps: freshLists(d.gaps), review: d.review, brief: d.brief, rising: freshLists(d.rising) });

function digestsIn(days, now) {
  const out = [];
  for (let i = 0; i < days + 1 && out.length < days; i++) {
    const d = readDigest(bjDate(now - i * DAY));
    if (d && d.generatedAt > now - (days + 1) * DAY) out.push(webDigest(d));
  }
  return out;
}

// 网页上算 AIGC 作品：分了类、不是「非AIGC / 教程」，抖音、小红书还要有官方 AI 标
const OLD_TYPE = { AI剧情: 'AI影视', AI短片: 'AI影视' };
const isWork = (x) => x.cat === 'video' && AIGC_TYPES.includes(OLD_TYPE[x.ai?.type] || x.ai?.type) && labelOk(x);

// ctx：{ fans: B站 UP 主粉丝数缓存, med: 互动率中位数 }，整次生成共用
function windowData(days, now, ctx) {
  // gone：查详情时发现视频已经删了 / 设了私密（covers.js 标的），封面换不回来、点进去也打不开，不展示
  const all = loadWindow(days, now).filter((x) => !x.gone).map((x) => slim(withFans(x, ctx.fans), now));
  const by = (cat) => all.filter((x) => x.cat === cat);

  const news = by('news').sort((a, b) => (b.pubAt || b.firstSeen) - (a.pubAt || a.firstSeen)).slice(0, LIMIT.news);

  // 24 小时看蹿升，更长的窗口看总播放；只要窗口内发布的
  // 抖音、小红书按点赞，B站按播放，量级差很多，必须分平台各自排序截断，否则抖音会被 B站挤掉
  // 窗口里出现过（还在热榜 / 搜索结果里）且近 31 天发布的都算；抖音、小红书只展示官方标了 AI 的
  const videos = ['douyin', 'bilibili', 'xiaohongshu'].flatMap((s) => by('video')
    .filter((x) => x.src === s && x.pubAt >= now - 31 * DAY && x.ai?.type !== '非AIGC' && labelOk(x))
    .sort(days === 1 ? (a, b) => (b.vel || 0) - (a.vel || 0) : (a, b) => (b.heat || 0) - (a.heat || 0))
    .slice(0, LIMIT.video))
    // 封面用数据里最新的那个（抖音封面两周过期，covers.js 会续期；往期按天看的是当天的旧数据，不换就是过期的）
    .map((x) => (okCover(coverIdx.get(x.url)?.cover) ? { ...x, cover: coverIdx.get(x.url).cover } : x))
    // 数据画像标签：低粉爆款、分享率高……
    .map((x) => { const pt = portrait(x, ctx.med); return pt.length ? { ...x, pt } : x; });

  // 爆款工具榜（3 天 / 7 天窗口和上一期比）、爆款 BGM 榜（抖音）：都只看窗口内发布的 AIGC 作品
  // 3 天 / 7 天窗口和上一期比；数据要攒够两期才比（系统刚上线时上期不全）
  const compare = (days === 3 || days === 7) && ctx.history >= 2 * days;
  const tools = toolRank((compare ? loadWindow(days * 2, now) : loadWindow(days, now)).filter(isWork), now, days, { compare }).slice(0, 20);
  const bgms = bgmRank(all.filter((x) => isWork(x) && x.pubAt >= now - days * DAY)).slice(0, 20);

  const trends = ['weibo', 'douyin', 'bilibili', 'xiaohongshu'].flatMap((src) => by('trend')
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

// ---------- 网页数据按板块拆开 ----------
// 打开网页先只下「核心」（选题、各板块条数，几十 KB），视频 / 热搜 / 热歌 / 资讯点到哪个板块再下哪个，
// 并且只留网页用得到的字段（以前一次下全部，24 小时那份压缩后 400KB，国内打开要 9 秒）
const keep = (o, keys) => {
  const r = {};
  for (const k of keys) if (o?.[k] !== undefined && o[k] !== '' && o[k] !== null) r[k] = o[k];
  return r;
};
const leanVideo = (x) => ({
  ...keep(x, ['id', 'src', 'board', 'title', 'url', 'author', 'heat', 'pubAt', 'vel', 'pt']),
  ...(okCover(x.cover) ? { cover: x.cover } : {}),
  // 简介大多就是标题，重复的不要
  ...(x.desc && !x.desc.startsWith(x.title.slice(0, 15)) ? { desc: x.desc.slice(0, 60) } : {}),
  m: keep(x.m, ['play', 'playWin', 'read', 'like', 'share', 'fav', 'comment', 'fans', 'dur', 'bgm', 'aiLabel', 'noDate']),
  ai: keep(x.ai, ['type', 'hook', 'tip', 'top']),
});
const leanTrend = (x) => ({
  ...keep(x, ['src', 'title', 'url', 'rank', 'peakRank', 'kind', 'label', 'heat', 'peakHeat', 'daysSeen', 'lastSeen', 'top']),
  m: keep(x.m, ['fetched', 'aiVideos']), ai: keep(x.ai, ['why', 'tag', 'idea']),
});
const leanSong = (x) => ({ ...keep(x, ['src', 'board', 'title', 'author', 'url', 'rank', 'peakRank', 'label', 'daysSeen']), ai: keep(x.ai, ['why', 'use']) });
const leanNews = (x) => ({ ...keep(x, ['src', 'title', 'url', 'pubAt', 'firstSeen', 'heat', 'board']), ...(x.board === 'HF 热门模型' && x.desc ? { desc: x.desc } : {}), ai: keep(x.ai, ['level', 'kind']) });
// 一份日报在网页上要用的部分（选题区）
const pickPart = (g) => (g ? keep(g, ['date', 'generatedAt', 'ai', 'picks', 'gaps', 'review', 'brief', 'rising']) : undefined);

// base：不带 .json 的路径。写出 base.json（核心）+ base.v / .t / .m / .n.json（各板块），返回总字节数
function writeSplit(base, w) {
  const events = (w.digests || []).flatMap((g) => (g.news || []).map((e) => ({ ...e, date: g.date })));
  const files = {
    '': {
      days: w.days, date: w.date, generatedAt: w.generatedAt,
      digests: (w.digests || []).map((g) => keep(g, ['date', 'generatedAt', 'ai'])),
      dg0: pickPart(w.digests?.[0]),
      counts: {
        douyin: w.videos.filter((x) => x.src === 'douyin').length, bilibili: w.videos.filter((x) => x.src === 'bilibili').length,
        xiaohongshu: w.videos.filter((x) => x.src === 'xiaohongshu').length,
        trend: w.trends.length, music: w.music.length, news: events.length || w.news.length,
      },
    },
    '.v': { videos: w.videos.map(leanVideo) },
    '.t': { trends: w.trends.map(leanTrend) },
    '.m': { music: w.music.map(leanSong), bgms: w.bgms },
    '.n': { news: w.news.map(leanNews), events, tools: w.tools },
  };
  let bytes = 0;
  for (const [suffix, obj] of Object.entries(files)) {
    writeJSON(`${base}${suffix}.json`, obj);
    bytes += fs.statSync(`${base}${suffix}.json`).size;
  }
  return { bytes, core: fs.statSync(`${base}.json`).size };
}

// 往期：最近 ARCHIVE_DAYS 天，每天一份当天数据（同样拆开）+ 早报原样页，外加一个日期索引 days.json
function buildArchive(now, ctx) {
  const index = [];
  let bytes = 0;
  for (let i = 0; i < ARCHIVE_DAYS; i++) {
    const date = bjDate(now - i * DAY);
    const day = readJSON(path.join(DATA, 'days', `${date}.json`));
    if (!day) continue;
    const at = Math.min(day.updatedAt || now, now);
    const dg = readDigest(date);
    bytes += writeSplit(path.join(SITE, 'data', 'd', date), { ...windowData(1, at, ctx), date, digests: dg ? [webDigest(dg)] : [] }).bytes;
    if (dg) {
      fs.mkdirSync(path.join(SITE, 'archive'), { recursive: true });
      fs.writeFileSync(path.join(SITE, 'archive', `${date}.html`), renderMail({ ...dg, picks: withCovers(dg.picks) }, { archive: true }));
      // 「AI 选题日报」里切换日期时单独下这一天的选题
      writeJSON(path.join(SITE, 'data', 'dg', `${date}.json`), pickPart(webDigest(dg)));
    }
    index.push({ date, at, digest: !!dg });
  }
  writeJSON(path.join(SITE, 'data', 'days.json'), index);
  console.log(`往期：${index.length} 天（其中有早报 ${index.filter((x) => x.digest).length} 天），合计 ${(bytes / 1048576).toFixed(1)}MB`);
}

// 周报：最近 8 周的周报存成网页，weeks.json 是索引
function buildWeekly() {
  const dir = path.join(DATA, 'weekly');
  const dates = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, 10)).sort().reverse().slice(0, 8) : [];
  for (const date of dates) {
    fs.mkdirSync(path.join(SITE, 'archive'), { recursive: true });
    fs.writeFileSync(path.join(SITE, 'archive', `week-${date}.html`), renderWeekly(readJSON(path.join(dir, `${date}.json`)), { archive: true }));
  }
  writeJSON(path.join(SITE, 'data', 'weeks.json'), dates);
  if (dates.length) console.log(`周报：${dates.length} 期`);
}

export function build(now = Date.now()) {
  fs.rmSync(SITE, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'web'), SITE, { recursive: true });
  const fans = Object.fromEntries(Object.entries(readJSON(path.join(DATA, 'bili-fans.json'), {})).map(([k, v]) => [k, v.f]));
  const history = fs.existsSync(path.join(DATA, 'days')) ? fs.readdirSync(path.join(DATA, 'days')).filter((f) => f.endsWith('.json')).length : 0;
  coverIdx = new Map(loadWindow(31, now).filter((x) => x.cat === 'video' && okCover(x.cover)).map((x) => [x.url, { cover: x.cover, heat: x.heat, src: x.src, title: x.title }]));
  const ctx = { fans, history, med: ratioMedians(loadWindow(30, now).map((x) => withFans(x, fans))) };
  for (const d of WINDOWS) {
    const w = windowData(d, now, ctx);
    const { bytes, core } = writeSplit(path.join(SITE, 'data', `w${d}`), w);
    console.log(`w${d}: 资讯 ${w.news.length} / 视频 ${w.videos.length} / 热搜 ${w.trends.length} / 热歌 ${w.music.length} / 日报 ${w.digests.length}  核心 ${(core / 1024).toFixed(0)}KB，合计 ${(bytes / 1024).toFixed(0)}KB`);
  }
  buildArchive(now, ctx);
  buildWeekly();
  const st = readJSON(path.join(DATA, 'status.json'), { sources: {} });
  writeJSON(path.join(SITE, 'data', 'status.json'), st);
  fs.writeFileSync(path.join(SITE, '.nojekyll'), '');
}

if (isMain(import.meta.url)) build();
