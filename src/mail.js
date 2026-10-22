// 生成并发送每日早报邮件
//   node src/mail.js --dry    只生成 out/mail.html 预览，不发送
//   node src/mail.js --wait   等到 SEND_AT（默认 09:00 北京时间）再发
// 顺序：今日选题 → AIGC 爆款 → 热梗热搜 → 热歌 / 飙升 → AI 圈大事件。每条都带「为什么能火」的分析
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { ROOT, DATA, DAY, HOUR, bjDate, readJSON, loadEnv, isMain, fmtNum, sleep } from './util.js';
import { SEND_AT, TZ } from './config.js';
import { PLATFORM } from './rank.js';

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
.p-douyin{background:#111;color:#fff}.p-bilibili{background:#fb7299;color:#fff}.p-weibo{background:#e6162d;color:#fff}.p-qqmusic{background:#20b363;color:#fff}.p-netease{background:#d43c33;color:#fff}
.r{display:inline-block;width:20px;color:#9aa1ad;font-weight:600}.r.top{color:#e5484d}
.up{color:#e5484d;font-weight:600}.refs a{color:#5b5bd6;font-size:12px;margin-right:10px}
.ft{padding:24px 20px 22px;font-size:12px;color:#9aa1ad;line-height:1.7}.warn{color:#f0820f}
`;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const a = (url, text) => `<a href="${esc(url)}">${text}</a>`;
const b = (text, cls = '') => `<span class="b ${cls}">${esc(text)}</span>`;
const pb = (src) => b(PLATFORM[src] || src, `p-${src}`);
const an = (label, text) => (text ? `<div class="a"><b>${label}</b>${esc(text)}</div>` : '');
const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const fmtDay = (ts) => new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', weekday: 'short' }).format(ts);
const fmtHM = (ts) => new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);
const sec = (title, sub, body) => `<div class="s"><h2>${title}${sub ? `<small>${sub}</small>` : ''}</h2>${body}</div>`;
const items = (arr, fn) => arr.map((x, i) => `<div class="it">${fn(x, i)}</div>`).join('');
const rk = (n) => `<span class="r ${n <= 3 ? 'top' : ''}">${n}</span>`;

export function render(d, { siteUrl } = {}) {
  const site = siteUrl || process.env.SITE_URL || '';
  const parts = [];

  // 1. 今日选题
  if (d.picks?.length) {
    parts.push(sec('🎯 今日选题', '基于抖音 / B站 AIGC 热点', d.picks.map((p, i) => `
      <div class="pk">
        <div>${b(`0${i + 1}`, 'hz')}${p.horizon ? b(p.horizon, 'ai') : ''}${p.platform ? b(p.platform) : ''}</div>
        <div class="t">${esc(p.title)}</div>
        ${an('为什么能火', p.why)}${an('怎么做', p.how)}
        ${p.refs?.length ? `<div class="refs">${p.refs.map((r) => a(r.url, `↗ ${esc(cut(r.title, 20))}`)).join(' ')}</div>` : ''}
      </div>`).join('')));
  }

  // 2. AIGC 爆款：先看近 30 天高赞榜（重点类型），再看 24 小时飙升
  const vids = d.videos || {};
  const note = (t) => `<span style="font-weight:400;font-size:12px;color:#6b7280">${t}</span>`;
  const vRow = (v, s) => `
    <div class="tt">${a(v.url, esc(cut(v.title, 60)))}</div>
    <div class="m">${b(v.ai?.type || 'AIGC', 'ai')}${v.m?.aiCorner ? b('AI角标') : ''}${s === 'douyin' && v.m?.play ? `▶ ${fmtNum(v.m.play)}　` : ''}${s === 'douyin' ? '❤' : '▶'} ${fmtNum(v.heat)}${v.vel && v.vel > 1 ? `　<span class="up">+${fmtNum(v.vel)}${s === 'douyin' ? '赞' : ''}/小时</span>` : ''}　${esc(v.author || '')}${v.pubAt && !v.m?.noDate ? `　${Math.max(1, Math.round((d.generatedAt - v.pubAt) / DAY))} 天前` : ''}</div>
    ${an('爆点', v.ai?.hook)}${an('参考', v.ai?.tip)}`;
  const blocks = [
    ['douyinTop', 'douyin', `高赞榜 · 近 30 天 ${note('按点赞；AI音乐 / MV / 歌手艺人 / 鬼畜 / 影视 / 换人')}`],
    ['bilibiliTop', 'bilibili', `高播放榜 · 近 30 天 ${note('按播放；同上 6 类')}`],
    ['douyin', 'douyin', `24 小时飙升 ${note('按每小时新增点赞')}`],
    ['bilibili', 'bilibili', `24 小时飙升 ${note('按每小时新增播放')}`],
  ];
  const vBlock = blocks.filter(([k]) => vids[k]?.length).map(([k, s, title]) => `<div class="sub">${pb(s)}${title}</div>` + items(vids[k].slice(0, k.endsWith('Top') ? 8 : 5), (v) => vRow(v, s))).join('');
  if (vBlock) parts.push(sec('🔥 AIGC 爆款', '高赞榜 + 24 小时飙升', vBlock));

  // 3. 热梗热搜
  const memes = d.memes || [];
  const tr = d.trends || {};
  const memeHtml = memes.length ? `<div class="sub">AI 挑出的热梗 / 可借势</div>` + items(memes, (t) => `
    <div class="tt">${b(t.ai.tag, t.ai.tag === '热梗' ? 'warm' : 'ai')}${a(t.url, esc(t.title))} ${pb(t.src)}</div>
    ${an('为什么火', t.ai.why)}${an('AI 做法', t.ai.idea)}`) : '';
  // 抖音热门挑战 / 玩法：热榜里抖音官方归类为「站内玩法」「话题互动」的词条
  const ch = d.challenges || [];
  const chHtml = ch.length ? `<div class="sub">${pb('douyin')}热门挑战 / 玩法<span style="font-weight:400;font-size:12px;color:#6b7280"> 抖音热榜里官方归类为玩法的词条</span></div>` + items(ch, (t) => `
    <div class="tt">${b(t.kind, t.kind === '抖音挑战' ? 'warm' : 'ai')}${a(t.url, esc(t.title))}${t.rank ? ` <span class="m">热榜第 ${t.rank}</span>` : ''}</div>
    ${t.m?.fetched ? `<div class="m">参与视频里 ${t.m.aiVideos || 0}/${t.m.fetched} 条是 AI 做的</div>` : ''}
    ${an('为什么火', t.ai?.why)}${an('AI 跟拍', t.ai?.idea)}
    ${(t.top || []).slice(0, 2).map((v) => `<div class="m">${a(v.url, `❤ ${fmtNum(v.like)}　${v.ai ? b('AI', 'ai') : ''}${esc(cut(v.title || '（无文案）', 36))}`)}</div>`).join('')}`) : '';
  const trendHtml = ['douyin', 'bilibili', 'weibo'].filter((s) => tr[s]?.length).map((s) => `<div class="sub">${pb(s)}热搜前 ${tr[s].length}</div>` + items(tr[s], (t, i) => `
    <div class="tt">${rk(i + 1)}${a(t.url, esc(t.title))}${t.kind ? ` ${b(t.kind, 'warm')}` : ''}${t.ai?.tag ? ` ${b(t.ai.tag, 'ai')}` : ''}</div>
    ${t.ai?.why ? `<div class="a">${esc(t.ai.why)}</div>` : ''}`)).join('');
  if (memeHtml || chHtml || trendHtml) parts.push(sec('😂 最新热梗热搜', '抖音 / B站 / 微博', memeHtml + chHtml + trendHtml));

  // 4. 热歌 / 飙升
  const mu = d.music || {};
  const musicHtml = ['抖音', 'B站', 'QQ音乐', '网易云'].filter((p) => mu[p]).map((p) => ['热歌榜', '飙升榜'].filter((k) => mu[p][k]?.length).map((k) => {
    const src = mu[p][k][0].src;
    const weekly = p === '抖音' || p === 'B站' ? '（周榜）' : '';
    return `<div class="sub">${pb(src)}${k}${weekly}</div>` + items(mu[p][k].slice(0, 5), (m) => `
      <div class="tt">${rk(m.rank)}${a(m.url, esc(m.title))} <small>— ${esc(cut(m.author || '', 24))}</small>${m.label ? ` <span class="up">${esc(m.label)}</span>` : ''}</div>
      ${m.ai?.why ? `<div class="a">${esc(m.ai.why)}${m.ai.use ? `　<b>可以做</b>${esc(m.ai.use)}` : ''}</div>` : ''}`);
  }).join('')).join('');
  if (musicHtml) parts.push(sec('🎵 热歌榜 & 飙升榜', '各榜前 5', musicHtml));

  // 5. AI 圈大事件
  if (d.news?.length) {
    const ev = d.news.slice(0, 10);
    parts.push(sec('🤖 今日 AI 圈大事件', `${d.news.length} 件，显示前 ${ev.length}`, items(ev, (e) => `
      <div>${e.level === '重磅' ? b('重磅', 'hot') : ''}${e.kind ? b(e.kind) : ''}</div>
      <div class="tt" style="font-weight:600;margin-top:3px">${a(e.refs[0]?.url, esc(e.title))}</div>
      ${e.summary ? `<div class="a">${esc(e.summary)}</div>` : ''}
      <div class="m">来源：${[...new Set(e.refs.map((r) => r.src))].join(' / ')}</div>`)));
  }

  const st = readJSON(path.join(DATA, 'status.json'), { sources: {} });
  const bad = Object.values(st.sources).filter((s) => !s.ok).map((s) => s.name);
  // TikHub 余额：低于 1 美元提醒充值（每天约 0.05 美元）
  const th = readJSON(path.join(DATA, 'tikhub.json'), null);
  const thWarn = th && typeof th.balance === 'number' && th.balance < 1 ? `<div class="warn">⚠ TikHub 余额剩 ${th.balance} 美元，大约还能用 ${Math.max(0, Math.floor(th.balance / 0.05))} 天，用完后抖音高赞榜会暂停。充值：user.tikhub.io</div>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AIGC 热点早报</title><style>${CSS.replace(/\n/g, '')}</style></head>
<body><div style="padding:16px 8px"><div class="w">
<div class="hd">
  <div class="k">AIGC 热点雷达 · 早报</div>
  <div class="dt">${fmtDay(d.generatedAt)}</div>
  <div class="cv">覆盖 ${fmtHM(d.window[0])} — ${fmtHM(d.window[1])}${d.ai ? `　·　AI 分析：${esc(d.ai)}` : ''}</div>
  ${site ? `<a class="btn" href="${esc(site)}">打开网页版，看全部 + 按 3 天 / 7 天 / 30 天查</a>` : ''}
</div>
${parts.join('\n')}
<div class="ft">
  ${bad.length ? `<div class="warn">⚠ 本次未采集到：${bad.join('、')}（下次会自动重试）</div>` : ''}
  ${thWarn}
  ${d.errors?.length ? '<div class="warn">⚠ AI 分析部分出错，相关板块用规则兜底</div>' : ''}
  <div>标「推测」的分析是 AI 根据有限信息做的判断，仅供参考。小红书暂未接入。</div>
</div>
</div></div></body></html>`;
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
