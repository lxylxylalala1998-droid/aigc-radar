// 抖音高赞 AIGC（经 TikHub 付费接口，国内免费接口拿不到）。只在每天早报那次运行时拉
//   1. 抖音热点宝·视频热榜，按标题关键词（AI / 即梦 / 可灵 / 豆包）过滤：抖音官方的热门视频榜，带播放 / 点赞 / 发布时间
//   2. 排除标题里明确说「不是 AI」的，按点赞从高到低查详情，只留抖音官方标了 AI 的（作者声明 / 平台识别 / AI 特效）
//      AI 标发布后基本不变，查过的记在 data/dy-verified.json（14 天）；数据会涨，每天刷新点赞最高的一批 AI 视频
import path from 'node:path';
import { clean, DAY, DATA, readJSON, writeJSON } from '../util.js';
import { DY_HOT_QUERIES, DY_VERIFY_PER_DAY, DY_REFRESH_PER_DAY, TIKHUB_MIN_BALANCE } from '../config.js';
import { plain, hashtags, aiLabel, coverOf } from './douyin.js';

const BASE = 'https://api.tikhub.io';
const STATE_FILE = path.join(DATA, 'tikhub.json'); // 余额、今天花了多少
const VERIFY_FILE = path.join(DATA, 'dy-verified.json'); // { 视频 id: { l: 'AI 标' 或 ''，t: 查的时间 } }
// 标题里明确否认用了 AI 的（「本视频不由 AI 生成」「真的不是 AI」）直接排除，不花钱查
export const NOT_AI = /(不是|不由|并非|没用|没有用|无需|非)\s*AI|真的不是/i;
const SUB = { 1001: '', 1002: '·低粉爆款', 1005: '·高点赞率' };

let spent = 0;
export async function th(p, body) {
  let res;
  // 每个接口有频率限制（查余额是每秒 1 次）：抖音、小红书两个源同时启动会撞上，返回 429，等一下再试
  for (let k = 0; ; k++) {
    res = await fetch(BASE + p, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${process.env.TIKHUB_API_KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90e3),
    });
    if (res.status !== 429 || k >= 4) break;
    await new Promise((r) => setTimeout(r, 1200 * (k + 1) + Math.random() * 500));
  }
  const j = await res.json().catch(() => ({}));
  if (res.status === 402) { const e = new Error('TikHub 余额不足'); e.broke = true; throw e; }
  if (!res.ok) throw new Error(`TikHub ${res.status} ${j?.detail?.message || ''}`.trim());
  return j;
}

// 余额和每天的花费：抖音（data/tikhub.json）和小红书（data/xhs.json）各记各的，邮件 / 自检提醒充值时合起来看
//   两个源同时跑，各自记下的余额都没扣掉对方后来花的钱，取较小的那个更接近实际
export function tikhubState() {
  const list = [readJSON(STATE_FILE, null), readJSON(path.join(DATA, 'xhs.json'), null)].filter((s) => typeof s?.balance === 'number');
  if (!list.length) return null;
  const day = list.map((s) => s.day || '').sort().pop();
  const today = list.filter((s) => (s.day || '') === day);
  return { balance: Math.min(...today.map((s) => s.balance)), perDay: +today.reduce((n, s) => n + (s.spentToday || 0), 0).toFixed(3) };
}

// 返回结构层层嵌套，递归找视频对象（带 aweme_id + statistics 的）
function awemes(j) {
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.aweme_id && o.statistics) { out.push(o); return; }
    for (const v of Object.values(o)) walk(v);
  })(j);
  return out;
}
const firstList = (o) => {
  if (Array.isArray(o) && o.length && typeof o[0] === 'object') return o;
  if (o && typeof o === 'object') for (const x of Object.values(o)) { const f = firstList(x); if (f) return f; }
  return null;
};

// 抖音视频 ID 的高 32 位是发布时间（秒）
export function idTime(id) {
  try { const ms = Number(BigInt(id) >> 32n) * 1000; return ms > Date.UTC(2016, 0) && ms <= Date.now() + 864e5 ? ms : 0; } catch { return 0; }
}

