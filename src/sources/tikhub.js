// 抖音高赞 AIGC（经 TikHub 付费接口，国内免费接口拿不到）。只在每天早报那次运行时拉
//   1. 盯一批 AIGC 话题，按「最多点赞」取，只留近 30 天的
//   2. 创作者中心热门视频榜（按播放），挑出 AIGC —— 唯一能拿到抖音真实播放量的地方
//   3. AI 发现的新玩法：搜一次拿到话题 ID，之后自动加进第 1 条
import path from 'node:path';
import { clean, isAI, sleep, DAY, DATA, readJSON, writeJSON } from '../util.js';
import { DY_HASHTAGS, DY_BILLBOARD_TAGS, DY_RECENT_PAGE, TIKHUB_NEW_TAGS_PER_DAY, TIKHUB_MIN_BALANCE } from '../config.js';
import { plain, hashtags, aiLabel } from './douyin.js';

const BASE = 'https://api.tikhub.io';
const TAG_FILE = path.join(DATA, 'dy-hashtags.json'); // AI 发现的新话题
const STATE_FILE = path.join(DATA, 'tikhub.json'); // 余额、今天花了多少

let spent = 0;
async function th(p, body) {
  const res = await fetch(BASE + p, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${process.env.TIKHUB_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90e3),
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 402) { const e = new Error('TikHub 余额不足'); e.broke = true; throw e; }
  if (!res.ok) throw new Error(`TikHub ${res.status} ${j?.detail?.message || ''}`.trim());
  return j;
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

// 抖音视频 ID 的高 32 位是发布时间（秒），用来补榜单里缺的发布时间
export function idTime(id) {
  try { const ms = Number(BigInt(id) >> 32n) * 1000; return ms > Date.UTC(2016, 0) && ms <= Date.now() + 864e5 ? ms : 0; } catch { return 0; }
}

function videoItem(a, board, hint) {
  const st = a.statistics || {};
  return {
    id: `dy:${a.aweme_id}`,
    cat: 'video', src: 'douyin', board,
    title: plain(a.desc).slice(0, 80) || '（无文案）',
    url: `https://www.douyin.com/video/${a.aweme_id}`,
    author: a.author?.nickname || '',
    cover: a.video?.cover?.url_list?.[0] || a.video?.origin_cover?.url_list?.[0], // 约 14 天有效
    heat: st.digg_count || 0,
    pubAt: (a.create_time || 0) * 1000,
    tags: hashtags(a).slice(0, 8).join(','),
    desc: clean(a.desc).slice(0, 120),
    m: { like: st.digg_count || 0, comment: st.comment_count || 0, share: st.share_count || 0, fav: st.collect_count || 0, hint, aiLabel: aiLabel(a) || undefined },
  };
}

// 新玩法 → 话题 ID：每天最多搜几个，搜到的话题之后每天自动盯（14 天内没再被 AI 提到就不盯了）
async function resolveNewTags(now, warnings) {
  const known = readJSON(TAG_FILE, {});
  const trends = readJSON(path.join(DATA, 'trend-keywords.json'), {});
  const norm = (s) => s.toLowerCase().replace(/s/g, '');
  const fixed = new Set(DY_HASHTAGS.map((t) => norm(t.name)));
  const todo = Object.entries(trends)
    .filter(([kw, v]) => v.last > now - 3 * DAY && !known[kw] && !fixed.has(norm(kw)))
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, TIKHUB_NEW_TAGS_PER_DAY);
  for (const [kw] of todo) {
    try {
      const j = await th('/api/v1/douyin/search/fetch_challenge_search_v2', { keyword: kw, cursor: 0, sort_type: '0', publish_time: '0', filter_duration: '0', content_type: '0', search_id: '', backtrace: '' });
      spent += 0.01;
      const tags = [];
      (function walk(o) { if (!o || typeof o !== 'object') return; const c = o.challenge_info; if (c?.cid) { tags.push(c); return; } for (const v of Object.values(o)) walk(v); })(j);
      const k = kw.toLowerCase().replace(/\s/g, '');
      const best = tags.find((c) => c.cha_name?.toLowerCase().replace(/\s/g, '') === k) || tags.find((c) => c.cha_name?.toLowerCase().includes(k)) || null;
      known[kw] = best ? { name: best.cha_name, id: String(best.cid), views: best.view_count || 0, added: now, last: now } : { none: true, added: now, last: now };
    } catch (e) { warnings.push(`搜话题「${kw}」：${e.message}`); if (e.broke) break; }
  }
  for (const [kw, v] of Object.entries(known)) {
    if (trends[kw]?.last) v.last = Math.max(v.last || 0, trends[kw].last);
    if (v.last < now - 14 * DAY) delete known[kw];
  }
  writeJSON(TAG_FILE, known, true);
  return Object.values(known).filter((v) => v.id).map((v) => ({ name: v.name, id: v.id, pages: 1, type: null, auto: true }));
}

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

  const out = [];
  const seen = new Set();
  const since = now - 31 * DAY;
  const push = (item) => { if (!seen.has(item.id) && item.pubAt > since) { seen.add(item.id); out.push(item); } };

  // 1. 话题：按最多点赞翻页（高赞），再按综合拉一页（最近新发的）
  const tags = [...DY_HASHTAGS, ...(await resolveNewTags(now, warnings))];
  let broke = false;
  // 所有话题请求排成一队，同时跑 4 个（TikHub 限速每秒 10 次），88 次请求约 1 分钟
  const jobs = tags.flatMap((t) => [
    ...Array.from({ length: t.pages || 1 }, (_, p) => ({ t, sort: 1, cursor: p * 10 })),
    ...(DY_RECENT_PAGE ? [{ t, sort: 0, cursor: 0 }] : []),
  ]);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < jobs.length && !broke) {
      const q = jobs[next++];
      try {
        const j = await th(`/api/v1/douyin/app/v3/fetch_hashtag_video_list?ch_id=${q.t.id}&cursor=${q.cursor}&sort_type=${q.sort}&count=10`);
        spent += 0.001;
        // 只收抖音官方标了 AI 的（作者声明 / 平台识别 / AI 特效）
        for (const a of awemes(j)) if (aiLabel(a)) push(videoItem(a, `话题·#${q.t.name}`, q.t.type));
      } catch (e) { warnings.push(`#${q.t.name}：${e.message}`); if (e.broke) broke = true; }
    }
  }));

  // 2. 创作者热门视频榜（近 30 天按播放），只留看起来跟 AI 有关的，交给 AI 再判断
  for (const b of broke ? [] : DY_BILLBOARD_TAGS) {
    try {
      const j = await th(`/api/v1/douyin/creator/fetch_creator_material_center_billboard?billboard_tag=${b.tag}&order_key=1&time_filter=3`);
      spent += 0.001;
      for (const x of firstList(j?.data) || []) {
        const text = `${x.title || ''} ${(x.key_words || []).join(' ')}`;
        if (!isAI(text) || !x.item_id) continue;
        // 榜单不带 AI 标记，查一次详情（0.001 美元）确认是不是官方标了 AI
        let detail = null;
        try { detail = awemes(await th(`/api/v1/douyin/app/v3/fetch_one_video?aweme_id=${x.item_id}`))[0]; spent += 0.001; } catch (e) { warnings.push(`详情 ${x.item_id}：${e.message}`); }
        const lbl = detail ? aiLabel(detail) : '';
        if (!lbl) continue;
        push({
          id: `dy:${x.item_id}`, cat: 'video', src: 'douyin', board: `热门视频榜·${b.name}`,
          title: plain(x.title || '').slice(0, 80) || '（无文案）', url: `https://www.douyin.com/video/${x.item_id}`,
          author: x.author_name || '', heat: x.like_count || 0, cover: x.cover?.url_list?.[0],
          // 榜单不给发布时间，但抖音视频 ID 的高 32 位就是发布时间戳（实测误差十几秒）
          pubAt: idTime(x.item_id) || now,
          desc: clean(x.title || '').slice(0, 120), tags: (x.key_words || []).slice(0, 6).join(','),
          m: { play: x.play_count || 0, like: x.like_count || 0, comment: x.comment_count || 0, share: x.share_count || 0, noDate: idTime(x.item_id) ? undefined : 1, aiLabel: lbl },
        });
      }
    } catch (e) { warnings.push(`热门视频榜·${b.name}：${e.message}`); if (e.broke) break; }
  }

  const today = new Date(now).toISOString().slice(0, 10);
  writeJSON(STATE_FILE, {
    balance: typeof balance === 'number' ? +(balance - spent).toFixed(3) : balance, checkedAt: now,
    spentToday: +((state.day === today ? state.spentToday || 0 : 0) + spent).toFixed(3), day: today,
  }, true);
  out.warnings = warnings.slice(0, 5);
  out.info = `本次约花 ${spent.toFixed(3)} 美元，余额约 ${typeof balance === 'number' ? (balance - spent).toFixed(3) : '?'}`;
  return out;
}
