// 周报：每周一早上发，回顾过去 7 天，帮博主排这一周的内容
//   一句话总结、本周建议的 5 个方向、上周一直在涨的题材（AI 写）
//   上周爆款 TOP5、选题复盘（哪类信号推荐的选题后劲足、时效标签准不准）、工具热度、低粉爆款（程序算）
//   node src/weekly.js           生成并发送（今天已经发过就跳过）
//   node src/weekly.js --dry     只生成 out/weekly.html 预览，不发送
//   node src/weekly.js --force   今天发过也重发
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA, DAY, bjDate, readJSON, writeJSON, loadEnv, isMain, fmtNum } from './util.js';
import { loadWindow, PLATFORM } from './rank.js';
import { ask, step, isWork, heatAt, saveUsage, typeOf, stats } from './curate.js';
import { lowFan, toolRank, withFans } from './insight.js';
import { recipients, sendHtml } from './mail.js';

const WEEK = 7;
const pct = (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;
const md = (date) => `${+date.slice(5, 7)}月${+date.slice(8)}日`;

// 选题复盘：过去 7 天每份日报的选题，参考作品从推荐时到现在每天涨了多少
function weekReview(now, pool) {
  const byUrl = new Map(pool.filter((x) => x.cat === 'video').map((x) => [x.url, x]));
  const rows = [];
  for (let k = 1; k <= WEEK; k++) {
    const dg = readJSON(path.join(DATA, 'digests', `${bjDate(now - k * DAY)}.json`));
    if (!dg?.picks || Array.isArray(dg.picks)) continue;
    const days = Math.max(0.5, (now - dg.generatedAt) / DAY);
    for (const s of ['douyin', 'bilibili']) {
      for (const p of dg.picks[s] || []) {
        let best = null;
        for (const r of (p.refs || []).filter((q) => q.kind === 'video')) {
          const x = byUrl.get(r.url);
          const then = r.heat || (x && heatAt(x, dg.generatedAt));
          if (!x || !then || !x.heat) continue;
          const g = (x.heat - then) / then;
          if (!best || g > best.g) best = { g, then, to: x.heat, url: r.url };
        }
        if (best) rows.push({ date: dg.date, src: s, title: p.title, horizon: p.horizon || '其它', timing: p.timing?.label || '没判断', growth: best.g, perDay: best.g / days, from: best.then, to: best.to, url: best.url });
      }
    }
  }
  const avgBy = (key) => Object.entries(rows.reduce((g, r) => ((g[r[key]] ||= []).push(r.perDay), g), {}))
    .map(([k, v]) => ({ k, n: v.length, avg: +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(3) })).sort((a, b) => b.avg - a.avg);
  return {
    n: rows.length, days: [...new Set(rows.map((r) => r.date))].sort(),
    byHorizon: avgBy('horizon'), byTiming: avgBy('timing'),
    best: [...rows].sort((a, b) => b.perDay - a.perDay).slice(0, 5),
  };
}

async function writeWeek(data) {
  const line = (x) => `${PLATFORM[x.src]}|${typeOf(x)}|${x.title}|${stats(x)}`;
  return ask(`下面是过去 7 天抖音、B站 AIGC 内容的汇总数据。请输出：
- summary：一句话总结上周 AIGC 内容圈的变化，≤50 字，要具体
- themes：上周一直在涨 / 持续出爆款的 3~5 个题材（是一类内容，不是单个作品），每个写 title（≤12 字）、platform（抖音 / B站 / 双平台）、why（为什么持续火，≤40 字）
- directions：本周建议重点做的 5 个方向，每个写 title（≤16 字）、platform、why（结合数据说，≤40 字）、how（具体怎么做：步骤和要点，不点名具体平台 / 模型，≤50 字）
  要参考【选题复盘】：哪类信号（时间段 / 时效）推荐的选题后劲更足，就往那类方向多倾斜；已经饱和的题材不要再推

输出格式：{"summary":"","themes":[{"title":"","platform":"","why":""}],"directions":[{"title":"","platform":"","why":"","how":""}]}

【上周爆款】
${data.works.map(line).join('\n')}

【每天的选题标题】
${data.pickTitles.join('\n') || '（无）'}

【选题复盘】参考作品之后每天平均涨幅
按时间段：${data.review.byHorizon.map((h) => `${h.k} ${pct(h.avg)}（${h.n} 个）`).join('，') || '（数据不够）'}
按时效标签：${data.review.byTiming.map((h) => `${h.k} ${pct(h.avg)}（${h.n} 个）`).join('，') || '（数据不够）'}

【爆款工具】${data.tools.slice(0, 8).map((t) => `${t.name} ${t.n}${t.prev != null ? `（上周 ${t.prev}）` : ''}`).join('，') || '（无）'}

【持续在榜的热搜 / 挑战】${data.lasting.map((x) => `${x.title}（${x.daysSeen} 天）`).join('、') || '（无）'}`, { maxTokens: 2500 });
}

export async function weekly(now = Date.now()) {
  const errors = [];
  const fans = Object.fromEntries(Object.entries(readJSON(path.join(DATA, 'bili-fans.json'), {})).map(([k, v]) => [k, v.f]));
  const all7 = loadWindow(WEEK, now).map((x) => withFans(x, fans));
  const pool = loadWindow(WEEK + 3, now);

  // 上周爆款：每个平台 7 天内发布的 AIGC 作品按热度前 5，同一作者只留一条
  const top = {};
  for (const s of ['douyin', 'bilibili']) {
    const seen = new Set();
    top[s] = all7.filter((x) => isWork(x) && x.src === s && x.pubAt > now - WEEK * DAY).sort((a, b) => (b.heat || 0) - (a.heat || 0))
      .filter((x) => { const k = x.author || x.id; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 10);
  }
  const low = Object.fromEntries(['douyin', 'bilibili'].map((s) => [s, all7.filter((x) => isWork(x) && x.src === s && x.pubAt > now - WEEK * DAY && lowFan(x)).sort((a, b) => (b.heat || 0) - (a.heat || 0)).slice(0, 3)]));
  const history = fs.existsSync(path.join(DATA, 'days')) ? fs.readdirSync(path.join(DATA, 'days')).filter((f) => f.endsWith('.json')).length : 0;
  const tools = toolRank(loadWindow(WEEK * 2, now).filter(isWork), now, WEEK, { compare: history >= WEEK * 2 }).slice(0, 10);
  const review = weekReview(now, pool);
  const pickTitles = [];
  for (let k = WEEK; k >= 1; k--) {
    const dg = readJSON(path.join(DATA, 'digests', `${bjDate(now - k * DAY)}.json`));
    if (dg?.picks && !Array.isArray(dg.picks)) pickTitles.push(`${md(dg.date)}：${['douyin', 'bilibili'].flatMap((s) => (dg.picks[s] || []).map((p) => p.title)).join(' / ')}`);
  }
  const lasting = all7.filter((x) => x.cat === 'trend' && x.daysSeen >= 3 && (x.kind || x.ai?.tag)).sort((a, b) => b.daysSeen - a.daysSeen).slice(0, 12);

  const ai = await step('周报', () => writeWeek({ works: [...top.douyin, ...top.bilibili], pickTitles, review, tools, lasting }), () => ({}), errors);
  const brief = (x) => ({ title: x.title, url: x.url, src: x.src, heat: x.heat, author: x.author, type: typeOf(x), fans: x.m?.fans, pubAt: x.pubAt, low: lowFan(x) || undefined });
  const out = {
    date: bjDate(now), generatedAt: now, range: [bjDate(now - WEEK * DAY), bjDate(now - DAY)], errors,
    summary: ai.summary || '', themes: (ai.themes || []).slice(0, 5), directions: (ai.directions || []).slice(0, 5),
    top: { douyin: top.douyin.slice(0, 5).map(brief), bilibili: top.bilibili.slice(0, 5).map(brief) },
    low: { douyin: low.douyin.map(brief), bilibili: low.bilibili.map(brief) },
    review, tools,
  };
  writeJSON(path.join(DATA, 'weekly', `${out.date}.json`), out, true);
  console.log(`周报完成：方向 ${out.directions.length}，题材 ${out.themes.length}，复盘 ${review.n} 个选题，工具 ${tools.length}${errors.length ? `；AI 出错 ${errors.length} 处` : ''}`);
  return out;
}

// ---------- 渲染（邮件和网页上的往期周报共用） ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const a = (url, text) => `<a href="${esc(url)}">${text}</a>`;
const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
const CSS = `body{margin:0;padding:0;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#191c22}
a{color:#191c22;text-decoration:none}.w{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e6e8ec;border-radius:14px;word-break:break-word}
.hd{padding:22px 20px 6px}.k{font-size:12px;color:#6b7280;letter-spacing:1px}.dt{font-size:22px;font-weight:800;margin-top:4px}.cv{font-size:12px;color:#6b7280;margin-top:4px}
.btn{display:inline-block;margin-top:14px;background:#5b5bd6;color:#fff!important;font-size:14px;padding:8px 18px;border-radius:8px}
.sum{margin:14px 20px 0;padding:12px 14px;background:#fff8d6;border-radius:10px;font-size:15px;font-weight:600;line-height:1.6}
.s{padding:22px 20px 0}.s h2{font-size:17px;margin:0 0 4px}.s h2 small{font-size:12px;font-weight:400;color:#6b7280;margin-left:6px}
.sub{font-size:14px;font-weight:700;margin:14px 0 2px}.it{padding:10px 0;border-bottom:1px solid #e6e8ec}
.tt{font-size:14.5px;line-height:1.45}.m{font-size:12px;color:#6b7280;margin-top:3px}.a{font-size:13px;line-height:1.55;margin-top:4px;color:#374151}.a b{color:#5b5bd6;font-weight:600;margin-right:4px}
.b{display:inline-block;font-size:11px;line-height:16px;padding:0 5px;border-radius:4px;margin-right:4px;background:#eef0f3;color:#6b7280}
.p-douyin{background:#111;color:#fff}.p-bilibili{background:#fb7299;color:#fff}.hot{background:#e5484d;color:#fff}.up{color:#e5484d;font-weight:600}
.dir{background:#ececfb;border-radius:10px;padding:12px 14px;margin:8px 0}.dir .t{font-size:15px;font-weight:700}
.ft{padding:24px 20px 22px;font-size:12px;color:#9aa1ad;line-height:1.7}`;

export function renderWeekly(w, { archive = false } = {}) {
  const site = process.env.SITE_URL || '';
  const pb = (src) => `<span class="b p-${src}">${PLATFORM[src] || esc(src)}</span>`;
  const sec = (title, sub, body) => (body ? `<div class="s"><h2>${title}${sub ? `<small>${sub}</small>` : ''}</h2>${body}</div>` : '');
  const items = (arr, fn) => arr.map((x, i) => `<div class="it">${fn(x, i)}</div>`).join('');
  const unit = (x) => (x.src === 'douyin' ? '赞' : '播放');
  const work = (x, i) => `<div class="tt">${i + 1}. ${a(x.url, esc(cut(x.title, 50)))}</div>
    <div class="m">${pb(x.src)}${esc(x.type || '')}　${fmtNum(x.heat)}${unit(x)}　${esc(x.author || '')}${x.fans ? `（粉丝 ${fmtNum(x.fans)}）` : ''}${x.low ? ' <span class="b hot">低粉爆款</span>' : ''}</div>`;
  const rv = w.review || {};
  const parts = [
    sec('🎯 本周建议做的 5 个方向', '', (w.directions || []).map((d, i) => `<div class="dir"><div class="t">${i + 1}. ${esc(d.title)} <span class="b">${esc(d.platform || '')}</span></div>${d.why ? `<div class="a"><b>为什么</b>${esc(d.why)}</div>` : ''}${d.how ? `<div class="a"><b>怎么做</b>${esc(d.how)}</div>` : ''}</div>`).join('')),
    sec('📈 上周一直在涨的题材', '', items(w.themes || [], (t) => `<div class="tt"><b>${esc(t.title)}</b> <span class="b">${esc(t.platform || '')}</span></div><div class="a">${esc(t.why || '')}</div>`)),
    sec('🔥 上周爆款 TOP5', '7 天内发布的 AIGC 作品，抖音按点赞、B站按播放', ['douyin', 'bilibili'].map((s) => (w.top?.[s]?.length ? `<div class="sub">${pb(s)}${PLATFORM[s]}</div>${items(w.top[s], work)}` : '')).join('')),
    sec('🔁 选题复盘', rv.n ? `${rv.days.map(md).join('、')} 的 ${rv.n} 个选题，参考作品之后每天平均涨幅` : '', rv.n ? `
      <div class="a"><b>按时间段</b>${rv.byHorizon.map((h) => `${esc(h.k)} <span class="up">${pct(h.avg)}</span>/天（${h.n} 个）`).join('　')}</div>
      <div class="a"><b>按时效标签</b>${rv.byTiming.map((h) => `${esc(h.k)} <span class="up">${pct(h.avg)}</span>/天（${h.n} 个）`).join('　')}</div>
      <div class="m" style="margin-top:6px">时效标签准的话，「刚起势」应该涨得最多、「已饱和」最少。</div>
      <div class="sub">后劲最足的选题</div>${items(rv.best || [], (r) => `<div class="tt">${pb(r.src)}${esc(r.title)}</div><div class="m">${md(r.date)}推荐 · ${esc(r.horizon)} · ${esc(r.timing)}　${fmtNum(r.from)} → ${fmtNum(r.to)}（<span class="up">${pct(r.perDay)}/天</span>）　${a(r.url, '参考作品 ↗')}</div>`)}` : ''),
    sec('🛠 工具热度', '爆款标题 / 话题里提到各工具的作品数', w.tools?.length ? `<div class="a">${w.tools.slice(0, 8).map((t, i) => `${i + 1}. <b style="color:#191c22">${esc(t.name)}</b> ${t.n}${t.prev != null ? `（上周 ${t.prev}）` : ''}`).join('　')}</div>` : ''),
    sec('🌱 低粉爆款', '粉丝很少也爆了，小号能做', ['douyin', 'bilibili'].map((s) => (w.low?.[s]?.length ? `<div class="sub">${pb(s)}${PLATFORM[s]}</div>${items(w.low[s], work)}` : '')).join('')),
  ].filter(Boolean);
  const range = `${md(w.range[0])} — ${md(w.range[1])}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AIGC 热点周报 · ${range}</title><style>${CSS.replace(/\n/g, '')}</style></head>
<body><div style="padding:16px 8px"><div class="w">
<div class="hd"><div class="k">AIGC 热点雷达 · 周报</div><div class="dt">${range}</div><div class="cv">回顾上周，排这周的内容</div>
${archive ? `<a class="btn" href="../">回到网页</a>` : site ? `<a class="btn" href="${esc(site)}">打开网页版</a>` : ''}</div>
${w.summary ? `<div class="sum">${esc(w.summary)}</div>` : ''}
${parts.join('\n')}
<div class="ft">${w.errors?.length ? '<div style="color:#f0820f">⚠ AI 分析部分出错，相关板块可能是空的</div>' : ''}<div>每周一早上发。选题复盘按每个选题涨得最多的那条参考作品算。</div></div>
</div></div></body></html>`;
}

if (isMain(import.meta.url)) {
  loadEnv();
  const args = process.argv.slice(2);
  (async () => {
    // 发成功才记 sent：没发出去的话，下次运行（或手动重跑）还会再发
    const file = path.join(DATA, 'weekly', `${bjDate()}.json`);
    if (readJSON(file)?.sent && !args.includes('--force') && !args.includes('--dry')) { console.log('今天的周报已经发过了，跳过（要重发加 --force）'); return; }
    const w = await weekly();
    saveUsage();
    const html = renderWeekly(w);
    if (args.includes('--dry')) {
      fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'out', 'weekly.html'), html);
      console.log(`预览已写到 out/weekly.html（${(Buffer.byteLength(html) / 1024).toFixed(0)}KB）`);
      return;
    }
    const range = `${md(w.range[0])}—${md(w.range[1])}`;
    await sendHtml(recipients(), `AIGC 热点周报 ${range}${w.directions?.[0] ? `｜${w.directions[0].title}` : ''}`, html);
    writeJSON(file, { ...w, sent: Date.now() }, true);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
