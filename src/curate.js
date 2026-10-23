// AI 点评，分两步：
//   annotate —— 每次采集后跑，只处理新出现的内容：
//       视频：是不是 AIGC、什么类型，AIGC 作品写「爆点分析」+「怎么参考」
//       热搜：每条写「为什么上热搜」，对 AIGC 自媒体有用的再打「热梗 / AI相关 / 可借势」标签 + AI 做法
//       热歌：每首写「为什么火」+「适合怎么 AI 二创」
//   digest   —— 每天早上跑：抖音 / B站各挑爆款，按 24h / 3天 / 7天 / 30天 四个时间段出选题，资讯归并成 AI 圈大事件
import fs from 'node:fs';
import path from 'node:path';
import { DATA, HOUR, DAY, bjDate, readJSON, writeJSON, loadEnv, isMain, isAI, fmtNum } from './util.js';
import { DEEPSEEK_BASE, DEEPSEEK_MODEL, ANALYZE_TOP_VIDEOS, ANALYZE_TOP_SONGS } from './config.js';
import { biliFans } from './sources/bilibili.js';
import { lowFan, ratioMedians, portrait, withFans, toolsOf, toolRank, bgmRank } from './insight.js';
import { loadWindow, velocity, slim, PLATFORM } from './rank.js';

// 标注版本号。分析内容的格式变了就加 1，旧数据会被重新标注一次
const V = 2;
// 重点类型（用户点名要盯的高赞内容）在前，后面是次要类型
export const FOCUS_TYPES = ['AI音乐', 'AI MV', 'AI歌手/艺人', 'AI鬼畜', 'AI影视', 'AI换人'];
export const AIGC_TYPES = [...FOCUS_TYPES, 'AI动画', 'AI特效玩法', 'AI整活'];
// 视频分类改过一次（AI剧情 / AI短片 并进 AI影视），旧数据先按新名字读，再由 annotate 重新标
const OLD_TYPE = { AI剧情: 'AI影视', AI短片: 'AI影视' };
export const typeOf = (x) => OLD_TYPE[x.ai?.type] || x.ai?.type;
// 抖音视频只认官方 AI 标（作者声明 / 平台识别 / AI 特效），没标的不算 AIGC
const dyOk = (x) => x.src !== 'douyin' || !!x.m?.aiLabel;
export const isWork = (x) => x.cat === 'video' && AIGC_TYPES.includes(typeOf(x)) && dyOk(x);
const VV = 3; // 视频标注版本

const SYSTEM = `你是一位资深的 AIGC 自媒体选题编辑，服务对象是在抖音、B站做 AI 内容的博主。
你的任务是帮他们看懂每个热点「为什么能火」，并判断能做什么内容。
要求：判断准确、语言精炼口语化、不说空话套话；只根据给出的信息和你确定知道的事实分析，拿不准的写「推测：」开头，绝不编造具体事件、人名、数据。
写做法时只描述步骤和方法（比如「文生图出角色 → 图生视频做动作 → 剪辑卡点」），不要写具体用哪家 AI 平台或哪个模型——从作品看不出来，写了容易错。
只输出 JSON，不要任何其它文字。`;

const hasKey = () => !!process.env.DEEPSEEK_API_KEY;

// 截断标题时可能把 emoji 切成半个（孤立的代理项），DeepSeek 会直接拒收整个请求，发送前清掉
const fixText = (s) => s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

// DeepSeek 用量：每次运行累计，结束时记到 data/deepseek-usage.json（按天，保留 40 天），方便算钱
const usage = { calls: 0, in: 0, hit: 0, out: 0 };
export function saveUsage(now = Date.now()) {
  if (!usage.calls) return;
  const file = path.join(DATA, 'deepseek-usage.json');
  const all = readJSON(file, {});
  const d = (all[bjDate(now)] ||= { calls: 0, in: 0, hit: 0, out: 0 });
  for (const k of Object.keys(usage)) d[k] += usage[k];
  for (const k of Object.keys(all)) if (k < bjDate(now - 40 * DAY)) delete all[k];
  writeJSON(file, all);
  console.log(`DeepSeek 用量：${usage.calls} 次调用，输入 ${usage.in} tokens（缓存命中 ${usage.hit}），输出 ${usage.out} tokens`);
}

export async function ask(prompt, { maxTokens = 6000 } = {}) {
  prompt = fixText(prompt);
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.3,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(240e3),
      });
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { throw new Error(`DeepSeek ${res.status}: ${text.slice(0, 160)}`); }
      if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${j?.error?.message || text.slice(0, 200)}`);
      const u = j.usage || {};
      usage.calls++; usage.in += u.prompt_tokens || 0; usage.hit += u.prompt_cache_hit_tokens || 0; usage.out += u.completion_tokens || 0;
      return JSON.parse(j.choices[0].message.content);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export async function step(name, fn, fallback, errors) {
  if (!hasKey()) return fallback();
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`  ✓ ${name} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return r;
  } catch (e) {
    console.log(`  ✗ ${name}：${e.message}`);
    errors.push(`${name}: ${e.message}`);
    return fallback();
  }
}

// 并发跑一组任务，最多 n 个同时
async function pool(tasks, n = 4) {
  const out = [];
  let k = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (k < tasks.length) { const i = k++; out[i] = await tasks[i](); }
  }));
  return out;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const hoursAgo = (ts, now) => (ts ? Math.max(0, Math.round((now - ts) / HOUR)) : '?');
const dayPath = (now) => path.join(DATA, 'days', `${bjDate(now)}.json`);
// AI 写说明时爱先复述一遍词条，裁掉
const dropEcho = (s = '', title = '') => (title && s.startsWith(title) ? s.slice(title.length).replace(/^[，,：:；;。\s]+/, '') : s);

export const fmtDur = (s) => (!s ? '' : s >= 60 ? `${Math.floor(s / 60)}分${s % 60 ? `${s % 60}秒` : '钟'}` : `${s}秒`);
export function stats(x) {
  const m = x.m || {};
  const more = `${m.dur ? ` 时长${fmtDur(m.dur)}` : ''}${m.fans ? ` 作者粉丝${fmtNum(m.fans)}` : ''}`;
  if (x.src === 'douyin') return `${m.play ? `${m.playWin ? `近${m.playWin}天` : ''}播放${fmtNum(m.play)} ` : ''}点赞${fmtNum(m.like)}${m.like24 ? `（近24小时+${fmtNum(m.like24)}）` : ''} 评论${fmtNum(m.comment)} 分享${fmtNum(m.share)}${m.fav ? ` 收藏${fmtNum(m.fav)}` : ''}${more}${m.bgm ? ` BGM:${m.bgm}` : ''}${m.aiLabel ? ` 【抖音官方AI标：${m.aiLabel}】` : ''}${m.hint ? ` 【来自 #${x.board.replace('话题·#', '')} 话题】` : ''}`;
  if (x.src === 'bilibili') return `播放${fmtNum(m.play)} 点赞${fmtNum(m.like)} 弹幕${fmtNum(m.danmaku)}${m.fav ? ` 收藏${fmtNum(m.fav)}` : ''}${more}`;
  return `播放${fmtNum(x.heat)}`;
}

// ====================== annotate ======================
// note：要写爆点 / 参考的视频（会被看到的），其余只分类
async function annotateVideos(list, now, note) {
  const lines = list.map((x, i) => [
    `${note.has(x.id) ? '★' : ''}${i}`, PLATFORM[x.src], x.m?.part || '', x.title, x.tags ? `话题:${x.tags}` : '', x.desc && x.desc !== x.title ? `简介:${x.desc.slice(0, 60)}` : '',
    stats(x), (x.m?.noDate ? '发布时间未知' : `发布${hoursAgo(x.pubAt, now)}h`),
  ].filter(Boolean).join('|'));
  const r = await ask(`下面是抖音 / B站上近期可能跟 AI 有关的视频（编号|平台|分区|标题|话题|简介|数据|发布时长）。
关键词搜索会混进很多不是 AI 生成的视频，请严格判断：
1. 「内容本身主要由 AI 生成 / AI 参与创作」的 AIGC 作品，给出 type（选最贴切的一个）：
   AI音乐（AI 作曲 / AI 翻唱 / AI 说唱）、
   AI MV（给歌配 AI 生成画面的 MV）、
   AI歌手/艺人（虚拟歌手、AI 艺人 / 数字人账号发的作品）、
   AI鬼畜（AI 做的鬼畜、魔性循环、名人唱跳恶搞）、
   AI影视（AI 短剧、漫剧、电影、预告片、剧情短片）、
   AI换人（把视频里的人换成另一个人，比如让黄仁勋替代迈克尔·杰克逊在演唱会上唱歌；AI 换脸）、
   AI动画（非剧情向的 AI 动画）、AI特效玩法（抖音 AI 特效模板、AI 滑镜、AI 变身、AI 换装这类一键玩法）、AI整活（其它恶搞、梗视频）
   视频来自某个 AI 话题（比如 #ai短剧）只说明它带了这个标签，还是要看内容判断
   带【抖音官方AI标】的视频平台已确认是 AI 生成，不要判成「非AIGC」，只判断属于哪一类
2. 讲 AI 的教程、评测、新闻解读：type 为「AI教程测评」，不用写分析
3. 跟 AI 生成无关的不要输出
4. 编号前带 ★ 的 AIGC 作品再写两句（不带 ★ 的只给 type，不写 hook / tip）：
   - hook：爆点分析——这条为什么能火（题材、情绪、反差、梗、技术新鲜感、蹭了什么热点、人设、节奏等），要具体到这条视频，≤45 字
   - tip：怎么参考——同类内容怎么做、关键步骤和要点是什么（不点名具体平台 / 模型），≤40 字

输出格式：{"items":[{"i":编号,"type":"AI音乐","hook":"","tip":""}]}

视频：
${lines.join('\n')}`, { maxTokens: 7000 });
  return r.items || [];
}