// 候选在各个时间窗口里的新增点赞，取最大的（排序用）
const winLike = (x) => Math.max(0, ...Object.values(x.win || {}).map((w) => w.like));

// 热榜条目 → 统一的视频结构
//   累计点赞、评论、分享：今天查了详情用详情，否则用上次查详情的记录（最多 3 天前）
//   播放：抖音不公开累计播放，用榜单上最长时间窗口的新增播放（m.playWin 天）
//   m.like24：近 24 小时新增点赞，算「飙升」用
function toItem(x, label, a, c = {}) {
  const st = a?.statistics || {};
  const title = a ? a.desc : x.item_title;
  const pw = Math.max(...Object.keys(x.win).map(Number));
  const like = Math.max(st.digg_count || c.n || 0, winLike(x));
  return {
    id: `dy:${x.item_id}`,
    cat: 'video', src: 'douyin', board: x.board,
    title: plain(title || '').slice(0, 80) || '（无文案）',
    url: `https://www.douyin.com/video/${x.item_id}`,
    author: x.nick_name || a?.author?.nickname || '',
    // 热点宝榜单自带的封面是 jpeg、每天刷新，邮件里也能显示，优先用；其次详情里的（已挑过 jpeg）、上次记下的
    cover: x.item_cover_url || coverOf(a) || (c.cv && !/\.heic/i.test(c.cv) ? c.cv : '') || undefined, // 约 14 天有效
    heat: like,
    pubAt: (x.publish_time || a?.create_time || 0) * 1000 || idTime(x.item_id),
    tags: (a ? hashtags(a) : (x.item_title || '').match(/#([^#\s]+)/g)?.map((t) => t.slice(1)) || []).slice(0, 8).join(','),
    desc: clean(title || '').slice(0, 120),
    m: {
      play: x.win[pw].play || undefined, playWin: pw / 24, like, like24: x.win[24]?.like,
      comment: st.comment_count || c.c || undefined, share: st.share_count || c.s || undefined, fav: st.collect_count || c.f || undefined,
      fans: x.fans_cnt || undefined, aiLabel: label,
      dur: durOf(a) || c.d || undefined, bgm: bgmOf(a) || c.bg || undefined,
    },
  };
}
// 时长（秒）、BGM（用的原声不算）
const durOf = (a) => (a?.video?.duration ? Math.round(a.video.duration / 1000) : 0);
export const bgmOf = (a) => { const t = clean(a?.music?.title || ''); return t && !/原声|创作的/.test(t) ? `${t}${a.music.author ? ` - ${clean(a.music.author)}` : ''}` : ''; };

export async function douyinAigc({ daily = false } = {}) {
  if (!process.env.TIKHUB_API_KEY) throw new Error('没配置 TIKHUB_API_KEY，跳过');
  if (!daily && !process.env.TIKHUB_EVERY_RUN) { const r = []; r.skipped = true; return r; }
  const now = Date.now();
  spent = 0;
  const warnings = [];
  const state = readJSON(STATE_FILE, {});

  const u = await th('/api/v1/tikhub/user/get_user_info');
  const balance = u?.user_data?.balance ?? u?.data?.user_data?.balance;
  if (typeof balance === 'number' && balance < TIKHUB_MIN_BALANCE) {
    writeJSON(STATE_FILE, { ...state, balance, checkedAt: now }, true);
    throw new Error(`TikHub 余额只剩 ${balance} 美元，已暂停抖音高赞榜，充值后自动恢复`);
  }

  // 1. 热点宝·视频热榜：按关键词、时间窗口翻页
  const cand = new Map();
  let broke = false;
  for (const q of DY_HOT_QUERIES) {
    for (let page = 1; page <= q.pages && !broke; page++) {
      try {
        const j = await th('/api/v1/douyin/billboard/fetch_hot_total_video_list', { page, page_size: 50, date_window: q.window, sub_type: q.sub || 1001, keyword: q.keyword, tags: [] });
        spent += 0.001;
        const list = firstList(j?.data) || [];
        const board = `热点宝·近${q.window / 24}天${SUB[q.sub || 1001]}`;
        // 榜单上的点赞 / 播放是「这个时间窗口内新增的」，不是累计：每个窗口分开记，榜单标签用最长的窗口
        for (const x of list) {
          if (!x.item_id) continue;
          const id = String(x.item_id);
          const c = cand.get(id) || { ...x, item_id: id, board, winMax: q.window, win: {} };
          const w = (c.win[q.window] ||= { like: 0, play: 0 });
          w.like = Math.max(w.like, x.like_cnt || 0);
          w.play = Math.max(w.play, x.play_cnt || 0);
          if (q.window > c.winMax) Object.assign(c, { board, winMax: q.window });
          cand.set(id, c);
        }
        if (list.length < 40) break; // 没有下一页了
      } catch (e) { warnings.push(`热榜 ${q.keyword}/${q.window}h/第${page}页：${e.message}`); if (e.broke) broke = true; break; }
    }
  }

  // 2. 排除明确否认 AI 的，按点赞从高到低查详情：确认 AI 标（发布后基本不变，查过就记下），顺便拿累计点赞、评论、分享、收藏
  //    数据会涨，所以每天先刷新点赞最高的 DY_REFRESH_PER_DAY 条 AI 视频（不管发布几天），剩下的额度查新上榜的；
  //    没轮到刷新的视频，点赞照样每天从榜单更新（发布 7 天内的，「近 7 天」榜单点赞就约等于累计），只有评论、分享会晚几天
  const verified = readJSON(VERIFY_FILE, {});
  for (const [id, v] of Object.entries(verified)) if (v.t < now - 14 * DAY) delete verified[id];
  const ranked = [...cand.values()].filter((x) => !NOT_AI.test(x.item_title || '')).sort((a, b) => winLike(b) - winLike(a));
  const budget = +process.env.DY_VERIFY_LIMIT || DY_VERIFY_PER_DAY;
  const stale = ranked.filter((x) => verified[x.item_id]?.l && verified[x.item_id].t < now - 20 * 3600e3);
  const fresh = ranked.filter((x) => !verified[x.item_id]);
  const top = stale.slice(0, Math.min(DY_REFRESH_PER_DAY, budget));
  const news = fresh.slice(0, budget - top.length);
  const todo = [...top, ...news, ...stale.slice(top.length, top.length + budget - top.length - news.length)]; // 新视频不够时，多出来的额度继续刷新
  const refreshing = todo.length - news.length;
  const details = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < todo.length && !broke) {
      const x = todo[next++];
      try {
        const a = awemes(await th(`/api/v1/douyin/app/v3/fetch_one_video?aweme_id=${x.item_id}`))[0];
        spent += 0.001;
        const l = a ? aiLabel(a) : '';
        const st = a?.statistics || {};
        verified[x.item_id] = l
          ? { l, t: now, n: st.digg_count || 0, c: st.comment_count || 0, s: st.share_count || 0, f: st.collect_count || 0, cv: coverOf(a), d: durOf(a), bg: bgmOf(a) }
          : { l, t: now };
        if (a) details.set(x.item_id, a);
      } catch (e) { warnings.push(`详情 ${x.item_id}：${e.message}`); if (e.broke) broke = true; }
    }
  }));
  writeJSON(VERIFY_FILE, verified);

  // 3. 只输出带官方 AI 标的
  const out = [];
  for (const x of ranked) {
    const label = verified[x.item_id]?.l;
    if (label) out.push(toItem(x, label, details.get(x.item_id), verified[x.item_id]));
  }

  const today = new Date(now).toISOString().slice(0, 10);
  writeJSON(STATE_FILE, {
    balance: typeof balance === 'number' ? +(balance - spent).toFixed(3) : balance, checkedAt: now,
    spentToday: +((state.day === today ? state.spentToday || 0 : 0) + spent).toFixed(3), day: today,
  }, true);
  out.warnings = warnings.slice(0, 5);
  out.info = `热榜 ${cand.size} 条，查详情 ${todo.length} 条（新视频 ${todo.length - refreshing}、刷新老视频累计赞 ${refreshing}），带 AI 标 ${out.length} 条；本次约花 ${spent.toFixed(3)} 美元，余额约 ${typeof balance === 'number' ? (balance - spent).toFixed(3) : '?'}`;
  return out;
}
