// 封面保障：网页上凡是有封面位置的地方都不能空着
//   1. 抖音视频封面：链接带签名，约 14 天过期；热榜上掉下去的视频不会再被刷新，10-23 以前抓的还有 heic（浏览器显示不了）
//      → 网页会展示的抖音视频（各时间窗口的列表 + 近 31 天日报里引用的），封面没有 / heic / 3 天内过期的，
//        经 TikHub 查一次详情换新封面，写回数据（每天最多 DY_COVER_PER_DAY 条）
//   2. 选题封面：没挂视频的选题（只借了热搜，或者教程测评挂的是新闻）
//      → 热搜对应的原作（补成主要依据）→ 新闻网页的配图（分享配图或正文第一张图，国内打不开的站不用）→ 同题材作品的封面；找到的写回日报，以后不用再找
//   都找不到的，网页上显示文字封面（选题标题），不会是空色块
import fs from 'node:fs';
import path from 'node:path';
import { DATA, DAY, UA, bjDate, readJSON, writeJSON } from './util.js';
import { DY_COVER_PER_DAY, TIKHUB_MIN_BALANCE, WEB_WINDOWS } from './config.js';
import { loadWindow } from './rank.js';
import { webVideos } from './clusters.js';
import { th, awemes, tikhubState } from './sources/tikhub.js';
import { coverOf } from './sources/douyin.js';
import { isWork, keyGrams, sharePhrase, trendIsWork } from './curate.js';

const STATE = path.join(DATA, 'covers.json'); // { day, used: 今天查了几条, failed: { 视频 id: 时间 } }
const dayFile = (ts) => path.join(DATA, 'days', `${bjDate(ts)}.json`);
const digestFile = (ts) => path.join(DATA, 'digests', `${bjDate(ts)}.json`);
const expires = (u) => +(/x-expires=(\d+)/.exec(u || '')?.[1] || 0) * 1000;
export const usable = (u) => !!u && !/\.heic/i.test(u);
const byHeat = (a, b) => (b.heat || 0) - (a.heat || 0);

// 近 31 天日报里引用到的视频链接：选题的主要依据和参考、还在涨、信息差
function digestVideoUrls(now) {
  const urls = new Set();
  for (let k = 0; k <= 31; k++) {
    const dg = readJSON(digestFile(now - k * DAY));
    if (!dg?.picks || Array.isArray(dg.picks)) continue;
    for (const s of ['douyin', 'bilibili']) {
      for (const p of dg.picks[s] || []) [p.main?.url, ...(p.refs || []).filter((r) => r.kind === 'video').map((r) => r.url)].forEach((u) => u && urls.add(u));
      for (const r of dg.rising?.[s] || []) if (r.url) urls.add(r.url);
    }
    for (const x of [...(dg.gaps?.toBilibili || []), ...(dg.gaps?.toDouyin || [])]) if (x.url) urls.add(x.url);
  }
  return urls;
}

// 新封面 / 已删除标记写回：loadWindow 里同一条视频以最新一天的数据为准，所以改它出现过的最近那一天
function writeBack(covers, gone, now) {
  const left = new Map([...covers, ...[...gone].map((id) => [id, null])]);
  for (let k = 0; k <= 33 && left.size; k++) {
    const f = dayFile(now - k * DAY);
    const day = readJSON(f);
    if (!day?.items) continue;
    let n = 0;
    for (const [id, cv] of left) {
      if (!day.items[id]) continue;
      if (cv) day.items[id].cover = cv;
      else day.items[id].gone = now;
      left.delete(id);
      n++;
    }
    if (n) writeJSON(f, day);
  }
}

// 网页各时间窗口列表里的抖音视频：和 build.js windowData 的挑法一致（近 31 天发布、带官方 AI 标，24 小时按增速、其余按热度，各取前 WEB_VIDEO_LIMIT 条）
function shownDouyin(now) {
  const ids = new Set();
  for (const days of WEB_WINDOWS) webVideos(days, now, 'douyin').forEach((x) => ids.add(x.id));
  return ids;
}

