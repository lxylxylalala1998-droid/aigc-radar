// 发信前自检：日报生成之后、发邮件之前跑一遍
//   能自动修的先修好写回日报（比如邮件里显示不了的封面），修不了的发报警邮件给管理员（早报照常发）
//   结果记在 data/check.json
//   node src/check.js          检查 + 自动修 + 有问题就报警
//   node src/check.js --dry    只检查，不写回、不发报警
import path from 'node:path';
import { DATA, DAY, bjDate, readJSON, writeJSON, loadEnv, isMain } from './util.js';
import { loadWindow } from './rank.js';
import { AI_TOOLS } from './config.js';
import { render, MAIL_LIMIT, alertRecipients, sendHtml } from './mail.js';
import { page } from './alert.js';

const BAD_FMT = /\.(webp|heic)(\?|$)/i; // 邮件客户端显示不了
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 封面能不能打开：403 / 404 这种明确打不开的才算坏；网络超时等拿不准的不动它（GitHub 在国外，访问国内图片偶尔慢）
async function coverBroken(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10e3) });
    const type = r.headers.get('content-type') || '';
    r.body?.cancel?.();
    return [403, 404, 410].includes(r.status) || (r.ok && !type.startsWith('image/'));
  } catch { return false; }
}

export async function check(now = Date.now(), { dry = false } = {}) {
  const date = bjDate(now);
  const file = path.join(DATA, 'digests', `${date}.json`);
  const d = readJSON(file);
  const fixed = []; // 已经自动修好的
  const issues = []; // 修不了、要人看一眼的
  const notes = []; // 正常情况的说明
  if (!d) {
    issues.push('今天的日报没有生成（AI 日报那一步没跑成），早报只能发昨天的内容');
    return finish({ date, now, fixed, issues, notes, dry });
  }

  // 1. 选题数量
  for (const s of ['douyin', 'bilibili']) {
    const n = d.picks?.[s]?.length || 0;
    const name = s === 'douyin' ? '抖音' : 'B站';
    if (n < 8) issues.push(`${name}选题只有 ${n} 个（正常是 10 个），可能是 AI 出的选题大多和前几天重复或对不上参考作品`);
    const rep = (d.picks?.[s] || []).filter((p) => p.repeat).length;
    if (rep) notes.push(`${name}有 ${rep} 个选题是前几天推过、还在涨的（新题材不够，标了「连续推荐」）`);
  }

  // 2. 和前 3 天重复（主要依据是同一条作品），正常情况下已经在出选题时去掉了
  const seen = new Set();
  for (let k = 1; k <= 3; k++) {
    const old = readJSON(path.join(DATA, 'digests', `${bjDate(now - k * DAY)}.json`));
    for (const s of ['douyin', 'bilibili']) for (const p of old?.picks?.[s] || []) [p.main?.url, ...(p.refs || []).filter((r) => r.kind === 'video').map((r) => r.url)].filter(Boolean).forEach((u) => seen.add(u));
  }
  const dup = ['douyin', 'bilibili'].flatMap((s) => (d.picks?.[s] || []).filter((p) => !p.repeat && p.main?.url && seen.has(p.main.url)));
  if (dup.length) issues.push(`有 ${dup.length} 个选题和前 3 天推过的是同一条作品，却没被去重：${dup.map((p) => p.title).join('、')}`);

  // 3. 选题封面：邮件里显示不了的格式先换成数据里的 jpeg 版本，换不了就去掉（邮件改成「看视频」链接）；打不开的同样处理
  const pool = new Map(loadWindow(3, now).filter((x) => x.cat === 'video' && x.cover && !BAD_FMT.test(x.cover)).map((x) => [x.url, x.cover]));
  let swapped = 0;
  let dropped = 0;
  for (const s of ['douyin', 'bilibili']) {
    for (const p of d.picks?.[s] || []) {
      const m = p.main;
      if (!m?.cover) continue;
      const bad = BAD_FMT.test(m.cover) || (await coverBroken(m.cover));
      if (!bad) continue;
      const alt = pool.get(m.url);
      if (alt && alt !== m.cover && !(await coverBroken(alt))) { m.cover = alt; swapped++; } else { delete m.cover; dropped++; }
    }
  }
  if (swapped) fixed.push(`${swapped} 个选题封面换成了邮件能显示的 jpeg 版本`);
  if (dropped) fixed.push(`${dropped} 个选题封面显示不了也没有替代，邮件里改成「▶ 看视频」链接`);
  const noCover = ['douyin', 'bilibili'].flatMap((s) => d.picks?.[s] || []).filter((p) => p.main?.url && !p.main.cover).length;
  if (noCover) notes.push(`${noCover} 个选题没有封面（邮件里显示「看视频」链接）`);

  // 4. 做法里点名了具体平台 / 模型（要求是只写步骤）
  const named = [];
  for (const s of ['douyin', 'bilibili']) {
    for (const p of d.picks?.[s] || []) {
      const text = `${p.flow || ''} ${p.how || ''}`;
      const hit = AI_TOOLS.filter(([, re]) => re.test(text)).map(([n]) => n);
      if (hit.length) named.push(`「${p.title}」提到 ${hit.join('、')}`);
    }
  }
  if (named.length) issues.push(`有 ${named.length} 个选题的做法里点名了具体平台 / 模型：${named.slice(0, 3).join('；')}${named.length > 3 ? ' 等' : ''}`);

  // 5. 各板块有没有内容
  if (!d.brief?.top?.length || !d.brief?.wind) issues.push('3 分钟速览没生成出来');
  const v = d.videos || {};
  if ((v.douyinTop?.length || 0) < 5) issues.push(`抖音高赞榜只有 ${v.douyinTop?.length || 0} 条`);
  if ((v.bilibiliTop?.length || 0) < 5) issues.push(`B站高播放榜只有 ${v.bilibiliTop?.length || 0} 条`);
  for (const [s, name] of [['douyin', '抖音'], ['bilibili', 'B站'], ['weibo', '微博']]) if ((d.trends?.[s]?.length || 0) < 5) issues.push(`${name}热搜只有 ${d.trends?.[s]?.length || 0} 条`);
  if (Object.keys(d.music || {}).length < 3) issues.push(`热歌只拿到 ${Object.keys(d.music || {}).length} 个平台（正常是 4 个）`);
  if ((d.news?.length || 0) < 3) issues.push(`AI 大事件只有 ${d.news?.length || 0} 件`);
  if (d.errors?.length) issues.push(`AI 分析有 ${d.errors.length} 处出错：${d.errors.slice(0, 2).join('；')}`);

  // 6. 数据源：这次采集失败的
  const st = readJSON(path.join(DATA, 'status.json'), { sources: {} });
  // 抖音 / B站 / 微博是核心数据，失败了要报警；资讯、模型榜这类偶尔失败很常见，只记一笔
  const bad = Object.values(st.sources || {}).filter((x) => !x.ok).map((x) => x.name);
  const core = bad.filter((n) => /抖音|B站|微博/.test(n));
  if (core.length) issues.push(`这次采集失败的核心数据源：${core.join('、')}（下次运行会自动重试）`);
  if (bad.length > core.length) notes.push(`这次没采到：${bad.filter((n) => !core.includes(n)).join('、')}`);

  // 7. 邮件大小：超过 95KB 会自动改发精简版；精简版还超就要人看
  const full = Buffer.byteLength(render(d));
  if (full > MAIL_LIMIT) {
    const small = Buffer.byteLength(render(d, { compact: true }));
    if (small > MAIL_LIMIT) issues.push(`邮件 ${Math.round(small / 1024)}KB，精简版也超过了 95KB，Gmail 可能只显示前面一部分`);
    else fixed.push(`邮件完整版 ${Math.round(full / 1024)}KB，超过 95KB，自动改发精简版（${Math.round(small / 1024)}KB）`);
  } else notes.push(`邮件 ${Math.round(full / 1024)}KB`);

  // 8. 余额
  const th = readJSON(path.join(DATA, 'tikhub.json'), null);
  if (typeof th?.balance === 'number' && th.balance < 1) issues.push(`TikHub 余额只剩 ${th.balance} 美元，记得充值`);
  const ds = readJSON(path.join(DATA, 'deepseek.json'), null);
  if (typeof ds?.balance === 'number' && ds.balance < 3) issues.push(`DeepSeek 余额只剩 ${ds.balance} 元，记得充值`);

  if (!dry && (swapped || dropped)) writeJSON(file, d, true);
  return finish({ date, now, fixed, issues, notes, dry });
}

