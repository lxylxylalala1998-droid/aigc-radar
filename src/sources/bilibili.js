import path from 'node:path';
import { createHash } from 'node:crypto';
import { http, clean, isAI, sleep, DAY, DATA, readJSON, writeJSON } from '../util.js';
import { BILI_KEYWORDS, BILI_RANK_RIDS, WATCH_KEYWORDS } from '../config.js';

// AI 从最近数据里发现的新兴玩法（curate.js 维护），取最近 3 天还在出现的前 8 个
export function trendKeywords(now = Date.now()) {
  const t = readJSON(path.join(DATA, 'trend-keywords.json'), {});
  return Object.entries(t).filter(([, v]) => v.last > now - 3 * DAY).sort((a, b) => b[1].last - a[1].last || b[1].n - a[1].n).slice(0, 8).map(([k]) => k);
}

let cookie = '';
async function biliCookie() {
  if (cookie) return;
  // 先领一个游客 buvid，海外 IP 不带它容易被 -412 风控
  try {
    const j = await http('https://api.bilibili.com/x/frontend/finger/spi', { retries: 1 });
    cookie = `buvid3=${j.data.b_3}; buvid4=${j.data.b_4}`;
  } catch { cookie = ' '; }
}
async function bili(url) {
  await biliCookie();
  const j = await http(url, { headers: { Referer: 'https://www.bilibili.com/', Cookie: cookie } });
  if (j.code !== 0) throw Object.assign(new Error(`B站接口 code=${j.code} ${j.message || ''}`), { code: j.code });
  return j.data;
}