export async function refreshDouyinCovers(now = Date.now()) {
  if (!process.env.TIKHUB_API_KEY) return '没配置 TIKHUB_API_KEY，跳过';
  const bal = tikhubState()?.balance;
  if (typeof bal === 'number' && bal < TIKHUB_MIN_BALANCE) return `TikHub 余额只剩 ${bal} 美元，跳过`;
  const st = readJSON(STATE, {});
  if (st.day !== bjDate(now)) Object.assign(st, { day: bjDate(now), used: 0 });
  st.failed ||= {};
  for (const [id, t] of Object.entries(st.failed)) if (t < now - 7 * DAY) delete st.failed[id];

  // 网页展示的抖音视频（各窗口列表）+ 近 31 天日报里引用的
  const refs = digestVideoUrls(now);
  const shown = shownDouyin(now);
  const all = loadWindow(31, now).filter((x) => x.cat === 'video' && x.src === 'douyin' && !x.gone);
  const need = all.filter((x) => (shown.has(x.id) || refs.has(x.url)) && !st.failed[x.id] && (!usable(x.cover) || expires(x.cover) < now + 3 * DAY))
    // 日报引用的、根本没封面的先换，其余按热度（越热越可能在列表前面）
    .sort((a, b) => (refs.has(b.url) - refs.has(a.url)) || (usable(a.cover) - usable(b.cover)) || byHeat(a, b));
  const todo = need.slice(0, Math.max(0, DY_COVER_PER_DAY - st.used));
  const got = new Map();
  const gone = new Set();
  let next = 0, calls = 0, broke = false;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < todo.length && !broke) {
      const x = todo[next++];
      try {
        const a = awemes(await th(`/api/v1/douyin/app/v3/fetch_one_video?aweme_id=${x.id.slice(3)}`))[0];
        calls++;
        const cv = coverOf(a);
        if (cv) got.set(x.id, cv);
        else {
          st.failed[x.id] = now; // 7 天内不再查
          if (!a) gone.add(x.id); // 查不到视频：删了或设了私密，网页上不再展示
        }
      } catch (e) { if (e.broke) broke = true; }
    }
  }));
  writeBack(got, gone, now);
  st.used += calls;
  writeJSON(STATE, st, true);
  // 记进 TikHub 今天的花费（余额提醒用）
  const tf = path.join(DATA, 'tikhub.json');
  const ts = readJSON(tf, null);
  const today = new Date(now).toISOString().slice(0, 10); // 和 tikhub.js 一样按 UTC 日期记
  if (ts && calls) writeJSON(tf, { ...ts, balance: typeof ts.balance === 'number' ? +(ts.balance - calls * 0.001).toFixed(3) : ts.balance, spentToday: +((ts.day === today ? ts.spentToday || 0 : 0) + calls * 0.001).toFixed(3), day: today }, true);
  return `抖音封面：要换 ${need.length} 条，这次换了 ${got.size} 条（查了 ${calls} 次，今天累计 ${st.used}/${DY_COVER_PER_DAY}）${need.length > todo.length ? `，剩下的明天接着换` : ''}`;
}

// 图片能不能直接打开：不带 referer（和网页一样），要是浏览器能显示的格式
export async function imageOk(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15e3) });
    const ct = r.headers.get('content-type') || '';
    const n = (await r.arrayBuffer()).byteLength;
    return r.ok && /^image\/(jpeg|jpg|png|webp|gif)/i.test(ct) && n > 2000;
  } catch { return false; }
}

// 国内打不开的站：网页在 GitHub 上能抓到，但用户在国内看不到这些站的图片，不用
const BLOCKED = /huggingface|google|gstatic|ggpht|youtube|ytimg|openai\.com|oaistatic|twimg|twitter\.com|(^|\.)x\.com|facebook|fbcdn|instagram|wikimedia|wikipedia|medium\.com|substack/i;
const host = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
// IT之家的正文图是一千多像素宽的 PNG（几百 KB），用它家图片服务缩成小图
const shrink = (u) => (/img\.ithome\.com\/newsuploadfiles\//.test(u) ? `${u.split('?')[0]}?x-bce-process=image/resize,m_lfit,w_360/format,f_jpg/quality,q_75` : u);
const attr = (tag, name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1];

// 新闻网页的配图：先找分享配图（og:image / twitter:image），没有就取正文第一张大图（IT之家没有 og:image）
export async function pageImage(url) {
  if (BLOCKED.test(host(url))) return '';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(15e3) });
    if (!r.ok) return '';
    const html = (await r.text()).slice(0, 500e3);
    const found = [];
    for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
      if (/(?:property|name)\s*=\s*["'](?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)["']/i.test(tag)) found.push(attr(tag, 'content'));
    }
    for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
      const src = attr(tag, 'data-original') || attr(tag, 'data-src') || attr(tag, 'data-lazy-src') || attr(tag, 'src');
      const w = +(attr(tag, 'width') || attr(tag, 'w') || 0);
      if (!src || /\.svg|\.gif|\/t\.png|logo|icon|avatar|emoji|sprite|placeholder|blank|qrcode/i.test(src) || (w && w < 300)) continue;
      found.push(src);
    }
    for (const c of found.filter(Boolean)) {
      const u = new URL(c.replace(/&amp;/g, '&'), url).href;
      if (!BLOCKED.test(host(u))) return shrink(u);
    }
  } catch {}
  return '';
}

