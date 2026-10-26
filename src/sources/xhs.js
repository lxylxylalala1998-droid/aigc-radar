// 小红书 AIGC 爆款 + 小红书热点（经 TikHub 付费接口；小红书自己的接口要登录 + 签名，免费拿不到）
// 只在每天早报那次运行时拉，同一天不重复拉（内容广场的数据一天更新一次，重复拉只是多花钱）
//   1. 蒲公英·内容广场「小红书热门」榜：按关键词搜视频笔记，带阅读 / 点赞 / 收藏 / 评论 / 发布时间 / 作者粉丝
//   2. 榜单不带 AI 标：按排名查笔记详情，只留作者声明了「内容含 AI 生成」的（笔记底部那行声明）
//      AI 标发布后基本不变，查过的记在 data/xhs-verified.json（30 天）；详情还会顺带返回 2 条相关笔记，它们的 AI 标也记下
//   3. 创作者中心·热点灵感：小红书自己的热点榜，放进热梗热搜
import path from 'node:path';
import { clean, sleep, DAY, DATA, bjDate, readJSON, writeJSON } from '../util.js';
import { XHS_SQUARE_QUERIES, XHS_VERIFY_PER_DAY, XHS_HOT_PAGES, TIKHUB_MIN_BALANCE } from '../config.js';
import { th, NOT_AI } from './tikhub.js';

const STATE_FILE = path.join(DATA, 'xhs.json'); // 余额、今天花了多少、哪天拉过
const VERIFY_FILE = path.join(DATA, 'xhs-verified.json'); // { 笔记 id: { l: 'AI 标' 或 ''，t: 查的时间，…详情里的数据 } }
// 标题在说「被当成 AI」的多半是真人作品（「美得没人质疑是AI」「当路人说我的画是AI」），不花钱查
const LOOKS_AI = /(像|以为是|当成|质疑.{0,6}|怀疑.{0,6}|说.{0,6}是)\s*AI/i;
const PRICE = { square: 0.02, hot: 0.01, detail: 0.01 };

// 笔记底部的声明：作者自己声明的是「Self-declared」；其它带 AI 字样的声明当作平台识别
// 不是 AI 的声明（「虚构演绎，仅供娱乐」这类）不算
function aiLabel(n) {
  const st = n?.note_statement;
  if (!st || !/AI/i.test(`${st.show_text || ''} ${st.pop_text || ''}`)) return '';
  return /self|作者|自主/i.test(st.pop_text || '') ? '作者声明' : '平台识别';
}