// wbi 签名（w_rid + wts）：B站网页端接口的防爬签名。网页端调分区排行接口是带签名的，这里照做（GitHub 上不带签名时返回过 -352 风控）
// 算法见 bilibili-API-collect 的 wbi 文档；密钥从 nav 接口取（没登录也给），每次运行取一次
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
let wbiKey = '';
async function wbi(params) {
  if (!wbiKey) {
    await biliCookie();
    // 没登录时 nav 返回 code=-101，但照样带 wbi_img
    const j = await http('https://api.bilibili.com/x/web-interface/nav', { headers: { Referer: 'https://www.bilibili.com/', Cookie: cookie } });
    const key = (u) => (u || '').split('/').pop().split('.')[0];
    const raw = key(j.data?.wbi_img?.img_url) + key(j.data?.wbi_img?.sub_url);
    if (raw.length < 64) throw new Error('没拿到 wbi 密钥');
    wbiKey = MIXIN.map((i) => raw[i]).join('').slice(0, 32);
  }
  const q = Object.entries({ ...params, wts: Math.floor(Date.now() / 1000) }).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v).replace(/[!'()*]/g, ''))}`).join('&');
  return `${q}&w_rid=${createHash('md5').update(q + wbiKey).digest('hex')}`;
}
// 被风控：HTTP 412，或者接口返回 -352 / -412
const blockedBy = (e) => e.status === 412 || [-352, -412].includes(e.code);

// B站新分区体系里有 AI 相关的二级分区（音乐/AI音乐、影视/AI影视、人工智能/AI杂谈……），热门 / 排行接口直接带（tnamev2），不用多发请求
// 网页端分区页上有（比如 www.bilibili.com/c/music/ai_music/），App 和投稿页上不一定看得到，可能是 B站按 AI 声明 / 内容自动归的
// 所以只当其中一个信号，标签（AI音乐 / AI动画 / AI MV……）和 B站的 AI 标注另外查（见 aiMarks）
// 旧分区（tname）是兼容映射出来的，不准：新分区在「AI音乐」的电竞应援歌，旧分区会映射成「电子竞技」
const aiPart = (v) => (isAI(v.tnamev2) || v.pid_name_v2 === '人工智能' ? v.tnamev2 : '');

const fixPic = (u) => (u && u.startsWith('//') ? 'https:' + u : u?.replace(/^http:/, 'https:'));
// 时长：搜索接口给「3:25」，排行 / 热门给秒数
const durSec = (d) => (typeof d === 'number' ? d : String(d || '').split(':').reduce((s, x) => s * 60 + (+x || 0), 0)) || undefined;

function video(v, board) {
  const st = v.stat || {};
  return {
    id: `bili:${v.bvid}`,
    cat: 'video', src: 'bilibili', board,
    title: clean(v.title),
    url: `https://www.bilibili.com/video/${v.bvid}`,
    author: v.author || v.owner?.name || '',
    cover: fixPic(v.pic),
    heat: v.play ?? st.view ?? 0,
    pubAt: (v.pubdate || 0) * 1000,
    desc: clean(v.description || v.desc || '').slice(0, 80),
    tags: (v.tag || '').split(',').slice(0, 8).join(','),
    m: {
      play: v.play ?? st.view ?? 0,
      like: v.like ?? st.like ?? 0,
      danmaku: v.video_review ?? st.danmaku ?? 0,
      fav: v.favorites ?? st.favorite ?? 0,
      reply: v.review ?? st.reply ?? undefined,
      coin: st.coin ?? undefined,
      share: st.share ?? undefined,
      part: v.tnamev2 || v.typename || v.tname || '',
      aiMark: v.aiMark || undefined, // B站在稿件上标的「含AI生成内容」这类说明
      dur: durSec(v.duration),
      mid: v.mid || v.owner?.mid || undefined,
      aid: v.aid || v.id || undefined,
    },
  };
}

// UP 主粉丝数（日报算「低粉爆款」用）：免费接口，结果缓存 7 天；被风控（412）就停
//   mids：UP 主 ID 数组；返回 { mid: 粉丝数 }（含缓存）
export async function biliFans(mids, { max = 100 } = {}) {
  const file = path.join(DATA, 'bili-fans.json');
  const cache = readJSON(file, {});
  const now = Date.now();
  for (const [k, v] of Object.entries(cache)) if (v.t < now - 7 * DAY) delete cache[k];
  let n = 0;
  for (const mid of mids) {
    if (cache[mid] || n >= max) continue;
    try {
      const d = await bili(`https://api.bilibili.com/x/relation/stat?vmid=${mid}`);
      cache[mid] = { f: d?.follower || 0, t: now };
      n++;
    } catch (e) { if (e.status === 412) break; }
    await sleep(300);
  }
  writeJSON(file, cache);
  return Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, v.f]));
}

// 标题不带 AI、也不在 AI 分区的热门 / 排行稿件，再查一次详情：B站标了「含AI生成内容」或者标签里有 AI（比如「AI音乐」）的也算 AI 稿件
// （比如 AI 做的电竞应援歌，标题只写歌名，B站搜「AI音乐」第一页也搜不到）
// 结果缓存 14 天（data/bili-ai.json），榜单每天变化不大，之后每次只查新上榜的；每次最多查 DETAIL_MAX 条（热门优先），免得拖慢采集；被风控就停
const DETAIL_MAX = 60;
async function aiMarks(list) {
  const file = path.join(DATA, 'bili-ai.json');
  const cache = readJSON(file, {});
  const now = Date.now();
  for (const [k, v] of Object.entries(cache)) if (v.t < now - 14 * DAY) delete cache[k];
  const errors = [];
  let n = 0;
  for (const v of list) {
    if (cache[v.bvid] || n >= DETAIL_MAX) continue;
    n++;
    try {
      const d = await bili(`https://api.bilibili.com/x/web-interface/view/detail?bvid=${v.bvid}`);
      const msg = d?.View?.argue_info?.argue_msg || '';
      const tags = (d?.Tags || []).map((t) => t.tag_name).filter(Boolean);
      const mark = isAI(msg) ? msg : '';
      cache[v.bvid] = mark || tags.some(isAI) ? { t: now, mark: mark || undefined, tags: tags.slice(0, 8).join(',') } : { t: now };
    } catch (e) {
      errors.push(`详情 ${v.bvid}: ${e.message}`);
      if (blockedBy(e)) { errors.push('查稿件详情被 B站风控，剩下的下次再查'); break; }
    }
    await sleep(300);
  }
  writeJSON(file, cache);
  return { cache, errors };
}