async function annotateTrends(list) {
  const lines = list.map((x, i) => {
    const extra = [
      x.kind && `【${x.kind}】${x.m?.fetched ? `参与视频里 ${x.m.aiVideos || 0}/${x.m.fetched} 条是 AI 做的` : ''}`,
      x.label && `标签:${x.label}`, x.desc && `分类:${x.desc}`, x.ctx?.length && `话题下热门视频文案:${x.ctx.join(' / ').slice(0, 150)}`,
    ].filter(Boolean).join('；');
    return `${i}|${PLATFORM[x.src]}|${x.rank || '上升'}|${x.title}${extra ? `|${extra}` : ''}`;
  });
  const r = await ask(`下面是微博、抖音、B站热搜上新出现的词条（编号|平台|排名|词条|补充信息）。补充信息里有抖音话题下热门视频的文案、微博分类，是判断的主要依据。
对【每一个】词条都输出：
- why：它为什么会上热搜——是什么事 / 什么梗，大家为什么关注或爱玩，≤35 字，不要重复词条原文。信息不够就写「推测：…」
另外，对 AIGC 自媒体有用的词条再加：
- tag：热梗（流行梗、名场面、魔性台词 / BGM、新造词、全网模仿的段子）/ AI相关（词条本身在说 AI 或机器人；普通数码产品不算）/ 可借势（热度高的影视剧、综艺、游戏、体育、节日，适合用 AI 做同人、恶搞、MV）
- idea：可以怎么用 AI 来做，≤30 字
纯政治、外交、灾难、刑事、负面社会新闻不加 tag（但仍要写 why）。
标了【抖音挑战】【话题互动】的是抖音官方归类的站内玩法 / 挑战：why 要说清楚这个挑战怎么玩、为什么大家爱跟；idea 必须写，说怎么用 AI 跟拍 / 参与（拍什么、AI 做哪一步，不点名具体平台），≤35 字。

输出格式：{"items":[{"i":编号,"why":"","tag":"","idea":""}]}

词条：
${lines.join('\n')}`, { maxTokens: 6000 });
  return r.items || [];
}

async function annotateSongs(groups) {
  const lines = groups.map((g, i) => `${i}|${g.title}|${g.author}|${g.where}${g.ctx ? `|${g.ctx}` : ''}`);
  const r = await ask(`下面是各音乐平台热歌榜 / 飙升榜上的歌（编号|歌名|歌手|上榜情况|补充信息）。补充信息可能有：B站代表稿件和推荐理由、在抖音热点视频里被当 BGM 的次数和示例文案。
对【每一首】输出：
- why：它为什么火 / 为什么在涨——比如被某类短视频当 BGM、影视剧 / 游戏 / 综艺带火、歌手新歌、老歌翻红、舞蹈或梗带火、季节应景等，≤35 字。拿不准就写「推测：…」，不要编造具体事件
- use：适合拿来做什么 AI 二创（AI 翻唱 / AI MV / 卡点 / 变装 / 情绪向剪辑等），≤20 字；不适合就留空

输出格式：{"items":[{"i":编号,"why":"","use":""}]}

歌：
${lines.join('\n')}`, { maxTokens: 6000 });
  return r.items || [];
}

async function discoverTrends(works, memes) {
  const lines = [
    ...works.slice(0, 120).map((x) => `作品|${PLATFORM[x.src]}|${typeOf(x)}|${x.title}${x.tags ? `|话题:${x.tags}` : ''}`),
    ...memes.slice(0, 40).map((x) => `热搜|${PLATFORM[x.src]}|${x.ai.tag}|${x.title}`),
  ];
  const r = await ask(`下面是刚抓到的 AIGC 作品（含话题标签）和带标签的热搜。请找出其中正在流行的【具体】AIGC 玩法 / 题材名称，用来去抖音、B站搜索更多同类爆款。
要有辨识度、别人会拿来当话题的名字（比如某个 AI 特效模板名、某种固定的 AI 内容格式）。
不要泛泛的词（AI音乐、AI视频、AIGC、AI动画这种不要），不要单个作品名或人名，最多 6 个，没有就返回空数组。
- kw：玩法名，≤10 字，就是会被拿去搜索的词
- why：这是什么玩法，≤20 字

输出格式：{"keywords":[{"kw":"","why":""}]}

${lines.join('\n')}`, { maxTokens: 800 });
  return r.keywords || [];
}

const TYPE_RE = [
  ['AI MV', /MV/i], ['AI音乐', /音乐|翻唱|歌|song|music|cover|Suno|Udio/i], ['AI动画', /动画|animation|anime/i],
  ['AI换人', /换脸|换人|替换/], ['AI鬼畜', /鬼畜/], ['AI歌手/艺人', /虚拟歌手|AI歌手|AI艺人|数字人/i],
  ['AI影视', /短剧|漫剧|剧情|剧场|电影|影视|短片|film|trailer|预告/i], ['AI特效玩法', /滑镜|特效|变身|抖音ai创作/i],
];
const guessType = (x) => (TYPE_RE.find(([, re]) => re.test(`${x.title} ${x.tags || ''}`)) || ['未分类'])[0];
const songKey = (x) => `${x.title.replace(/[（(][^）)]*[）)]/g, '').trim().toLowerCase()}|${(x.author || '').split(/[,/、&]/)[0].trim().toLowerCase()}`;