// 同题材：共有一个中文专有词（3 字以上），或者共有一个英文名（5 个字母以上，多是工具 / 模型名，比如 seedance、deepseek）
const EN_STOP = new Set(['video', 'videos', 'model', 'models', 'image', 'images', 'music', 'flash', 'preview', 'cover', 'remix', 'version', 'official', 'trailer', 'short', 'shorts', 'first', 'world', 'style']);
const enWords = (t) => new Set((String(t || '').toLowerCase().match(/[a-z][a-z0-9]{4,}/g) || []).filter((w) => !EN_STOP.has(w)));
function sameTheme(text, x) {
  if (sharePhrase(keyGrams(x.title), new Set(keyGrams(text)))) return true;
  const a = enWords(text);
  for (const w of enWords(`${x.title} ${x.tags || ''}`)) if (a.has(w)) return true;
  return false;
}

// 给日报里没有封面的选题找封面，有改动返回 true
//   works：{ douyin: [...], bilibili: [...] } 近 30 天的 AIGC 作品（封面能用的）
export async function fixPickCovers(dg, works, now = Date.now()) {
  if (!dg?.picks || Array.isArray(dg.picks)) return false;
  let changed = false;
  for (const s of ['douyin', 'bilibili']) {
    for (const p of dg.picks[s] || []) {
      if (p.main?.url || p.refs?.some((r) => r.kind === 'video') || p.cover?.img) continue; // 有作品的，封面由 build 用最新数据补
      if (p.coverTried > now - DAY) continue; // 找过没找到，一天最多再找一次
      const pool = works[s] || [];
      // 1. 只借了热搜：热搜说的就是哪条作品，补成主要依据（跨天去重也靠它）
      const w = (p.refs || []).filter((r) => r.kind === 'trend')
        .map((t) => pool.filter((x) => trendIsWork(t.title, x)).sort(byHeat)[0]).find(Boolean);
      if (w) {
        p.main = { url: w.url, cover: w.cover, src: w.src, title: w.title, heat: w.heat };
        p.refs = [{ kind: 'video', title: w.title, url: w.url, id: w.id, heat: w.heat }, ...(p.refs || [])];
        delete p.coverTried;
        changed = true;
        continue;
      }
      // 2. 挂的是新闻（新工具测评）：用新闻网页的配图
      const news = (p.refs || []).find((r) => r.kind === 'news');
      const img = news ? await pageImage(news.url) : '';
      if (img && await imageOk(img)) {
        p.cover = { img, url: news.url, title: news.title, kind: 'news' };
        delete p.coverTried;
        changed = true;
        continue;
      }
      // 3. 同题材作品的封面（只当配图，不算主要依据）
      const text = [p.title, ...(p.refs || []).map((r) => r.title)].join(' ');
      const v = pool.filter((x) => sameTheme(text, x)).sort(byHeat)[0];
      if (v) {
        p.cover = { img: v.cover, url: v.url, title: v.title, src: v.src, kind: 'video' };
        delete p.coverTried;
      } else p.coverTried = now;
      changed = true;
    }
  }
  return changed;
}

export const worksBySrc = (list) => Object.fromEntries(['douyin', 'bilibili'].map((s) => [s, list.filter((x) => isWork(x) && x.src === s && usable(x.cover))]));

// 近 31 天的日报逐份补选题封面（每 3 小时跑一次，补过的不会重复找）
export async function backfillPickCovers(now = Date.now()) {
  const works = worksBySrc(loadWindow(31, now));
  let fixed = 0, left = 0;
  for (let k = 0; k <= 31; k++) {
    const f = digestFile(now - k * DAY);
    if (!fs.existsSync(f)) continue;
    const dg = readJSON(f);
    if (await fixPickCovers(dg, works, now)) writeJSON(f, dg, true);
    for (const s of ['douyin', 'bilibili']) for (const p of dg.picks?.[s] || []) {
      if (p.main?.url || p.refs?.some((r) => r.kind === 'video')) continue;
      if (p.cover?.img) fixed++; else left++;
    }
  }
  return `选题封面：没挂作品的选题里 ${fixed} 个有配图${left ? `，${left} 个没找到（显示文字封面）` : ''}`;
}