// B站热搜
export async function biliHot() {
  const d = await bili('https://api.bilibili.com/x/web-interface/search/square?limit=50');
  return (d?.trending?.list || []).map((x, i) => ({
    id: `bili:${x.keyword}`,
    cat: 'trend', src: 'bilibili', board: 'B站热搜',
    title: x.show_name || x.keyword,
    url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(x.keyword)}`,
    heat: x.heat_score || 0,
    rank: i + 1,
  }));
}

// B站 AI 稿件：关键词搜索（近 3 天 / 近 7 天，早报那次再加近 30 天，按播放） + 分区排行 + 综合热门里挑 AI 相关
//   排行 / 热门里算 AI 相关的：标题带 AI、在 AI 分区，或者 B站标了 AI 生成 / 标签带 AI
export async function biliAI({ long = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const since = Date.now() - (long ? 31 : 10) * DAY; // 太老的稿件（分区排行里偶尔混进来）不要
  const out = [];
  const errors = [];
  // 同一条稿件也可能被关键词搜到，搜索结果里只有旧分区，没有 AI 分区 / AI 标注，最后统一补上
  const hint = new Map();
  const jobs = [];
  for (const k of BILI_KEYWORDS) {
    jobs.push({ kw: k.kw, days: 3 });
    if (k.core) jobs.push({ kw: k.kw, days: 7 });
  }
  if (long) for (const k of BILI_KEYWORDS) if (k.core) jobs.push({ kw: k.kw, days: 30 });
  // 关注的玩法 + AI 发现的新玩法：这类题材标题里常常不带「AI」，固定关键词搜不到
  const fixed = new Set(BILI_KEYWORDS.map((k) => k.kw));
  for (const kw of new Set([...WATCH_KEYWORDS, ...trendKeywords()])) if (!fixed.has(kw)) jobs.push({ kw, days: 7 });
  let blocked = false;
  for (const job of jobs) {
    if (blocked) break;
    const url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&order=click&page=1'
      + `&keyword=${encodeURIComponent(job.kw)}&pubtime_begin_s=${now - job.days * 86400}&pubtime_end_s=${now}`;
    try {
      const d = await bili(url);
      for (const v of d?.result || []) out.push(video(v, `搜索·${job.kw}`));
    } catch (e) {
      errors.push(`${job.kw}: ${e.message}`);
      // 412 = 被风控了，后面的搜索不要再打，留给排行榜接口
      if (e.status === 412) { blocked = true; errors.push(`搜索被 B站风控（412），跳过剩余 ${jobs.length - jobs.indexOf(job) - 1} 个关键词`); }
    }
    await sleep(1500);
  }
  // 标题不带 AI、也不在 AI 分区的，要查详情（标签、B站的 AI 标注）才知道
  const rankUnsure = [];
  const popUnsure = [];
  for (const rid of BILI_RANK_RIDS) {
    try {
      const d = await bili(`https://api.bilibili.com/x/web-interface/ranking/v2?${await wbi({ rid, type: 'all', web_location: '333.934' })}`);
      for (const v of d?.list || []) {
        if (aiPart(v)) hint.set(`bili:${v.bvid}`, { part: v.tnamev2 });
        const board = `排行·${v.tnamev2 || v.tname || rid}`;
        if (isAI(v.title) || /AI/.test(v.tname || '') || aiPart(v)) out.push(video(v, board));
        else if (v.pubdate * 1000 > since) rankUnsure.push({ v, board });
      }
    } catch (e) { errors.push(`rank ${rid}: ${e.message}`); }
    await sleep(400);
  }
  for (let pn = 1; pn <= 3; pn++) {
    try {
      const d = await bili(`https://api.bilibili.com/x/web-interface/popular?ps=50&pn=${pn}`);
      for (const v of d?.list || []) {
        if (aiPart(v)) hint.set(`bili:${v.bvid}`, { part: v.tnamev2 });
        if (isAI(v.title) || aiPart(v)) out.push(video(v, '综合热门'));
        else if (v.pubdate * 1000 > since) popUnsure.push({ v, board: '综合热门' });
      }
    } catch (e) { errors.push(`popular ${pn}: ${e.message}`); }
    await sleep(400);
  }
  const unsure = [...popUnsure, ...rankUnsure];
  const { cache, errors: e2 } = await aiMarks(unsure.map((x) => x.v));
  errors.push(...e2);
  for (const { v, board } of unsure) {
    const c = cache[v.bvid];
    if (!c?.mark && !c?.tags) continue;
    hint.set(`bili:${v.bvid}`, { aiMark: c.mark, tags: c.tags });
    out.push(video({ ...v, tag: c.tags, aiMark: c.mark }, board));
  }
  for (const v of out) {
    const h = hint.get(v.id);
    if (!h) continue;
    if (h.part) v.m.part = h.part;
    if (h.aiMark) v.m.aiMark = h.aiMark;
    if (h.tags && !v.tags) v.tags = h.tags;
  }
  const fresh = out.filter((v) => v.pubAt > since);
  if (!fresh.length && errors.length) throw new Error(errors.slice(0, 3).join('; '));
  fresh.warnings = errors;
  return fresh;
}