export async function annotate(now = Date.now()) {
  const file = dayPath(now);
  const day = readJSON(file);
  if (!day) { console.log('今天还没有数据，跳过标注'); return []; }
  const errors = [];
  const items = Object.values(day.items);
  const fresh = (x) => x.ai?.v !== V;

  // 只给「会被看到」的视频写爆点 / 参考（每个平台 24 小时飙升前 N + 30 天热度前 N），其余只分类，省 DeepSeek 的钱
  // 之后哪条冲进了前 N 还没分析，下一轮补上
  const pool30 = loadWindow(30, now).filter((x) => x.cat === 'video' && dyOk(x) && x.pubAt > now - 31 * DAY);
  const shown = new Set();
  for (const s of ['douyin', 'bilibili']) {
    const mine = pool30.filter((x) => x.src === s && !['非AIGC', 'AI教程测评'].includes(x.ai?.type));
    mine.filter((x) => x.lastSeen >= now - DAY).map((x) => [x, velocity(x, now).perHour]).sort((a, b) => b[1] - a[1])
      .slice(0, ANALYZE_TOP_VIDEOS).forEach(([x]) => shown.add(x.id));
    [...mine].sort((a, b) => (b.heat || 0) - (a.heat || 0)).slice(0, ANALYZE_TOP_VIDEOS).forEach((x) => shown.add(x.id));
  }
  const needNote = (x) => shown.has(x.id) && !x.ai?.hook && !x.ai?.noted && !['非AIGC', 'AI教程测评'].includes(x.ai?.type);
  const videos = items
    .filter((x) => x.cat === 'video' && x.pubAt > now - 31 * DAY && dyOk(x) && (x.ai?.vv !== VV || needNote(x)))
    .map((x) => ({ x, vel: velocity(x, now).perHour }))
    .sort((a, b) => b.vel - a.vel)
    .slice(0, 400)
    .map((v) => v.x);
  const note = new Set(videos.filter(needNote).map((x) => x.id));
  const trends = items
    // 挑战类如果之前标注时没给 AI 做法（加这个功能之前标的），补一次
    .filter((x) => x.cat === 'trend' && (fresh(x) || (x.kind && !x.ai?.idea && !x.ai?.kv)) && x.lastSeen >= now - 2 * HOUR)
    .sort((a, b) => (a.rank || 99) - (b.rank || 99));
  // 同一首歌可能同时在好几个榜上，合并成一组只问一次
  const bgm = items.filter((x) => x.cat === 'bgm');
  const groups = new Map();
  // 网页每个榜只展示前 ANALYZE_TOP_SONGS 首，后面的不分析
  for (const x of items.filter((s) => s.cat === 'music' && fresh(s) && s.lastSeen >= now - 2 * HOUR && (s.rank || 99) <= ANALYZE_TOP_SONGS)) {
    const k = songKey(x);
    const g = groups.get(k) || { title: x.title, author: x.author, ids: [], where: [], ctx: '' };
    g.ids.push(x.id);
    g.where.push(`${x.board}#${x.rank}${x.label ? `(${x.label})` : ''}`);
    if (x.desc && !g.ctx.includes(x.desc)) g.ctx += x.desc;
    groups.set(k, g);
  }
  for (const [k, g] of groups) {
    const b = bgm.find((x) => songKey(x) === k);
    if (b) g.ctx += `${g.ctx ? '；' : ''}在 ${b.m.videos} 个抖音热点视频里当 BGM，例：${b.desc}`;
    g.where = g.where.join('、');
  }
  const songs = [...groups.values()];
  console.log(`标注：视频 ${videos.length}（其中写分析 ${note.size}），新热搜 ${trends.length}，新歌 ${songs.length} 首；${hasKey() ? DEEPSEEK_MODEL : '未配置 Key，用规则兜底'}`);

  const vb = chunk(videos, 80);
  const tb = chunk(trends, 50);
  const sb = chunk(songs, 60);
  const tasks = [
    ...vb.map((b, k) => () => step(`视频 ${k + 1}/${vb.length}`, async () => ({ ok: true, items: await annotateVideos(b, now, note) }),
      () => ({ ok: false, items: b.map((x, i) => (isAI(`${x.title} ${x.tags || ''}`) || x.m?.aiCorner ? { i, type: guessType(x) } : null)).filter(Boolean) }), errors)),
    ...tb.map((b, k) => () => step(`热搜 ${k + 1}/${tb.length}`, async () => ({ ok: true, items: await annotateTrends(b) }),
      () => ({ ok: false, items: b.map((x, i) => (isAI(x.title) ? { i, tag: 'AI相关' } : null)).filter(Boolean) }), errors)),
    ...sb.map((b, k) => () => step(`热歌 ${k + 1}/${sb.length}`, async () => ({ ok: true, items: await annotateSongs(b) }), () => ({ ok: false, items: [] }), errors)),
  ];
  const res = await pool(tasks, 4);
  const vres = res.slice(0, vb.length);
  const tres = res.slice(vb.length, vb.length + tb.length);
  const sres = res.slice(vb.length + tb.length);

  // 写回。AI 处理过的打上版本号，下次不再重复送；规则兜底的不打，等 AI 恢复后再处理
  const put = (id, ai, ok) => { day.items[id].ai = { ...day.items[id].ai, ...ai, ...(ok ? { v: V, checked: 1 } : {}) }; };
  vb.forEach((b, k) => {
    // 编号前可能带着 ★ 回来，只取数字
    const by = new Map(vres[k].items.map((x) => [+String(x.i).replace(/\D/g, ''), x]));
    b.forEach((x, i) => {
      const a = by.get(i);
      // 带官方 AI 标的抖音视频一定是 AIGC，AI 没归类就记「未分类」
      const type = a?.type || (x.src === 'douyin' ? '未分类' : '非AIGC');
      // 已经写过分析的不要被这次「只分类」的结果覆盖掉；要写分析的标 noted，AI 没写也不再反复送
      const old = day.items[x.id].ai || {};
      if (a || vres[k].ok) put(x.id, { type: x.src === 'douyin' && type === '非AIGC' ? '未分类' : type, hook: a?.hook || old.hook || undefined, tip: a?.tip || old.tip || undefined, vv: vres[k].ok ? VV : undefined, noted: note.has(x.id) && vres[k].ok ? 1 : old.noted }, vres[k].ok);
    });
  });
  tb.forEach((b, k) => {
    const by = new Map(tres[k].items.map((x) => [+x.i, x]));
    b.forEach((x, i) => {
      const a = by.get(i);
      if (a || tres[k].ok) put(x.id, { why: dropEcho(a?.why, x.title) || undefined, tag: a?.tag || undefined, idea: dropEcho(a?.idea, x.title) || undefined, kv: x.kind && tres[k].ok ? 1 : undefined }, tres[k].ok);
    });
  });
  sb.forEach((b, k) => {
    const by = new Map(sres[k].items.map((x) => [+x.i, x]));
    b.forEach((g, i) => {
      const a = by.get(i);
      if (a || sres[k].ok) g.ids.forEach((id) => put(id, { why: a?.why || undefined, use: a?.use || undefined }, sres[k].ok));
    });
  });
  writeJSON(file, day);

  // 发现新兴玩法：从这次新标注的 AIGC 作品和带标签的热搜里提炼，下一轮加进搜索词
  const newWorks = videos.map((x) => day.items[x.id]).filter(isWork);
  const newMemes = trends.map((x) => day.items[x.id]).filter((x) => x.ai?.tag);
  if (hasKey() && (newWorks.length || newMemes.length)) {
    await step('发现新玩法', async () => {
      const found = await discoverTrends(newWorks, newMemes);
      const tf = path.join(DATA, 'trend-keywords.json');
      const t = readJSON(tf, {});
      for (const f of found) {
        const kw = String(f.kw || '').trim();
        if (!kw || kw.length > 12) continue;
        t[kw] = { first: t[kw]?.first || now, last: now, n: (t[kw]?.n || 0) + 1, why: f.why || t[kw]?.why };
      }
      // 7 天没再出现的玩法就淘汰，最多留 30 个
      const kept = Object.entries(t).filter(([, v]) => v.last > now - 7 * DAY).sort((a, b) => b[1].last - a[1].last).slice(0, 30);
      writeJSON(tf, Object.fromEntries(kept), true);
      console.log(`    新玩法：${found.map((f) => f.kw).join('、') || '无'}`);
    }, () => {}, errors);
  }

  const n = Object.values(day.items);
  console.log(`  当天 AIGC 作品 ${n.filter(isWork).length}（抖音 ${n.filter((x) => isWork(x) && x.src === 'douyin').length}），有分析的热搜 ${n.filter((x) => x.cat === 'trend' && x.ai?.why).length}，有分析的歌 ${n.filter((x) => x.cat === 'music' && x.ai?.why).length}`);
  return errors;
}

// ====================== digest ======================
async function mergeNews(news, hf, now) {
  const lines = news.map((x, i) => `${i}|${x.src}|${hoursAgo(x.pubAt || x.firstSeen, now)}h前|${x.title}${x.heat ? `|HN热度${x.heat}` : ''}`);
  const hfLines = hf.map((x, i) => `H${i}|${x.title}|${x.desc || ''}|❤${x.heat || 0}`);
  const r = await ask(`下面是过去 24 小时的 AI 相关资讯（编号|来源|发布时间|标题），以及 Hugging Face 当前热门模型（H编号）。
请：
1. 把报道同一件事的条目合并成一个「事件」；
2. 去掉跟 AI 无关的、纯营销软文、没信息量的；
3. 挑出对 AIGC 自媒体最有用的最多 15 个事件，按重要性从高到低排；
4. HF 热门模型里如果有值得一提的新模型（新发布或大版本），也作为事件放进去。

每个事件输出：
- title：中文标题，≤28 字，直接说清楚谁做了什么（英文标题要翻译）
- summary：一句话说清楚这件事和它对做内容的人意味着什么，≤60 字
- kind：新模型 / 模型升级 / 产品功能 / 行业大事件 / 融资并购 / 政策监管 / 研究论文 之一
- level：重磅 / 值得关注 / 一般
- ids：涉及的编号数组（如 [3,17] 或 ["H2"]）

输出格式：{"events":[{"title":"","summary":"","kind":"","level":"","ids":[]}]}

资讯：
${lines.join('\n')}

HF 热门模型：
${hfLines.join('\n') || '（无）'}`);
  return r.events || [];
}

async function pickHits(list, now) {
  const lines = list.map((x, i) => `${i}|${PLATFORM[x.src]}|${typeOf(x)}|${x.title}|${stats(x)}|${x.m?.noDate ? '发布时间未知' : `发布${hoursAgo(x.pubAt, now)}h`}|每小时+${fmtNum(x.vel)}${x.src === 'douyin' ? '赞' : '播放'}${x.tags ? `|话题:${x.tags}` : ''}`);
  const r = await ask(`下面是过去 24 小时增长最快的 AIGC 作品（编号|平台|类型|标题|数据|发布时长|增速|话题）。
从【抖音】和【B站】里各挑 6 个最值得 AI 自媒体参考的爆款（某个平台候选不足 6 个就全选）（优先增长快、有代表性、可复制；同一系列 / 同一个特效模板只选一个代表）。
对每个写：
- hook：爆点分析——这条具体为什么能火，结合数据说（比如几小时涨了多少），≤50 字
- tip：怎么参考——同类内容怎么做、关键步骤、镜头 / 节奏 / 文案怎么设计（不点名具体平台 / 模型），≤45 字

输出格式：{"top":[{"i":编号,"hook":"","tip":""}]}

${lines.join('\n')}`, { maxTokens: 3000 });
  return r.top || [];
}

