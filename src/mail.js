// 生成并发送每日早报邮件
//   node src/mail.js --dry    只生成 out/mail.html 预览，不发送
//   node src/mail.js --wait   等到 SEND_AT（默认 09:00 北京时间）再发
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { ROOT, DATA, DAY, HOUR, bjDate, readJSON, loadEnv, isMain, fmtNum, sleep } from './util.js';
import { SEND_AT, TZ } from './config.js';
import { PLATFORM } from './rank.js';

const C = { text: '#191c22', muted: '#6b7280', line: '#e6e8ec', bg: '#f5f6f8', accent: '#5b5bd6', soft: '#ececfb', hot: '#e5484d', warm: '#f0820f' };
const PCOLOR = { weibo: '#e6162d', douyin: '#111111', bilibili: '#fb7299', youtube: '#ff0033', qqmusic: '#20b363', netease: '#d43c33' };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const a = (url, text, style = '') => `<a href="${esc(url)}" style="color:${C.text};text-decoration:none;${style}">${text}</a>`;
const badge = (text, bg, color = '#fff') => `<span style="display:inline-block;font-size:11px;line-height:16px;padding:0 5px;border-radius:4px;background:${bg};color:${color};margin-right:4px;white-space:nowrap">${esc(text)}</span>`;
const pbadge = (src) => badge(PLATFORM[src] || src, PCOLOR[src] || '#888');
const fmtDay = (ts) => new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', weekday: 'short' }).format(ts);
const fmtHM = (ts) => new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);

function section(title, sub, body) {
  return `
  <tr><td style="padding:22px 20px 6px">
    <div style="font-size:17px;font-weight:700;color:${C.text}">${title}${sub ? `<span style="font-size:12px;font-weight:400;color:${C.muted};margin-left:8px">${sub}</span>` : ''}</div>
  </td></tr>
  <tr><td style="padding:0 20px">${body}</td></tr>`;
}
const item = (inner, last) => `<div style="padding:10px 0;${last ? '' : `border-bottom:1px solid ${C.line}`}">${inner}</div>`;
const list = (arr, fn) => arr.map((x, i) => item(fn(x, i), i === arr.length - 1)).join('');
const ai = (t) => (t ? `<div style="font-size:13px;color:${C.accent};margin-top:3px">AI · ${esc(t)}</div>` : '');