// B站全站音乐榜（周榜，每周五更新）。B站没有单独的飙升榜，用 last_rank 算：新上榜 + 排名升得最多的
export async function biliMusic() {
  const p = await bili('https://api.bilibili.com/x/copyright-music-publicity/toplist/all_period?list_type=1');
  const all = Object.values(p?.list || {}).flat().sort((a, b) => b.publish_time - a.publish_time);
  if (!all.length) throw new Error('B站音乐榜期数为空');
  const latest = all[0];
  const d = await bili(`https://api.bilibili.com/x/copyright-music-publicity/toplist/music_list?list_id=${latest.ID}`);
  const list = d?.list || [];
  const song = (x, board, rank, label) => ({
    id: `bili:${board}:${x.music_id}`,
    cat: 'music', src: 'bilibili', board,
    title: clean(x.music_title), author: clean(x.singer),
    url: x.creation_bvid ? `https://www.bilibili.com/video/${x.creation_bvid}` : 'https://music.bilibili.com/pc/music-center/',
    cover: fixPic(x.mv_cover || x.creation_cover),
    heat: x.heat || 0, rank, label,
    // 分析「为什么火」的依据：代表稿件、榜单推荐理由、被多少稿件当素材
    desc: [x.creation_title && `代表稿件：${clean(x.creation_title)}`, x.creation_reason && `推荐理由：${clean(x.creation_reason)}`, x.material_use_num && `${x.material_use_num} 个稿件用作素材`].filter(Boolean).join('；'),
    m: { period: latest.priod, lastRank: x.last_rank || 0 },
  });
  const hot = list.map((x) => song(x, 'B站热歌榜', x.rank, x.last_rank ? (x.last_rank > x.rank ? `↑${x.last_rank - x.rank}` : x.last_rank < x.rank ? `↓${x.rank - x.last_rank}` : '') : '新'));
  const rise = list
    .map((x) => ({ x, up: x.last_rank ? x.last_rank - x.rank : 100 - x.rank })) // 新上榜排在最前，其中名次越高越靠前
    .filter((r) => r.up > 0)
    .sort((a, b) => b.up - a.up)
    .map((r, i) => song(r.x, 'B站飙升榜', i + 1, r.x.last_rank ? `↑${r.up}` : '新'));
  return [...hot, ...rise];
}