async function pickTop(list, now) {
  const lines = list.map((x, i) => `${i}|${PLATFORM[x.src]}|${typeOf(x)}|${x.title}|${stats(x)}|${x.m?.noDate ? '发布时间未知' : `发布${Math.max(1, Math.round(hoursAgo(x.pubAt, now) / 24))}天`}${x.tags ? `|话题:${x.tags}` : ''}`);
  const r = await ask(`下面是近 30 天点赞（抖音）/ 播放（B站）最高的 AIGC 作品（编号|平台|类型|标题|数据|发布天数|话题）。
为【每一条】都写：
  - hook：它为什么能火到这个量级——题材、情绪、反差、人设、技术新鲜感、借了什么势，结合数据说，≤50 字
  - tip：想做同类内容怎么做——选题、关键步骤、镜头 / 节奏 / 文案（不点名具体平台 / 模型），≤45 字

输出格式：{"top":[{"i":编号,"hook":"","tip":""}]}

${lines.join('\n')}`, { maxTokens: 3500 });
  return r.top || [];
}

// 选题和参考稿件对不对得上：选题标题和稿件（标题 / 话题 / 简介 / 作者 / 分析）至少共有一个实义词
// 中文按两字切，英文按单词；「AI」「视频」「挑战」这类泛词不算
const STOP = new Set(['ai', 'aigc', 'mv', '视频', '爆款', '一个', '我们', '大家', '系列', '合集', '原创', '作品', '今天', '什么', '怎么', '这个', '可以', '不是', '如何', '教程', '新版', '抖音', 'b站', '版本', '整活', '挑战', '玩法', '模板', '用ai', '生成', '制作', '一键', '同款']);
function grams(text) {
  const t = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) if (!STOP.has(w)) out.add(w);
  for (const seg of t.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(' ')) {
    for (let i = 0; i + 1 < seg.length; i++) { const g = seg.slice(i, i + 2); if (!STOP.has(g)) out.add(g); }
  }
  return out;
}
export function related(title, x) {
  const a = grams(title);
  const b = grams([x.title, x.tags, x.desc, x.author, x.board, x.ai?.why, x.ai?.hook].join(' '));
  for (const g of a) if (b.has(g)) return true;
  return false;
}

