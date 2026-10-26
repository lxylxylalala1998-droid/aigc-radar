// 生成并发送每日早报邮件
//   node src/mail.js --dry    只生成 out/mail.html 预览，不发送
//   node src/mail.js --wait   等到 SEND_AT（默认 09:00 北京时间）再发
//   node src/mail.js --mark   发完写 data/sent.json（定时早报用，防止当天重复发）
// 顺序和网页一致：今日选题（抖音 10 / B站 10）→ 抖音热点 → B站热点 → 小红书热点 → 热梗热搜 → 热歌飙升 → AI 大事件。每条都带「为什么能火」的分析
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { ROOT, DATA, DAY, HOUR, bjDate, readJSON, writeJSON, loadEnv, isMain, fmtNum, sleep } from './util.js';
import { SEND_AT, TZ, DEEPSEEK_WARN_BALANCE } from './config.js';
import { PLATFORM, unitOf } from './rank.js';
import { tikhubState } from './sources/tikhub.js';

// 用 <style> 里的短类名而不是逐个元素写内联样式：内容多，Gmail 超过 102KB 会截断
const CSS = `
body{margin:0;padding:0;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#191c22}
a{color:#191c22;text-decoration:none}
.w{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e6e8ec;border-radius:14px;word-break:break-word}
.hd{padding:22px 20px 6px}.k{font-size:12px;color:#6b7280;letter-spacing:1px}.dt{font-size:22px;font-weight:800;margin-top:4px}.cv{font-size:12px;color:#6b7280;margin-top:4px}
.btn{display:inline-block;margin-top:14px;background:#5b5bd6;color:#fff!important;font-size:14px;padding:8px 18px;border-radius:8px}
.s{padding:22px 20px 0}.s h2{font-size:17px;margin:0 0 4px}.s h2 small{font-size:12px;font-weight:400;color:#6b7280;margin-left:6px}
.sub{font-size:14px;font-weight:700;margin:14px 0 2px;color:#191c22}
.pk{background:#ececfb;border-radius:10px;padding:12px 14px;margin:8px 0}.pk .t{font-size:15px;font-weight:700;line-height:1.45;margin-top:4px}
.it{padding:10px 0;border-bottom:1px solid #e6e8ec}
.tt{font-size:14.5px;line-height:1.45}.tt small{color:#6b7280;font-size:13px}
.m{font-size:12px;color:#6b7280;margin-top:3px}
.a{font-size:13px;line-height:1.55;margin-top:4px;color:#374151}.a b{color:#5b5bd6;font-weight:600;margin-right:4px}
.b{display:inline-block;font-size:11px;line-height:16px;padding:0 5px;border-radius:4px;margin-right:4px;background:#eef0f3;color:#6b7280}
.hot{background:#e5484d;color:#fff}.ai{background:#ececfb;color:#5b5bd6}.hz{background:#5b5bd6;color:#fff}.warm{background:#f0820f;color:#fff}
.p-douyin{background:#111;color:#fff}.p-bilibili{background:#fb7299;color:#fff}.p-xiaohongshu{background:#ff2442;color:#fff}.p-weibo{background:#e6162d;color:#fff}.p-qqmusic{background:#20b363;color:#fff}.p-netease{background:#d43c33;color:#fff}
.r{display:inline-block;width:20px;color:#9aa1ad;font-weight:600}.r.top{color:#e5484d}
.up{color:#e5484d;font-weight:600}.refs a{color:#5b5bd6;font-size:12px;margin-right:10px}
.bx{border-radius:10px;overflow:hidden;margin:12px 0;background:#fff}.bx-dy{border:2px solid #161823}.bx-bl{border:2px solid #fb7299}
.bh{padding:10px 14px;color:#fff;font-size:16px;font-weight:700;letter-spacing:.5px}.bh-dy{background:#161823;border-bottom:3px solid #fe2c55}.bh-bl{background:#fb7299;border-bottom:3px solid #00a1d6}
.bi{padding:10px 14px;border-top:1px solid #eef0f3}.bi .t{font-size:15px;font-weight:700;line-height:1.45}.bn{font-weight:800;font-size:15px;margin-right:6px}.bn-dy{color:#fe2c55}.bn-bl{color:#00a1d6}
.ft{padding:24px 20px 22px;font-size:12px;color:#9aa1ad;line-height:1.7}.warn{color:#f0820f}
.pt{display:inline-block;font-size:11px;line-height:14px;padding:0 4px;border-radius:4px;margin-right:4px;border:1px dashed #9aa1ad;color:#6b7280}.pt.low{border:1px solid #e5484d;color:#e5484d}
.nt{font-weight:400;font-size:12px;color:#6b7280}.pkt{width:100%;border-collapse:collapse}.pc{width:104px;padding-left:10px}.pc img{display:block;width:104px;border-radius:6px}.c{text-align:center}.rs b{color:#e5484d}.gp{background:#f7f7fb;border-radius:10px;padding:10px 14px;margin:8px 0}
`;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const a = (url, text) => `<a href="${esc(url)}">${text}</a>`;
const b = (text, cls = '') => `<span class="b ${cls}">${esc(text)}</span>`;
const pb = (src) => b(PLATFORM[src] || src, `p-${src}`);
const an = (label, text) => (text ? `<div class="a"><b>${label}</b>${esc(text)}</div>` : '');
const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const note = (t) => `<span class="nt">${t}</span>`;
// 时效标签颜色：刚起势橙、高峰期红、已饱和灰
const TIMING_B = { 刚起势: 'warm', 高峰期: 'hot', 已饱和: '' };
const fmtDay = (ts) => new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', weekday: 'short' }).format(ts);
const fmtHM = (ts) => new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);
const sec = (title, sub, body) => `<div class="s"><h2>${title}${sub ? `<small>${sub}</small>` : ''}</h2>${body}</div>`;
const items = (arr, fn) => arr.map((x, i) => `<div class="it">${fn(x, i)}</div>`).join('');
const rk = (n) => `<span class="r ${n <= 3 ? 'top' : ''}">${n}</span>`;