// 标题 / 正文里的话题写成「#话题名[话题]#」，拿出来当标签，正文里去掉；截断留下的半个「#ai[」也去掉
const TOPIC = /#([^#[\]]+)\[话题\]#?/g;
const plain = (s = '') => clean(String(s).replace(TOPIC, ' ').replace(/#\S*$/, '').replace(/\[[^\]]{1,6}R?\]/g, ''));
const topics = (s = '') => [...String(s).matchAll(TOPIC)].map((m) => m[1].trim()).filter(Boolean);
// 发布时间是北京时间字符串「2026-10-18 19:25:07」
const pubAt = (s) => { const t = Date.parse(`${String(s || '').replace(' ', 'T')}+08:00`); return Number.isFinite(t) ? t : 0; };
// 封面：榜单给的是 http、1080 宽，换成 https、360 宽（20KB 左右）；带别的网站的 Referer 会 403，网页上都是 no-referrer
const coverOf = (n) => (n.noteImages?.[0]?.imageUrl || '').replace(/^http:/, 'https:').replace(/\/w\/\d+\//, '/w/360/');

function record(d, now) {
  const l = aiLabel(d);
  if (!l) return { l, t: now };
  return {
    l, t: now, n: d.liked_count || 0, f: d.collected_count || 0, c: d.comments_count || 0, s: d.shared_count || 0,
    tg: (d.hash_tag || []).map((h) => clean(h.name || '')).filter(Boolean).slice(0, 8).join(','), ds: plain(d.desc).slice(0, 120),
  };
}

function toItem(c, v) {
  const { n, u } = c;
  const like = Math.max(n.likeNum || 0, v.n || 0);
  return {
    id: `xhs:${n.noteId}`,
    cat: 'video', src: 'xiaohongshu', board: c.board,
    title: (plain(n.title) || v.ds || '（无标题）').slice(0, 80),
    // 链接要带 xsec_token，不带的话网页版打不开
    url: n.noteLink || `https://www.xiaohongshu.com/explore/${n.noteId}`,
    author: clean(u.nickName || ''),
    cover: coverOf(n) || undefined,
    heat: like,
    pubAt: pubAt(n.notePublishTime),
    tags: v.tg || topics(n.title).slice(0, 8).join(','),
    desc: v.ds || undefined,
    m: {
      read: n.readNum || undefined, like, fav: Math.max(n.favNum || 0, v.f || 0) || undefined, comment: Math.max(n.cmtNum || 0, v.c || 0) || undefined,
      share: v.s || undefined, fans: u.fansNum || undefined, dur: n.videoDuration || undefined, aiLabel: v.l,
    },
  };
}

export async function xhsAigc({ daily = false } = {}) {
  if (!process.env.TIKHUB_API_KEY) throw new Error('没配置 TIKHUB_API_KEY，跳过');
  const now = Date.now();
  const state = readJSON(STATE_FILE, {});
  const skip = () => { const r = []; r.skipped = true; return r; };
  if (!daily && !process.env.XHS_EVERY_RUN) return skip();
  if (state.runDate === bjDate(now) && !process.env.XHS_FORCE) return skip();

  const u = await th('/api/v1/tikhub/user/get_user_info');
  const balance = u?.user_data?.balance ?? u?.data?.user_data?.balance;
  if (typeof balance === 'number' && balance < TIKHUB_MIN_BALANCE) throw new Error(`TikHub 余额只剩 ${balance} 美元，已暂停小红书，充值后自动恢复`);

  let spent = 0;
  let broke = false;
  let retried = 0;
  const warnings = [];
  // 上游偶尔返回「查询未命中」：同样的请求一会儿有数据、一会儿是空的（空的也照样扣费），隔几秒重试，最多 3 次
  async function retryEmpty(fn, price, pick) {
    for (let k = 0; ; k++) {
      const j = await fn();
      spent += price;
      const got = pick(j);
      if (got?.length || k >= 2) return got || [];
      retried++;
      await sleep(3000);
    }
  }

  // 1. 内容广场：按关键词、统计窗口翻页（每个榜只有 Top 100）
  const cand = new Map();
  for (const q of XHS_SQUARE_QUERIES) {
    for (let page = 1; page <= q.pages && !broke; page++) {
      try {
        const body = { biz_type: 1, page_num: page, page_size: 34, search_word: q.keyword, order_by: 'premium_like_num', date_range: q.days, note_type: 2 };
        const list = await retryEmpty(() => th('/api/v1/xiaohongshu/pgy/get_content_square', body), PRICE.square, (j) => j?.data?.data?.noteList);
        list.forEach((x, i) => {
          const n = x.noteInfo;
          if (n?.noteId && !cand.has(n.noteId)) cand.set(n.noteId, { n, u: x.userInfo || {}, board: `小红书热门·近${q.days}天`, rank: (page - 1) * 34 + i + 1 });
        });
        if (!list.length) warnings.push(`内容广场 ${q.keyword}/近${q.days}天/第${page}页：试了 3 次都是空的`);
        if (list.length < 34) break;
      } catch (e) { warnings.push(`内容广场 ${q.keyword}/近${q.days}天/第${page}页：${e.message}`); if (e.broke) broke = true; break; }
    }
  }

  // 2. 按排名查详情确认 AI 标（标题明确否认 AI 的跳过），查过的不再查
  const verified = readJSON(VERIFY_FILE, {});
  for (const [id, v] of Object.entries(verified)) if (v.t < now - 30 * DAY) delete verified[id];
  const ranked = [...cand.values()].sort((a, b) => a.rank - b.rank);
  const budget = process.env.XHS_VERIFY_LIMIT != null ? +process.env.XHS_VERIFY_LIMIT : XHS_VERIFY_PER_DAY;
  const todo = ranked.filter((c) => !verified[c.n.noteId] && !NOT_AI.test(c.n.title || '') && !LOOKS_AI.test(c.n.title || '')).slice(0, budget);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < todo.length && !broke) {
      const c = todo[next++];
      try {
        const j = await th(`/api/v1/xiaohongshu/app_v2/get_video_note_detail?note_id=${c.n.noteId}`);
        spent += PRICE.detail;
        const notes = [].concat(j?.data?.data || []).filter((d) => d?.id);
        // 一条都没返回多半是上游出错，不记，明天再查
        if (!notes.length) { warnings.push(`详情 ${c.n.noteId}：返回为空`); continue; }
        for (const d of notes) if (d.id === c.n.noteId || !verified[d.id]) verified[d.id] = record(d, now);
        verified[c.n.noteId] ||= { l: '', t: now }; // 详情里没有这条（被删了之类），当作没有 AI 标
      } catch (e) { warnings.push(`详情 ${c.n.noteId}：${e.message}`); if (e.broke) broke = true; }
    }
  }));
  writeJSON(VERIFY_FILE, verified);
  const items = ranked.filter((c) => verified[c.n.noteId]?.l).map((c) => toItem(c, verified[c.n.noteId]));

  // 3. 小红书热点榜
  const hot = [];
  let cursor = '';
  for (let p = 0; p < XHS_HOT_PAGES && !broke; p++) {
    try {
      let d = {};
      await retryEmpty(() => th(`/api/v1/xiaohongshu/app_v2/get_creator_hot_inspiration_feed?cursor=${encodeURIComponent(cursor)}`), PRICE.hot, (j) => { d = j?.data?.data || {}; return d.items; });
      hot.push(...(d.items || []).filter((h) => h.title));
      if (d.end_flag || !d.cursor) break;
      cursor = d.cursor;
    } catch (e) { warnings.push(`热点第${p + 1}页：${e.message}`); if (e.broke) broke = true; break; }
  }
  const trends = hot.map((h, i) => ({
    id: `xiaohongshu:${clean(h.title)}`,
    cat: 'trend', src: 'xiaohongshu', board: '小红书热点',
    title: clean(h.title),
    url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(clean(h.title))}`,
    heat: h.score || 0, rank: i + 1,
  }));

  const day = new Date(now).toISOString().slice(0, 10);
  writeJSON(STATE_FILE, {
    balance: typeof balance === 'number' ? +(balance - spent).toFixed(3) : undefined, checkedAt: now, day,
    spentToday: +((state.day === day ? state.spentToday || 0 : 0) + spent).toFixed(3),
    // 榜单拿到了才算今天拉过；没拿到的话下次运行再试
    runDate: cand.size ? bjDate(now) : state.runDate,
  }, true);
  if (!cand.size && !trends.length) throw new Error(warnings[0] || '内容广场和热点榜都是空的');
  const out = [...items, ...trends];
  out.warnings = warnings.slice(0, 5);
  out.info = `内容广场 ${cand.size} 条，查详情 ${todo.length} 条，带 AI 标 ${items.length} 条；热点 ${trends.length} 条；${retried ? `上游返回空重试 ${retried} 次；` : ''}本次约花 ${spent.toFixed(2)} 美元，余额约 ${typeof balance === 'number' ? (balance - spent).toFixed(2) : '?'}`;
  return out;
}