export function render(d, { siteUrl } = {}) {
  const site = siteUrl || process.env.SITE_URL || '';
  const parts = [];

  if (d.picks?.length) {
    parts.push(section('🎯 今日选题', 'AI 根据下面所有热点给的建议', d.picks.map((p, i) => `
      <div style="background:${C.soft};border-radius:10px;padding:12px 14px;margin:8px 0">
        <div style="font-size:15px;font-weight:700;color:${C.text};line-height:1.45"><span style="color:${C.accent};margin-right:6px">${i + 1}</span>${esc(p.title)}</div>
        <div style="font-size:13px;color:${C.muted};margin-top:5px;line-height:1.55"><b style="color:${C.text}">为什么</b>　${esc(p.why)}</div>
        <div style="font-size:13px;color:${C.muted};margin-top:3px;line-height:1.55"><b style="color:${C.text}">怎么做</b>　${esc(p.how)}</div>
        ${p.refs?.length ? `<div style="font-size:12px;margin-top:6px;line-height:1.7">${p.refs.map((r) => a(r.url, `↗ ${esc(r.title.length > 22 ? r.title.slice(0, 22) + '…' : r.title)}`, `color:${C.accent};margin-right:10px`)).join(' ')}</div>` : ''}
      </div>`).join('')));
  }

  if (d.news?.length) {
    const ev = d.news.slice(0, 10);
    parts.push(section('🤖 AI 圈大事件', `${d.news.length} 件，显示前 ${ev.length}`, list(ev, (e) => `
      <div>${e.level === '重磅' ? badge('重磅', C.hot) : ''}${e.kind ? badge(e.kind, C.bg, C.muted) : ''}</div>
      <div style="font-size:15px;font-weight:600;line-height:1.45;margin-top:4px">${a(e.refs[0]?.url, esc(e.title))}</div>
      ${e.summary ? `<div style="font-size:13px;color:${C.muted};line-height:1.55;margin-top:2px">${esc(e.summary)}</div>` : ''}
      <div style="font-size:12px;color:#9aa1ad;margin-top:3px">来源：${[...new Set(e.refs.map((r) => r.src))].join(' / ')}</div>`)));
  }

  if (d.videos?.length) {
    const vs = d.videos.slice(0, 10);
    parts.push(section('🔥 AIGC 爆款', '过去 24 小时增长最快', list(vs, (v) => `
      <div style="font-size:14.5px;line-height:1.45">${a(v.url, esc(v.title))}</div>
      <div style="font-size:12px;color:${C.muted};margin-top:4px">${pbadge(v.src)}${badge(v.ai?.type || 'AIGC', C.soft, C.accent)}▶ ${fmtNum(v.heat)}${v.vel ? `　<b style="color:${C.hot}">+${fmtNum(v.vel)}/小时</b>` : ''}　${esc(v.author || '')}</div>
      ${ai(v.why)}`)));
  }

  if (d.memes?.length) {
    const ms = d.memes.slice(0, 12);
    // 窄屏上三栏会挤爆，改成每个平台一段可折行的文字
    const top = (src) => (d.trends?.[src] || []).slice(0, 10).map((x, i) => `<span style="color:${i < 3 ? C.hot : '#9aa1ad'};margin-right:3px">${i + 1}</span>${a(x.url, esc(x.title))}`).join(`<span style="color:#c9cdd4">　|　</span>`);
    parts.push(section('😂 热梗 & 可借势热搜', 'AI 从微博 / 抖音 / B站热搜里挑的', list(ms, (t) => `
      <div style="font-size:14.5px;line-height:1.45">${badge(t.ai.tag, t.ai.tag === '热梗' ? C.warm : C.soft, t.ai.tag === '热梗' ? '#fff' : C.accent)}${a(t.url, esc(t.title))}　${pbadge(t.src)}</div>
      ${ai(t.ai.note)}`) + `
      <div style="margin-top:14px;font-size:13px;font-weight:600;color:${C.text}">各平台热搜前 10</div>
      ${['weibo', 'douyin', 'bilibili'].filter((s) => d.trends?.[s]?.length).map((s) => `<div style="font-size:13px;line-height:1.9;margin-top:8px">${pbadge(s)} ${top(s)}</div>`).join('')}`));
  }

  const hl = d.music?.highlights || [];
  const boards = d.music?.boards || {};
  // 邮件里只放变化快的三个榜，其它榜在网页上看
  const pick = ['抖音热歌榜', 'QQ音乐飙升榜', '网易云飙升榜'].filter((b) => boards[b]?.length);
  if (hl.length || pick.length) {
    const boardHtml = pick.map((b) => `
      <div style="margin-top:12px;font-size:13px;font-weight:600">${esc(b)}</div>
      ${boards[b].slice(0, b.includes('抖音') ? 8 : 5).map((m) => `<div style="font-size:13px;line-height:1.6;padding:2px 0"><span style="color:${m.rank <= 3 ? C.hot : '#9aa1ad'};display:inline-block;width:20px">${m.rank}</span>${a(m.url, esc(m.title))}<span style="color:${C.muted}"> — ${esc(m.author)}</span>${m.label ? ` <span style="color:${C.hot};font-size:12px">${esc(m.label)}</span>` : ''}</div>`).join('')}`).join('');
    parts.push(section('🎵 热歌', '', (hl.length ? `<div style="font-size:13px;font-weight:600;margin-top:4px">AI 推荐：适合做 AI 翻唱 / MV</div>` + list(hl, (m) => `
      <div style="font-size:14.5px">${a(m.url, `${esc(m.title)}<span style="color:${C.muted}"> — ${esc(m.author)}</span>`)}</div>
      <div style="font-size:12px;color:${C.muted};margin-top:3px">${pbadge(m.src)}${esc(m.board)} 第 ${m.rank} 名</div>
      ${ai(m.note)}`) : '') + boardHtml));
  }

  const st = readJSON(path.join(DATA, 'status.json'), { sources: {} });
  const bad = Object.values(st.sources).filter((s) => !s.ok).map((s) => s.name);
  const btn = site ? `<a href="${esc(site)}" style="display:inline-block;background:${C.accent};color:#fff;text-decoration:none;font-size:14px;padding:8px 18px;border-radius:8px">打开网页版，按 3 天 / 7 天 / 30 天查</a>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AIGC 热点早报</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:${C.text}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${C.bg}"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;table-layout:fixed;word-break:break-word;background:#fff;border-radius:14px;border:1px solid ${C.line}">
  <tr><td style="padding:22px 20px 4px">
    <div style="font-size:12px;color:${C.muted};letter-spacing:1px">AIGC 热点雷达 · 早报</div>
    <div style="font-size:22px;font-weight:800;margin-top:4px">${fmtDay(d.generatedAt)}</div>
    <div style="font-size:12px;color:${C.muted};margin-top:4px">覆盖 ${fmtHM(d.window[0])} — ${fmtHM(d.window[1])}${d.ai ? `　·　AI 点评：${esc(d.ai)}` : ''}</div>
    ${btn ? `<div style="margin-top:14px">${btn}</div>` : ''}
  </td></tr>
  ${parts.join('')}
  <tr><td style="padding:24px 20px 22px;font-size:12px;color:#9aa1ad;line-height:1.7">
    ${bad.length ? `<div style="color:${C.warm}">⚠ 本次未采集到：${bad.join('、')}（下次会自动重试）</div>` : ''}
    ${d.errors?.length ? `<div style="color:${C.warm}">⚠ AI 点评部分出错，相关板块用规则兜底</div>` : ''}
    <div>数据来自微博、抖音、B站、YouTube、QQ音乐、网易云及多家 AI 媒体的公开榜单。小红书暂未接入。</div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export function subject(d) {
  const first = d.picks?.[0]?.title || d.news?.[0]?.title || '';
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

export async function send(d) {
  const to = (process.env.MAIL_TO || '').split(/[,;，；\s]+/).filter(Boolean);
  const user = process.env.SMTP_USER;
  if (!to.length || !user || !process.env.SMTP_PASS) throw new Error('缺少 MAIL_TO / SMTP_USER / SMTP_PASS，无法发信');
  const port = +(process.env.SMTP_PORT || 465);
  const tx = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.qq.com', port, secure: port === 465,
    auth: { user, pass: process.env.SMTP_PASS },
  });
  const html = render(d);
  const fails = [];
  // 每个收件人单独发一封：互相看不到邮箱，一个地址出错也不影响别人
  for (const addr of to) {
    try {
      await tx.sendMail({ from: { name: process.env.MAIL_FROM_NAME || 'AIGC 热点雷达', address: user }, to: addr, subject: subject(d), html });
      console.log(`✓ 已发送 → ${addr.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
    } catch (e) {
      fails.push(addr);
      console.log(`✗ 发送失败 → ${addr.replace(/(.{2}).*(@.*)/, '$1***$2')}：${e.message}`);
    }
    await sleep(1500);
  }
  if (fails.length === to.length) throw new Error('全部发送失败');
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
      fs.writeFileSync(path.join(ROOT, 'out', 'mail.html'), render(d));
      console.log(`主题：${subject(d)}\n预览已写到 out/mail.html（${(fs.statSync(path.join(ROOT, 'out', 'mail.html')).size / 1024).toFixed(0)}KB）`);
      return;
    }
    if (args.includes('--wait')) await waitUntilSendTime();
    await send(d);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