// 选题去重：两个选题参考了同一条稿件，或者参考稿件标题里有同一个专有词（连续 3 个字以上，比如「过来人」），算同一个题材，只留排前面的
// 【AI MV大赛】这类活动标签、#话题 不算，常见口语词也不算
const COMMON = new Set(['你的', '我的', '一下', '一起', '就是', '真的', '没有', '还是', '自己', '时候', '如果', '给你', '你会', '可能', '现在', '以前', '一定', '为什', '不会', '这样', '那个', '出来', '起来', '开始', '第一', '一次', '所有', '的人', '一样', '之后', '知道', '喜欢', '最后', '看看', '居然', '竟然', '原来', '终于', '全站', '中国', '世界', '人生', '时代', '小孩', '孩子', '宝宝', '唱歌', '音乐', '歌曲', '演唱', '新歌', '画风', '短剧', '电影', '动画', '特效', '创作', '网页', '即梦', '可灵', '豆包']);
function themeGrams(p) {
  const text = [p.title, ...p.refs.map((r) => r.title)].join(' ').replace(/【[^】]*】|#[^#\s]+/g, ' ');
  return [...grams(text)].filter((g) => !COMMON.has(g));
}
function samePick(a, b) {
  if (a.refs.some((r) => b.refs.some((x) => x.url === r.url))) return true;
  const gb = new Set(b.g);
  // 专有词：共有两个首尾相接的两字词（如「过来」「来人」）
  return a.g.some((g) => gb.has(g) && a.g.some((h) => h !== g && gb.has(h) && h[0] === g[1]));
}
export function dedupePicks(list) {
  const kept = [];
  for (const p of list) {
    const q = { ...p, g: themeGrams(p) };
    if (!kept.some((k) => samePick(k, q))) kept.push(q);
  }
  return kept.map(({ g, ...p }) => p);
}

// 平台特点：给 AI 定「怎么做」时参考
const PLATFORM_STYLE = {
  douyin: '抖音：竖屏，15~60 秒，前 3 秒定生死；擅长 AI 特效模板、卡点、BGM、挑战玩法、情绪向和反差向内容，文案 + 话题标签很关键',
  bilibili: 'B站：横屏为主，1~5 分钟，适合有完整度的作品；擅长 AI MV、AI 剧情 / 短剧系列化、鬼畜、AI 翻唱，重视弹幕互动、标题封面和参加官方活动（如 AI MV 大赛、AI 全民制作人）',
};

async function makePicks(blocks, s) {
  const name = PLATFORM[s];
  const r = await ask(`下面是${name}上 AIGC 相关的热点数据，按时间段分组（方括号里是编号）。
请给出「今天最值得在${name}上做的 14 个选题」，按值得做的程度从高到低排：
- 每个选题必须直接来自下面列出的某个具体作品或热点：refs 填的就是这个选题要参考的那几条（标题、内容要能对上），不要引用跟选题主题无关的素材凑数；下面没有对应作品的题材不要出。题材是 AIGC 内容，优先这几类：AI音乐、AI MV、AI歌手/艺人、AI鬼畜、AI影视、AI换人（比如让名人替换明星开演唱会），其次 AI 特效玩法、AI 整活；可以结合热梗、热歌借势
- 选题要覆盖不同时间段：至少 3 个来自「24小时飙升」，至少 2 个来自「近3天爆款」，至少 2 个来自「本周热点」或「长期热点」
- 一视同仁：14 个选题分散到不同作品、不同题材，同一个系列 / 同一种玩法最多出 1 个，不要因为某个题材热就反复出
- 选题分两类（kind）：「作品」= 自己做一条 AIGC 作品；「教程测评」= 教别人怎么做某类爆款，或测评新工具新模型。14 个里要有 1~2 个教程测评，并且至少 1 个排进前 10，来源：【新工具 / 新模型】、【爆款工具热度】里正在涨的工具、门槛低但数据好的爆款（教大家怎么做）；没有这些素材就不出
- 标了「低粉爆款」的作品说明小号也能做，同等条件下优先；标了「分享率高 / 收藏率高 / 评论多」的，做法要顺着这个特点设计
- 做法要贴合平台：${PLATFORM_STYLE[s]}
- 每个选题输出：
  - title：选题标题，像一个能直接发在${name}上的视频标题，≤24 字
  - kind：作品 / 教程测评
  - horizon：24小时飙升 / 近3天爆款 / 本周热点 / 长期热点
  - form：单条 / 系列（系列 = 适合连续更新、做成合集让人追更的）
  - why：这个题材为什么能火，引用数据（播放、点赞、增速、持续天数），≤50 字，不要出现方括号编号
  - how：具体怎么做（形式、时长、关键镜头 / 节奏 / 文案），≤60 字
  - flow：工作流程，按步骤写怎么做出来，如「文生图出角色定妆 → 图生视频做动作 → 剪辑卡点配字幕」，≤36 字；只写步骤，不要写具体用哪家平台 / 哪个模型
  - level：难度，低（套模板 / 一键特效）/ 中（要自己写提示词、剪辑）/ 高（要写剧本分镜、多工具配合、保持角色一致）
  - time：一个人做出一条大概要多久，如「1 小时内」「半天」「2~3 天」
  - formula：这类爆款的可复用公式，如「经典 IP × 反差画风 × 名场面卡点」，≤24 字
  - variants：2~3 个换皮方向（同一个公式换题材 / IP / 人物，避免和原作撞车），每个 ≤16 字
  - risk：风险提示——涉及真人肖像（明星、企业家、政要）、影视动漫游戏 IP、历史人物戏说、未成年人、医疗金融等敏感领域时，说清楚风险和怎么规避（比如发布时声明 AI 生成、不商用、换成原创角色），≤36 字；没有明显风险就留空
  - refs：参考素材编号数组，如 ["A1","C3"]。第一个必须是这个选题最主要依据的那条具体作品（视频，A / B / C / D 开头的编号），后面可以再跟热搜、热歌等

输出格式：{"picks":[{"title":"","kind":"","horizon":"","form":"","why":"","how":"","flow":"","level":"","time":"","formula":"","variants":[],"risk":"","refs":[]}]}

${blocks}`, { maxTokens: 12000 });
  return r.picks || [];
}

// 抖音 AIGC 视频里出现最多的话题标签（看 AI 特效 / 玩法趋势）
function topTags(videos, n = 8) {
  const c = new Map();
  for (const v of videos.filter((x) => x.src === 'douyin')) {
    for (const t of (v.tags || '').split(',').filter(Boolean)) {
      const e = c.get(t) || { n: 0, likes: 0 };
      e.n++; e.likes += v.heat || 0;
      c.set(t, e);
    }
  }
  return [...c].filter(([, e]) => e.n >= 2).sort((a, b) => b[1].n - a[1].n || b[1].likes - a[1].likes).slice(0, n);
}

// 不走 AI 的步骤（抓评论、查粉丝数、查余额）：出错只打日志，用兜底值，不影响日报
async function safe(name, fn, fallback) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`  ✓ ${name} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return r;
  } catch (e) { console.log(`  ✗ ${name}：${e.message}`); return fallback; }
}

// 题材比对用的关键词：去掉【活动标签】和 #话题，去掉泛词
const keyGrams = (text) => [...grams(String(text || '').replace(/【[^】]*】|#[^#\s]+/g, ' '))].filter((g) => !COMMON.has(g));
// 话题标签只留跟题材有关的：把 AI、工具名、泛词剔掉后还剩实际内容的才算
//   「#抖音AI创作浪潮计划」「#即梦AI」「#AI短剧推荐」剔完是空的，不算；「#AI小黑猫卡点练舞」剩「小黑猫卡点练舞」，算
const GENERIC_WORDS = /aigc|ai|即梦|可灵|豆包|海螺|seedance|oiioii|libtv|剪映|必剪|updream|deepseek|抖音|创作|浪潮|计划|激励|征集|挑战赛|全宇宙|上热门|热门|推荐|原创|作品|视频|动画|动漫|二次元|短剧|漫剧|剧情|大片|短片|影视|剪辑|音乐|翻唱|特效|模板|全民制作人|mv|大赛|生成|绘画|精选|合集|热点|搞笑|鬼畜|可爱|娱乐|人工智能|此视频由|爱生成|dou/gi;
// 另外，当天在 5% 以上作品里都出现的标签也算通用（digest 开始时按平台统计）
let commonTags = new Set();
function countCommonTags(works) {
  const c = new Map();
  const n = {};
  for (const x of works) {
    n[x.src] = (n[x.src] || 0) + 1;
    for (const t of new Set((x.tags || '').toLowerCase().split(',').filter(Boolean))) c.set(`${x.src}|${t}`, (c.get(`${x.src}|${t}`) || 0) + 1);
  }
  commonTags = new Set([...c].filter(([k, v]) => v >= 10 && v >= 0.05 * n[k.split('|')[0]]).map(([k]) => k.split('|')[1]));
}
const themeTag = (t) => t.replace(GENERIC_WORDS, '').length >= 2 && !commonTags.has(t.toLowerCase());
const themeText = (x) => `${x.title || ''} ${(x.tags || '').split(',').filter(themeTag).join(' ')}`;
// 共享专有词：有一对首尾相接的两字词都相同（≈ 共有一个 3 字以上的词，比如「过来人」）
function sharePhrase(ga, gb) {
  for (const g of ga) if (gb.has(g)) for (const h of ga) if (h !== g && h[0] === g[1] && gb.has(h)) return true;
  return false;
}

// 时效：这个题材现在跟还来不来得及
//   刚起势：最早的爆款不超过 3 天、还在加速、同题材 AI 作品还少
//   已饱和：近 3 天同题材 AI 作品很多，或者已经 5 天以上且明显放缓
//   其余：高峰期
function timing(refs, pool, now) {
  const vids = refs.filter((x) => x.cat === 'video');
  const trs = refs.filter((x) => x.cat === 'trend');
  if (!vids.length && !trs.length) return undefined;
  const first = Math.min(...vids.map((x) => x.pubAt || now), ...trs.map((x) => x.firstSeen || now));
  const ageD = Math.max(0, (now - first) / DAY);
  // 加速度：现在每小时的增量 / 发布以来平均每小时的增量；发布不到 30 小时的当作还在冲
  const accs = vids.map((x) => {
    const h = (now - (x.pubAt || now)) / HOUR;
    if (h < 30) return 1.5;
    const avg = (x.heat || 0) / h;
    return avg ? velocity(x, now).perHour / avg : 1;
  });
  for (const t of trs) {
    const h = (t.hist || []).filter((q) => q[2]);
    accs.push(h.length >= 2 && h[h.length - 1][2] < h[0][2] ? 1.2 : 0.6); // 热搜排名在往前走算加速
  }
  const accel = Math.max(...accs);
  const g = new Set(keyGrams(refs.map(themeText).join(' ')));
  const similar = pool.filter((x) => !refs.some((r) => r.id === x.id) && sharePhrase(keyGrams(themeText(x)), g)).length;
  const label = similar >= 12 || (accel < 0.4 && ageD >= 5) ? '已饱和' : ageD <= 3 && similar <= 4 && accel >= 0.8 ? '刚起势' : '高峰期';
  const basis = [`最早的爆款${ageD < 1 ? '不到 1 天' : ` ${Math.round(ageD)} 天`}前`, `近 3 天同题材 AI 作品 ${similar} 条`, accel >= 1 ? '还在加速' : accel >= 0.5 ? '增速平稳' : '增速放缓'].join(' · ');
  return { label, basis };
}

// 跨平台信息差候选：from 平台近 7 天的 AIGC 爆款，在 to 平台近 30 天的 AI 稿件里找不到同题材的
function gapCands(all7, all30, from, to, now) {
  const target = all30.filter((x) => x.cat === 'video' && x.src === to).map((x) => new Set(keyGrams(themeText(x))));
  const seen = new Set();
  return all7.filter((x) => isWork(x) && x.src === from && x.pubAt > now - 7 * DAY)
    .sort((a, b) => (b.heat || 0) - (a.heat || 0)).slice(0, 40)
    .filter((x) => { const k = x.author || x.id; if (seen.has(k)) return false; seen.add(k); return true; })
    .filter((x) => { const g = keyGrams(themeText(x)); return g.length >= 2 && !target.some((t) => sharePhrase(g, t)); })
    .slice(0, 12);
}

async function pickGaps(dy, bl, now) {
  const line = (code, x) => `${code}|${typeOf(x)}|${x.title}|${stats(x)}|发布${Math.max(1, Math.round(hoursAgo(x.pubAt, now) / 24))}天${x.tags ? `|话题:${x.tags}` : ''}`;
  return ask(`下面两组是跨平台「信息差」候选：
【抖音有、B站没有】抖音近 7 天的 AIGC 爆款，我们在 B站近 30 天的 AI 稿件里没找到同题材的（D 编号）
${dy.map((x, i) => line(`D${i}`, x)).join('\n') || '（无）'}

【B站有、抖音没有】B站近 7 天的 AIGC 爆款，我们在抖音近 30 天的 AI 作品里没找到同题材的（B 编号）
${bl.map((x, i) => line(`B${i}`, x)).join('\n') || '（无）'}

每组挑最多 4 个「值得在另一个平台做」的题材：题材 / 玩法本身要能迁移（纯抖音特效模板、强依赖某个平台活动或站内梗的不要；只是单个作品、提炼不出可迁移题材的不要）。
不是建议搬运原视频，而是在另一个平台用同样的题材做原创。每个写：
- why：为什么值得在另一个平台做，≤30 字
- how：怎么改成适合另一个平台的版本（去 B站：横屏、1~3 分钟、做系列合集、埋弹幕梗；去抖音：竖屏、30 秒内、前 3 秒给高潮、配热门 BGM），≤40 字

输出格式：{"toBilibili":[{"i":"D编号","why":"","how":""}],"toDouyin":[{"i":"B编号","why":"","how":""}]}`, { maxTokens: 2000 });
}

// 选题复盘：前 3 天推荐的选题，参考作品后来又涨了多少（每天的涨幅），看哪类信号更靠谱
export function heatAt(x, ts) {
  const near = (x.hist || []).filter((q) => Math.abs(q[0] - ts) < 6 * HOUR).sort((a, b) => Math.abs(a[0] - ts) - Math.abs(b[0] - ts))[0];
  return near ? near[1] : null;
}
function reviewPicks(now, pool) {
  const byUrl = new Map(pool.filter((x) => x.cat === 'video').map((x) => [x.url, x]));
  const rows = [];
  for (let k = 1; k <= 3; k++) {
    const dg = readJSON(path.join(DATA, 'digests', `${bjDate(now - k * DAY)}.json`));
    if (!dg?.picks || Array.isArray(dg.picks)) continue;
    const days = (now - dg.generatedAt) / DAY;
    if (days < 0.5) continue;
    for (const s of ['douyin', 'bilibili']) {
      for (const p of dg.picks[s] || []) {
        let best = null;
        for (const r of (p.refs || []).filter((q) => q.kind === 'video')) {
          const x = byUrl.get(r.url);
          const then = r.heat || (x && heatAt(x, dg.generatedAt));
          if (!x || !then || !x.heat) continue;
          const g = (x.heat - then) / then;
          if (!best || g > best.g) best = { g, then, to: x.heat, title: r.title, url: r.url };
        }
        if (best) {
          const perDay = best.g / days;
          rows.push({
            date: dg.date, k, src: s, title: p.title, horizon: p.horizon, growth: +best.g.toFixed(3), perDay: +perDay.toFixed(3),
            from: best.then, to: best.to, ref: { title: best.title, url: best.url },
            status: perDay >= 0.15 ? '继续涨' : perDay >= 0.03 ? '放缓' : '停滞',
          });
        }
      }
    }
  }
  if (!rows.length) return undefined;
  const latest = Math.min(...rows.map((r) => r.k));
  const items = rows.filter((r) => r.k === latest).sort((a, b) => b.perDay - a.perDay);
  const byHorizon = Object.entries(rows.reduce((g, r) => ((g[r.horizon || '其它'] ||= []).push(r.perDay), g), {}))
    .map(([horizon, v]) => ({ horizon, n: v.length, avg: +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(3) }))
    .sort((a, b) => b.avg - a.avg);
  return { date: items[0].date, items, byHorizon, days: [...new Set(rows.map((r) => r.date))] };
}

// 3 分钟速览：AI 从最终的 20 个选题里挑今天最该做的 3 个，写一句话风向
async function makeBrief(picks, extra) {
  const lines = ['douyin', 'bilibili'].flatMap((s) => picks[s].map((p, i) => `${s === 'douyin' ? 'D' : 'B'}${i}|${PLATFORM[s]}|${p.kind}|${p.horizon || ''}|${p.timing?.label || ''}|难度${p.level || '?'}·${p.time || '?'}|${p.title}|${p.why}`));
  return ask(`下面是今天给抖音、B站 AIGC 博主出的选题（编号|平台|类型|时间段|时效|难度·耗时|标题|为什么能火），以及一些全局数据。
请：
1. 挑出今天最该做的 3 个：优先「刚起势 / 高峰期」、投入产出比高（难度低或中、爆点明确）的；两个平台都要照顾到，除非某个平台明显更值得；3 个不要是同一种题材
   每个写 why：为什么今天先做它，≤30 字
2. wind：一句话说今天的风向（什么在涨、什么已经饱和、该往哪边走），≤45 字，要具体到题材，不要空话

输出格式：{"wind":"","top":[{"code":"D0","why":""}]}

选题：
${lines.join('\n')}

${extra}`, { maxTokens: 800 });
}

// 取前 10 个选题；AI 出了教程测评但排在 10 名以后时，换掉第 10 个，保证至少有 1 个
function keepTutorial(list) {
  const top = list.slice(0, 10);
  if (!top.some((p) => p.kind === '教程测评')) {
    const t = list.slice(10).find((p) => p.kind === '教程测评');
    if (t) top.splice(Math.min(top.length, 9), 1, t);
  }
  return top;
}

// DeepSeek 余额（元），邮件里低于 DEEPSEEK_WARN_BALANCE 时提醒充值
export async function deepseekBalance(now) {
  const r = await fetch(`${DEEPSEEK_BASE}/user/balance`, { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }, signal: AbortSignal.timeout(20e3) });
  const j = await r.json();
  const cny = (j.balance_infos || []).find((b) => b.currency === 'CNY') || j.balance_infos?.[0];
  if (!cny) throw new Error('没拿到余额');
  writeJSON(path.join(DATA, 'deepseek.json'), { balance: +cny.total_balance, currency: cny.currency, checkedAt: now }, true);
  return +cny.total_balance;
}

export async function digest(now = Date.now()) {
  const errors = [];
  const since = now - DAY;
  let all1 = loadWindow(1.25, now);
  let all7 = loadWindow(7, now);
  let all30 = loadWindow(30, now);
  const withVel = (x) => ({ ...x, vel: velocity(x, now).perHour });

  // ---- B站 UP 主粉丝数（算低粉爆款）：只查 30 天热度靠前的 AIGC 作品的作者，结果缓存 7 天 ----
  const mids = [...new Set(all30.filter((x) => isWork(x) && x.src === 'bilibili' && x.m?.mid).sort((a, b) => (b.heat || 0) - (a.heat || 0)).slice(0, 200).map((x) => x.m.mid))];
  const cachedFans = Object.fromEntries(Object.entries(readJSON(path.join(DATA, 'bili-fans.json'), {})).map(([k, v]) => [k, v.f]));
  const fans = await safe('B站粉丝数', () => biliFans(mids), cachedFans);
  [all1, all7, all30] = [all1, all7, all30].map((list) => list.map((x) => withFans(x, fans)));
  // 互动率中位数（分享率、收藏率……），用来给作品打「数据画像」标签
  const med = ratioMedians(all30);
  countCommonTags(all7.filter(isWork));
  const dress = (x) => { const o = slim(x, now); const pt = portrait(x, med); if (pt.length) o.pt = pt; return o; };

  // ---- 爆款（抖音 / B站，过去 24 小时增速） ----
  const fresh = all1.filter((x) => isWork(x) && x.lastSeen >= since && x.pubAt > now - 7 * DAY).map(withVel);
  const cand = ['douyin', 'bilibili'].flatMap((s) => fresh.filter((x) => x.src === s).sort((a, b) => b.vel - a.vel).slice(0, 25));
  const top = await step('爆款点评', () => pickHits(cand, now),
    () => ['douyin', 'bilibili'].flatMap((s) => cand.filter((x) => x.src === s).slice(0, 6).map((x) => ({ i: cand.indexOf(x), hook: x.ai.hook, tip: x.ai.tip }))), errors);
  const hits = top.map((t) => cand[+t.i] && { ...cand[+t.i], ai: { ...cand[+t.i].ai, hook: t.hook || cand[+t.i].ai.hook, tip: t.tip || cand[+t.i].ai.tip } }).filter(Boolean)
    .filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i);
  // AI 有时挑得少，每个平台不满 6 条就按增速补齐（补上的沿用标注时写好的爆点 / 参考）
  for (const s of ['douyin', 'bilibili']) {
    let have = hits.filter((x) => x.src === s).length;
    for (const x of cand.filter((c) => c.src === s && !hits.some((h) => h.id === c.id))) {
      if (have >= 6) break;
      hits.push(x);
      have++;
    }
  }
  const videos = Object.fromEntries(['douyin', 'bilibili'].map((s) => [s, hits.filter((x) => x.src === s).slice(0, 6).map(dress)]));

  // ---- 高赞榜：近 30 天所有 AIGC 作品（不限类型，抖音只认官方 AI 标），严格按点赞（抖音）/ 播放（B站）取前 N 名 ----
  // 同一作者只留最火的一条（避免一个系列霸榜）；AI 只负责逐条写分析，不参与挑选
  const TOPN = { douyin: 10, bilibili: 10 };
  const topList = ['douyin', 'bilibili'].flatMap((s) => {
    const seenAuthor = new Set();
    return all30
      .filter((x) => isWork(x) && x.src === s && x.pubAt > now - 30 * DAY)
      .sort((a, b) => (b.heat || 0) - (a.heat || 0))
      .filter((x) => { const k = x.author || x.id; if (seenAuthor.has(k)) return false; seenAuthor.add(k); return true; })
      .slice(0, TOPN[s]).map(withVel);
  });
  const notes = await step('高赞榜点评', () => pickTop(topList, now), () => [], errors);
  const noteOf = new Map(notes.map((t) => [+t.i, t]));
  const topDone = topList.map((x, i) => ({
    ...x, ai: { ...x.ai, hook: noteOf.get(i)?.hook || x.ai.hook, tip: noteOf.get(i)?.tip || x.ai.tip },
  }));
  for (const s of ['douyin', 'bilibili']) videos[`${s}Top`] = topDone.filter((x) => x.src === s).map(dress);

  // ---- 低粉爆款：近 14 天，作者粉丝不到 10 万却爆了的 AIGC 作品（小号也能做的证据） ----
  for (const s of ['douyin', 'bilibili']) {
    const seen = new Set();
    videos[`${s}Low`] = all30.filter((x) => isWork(x) && x.src === s && x.pubAt > now - 14 * DAY && lowFan(x))
      .sort((a, b) => (b.heat || 0) - (a.heat || 0))
      .filter((x) => { const k = x.author || x.id; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 8).map(withVel).map(dress);
  }

  // ---- 爆款工具榜（近 7 天 vs 上 7 天）、爆款 BGM 榜（近 7 天抖音 AIGC 作品） ----
  // 「上 7 天」要有满 14 天的数据才可比（系统刚上线时上期数据不全，先不比）
  const history = fs.existsSync(path.join(DATA, 'days')) ? fs.readdirSync(path.join(DATA, 'days')).filter((f) => f.endsWith('.json')).length : 0;
  const tools = toolRank(loadWindow(14, now).filter(isWork), now, 7, { compare: history >= 14 }).slice(0, 12);
  const bgms = bgmRank(all7.filter((x) => isWork(x) && x.pubAt > now - 7 * DAY)).slice(0, 10);

  // ---- AI 圈大事件（先做，新工具 / 新模型要拿去出测评教程选题） ----
  const news = all1
    .filter((x) => x.cat === 'news' && (x.pubAt || x.firstSeen) >= now - 30 * HOUR && x.board !== 'HF 热门模型')
    .sort((a, b) => (b.pubAt || b.firstSeen) - (a.pubAt || a.firstSeen))
    .slice(0, 140);
  const hf = all1
    .filter((x) => x.board === 'HF 热门模型' && x.lastSeen >= since && (!x.pubAt || x.pubAt > now - 21 * DAY))
    .sort((a, b) => (a.rank || 99) - (b.rank || 99))
    .slice(0, 12);
  const events = await step('资讯归并', () => mergeNews(news, hf, now), () => news.filter((x) => isAI(x.title)).slice(0, 12).map((x) => ({ title: x.title, summary: '', ids: [news.indexOf(x)] })), errors);
  const refOf = (id) => (String(id).startsWith('H') ? hf[+String(id).slice(1)] : news[+id]);
  const newsOut = events.map((e) => ({
    title: e.title, summary: e.summary, kind: e.kind, level: e.level,
    refs: (e.ids || []).map(refOf).filter(Boolean).map((x) => ({ id: x.id, title: x.title, url: x.url, src: x.src })),
  })).filter((e) => e.refs.length);

  // ---- 选题素材：四个时间段 + 新工具 + 工具热度 ----
  const memes = all1.filter((x) => x.cat === 'trend' && x.lastSeen >= since && x.ai?.tag)
    .sort((a, b) => ({ 热梗: 0, AI相关: 1, 可借势: 2 }[a.ai.tag] ?? 9) - ({ 热梗: 0, AI相关: 1, 可借势: 2 }[b.ai.tag] ?? 9) || (a.peakRank || 99) - (b.peakRank || 99))
    .slice(0, 15);
  // 抖音热门挑战 / 玩法：热榜里抖音官方归类为「站内玩法」「话题互动」的词条，挑战排前面，AI 参与多的排前面
  const challenges = all1.filter((x) => x.cat === 'trend' && x.kind && x.lastSeen >= since)
    .sort((a, b) => (a.kind === '抖音挑战' ? 0 : 1) - (b.kind === '抖音挑战' ? 0 : 1) || (b.m?.aiVideos || 0) - (a.m?.aiVideos || 0) || (a.peakRank || 99) - (b.peakRank || 99))
    .slice(0, 8);
  const byHeat = (arr, n, exclude) => arr.filter((x) => !exclude.has(x.id)).sort((a, b) => (b.heat || 0) - (a.heat || 0)).slice(0, n);
  const lastingTrends = all7.filter((x) => x.cat === 'trend' && x.daysSeen >= 3 && x.ai?.tag).sort((a, b) => b.daysSeen - a.daysSeen);
  const lastingSongs = all30.filter((x) => x.cat === 'music' && x.daysSeen >= 7).sort((a, b) => b.daysSeen - a.daysSeen);
  // AI 最近 3 天发现的新兴玩法（annotate 里维护）
  const tk = readJSON(path.join(DATA, 'trend-keywords.json'), {});
  const trendKw = Object.entries(tk).filter(([, v]) => v.last > now - 3 * DAY)
    .sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last).slice(0, 8)
    .map(([kw, v]) => ({ kw, why: v.why, first: v.first, n: v.n }));
  // 新工具 / 新模型（可以做首发测评、教程）
  const toolNews = newsOut.filter((e) => ['新模型', '模型升级', '产品功能'].includes(e.kind)).slice(0, 6);

  // 抖音、B站各准备一份素材：只放本平台的作品 / 热搜 / 热歌，微博热梗两边都可以借势
  function platformBlocks(s) {
    const refs = {};
    const vExtra = (x) => [toolsOf(x).length && `工具:${toolsOf(x).join('、')}`, lowFan(x) && '低粉爆款', ...portrait(x, med).filter((t) => t !== '低粉爆款')].filter(Boolean).join('｜');
    const line = (code, x) => {
      refs[code] = x;
      const what = x.cat === 'video' ? `${typeOf(x)}｜${x.title}｜${stats(x)}${x.vel ? `｜每小时+${fmtNum(x.vel)}` : ''}${vExtra(x) ? `｜${vExtra(x)}` : ''}${x.ai.hook ? `｜爆点：${x.ai.hook}` : ''}`
        : x.cat === 'trend' ? `${PLATFORM[x.src]}热搜｜${x.kind || x.ai?.tag || ''}｜${x.title}${x.daysSeen > 1 ? `｜在榜${x.daysSeen}天` : ''}${x.kind && x.m?.fetched ? `｜参与视频 ${x.m.aiVideos || 0}/${x.m.fetched} 条是 AI 做的` : ''}｜${x.ai?.why || ''}`
          : x.cat === 'news' ? `${x.kind}｜${x.title}｜${x.desc || ''}`
            : `${x.board}#${x.rank || '-'}｜${x.title} - ${x.author}${x.daysSeen > 1 ? `｜在榜${x.daysSeen}天` : ''}｜${x.ai?.why || ''}`;
      return `[${code}] ${what}`;
    };
    const mine = (x) => x.src === s;
    const used = new Set();
    const h24 = fresh.filter(mine).sort((a, b) => b.vel - a.vel).slice(0, 15);
    h24.forEach((x) => used.add(x.id));
    const h3 = byHeat(all7.filter((x) => mine(x) && isWork(x) && x.pubAt > now - 3 * DAY).map(withVel), 10, used);
    h3.forEach((x) => used.add(x.id));
    const w7 = all7.filter((x) => mine(x) && isWork(x) && x.pubAt > now - 7 * DAY);
    const h7 = byHeat(w7, 10, used);
    h7.forEach((x) => used.add(x.id));
    const w30 = all30.filter((x) => mine(x) && isWork(x));
    const h30 = byHeat(w30, 12, used);
    const pm = memes.filter((x) => x.src === s || x.src === 'weibo');
    const pc = s === 'douyin' ? challenges.filter((x) => !pm.includes(x)) : [];
    const lt = lastingTrends.filter((x) => x.src === s || x.src === 'weibo').slice(0, 8);
    // 本平台正在飙升的歌（借势做 AI 翻唱 / MV）+ 长期在榜的歌
    const songs = [...all1.filter((x) => x.cat === 'music' && mine(x) && x.board.includes('飙升') && (x.rank || 99) <= 6), ...lastingSongs.filter(mine).slice(0, 4)];
    const tags7 = s === 'douyin' ? topTags(w7) : [];
    const typeCount = Object.entries(w30.reduce((c, x) => ((c[typeOf(x)] = (c[typeOf(x)] || 0) + 1), c), {})).sort((a, b) => b[1] - a[1]);
    // 评论区有人求教程 / 求更新的高赞作品

    const tn = toolNews.map((e) => ({ cat: 'news', kind: e.kind, title: e.title, desc: e.summary, url: e.refs[0].url }));
    const blocks = [
      `【24小时飙升】\n${[...h24.map((x, i) => line(`A${i}`, x)), ...pm.map((x, i) => line(`T${i}`, x)), ...pc.map((x, i) => line(`K${i}`, x))].join('\n') || '（无）'}`,
      `【近3天爆款】\n${h3.map((x, i) => line(`B${i}`, x)).join('\n') || '（无）'}`,
      `【本周热点】\n${[...h7.map((x, i) => line(`C${i}`, x)), ...lt.map((x, i) => line(`L${i}`, x))].join('\n') || '（无）'}${tags7.length ? `\n抖音 AIGC 话题标签（7天内视频数/总赞）：${tags7.map(([t, e]) => `#${t} ${e.n}条/${fmtNum(e.likes)}赞`).join('，')}` : ''}`,
      `【长期热点（30天）】\n${h30.map((x, i) => line(`D${i}`, x)).join('\n') || '（无）'}${typeCount.length ? `\n30 天 AIGC 作品类型分布：${typeCount.map(([t, n]) => `${t} ${n}`).join('，')}` : ''}`,
      songs.length ? `【可借势的热歌】\n${songs.map((x, i) => line(`S${i}`, x)).join('\n')}` : '',

      tn.length ? `【新工具 / 新模型】可以做首发测评、教程\n${tn.map((x, i) => line(`N${i}`, x)).join('\n')}` : '',
      tools.length ? `【爆款工具热度】近 7 天 AIGC 爆款里提到各工具的作品数（括号里是上 7 天）：${tools.slice(0, 10).map((t) => `${t.name} ${t.n}（${t.prev}）`).join('，')}` : '',
    ].filter(Boolean).join('\n\n');
    console.log(`${PLATFORM[s]}选题素材：24h ${h24.length}+热梗 ${pm.length}+挑战 ${pc.length}，3天 ${h3.length}，本周 ${h7.length}+长热搜 ${lt.length}，30天 ${h30.length}，热歌 ${songs.length}，新工具 ${tn.length}`);
    return { blocks, refs };
  }
  const pb = { douyin: platformBlocks('douyin'), bilibili: platformBlocks('bilibili') };

  // ---- 今日选题 + 跨平台信息差 ----
  const gapIn = { douyin: gapCands(all7, all30, 'douyin', 'bilibili', now), bilibili: gapCands(all7, all30, 'bilibili', 'douyin', now) };
  const [dyPicks, blPicks, gapsRaw] = await Promise.all([
    step('抖音选题', () => makePicks(pb.douyin.blocks, 'douyin'), () => [], errors),
    step('B站选题', () => makePicks(pb.bilibili.blocks, 'bilibili'), () => [], errors),
    step('信息差', () => pickGaps(gapIn.douyin, gapIn.bilibili, now), () => ({}), errors),
  ]);
  const gapOut = (list, arr) => (Array.isArray(arr) ? arr : []).map((g) => {
    const x = list[+String(g.i).replace(/\D/g, '')];
    return x && { ...dress(withVel(x)), why: g.why, how: g.how };
  }).filter(Boolean).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i).slice(0, 4);
  const gaps = { toBilibili: gapOut(gapIn.douyin, gapsRaw?.toBilibili), toDouyin: gapOut(gapIn.bilibili, gapsRaw?.toDouyin) };

  // ---- 热搜 / 热歌：取最新一次采集的榜单 ----
  const trends = Object.fromEntries(['douyin', 'bilibili', 'weibo'].map((src) => [src, all1
    .filter((x) => x.cat === 'trend' && x.src === src && x.lastSeen >= since && x.rank)
    .sort((a, b) => (a.peakRank || 99) - (b.peakRank || 99) || (b.peakHeat || 0) - (a.peakHeat || 0))
    .slice(0, 10).map((x) => slim(x, now))]));
  const latest = Math.max(0, ...all1.filter((x) => x.cat === 'music').map((x) => x.lastSeen));
  const music = {};
  for (const x of all1.filter((m) => m.cat === 'music' && m.lastSeen >= latest - 6 * HOUR).sort((a, b) => (a.rank || 99) - (b.rank || 99))) {
    const plat = PLATFORM[x.src];
    const kind = x.board.includes('飙升') ? '飙升榜' : '热歌榜';
    ((music[plat] ||= {})[kind] ||= []).length < 10 && music[plat][kind].push(slim(x, now));
  }

  // 时效判断用：近 3 天同平台的 AIGC 作品
  const pool3 = Object.fromEntries(['douyin', 'bilibili'].map((s) => [s, all7.filter((x) => isWork(x) && x.src === s && x.pubAt > now - 3 * DAY)]));
  const LEVELS = ['低', '中', '高'];

  // 今日选题：抖音 10 个、B站 10 个
  // 每个平台 AI 出 14 个，参考对不上标题的删掉，一个都对不上的选题整条丢弃；同题材的只留一个，取前 10
  // 参考作品记下当时的热度，第二天复盘看它后来又涨了多少
  const picks = Object.fromEntries([['douyin', dyPicks], ['bilibili', blPicks]].map(([s, list]) => [s, keepTutorial(dedupePicks(list.map((p) => {
      const refs = (p.refs || []).map((c) => pb[s].refs[c]).filter(Boolean).filter((x) => related(p.title, x));
      if (!refs.length) return null;
      return {
        title: p.title, kind: p.kind === '教程测评' ? '教程测评' : '作品', horizon: p.horizon, form: p.form === '系列' ? '系列' : '单条',
        why: p.why, how: p.how, flow: p.flow || undefined,
        level: LEVELS.includes(p.level) ? p.level : undefined, time: p.time || undefined,
        formula: p.formula || undefined, variants: (Array.isArray(p.variants) ? p.variants : []).filter((v) => typeof v === 'string' && v).slice(0, 3),
        risk: p.risk || undefined, timing: timing(refs, pool3[s], now),
        // 主要依据：AI 排在第一的那条作品（没有作品参考就没有），选题旁边显示它的封面，点开看视频
        main: (({ url, cover, src, title, heat } = {}) => (url ? { url, cover, src, title, heat } : undefined))(refs.find((x) => x.cat === 'video')),
        refs: refs.map((x) => ({ kind: x.cat, title: x.cat === 'music' ? `${x.title} - ${x.author}` : x.title, url: x.url, id: x.id, heat: x.cat === 'video' ? x.heat : undefined })),
      };
    }).filter(Boolean)))]));

  // ---- 3 分钟速览：从 20 个选题里挑今天最该做的 3 个 + 一句话风向，再配 1 个低粉爆款、1 个信息差 ----
  const review = reviewPicks(now, all7);
  const briefExtra = [
    review?.byHorizon?.length ? `最近几天选题复盘（参考作品之后每天涨幅）：${review.byHorizon.map((h) => `${h.horizon} ${Math.round(h.avg * 100)}%/天`).join('，')}` : '',
    tools.length ? `近 7 天爆款里提到最多的工具：${tools.slice(0, 6).map((t) => `${t.name} ${t.n}`).join('，')}` : '',
    challenges.length ? `抖音正在流行的挑战 / 玩法：${challenges.slice(0, 6).map((x) => x.title).join('、')}` : '',
  ].filter(Boolean).join('\n');
  const briefRaw = picks.douyin.length || picks.bilibili.length ? await step('3 分钟速览', () => makeBrief(picks, briefExtra), () => ({}), errors) : {};
  const byCode = (c) => {
    const m = /^([DB])(\d+)$/.exec(String(c || '').trim().toUpperCase());
    if (!m) return null;
    const s = m[1] === 'D' ? 'douyin' : 'bilibili';
    return picks[s][+m[2]] ? { s, i: +m[2], p: picks[s][+m[2]] } : null;
  };
  const briefTop = (briefRaw.top || []).map((t) => { const r = byCode(t.code); return r && { ...r, why: t.why }; }).filter(Boolean)
    .filter((r, k, a) => a.findIndex((q) => q.s === r.s && q.i === r.i) === k);
  // AI 没挑够就按顺序补：抖音第 1、B站第 1、抖音第 2……
  for (const [s, i] of [['douyin', 0], ['bilibili', 0], ['douyin', 1], ['bilibili', 1]]) {
    if (briefTop.length >= 3) break;
    if (picks[s][i] && !briefTop.some((r) => r.s === s && r.i === i)) briefTop.push({ s, i, p: picks[s][i], why: picks[s][i].why });
  }
  const lowPick = [...(videos.douyinLow || []).slice(0, 1), ...(videos.bilibiliLow || []).slice(0, 1)][0];
  const gapPick = gaps.toBilibili[0] || gaps.toDouyin[0];
  const brief = {
    wind: briefRaw.wind || '',
    top: briefTop.slice(0, 3).map(({ s, i, p, why }) => ({ src: s, i, title: p.title, kind: p.kind, horizon: p.horizon, level: p.level, time: p.time, timing: p.timing?.label, why })),
    low: lowPick && { title: lowPick.title, url: lowPick.url, src: lowPick.src, heat: lowPick.heat, author: lowPick.author, fans: lowPick.m?.fans, hook: lowPick.ai?.hook },
    gap: gapPick && { title: gapPick.title, url: gapPick.url, src: gapPick.src, heat: gapPick.heat, to: gapPick.src === 'douyin' ? 'bilibili' : 'douyin', how: gapPick.how },
  };

  const out = {
    date: bjDate(now), generatedAt: now, window: [since, now],
    ai: hasKey() ? DEEPSEEK_MODEL : null, errors,
    picks,
    brief,
    gaps,
    review,
    tools,
    bgms,
    trendKeywords: trendKw.map(({ kw, why }) => ({ kw, why })),
    videos,
    // 热梗里已经单列的抖音挑战不重复放
    memes: memes.filter((x) => !x.kind).slice(0, 10).map((x) => slim(x, now)),
    challenges: challenges.map((x) => slim(x, now)),
    trends,
    music,
    news: newsOut,
  };
  writeJSON(path.join(DATA, 'digests', `${out.date}.json`), out, true);

  // 爆款的精修点评、评论区洞察、事件归属写回当天数据，网页上也能看到
  const file = dayPath(now);
  const day = readJSON(file);
  if (day) {
    const put = (id, ai) => { if (day.items[id]) day.items[id].ai = { ...day.items[id].ai, ...ai }; };
    hits.forEach((v) => put(v.id, { hook: v.ai.hook, tip: v.ai.tip, top: 1 }));
    topDone.forEach((v) => put(v.id, { hook: v.ai.hook, tip: v.ai.tip }));
    newsOut.forEach((e) => e.refs.forEach((r) => put(r.id, { event: e.title, kind: e.kind, level: e.level })));
    writeJSON(file, day);
  }

  if (hasKey()) await safe('DeepSeek 余额', () => deepseekBalance(now), null);
  const lowN = (s) => videos[`${s}Low`]?.length || 0;
  console.log(`日报完成：选题 抖音 ${out.picks.douyin.length} / B站 ${out.picks.bilibili.length}，高赞榜 抖音 ${videos.douyinTop?.length || 0} / B站 ${videos.bilibiliTop?.length || 0}，低粉爆款 抖音 ${lowN('douyin')} / B站 ${lowN('bilibili')}，信息差 ${gaps.toBilibili.length}+${gaps.toDouyin.length}，复盘 ${out.review?.items.length || 0}，工具 ${tools.length}，BGM ${bgms.length}，抖音挑战 ${out.challenges.length}，爆款 抖音 ${videos.douyin.length} / B站 ${videos.bilibili.length}，热梗 ${out.memes.length}，事件 ${newsOut.length}${errors.length ? `；AI 出错 ${errors.length} 处` : ''}`);
  return out;
}

if (isMain(import.meta.url)) {
  loadEnv();
  const what = process.argv[2] || 'all';
  (async () => {
    if (what === 'annotate' || what === 'all') await annotate();
    if (what === 'digest' || what === 'all') await digest();
    saveUsage();
  })().catch((e) => { saveUsage(); console.error(e); process.exit(1); });
}