async function finish({ date, now, fixed, issues, notes, dry }) {
  const r = { date, at: now, ok: !issues.length, fixed, issues, notes };
  console.log(`发信前自检：${issues.length ? `${issues.length} 个问题` : '没问题'}${fixed.length ? `，自动修了 ${fixed.length} 处` : ''}`);
  for (const x of fixed) console.log(`  ✓ 已修：${x}`);
  for (const x of issues) console.log(`  ✗ ${x}`);
  for (const x of notes) console.log(`  · ${x}`);
  if (dry) return r;
  writeJSON(path.join(DATA, 'check.json'), r, true);
  if (issues.length) {
    const lines = [
      `${date} 的早报自检发现 <b style="color:#e5484d">${issues.length} 个问题</b>，早报照常会发，下面这些需要留意：`,
      ...issues.map((x) => `✗ ${esc(x)}`),
      ...(fixed.length ? ['已经自动修好的：', ...fixed.map((x) => `✓ ${esc(x)}`)] : []),
      '偶尔一次不用管；连续几天出现同样的问题，把这封邮件转给 Claude 看看。',
    ];
    await sendHtml(alertRecipients(), `⚠ AIGC 热点雷达：今天的早报自检发现 ${issues.length} 个问题`, page('早报自检发现问题', lines));
  }
  return r;
}

if (isMain(import.meta.url)) {
  loadEnv();
  // 自检本身出错也不能挡住发早报：打印出来就退出，不报失败
  check(Date.now(), { dry: process.argv.includes('--dry') }).catch((e) => console.error(`自检出错（不影响发信）：${e.message}`));
}