// archive：存成网页版往期日报时用，不显示「本次未采集到」、余额这类只对当时有意义的提醒，按钮改成回到网页看这天的完整数据
// compact：邮件快超过 Gmail 的 102KB 截断线时用的精简版，热搜 / 热歌 / 飙升等次要列表少放几条（完整版在网页）
export const MAIL_LIMIT = 95 * 1024;
export function render(d, { siteUrl, archive = false, compact = false } = {}) {
  const L = compact ? { trend: 4, ch: 3, meme: 3, song: 2, low: 2, vel: 2 } : { trend: 6, ch: 5, meme: 5, song: 3, low: 3, vel: 3 };
  const site = siteUrl || process.env.SITE_URL || '';
  const parts = [];

  // 0. 3 分钟速览：今天最该做的 3 个选题 + 一句话风向 + 1 个低粉爆款 + 1 个信息差
  const br = d.brief;
  if (br && (br.top?.length || br.wind)) {
    const tb = (t) => [t.timing && b(t.timing, TIMING_B[t.timing] ?? ''), t.kind === '教程测评' && b('教程测评', 'hz'), t.level && b(`难度${t.level}${t.time ? ` · ${t.time}` : ''}`)].filter(Boolean).join('');
    parts.push(sec('⚡ 3 分钟速览', '先看这一块，完整选题和参考在下面', `
      ${br.wind ? `<div class="gp" style="font-weight:600;line-height:1.6">🧭 ${esc(br.wind)}</div>` : ''}
      ${(br.top || []).map((t, i) => `<div class="it"><div class="tt"><b>${i + 1}. </b>${pb(t.src)}<b>${esc(t.title)}</b></div><div class="m">${tb(t)}${PLATFORM[t.src]}选题第 ${t.i + 1} 个</div>${an('为什么先做', t.why)}</div>`).join('')}
      ${br.low ? `<div class="it"><div class="m">🌱 低粉爆款</div><div class="tt">${a(br.low.url, esc(cut(br.low.title, 40)))}</div><div class="m">${pb(br.low.src)}${fmtNum(br.low.heat)}${unitOf(br.low.src)}${br.low.fans ? `，作者粉丝只有 ${fmtNum(br.low.fans)}` : ''}</div></div>` : ''}
      ${br.gap ? `<div class="it" style="border-bottom:0"><div class="m">🔀 ${PLATFORM[br.gap.src]}爆了、${PLATFORM[br.gap.to]}还没人做</div><div class="tt">${a(br.gap.url, esc(cut(br.gap.title, 40)))}</div>${an(`搬到${PLATFORM[br.gap.to]}`, br.gap.how)}</div>` : ''}`));
  }

  // 1. 今日选题：抖音 10 个、B站 10 个，各用平台代表色框住（邮件太窄，上下排）
  const byPlat = Array.isArray(d.picks)
    ? { douyin: d.picks.filter((p) => p.platform !== 'B站'), bilibili: d.picks.filter((p) => p.platform === 'B站' || p.platform === '双平台') }
    : { douyin: d.picks?.douyin || [], bilibili: d.picks?.bilibili || [] };
  const pickBox = (s) => {
    const list = byPlat[s];
    if (!list.length) return '';
    const k = s === 'douyin' ? 'dy' : 'bl';
    // 邮件不放封面：抖音封面在 QQ 邮箱等邮件客户端里经常显示不了，只有 B站有图两边不齐，主要依据改成下面一行文字链接
    // 网页版往期（archive，浏览器里看）右边照常放主要依据那条作品的封面，点开看视频（B站封面用缩略图，10KB 左右）
    const side = (p) => {
      const mv = p.main;
      if (!archive || !mv?.url || !mv.cover || /\.heic/i.test(mv.cover)) return '';
      const img = mv.src === 'bilibili' && /hdslb\.com/.test(mv.cover) && !mv.cover.includes('@') ? `${mv.cover}@320w_200h_1c.jpg` : mv.cover;
      // 和网页一样不带 referer：B站 / 抖音的图片防盗链，带着别的网站的 referer 会打不开
      return `<td class="pc" valign="top">${a(mv.url, `<img src="${esc(img)}" width="104" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`)}<div class="m c">▶ 主要依据</div></td>`;
    };
    const refLinks = (p, withMain) => {
      const rest = (p.refs || []).filter((r) => r.url !== p.main?.url).slice(0, 2).map((r) => a(r.url, `↗ ${esc(cut(r.title, 16))}`));
      const main = withMain && p.main?.url ? [a(p.main.url, `<b>▶ 主要依据</b>${p.main.title ? `：${esc(cut(p.main.title, 16))}` : ''}`)] : [];
      return main.length || rest.length ? `<div class="refs">${[...main, ...rest].join(' ')}</div>` : '';
    };
    return `<div class="bx bx-${k}"><div class="bh bh-${k}">${PLATFORM[s]} · 今日选题 ${list.length} 个</div>${list.map((p, i) => {
      const sd = side(p);
      const body = `
        <div class="t"><span class="bn bn-${k}">${String(i + 1).padStart(2, '0')}</span>${p.horizon ? b(p.horizon, 'ai') : ''}${p.repeat ? b('连续推荐') : ''}${esc(p.title)}</div>
        <div class="m">${p.kind === '教程测评' ? b('教程测评', 'hz') : ''}${p.form === '系列' ? b('系列追更') : ''}${p.level ? b(`难度${p.level}${p.time ? ` · ${p.time}` : ''}`) : ''}${p.timing ? `${b(p.timing.label, TIMING_B[p.timing.label] ?? '')}${esc(p.timing.basis)}` : ''}</div>
        ${an('为什么能火', p.why)}${an('怎么做', p.how)}${an(p.flow ? '工作流程' : '工具链', p.flow || p.tools)}${an('公式', p.formula)}
        ${p.risk ? `<div class="a rs"><b>⚠ 风险</b>${esc(p.risk)}</div>` : ''}
        ${refLinks(p, !sd)}`;
      return `
      <div class="bi">${sd ? `<table class="pkt" role="presentation"><tr><td valign="top">${body}</td>${sd}</tr></table>` : body}</div>`;
    }).join('')}${d.rising?.[s]?.length ? `<div class="bi"><div class="m"><b style="color:#5b5bd6">前几天推过 · 还在涨：</b>${d.rising[s].map((r) => (r.url ? a(r.url, esc(cut(r.title, 18))) : esc(cut(r.title, 18)))).join('　')}</div></div>` : ''}</div>`;
  };
  // 跨平台信息差：一个平台爆了、另一个平台还没人做的题材（各 3 个）
  const gapBox = (list, from, to) => (list?.length ? `<div class="sub">${PLATFORM[from]}爆了 · ${PLATFORM[to]}还没人做</div>${list.slice(0, 3).map((x) => `<div class="gp">
      <div class="tt">${a(x.url, esc(cut(x.title, 40)))}</div>
      <div class="m">${pb(x.src)}${x.src === 'bilibili' ? '▶' : '❤'} ${fmtNum(x.heat)}　${esc(x.ai?.type || '')}</div>
      ${an('为什么值得做', x.why)}${an(`搬到${PLATFORM[to]}`, x.how)}</div>`).join('')}` : '');
  const gapHtml = d.gaps ? gapBox(d.gaps.toBilibili, 'douyin', 'bilibili') + gapBox(d.gaps.toDouyin, 'bilibili', 'douyin') : '';
  // 选题复盘：前一天的选题后来涨了多少
  const rv = d.review;
  const pct = (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;
  const rvHtml = rv?.items?.length ? `<div class="sub">选题复盘 · ${rv.date.slice(5).replace('-', '月')}日的选题 ${note('参考作品之后每天又涨了多少')}</div>
    <div class="a">${rv.byHorizon?.length ? `按信号看：${rv.byHorizon.map((h) => `${esc(h.horizon)} ${pct(h.avg)}/天`).join('，')}` : ''}</div>
    ${rv.items.slice(0, 3).map((r) => `<div class="m">${b(r.status, r.status === '继续涨' ? 'hot' : '')}${pb(r.src)}${esc(cut(r.title, 22))}　${fmtNum(r.from)} → ${fmtNum(r.to)}（${pct(r.perDay)}/天）</div>`).join('')}
    ${(() => { const st = rv.items.filter((r) => r.status === '停滞'); return st.length ? `<div class="m">已停滞：${st.slice(0, 5).map((r) => esc(cut(r.title, 14))).join('、')}${st.length > 5 ? ` 等 ${st.length} 个` : ''}</div>` : ''; })()}` : '';
  const pickHtml = pickBox('douyin') + pickBox('bilibili');
  if (pickHtml) parts.push(sec('🎯 今日选题', '抖音、B站各 10 个，按值得做的程度排', pickHtml + (gapHtml ? `<div class="sub" style="font-size:16px;margin-top:18px">🔀 跨平台信息差 ${note('用同样的题材做原创，不是搬运')}</div>${gapHtml}` : '') + rvHtml));

  // 2 / 3. 抖音热点、B站热点：近 30 天高赞（重点类型）+ 24 小时飙升
  const vids = d.videos || {};
  const fmtDur = (t) => (!t ? '' : t >= 60 ? `${Math.floor(t / 60)}分${t % 60 ? `${t % 60}秒` : '钟'}` : `${t}秒`);
  const pts = (v) => (v.pt || []).map((k) => `<span class="pt ${k === '低粉爆款' ? 'low' : ''}">${esc(k)}</span>`).join('');
  const vRow = (v, s) => `
    <div class="tt">${a(v.url, esc(cut(v.title, 60)))}</div>
    <div class="m">${b(v.ai?.type || 'AIGC', 'ai')}${v.m?.aiLabel ? b({ 作者声明: '作者声明AI', 平台识别: '平台识别AI', AI特效: 'AI特效角标' }[v.m.aiLabel] || 'AI标') : ''}${pts(v)}${s === 'douyin' && v.m?.play ? `▶ ${v.m.playWin ? `近${v.m.playWin}天 ` : ''}${fmtNum(v.m.play)}　` : ''}${s === 'xiaohongshu' && v.m?.read ? `阅读 ${fmtNum(v.m.read)}　` : ''}${s === 'bilibili' ? '▶' : '❤'} ${fmtNum(v.heat)}${v.vel && v.vel > 1 ? `　<span class="up">+${fmtNum(v.vel)}${s === 'bilibili' ? '' : '赞'}/小时</span>` : ''}　${esc(v.author || '')}${v.m?.fans && v.pt?.includes('低粉爆款') ? `（粉丝 ${fmtNum(v.m.fans)}）` : ''}${v.pubAt && !v.m?.noDate ? `　${Math.max(1, Math.round((d.generatedAt - v.pubAt) / DAY))} 天前` : ''}${v.m?.dur ? `　${fmtDur(v.m.dur)}` : ''}</div>
    ${v.m?.bgm ? `<div class="m">♪ ${esc(cut(v.m.bgm, 30))}</div>` : ''}
    ${an('爆点', v.ai?.hook)}${an('参考', v.ai?.tip)}`;
  const LOW_NOTE = { douyin: '作者粉丝不到 5 万、点赞过 10 万：小号也能做', bilibili: 'UP 主粉丝不到 3 万、播放过 30 万：小号也能做', xiaohongshu: '作者粉丝不到 1 万、点赞过 5 万：小号也能做' };
  // dedupe：后面的小节不再列前面已经出现过的作品（小红书的数据本来就来自热门榜，高赞榜和飙升大多是同几条）
  const vSection = (s, emoji, topTitle, topNote, velNote, { topN = 10, dedupe = false } = {}) => {
    const shown = new Set();
    let html = '';
    for (const [k, title, n, max] of [[`${s}Top`, topTitle, topNote, topN], [`${s}Low`, '低粉爆款 · 近 14 天', LOW_NOTE[s], L.low], [s, '24 小时飙升', velNote, L.vel]]) {
      const list = (vids[k] || []).filter((v) => !dedupe || !shown.has(v.id)).slice(0, max);
      if (!list.length) continue;
      list.forEach((v) => shown.add(v.id));
      html += `<div class="sub">${title} ${note(n)}</div>` + items(list, (v) => vRow(v, s));
    }
    if (html) parts.push(sec(`${emoji} ${PLATFORM[s]}热点`, `${PLATFORM[s]}上的 AIGC 爆款`, html));
  };
  vSection('douyin', '🎬', '高赞榜 TOP10 · 近 30 天', '近 30 天所有 AIGC 作品严格按累计点赞排，同一作者只留最火的一条；只收抖音官方标了 AI 的', '按每小时新增点赞');
  vSection('bilibili', '📺', '高播放榜 TOP10 · 近 30 天', '近 30 天所有 AIGC 作品严格按播放排，同一作者只留最火的一条', '按每小时新增播放');
  // 邮件只放前 6（Gmail 超过 102KB 会截断），完整榜单在网页
  vSection('xiaohongshu', '📕', '高赞榜 TOP6 · 近 30 天', '近 30 天所有 AIGC 作品严格按累计点赞排，同一作者只留最火的一条；只收作者声明了 AI 生成的，完整 TOP10 在网页', '按每小时新增点赞，每天更新一次；上面列过的不重复', { topN: 6, dedupe: true });

  // 4. 热梗热搜：抖音 / B站 / 微博各自一张榜，再是抖音挑战、热梗精选（和网页同序）
  const tr = d.trends || {};
  // 邮件只放精简版（Gmail 超过 102KB 会截断），完整榜单在网页
  const trendHtml = ['douyin', 'bilibili', 'weibo', 'xiaohongshu'].filter((s) => tr[s]?.length).map((s) => `<div class="sub">${pb(s)}${PLATFORM[s]}${s === 'xiaohongshu' ? '热点' : '热搜'} · 前 ${Math.min(L.trend, tr[s].length)}</div>` + items(tr[s].slice(0, L.trend), (t, i) => `
    <div class="tt">${rk(i + 1)}${a(t.url, esc(t.title))}${t.kind ? ` ${b(t.kind, 'warm')}` : ''}${t.ai?.tag ? ` ${b(t.ai.tag, 'ai')}` : ''}</div>
    ${t.ai?.why ? `<div class="a">${esc(t.ai.why)}</div>` : ''}`)).join('');
  const ch = d.challenges || [];
  const chHtml = ch.length ? `<div class="sub">${pb('douyin')}抖音挑战 / 玩法 ${note('抖音热榜里官方归类为玩法的词条')}</div>` + items(ch.slice(0, L.ch), (t) => `
    <div class="tt">${b(t.kind, t.kind === '抖音挑战' ? 'warm' : 'ai')}${a(t.url, esc(t.title))}${t.rank ? ` <span class="m">热榜第 ${t.rank}</span>` : ''}</div>
    ${t.m?.fetched ? `<div class="m">参与视频里 ${t.m.aiVideos || 0}/${t.m.fetched} 条是 AI 做的</div>` : ''}
    ${an('为什么火', t.ai?.why)}${an('AI 跟拍', t.ai?.idea)}
    ${(t.top || []).slice(0, 1).map((v) => `<div class="m">${a(v.url, `❤ ${fmtNum(v.like)}　${v.ai ? b('AI', 'ai') : ''}${esc(cut(v.title || '（无文案）', 36))}`)}</div>`).join('')}`) : '';
  const memes = d.memes || [];
  const memeHtml = memes.length ? `<div class="sub">热梗精选 ${note('AI 从各平台热搜里挑的热梗 / AI 相关 / 可借势')}</div>` + items(memes.slice(0, L.meme), (t) => `
    <div class="tt">${b(t.ai.tag, t.ai.tag === '热梗' ? 'warm' : 'ai')}${a(t.url, esc(t.title))} ${pb(t.src)}</div>
    ${an('为什么火', t.ai.why)}${an('AI 做法', t.ai.idea)}`) : '';
  if (trendHtml || chHtml || memeHtml) parts.push(sec('😂 热梗热搜', '抖音 / B站 / 微博 / 小红书 / 抖音挑战 / 热梗精选', trendHtml + chHtml + memeHtml));

  // 5. 热歌飙升：四个平台，热歌榜 / 飙升榜各前 5（完整 TOP20 在网页）
  const mu = d.music || {};
  const musicHtml = ['抖音', 'B站', 'QQ音乐', '网易云'].filter((p) => mu[p]).map((p) => ['热歌榜', '飙升榜'].filter((k) => mu[p][k]?.length).map((k) => {
    const src = mu[p][k][0].src;
    const weekly = p === '抖音' || p === 'B站' ? '（周榜）' : '';
    return `<div class="sub">${pb(src)}${k}${weekly}</div>` + items(mu[p][k].slice(0, L.song), (m) => `
      <div class="tt">${rk(m.rank)}${a(m.url, esc(m.title))} <small>— ${esc(cut(m.author || '', 24))}</small>${m.label ? ` <span class="up">${esc(m.label)}</span>` : ''}</div>
      ${m.ai?.why ? `<div class="a">${esc(m.ai.why)}${m.ai.use ? `　<b>可以做</b>${esc(m.ai.use)}` : ''}</div>` : ''}`);
  }).join('')).join('');
  // 抖音 AIGC 爆款用得最多的 BGM（近 7 天）
  const bg = d.bgms || [];
  const bgmHtml = bg.length ? `<div class="sub">🎧 AIGC 爆款常用 BGM · 近 7 天 ${note('抖音 AIGC 作品用得最多的配乐，不含原声')}</div>` + items(bg.slice(0, 5), (m, i) => `
    <div class="tt">${rk(i + 1)}${esc(cut(m.title, 30))}　<span class="m">${m.n} 条在用 · 合计 ❤ ${fmtNum(m.likes)}</span></div>
    ${m.best ? `<div class="m">代表作：${a(m.best.url, esc(cut(m.best.title, 30)))}</div>` : ''}`) : '';
  if (musicHtml || bgmHtml) parts.push(sec('🎵 热歌飙升', '各榜前 3，完整 TOP20 在网页', bgmHtml + musicHtml));

  // 6. AI 大事件：汇总全部资讯来源，同一件事的多篇报道合并
  // 爆款工具榜：近 7 天 AIGC 爆款里提到各工具的作品数，和上 7 天比
  const tl = d.tools || [];
  const toolHtml = tl.length ? `<div class="sub">🛠 爆款工具榜 · 近 7 天 ${note('AIGC 作品标题 / 话题里提到的工具，括号里是上 7 天')}</div><div class="a">${tl.slice(0, 8).map((t, i) => `${i + 1}. <b style="color:#191c22">${esc(t.name)}</b> ${t.n}${t.prev != null ? `（${t.prev}${t.prev && t.n > t.prev * 1.3 ? ' <span class="up">↑</span>' : !t.prev ? ' <span class="up">新</span>' : ''}）` : ''}`).join('　')}</div>` : '';
  if (d.news?.length || toolHtml) {
    const ev = (d.news || []).slice(0, 10);
    parts.push(sec('🤖 AI 大事件', `${(d.news || []).length} 件，显示前 ${ev.length}`, toolHtml + items(ev, (e) => `
      <div>${e.level === '重磅' ? b('重磅', 'hot') : ''}${e.kind ? b(e.kind) : ''}</div>
      <div class="tt" style="font-weight:600;margin-top:3px">${a(e.refs[0]?.url, esc(e.title))}</div>
      ${e.summary ? `<div class="a">${esc(e.summary)}</div>` : ''}
      <div class="m">来源：${[...new Set(e.refs.map((r) => r.src))].join(' / ')}</div>`)));
  }

  const st = archive ? { sources: {} } : readJSON(path.join(DATA, 'status.json'), { sources: {} });
  const bad = Object.values(st.sources).filter((s) => !s.ok).map((s) => s.name);
  // TikHub 余额（抖音 + 小红书合起来）：低于 1 美元提醒充值，按今天两边一共花的钱估还能用几天
  const th = archive ? null : tikhubState();
  // DeepSeek 余额：低于 DEEPSEEK_WARN_BALANCE 元提醒；按最近 3 天的用量估还能用几天（价格按官网 flash 档的高峰 / 空闲均价估）
  const ds = archive ? null : readJSON(path.join(DATA, 'deepseek.json'), null);
  const use = Object.entries(readJSON(path.join(DATA, 'deepseek-usage.json'), {})).sort().slice(-4, -1).map(([, u]) => ((u.in - u.hit) * 1.5 + u.hit * 0.03 + u.out * 6) / 1e6);
  const perDay = use.length ? use.reduce((s, x) => s + x, 0) / use.length : 0;
  const dsWarn = ds && typeof ds.balance === 'number' && ds.balance < DEEPSEEK_WARN_BALANCE ? `<div class="warn">⚠ DeepSeek 余额剩 ${ds.balance.toFixed(2)} 元${perDay ? `，按最近的用量大约还能用 ${Math.max(0, Math.floor(ds.balance / perDay))} 天` : ''}，用完后 AI 分析会停。充值：platform.deepseek.com</div>` : '';
  const thWarn = th && th.balance < 1 ? `<div class="warn">⚠ TikHub 余额剩 ${th.balance} 美元${th.perDay ? `，大约还能用 ${Math.max(0, Math.floor(th.balance / th.perDay))} 天` : ''}，用完后抖音高赞榜、小红书会暂停。充值：user.tikhub.io</div>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${archive ? '<meta name="robots" content="noindex, nofollow">' : ''}<title>AIGC 热点早报 · ${fmtDay(d.generatedAt)}</title><style>${CSS.replace(/\n/g, '')}</style></head>
<body><div style="padding:16px 8px"><div class="w">
<div class="hd">
  <div class="k">AIGC 热点雷达 · 早报</div>
  <div class="dt">${fmtDay(d.generatedAt)}</div>
  <div class="cv">覆盖 ${fmtHM(d.window[0])} — ${fmtHM(d.window[1])}${d.ai ? `　·　AI 分析：${esc(d.ai)}` : ''}</div>
  ${archive ? `<a class="btn" href="../#w=1&day=${esc(d.date)}">在网页上看这天的完整数据</a>` : site ? `<a class="btn" href="${esc(site)}">打开网页版，看全部 + 按 3 天 / 7 天 / 30 天查</a>` : ''}
</div>
${parts.join('\n')}
<div class="ft">
  ${bad.length ? `<div class="warn">⚠ 本次未采集到：${bad.join('、')}（下次会自动重试）</div>` : ''}
  ${thWarn}
  ${dsWarn}
  ${d.errors?.length ? '<div class="warn">⚠ AI 分析部分出错，相关板块用规则兜底</div>' : ''}
  <div>标「推测」的分析是 AI 根据有限信息做的判断，仅供参考。${site ? `看不懂某个标签？${a(`${site}#guide`, '<span style="color:#5b5bd6">看「怎么看这份报告」</span>')}` : ''}</div>
</div>
</div></div></body></html>`;
}

export function subject(d) {
  const first = (Array.isArray(d.picks) ? d.picks[0] : d.picks?.douyin?.[0] || d.picks?.bilibili?.[0])?.title || d.news?.[0]?.title || '';
  return `AIGC 热点早报 ${fmtDay(d.generatedAt)}${first ? `｜${first}` : ''}`;
}

// 等到北京时间 SEND_AT 再发；如果已经过了（GitHub 定时延迟），立刻发
async function waitUntilSendTime() {
  const [h, m] = SEND_AT.split(':').map(Number);
  const now = Date.now();
  const target = Date.parse(`${bjDate(now)}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
  const wait = target - now;
  if (wait > 0 && wait < 3 * HOUR) {
    console.log(`等待 ${Math.round(wait / 60e3)} 分钟到 ${SEND_AT} 再发送…`);
    await sleep(wait);
  }
}

// 收件人：MAIL_TO 里的全部地址；报警邮件只发给 ALERT_TO（没设就是 MAIL_TO 的第一个）
export const recipients = () => (process.env.MAIL_TO || '').split(/[,;，；\s]+/).filter(Boolean);
export const alertRecipients = () => {
  const a = (process.env.ALERT_TO || '').split(/[,;，；\s]+/).filter(Boolean);
  return a.length ? a : recipients().slice(0, 1);
};

// 发一封 HTML 邮件给一组人：每个收件人单独发一封，互相看不到邮箱，一个地址出错也不影响别人
export async function sendHtml(to, subj, html) {
  const user = process.env.SMTP_USER;
  if (!to.length || !user || !process.env.SMTP_PASS) throw new Error('缺少 MAIL_TO / SMTP_USER / SMTP_PASS，无法发信');
  const port = +(process.env.SMTP_PORT || 465);
  const tx = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.qq.com', port, secure: port === 465,
    auth: { user, pass: process.env.SMTP_PASS },
  });
  const fails = [];
  for (const addr of to) {
    try {
      await tx.sendMail({ from: { name: process.env.MAIL_FROM_NAME || 'AIGC 热点雷达', address: user }, to: addr, subject: subj, html });
      console.log(`✓ 已发送 → ${addr.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
    } catch (e) {
      fails.push(addr);
      console.log(`✗ 发送失败 → ${addr.replace(/(.{2}).*(@.*)/, '$1***$2')}：${e.message}`);
    }
    await sleep(1500);
  }
  if (fails.length === to.length) throw new Error('全部发送失败');
}

// 超过 95KB 就发精简版（发信前自检也会提前算一遍）
export function mailHtml(d) {
  const full = render(d);
  return Buffer.byteLength(full) > MAIL_LIMIT ? render(d, { compact: true }) : full;
}

export async function send(d) {
  await sendHtml(recipients(), subject(d), mailHtml(d));
}

function latestDigest() {
  for (let i = 0; i < 3; i++) {
    const d = readJSON(path.join(DATA, 'digests', `${bjDate(Date.now() - i * DAY)}.json`));
    if (d) return d;
  }
  throw new Error('找不到最近的日报，先跑 node src/curate.js');
}

if (isMain(import.meta.url)) {
  loadEnv();
  const args = process.argv.slice(2);
  (async () => {
    const d = latestDigest();
    if (args.includes('--dry')) {
      fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'out', 'mail.html'), mailHtml(d));
      console.log(`主题：${subject(d)}\n预览已写到 out/mail.html（${(fs.statSync(path.join(ROOT, 'out', 'mail.html')).size / 1024).toFixed(0)}KB）`);
      return;
    }
    if (args.includes('--wait')) await waitUntilSendTime();
    await send(d);
    // 定时早报发完记一笔：当天后面的早报时间点看到它就不再重复发
    if (args.includes('--mark')) writeJSON(path.join(DATA, 'sent.json'), { date: bjDate(), at: Date.now() }, true);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
