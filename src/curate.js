// AI 点评，分两步：
//   annotate —— 每次采集后跑，只处理新出现的内容：
//       视频：是不是 AIGC、什么类型，AIGC 作品写「爆点分析」+「怎么参考」
//       热搜：每条写「为什么上热搜」，对 AIGC 自媒体有用的再打「热梗 / AI相关 / 可借势」标签 + AI 做法
//       热歌：每首写「为什么火」+「适合怎么 AI 二创」
//   digest   —— 每天早上跑：抖音 / B站各挑爆款，按 24h / 3天 / 7天 / 30天 四个时间段出选题，资讯归并成 AI 圈大事件
import path from 'node:path';
import { DATA, HOUR, DAY, bjDate, readJSON, writeJSON, loadEnv, isMain, isAI, fmtNum } from './util.js';
import { DEEPSEEK_BASE, DEEPSEEK_MODEL } from './config.js';
import { loadWindow, velocity, slim, PLATFORM } from './rank.js';

// 标注版本号。分析内容的格式变了就加 1，旧数据会被重新标注一次
const V = 2;
// 重点类型（用户点名要盯的高赞内容）在前，后面是次要类型
export const FOCUS_TYPES = ['AI音乐', 'AI MV', 'AI歌手/艺人', 'AI鬼畜', 'AI影视', 'AI换人'];
export const AIGC_TYPES = [...FOCUS_TYPES, 'AI动画', 'AI特效玩法', 'AI整活'];
// 视频分类改过一次（AI剧情 / AI短片 并进 AI影视），旧数据先按新名字读，再由 annotate 重新标
const OLD_TYPE = { AI剧情: 'AI影视', AI短片: 'AI影视' };
const typeOf = (x) => OLD_TYPE[x.ai?.type] || x.ai?.type;
const isWork = (x) => x.cat === 'video' && AIGC_TYPES.includes(typeOf(x));
const isFocus = (x) => x.cat === 'video' && FOCUS_TYPES.includes(typeOf(x));
const VV = 3; // 视频标注版本

const SYSTEM = `你是一位资深的 AIGC 自媒体选题编辑，服务对象是在抖音、B站做 AI 内容的博主。
你的任务是帮他们看懂每个热点「为什么能火」，并判断能做什么内容。
要求：判断准确、语言精炼口语化、不说空话套话；只根据给出的信息和你确定知道的事实分析，拿不准的写「推测：」开头，绝不编造具体事件、人名、数据。
只输出 JSON，不要任何其它文字。`;

const hasKey = () => !!process.env.DEEPSEEK_API_KEY;

// 截断标题时可能把 emoji 切成半个（孤立的代理项），DeepSeek 会直接拒收整个请求，发送前清掉
const fixText = (s) => s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

async function ask(prompt, { maxTokens = 6000 } = {}) {
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
      return JSON.parse(j.choices[0].message.content);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function step(name, fn, fallback, errors) {
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

function stats(x) {
  const m = x.m || {};
  if (x.src === 'douyin') return `${m.play ? `播放${fmtNum(m.play)} ` : ''}点赞${fmtNum(m.like)} 评论${fmtNum(m.comment)} 分享${fmtNum(m.share)}${m.fav ? ` 收藏${fmtNum(m.fav)}` : ''}${m.aiCorner ? ' 【抖音AI角标】' : ''}${m.hint ? ` 【来自 #${x.board.replace('话题·#', '')} 话题】` : ''}`;
  if (x.src === 'bilibili') return `播放${fmtNum(m.play)} 点赞${fmtNum(m.like)} 弹幕${fmtNum(m.danmaku)}`;
  return `播放${fmtNum(x.heat)}`;
}

// ====================== annotate ======================
async function annotateVideos(list, now) {
  const lines = list.map((x, i) => [
    i, PLATFORM[x.src], x.m?.part || '', x.title, x.tags ? `话题:${x.tags}` : '', x.desc && x.desc !== x.title ? `简介:${x.desc.slice(0, 60)}` : '',
    stats(x), (x.m?.noDate ? '发布时间未知' : `发布${hoursAgo(x.pubAt, now)}h`),
  ].filter(Boolean).join('|'));
  const r = await ask(`下面是抖音 / B站上近期可能跟 AI 有关的视频（编号|平台|分区|标题|话题|简介|数据|发布时长）。
关键词搜索会混进很多不是 AI 生成的视频，请严格判断：
1. 「内容本身主要由 AI 生成 / AI 参与创作」的 AIGC 作品，给出 type（选最贴切的一个）：
   AI音乐（AI 作曲 / AI 翻唱 / AI 说唱，比如让古人开麦唱歌说唱）、
   AI MV（给歌配 AI 生成画面的 MV）、
   AI歌手/艺人（虚拟歌手、AI 艺人 / 数字人账号发的作品）、
   AI鬼畜（AI 做的鬼畜、魔性循环、名人唱跳恶搞）、
   AI影视（AI 短剧、漫剧、电影、预告片、剧情短片）、
   AI换人（把视频里的人换成另一个人，比如让黄仁勋替代迈克尔·杰克逊在演唱会上唱歌；AI 换脸）、
   AI动画（非剧情向的 AI 动画）、AI特效玩法（抖音 AI 特效模板、AI 滑镜、AI 变身、AI 换装这类一键玩法）、AI整活（其它恶搞、梗视频）
   视频来自某个 AI 话题（比如 #ai短剧）只说明它带了这个标签，还是要看内容判断
2. 讲 AI 的教程、评测、新闻解读：type 为「AI教程测评」，不用写分析
3. 跟 AI 生成无关的不要输出
4. 每个 AIGC 作品再写两句：
   - hook：爆点分析——这条为什么能火（题材、情绪、反差、梗、技术新鲜感、蹭了什么热点、人设、节奏等），要具体到这条视频，≤45 字
   - tip：怎么参考——同类内容怎么做、用什么工具、关键点是什么，≤40 字

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
标了【抖音挑战】【话题互动】的是抖音官方归类的站内玩法 / 挑战：why 要说清楚这个挑战怎么玩、为什么大家爱跟；idea 必须写，说怎么用 AI 跟拍 / 参与（用什么工具、拍什么），≤35 字。

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
例如「古人开麦」（AI 让古人说唱 / 唱歌）、「AI趣味滑镜」（抖音 AI 特效）、「AI老照片动起来」这种有辨识度、别人会拿来当话题的名字。
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

  const videos = items
    .filter((x) => x.cat === 'video' && x.ai?.vv !== VV && x.pubAt > now - 31 * DAY)
    .map((x) => ({ x, vel: velocity(x, now).perHour }))
    .sort((a, b) => b.vel - a.vel)
    .slice(0, 400)
    .map((v) => v.x);
  const trends = items
    // 挑战类如果之前标注时没给 AI 做法（加这个功能之前标的），补一次
    .filter((x) => x.cat === 'trend' && (fresh(x) || (x.kind && !x.ai?.idea && !x.ai?.kv)) && x.lastSeen >= now - 2 * HOUR)
    .sort((a, b) => (a.rank || 99) - (b.rank || 99));
  // 同一首歌可能同时在好几个榜上，合并成一组只问一次
  const bgm = items.filter((x) => x.cat === 'bgm');
  const groups = new Map();
  for (const x of items.filter((s) => s.cat === 'music' && fresh(s) && s.lastSeen >= now - 2 * HOUR)) {
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
  console.log(`标注：新视频 ${videos.length}，新热搜 ${trends.length}，新歌 ${songs.length} 首；${hasKey() ? DEEPSEEK_MODEL : '未配置 Key，用规则兜底'}`);

  const vb = chunk(videos, 80);
  const tb = chunk(trends, 50);
  const sb = chunk(songs, 60);
  const tasks = [
    ...vb.map((b, k) => () => step(`视频 ${k + 1}/${vb.length}`, async () => ({ ok: true, items: await annotateVideos(b, now) }),
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
    const by = new Map(vres[k].items.map((x) => [+x.i, x]));
    b.forEach((x, i) => {
      const a = by.get(i);
      if (a || vres[k].ok) put(x.id, { type: a?.type || '非AIGC', hook: a?.hook || undefined, tip: a?.tip || undefined, vv: vres[k].ok ? VV : undefined }, vres[k].ok);
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
- tip：怎么参考——同类内容怎么做、用什么工具、关键镜头 / 节奏 / 文案怎么设计，≤45 字

输出格式：{"top":[{"i":编号,"hook":"","tip":""}]}

${lines.join('\n')}`, { maxTokens: 3000 });
  return r.top || [];
}

async function pickTop(list, now) {
  const lines = list.map((x, i) => `${i}|${PLATFORM[x.src]}|${typeOf(x)}|${x.title}|${stats(x)}|${x.m?.noDate ? '发布时间未知' : `发布${Math.max(1, Math.round(hoursAgo(x.pubAt, now) / 24))}天`}${x.tags ? `|话题:${x.tags}` : ''}`);
  const r = await ask(`下面是近 30 天点赞（抖音）/ 播放（B站）最高的 AIGC 作品（编号|平台|类型|标题|数据|发布天数|话题），类型都是重点关注的：AI音乐、AI MV、AI歌手/艺人、AI鬼畜、AI影视、AI换人。
从【抖音】挑 8 个、【B站】挑 5 个最值得 AI 自媒体研究的高赞作品（候选不够就全选）：
- 尽量覆盖不同类型，同一作者 / 同一系列只选最火的一个
- 对每个写：
  - hook：它为什么能火到这个量级——题材、情绪、反差、人设、技术新鲜感、借了什么势，结合数据说，≤50 字
  - tip：想做同类内容怎么做——选题、工具、关键镜头 / 节奏 / 文案，≤45 字

输出格式：{"top":[{"i":编号,"hook":"","tip":""}]}

${lines.join('\n')}`, { maxTokens: 3000 });
  return r.top || [];
}

// 平台特点：给 AI 定「怎么做」时参考
const PLATFORM_STYLE = {
  douyin: '抖音：竖屏，15~60 秒，前 3 秒定生死；擅长 AI 特效模板、卡点、BGM、挑战玩法、情绪向和反差向内容，文案 + 话题标签很关键',
  bilibili: 'B站：横屏为主，1~5 分钟，适合有完整度的作品；擅长 AI MV、AI 剧情 / 短剧系列化、鬼畜、AI 翻唱，重视弹幕互动、标题封面和参加官方活动（如 AI MV 大赛、AI 全民制作人）',
};

async function makePicks(blocks, s) {
  const name = PLATFORM[s];
  const r = await ask(`下面是${name}上 AIGC 相关的热点数据，按时间段分组（方括号里是编号）。
请给出「今天最值得在${name}上做的 10 个选题」，按值得做的程度从高到低排：
- 选题的依据必须是下面${name}上的真实作品和热点（每个选题至少引用一个参考素材），题材是 AIGC 内容，优先这几类：AI音乐、AI MV、AI歌手/艺人、AI鬼畜、AI影视、AI换人（比如让名人替换明星开演唱会），其次 AI 特效玩法、AI 整活；可以结合热梗、热歌借势
- 10 个选题要覆盖不同时间段：至少 3 个来自「24小时飙升」，至少 2 个来自「近3天爆款」，至少 2 个来自「本周热点」或「长期热点」
- 类型尽量分散，不要两个选题做同一件事
- 做法要贴合平台：${PLATFORM_STYLE[s]}
- 每个选题输出：
  - title：选题标题，像一个能直接发在${name}上的视频标题，≤24 字
  - horizon：24小时飙升 / 近3天爆款 / 本周热点 / 长期热点
  - why：这个题材为什么能火，引用数据（播放、点赞、增速、持续天数），≤50 字，不要出现方括号编号
  - how：具体怎么做（形式、时长、用什么工具、关键镜头 / 节奏 / 文案），≤60 字
  - refs：参考素材编号数组，如 ["A1","C3"]

输出格式：{"picks":[{"title":"","horizon":"","why":"","how":"","refs":[]}]}

${blocks}`, { maxTokens: 6000 });
  return (r.picks || []).slice(0, 10);
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

export async function digest(now = Date.now()) {
  const errors = [];
  const since = now - DAY;
  const all1 = loadWindow(1.25, now);
  const all7 = loadWindow(7, now);
  const all30 = loadWindow(30, now);
  const withVel = (x) => ({ ...x, vel: velocity(x, now).perHour });

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
  const videos = Object.fromEntries(['douyin', 'bilibili'].map((s) => [s, hits.filter((x) => x.src === s).slice(0, 6).map((x) => slim(x, now))]));

  // ---- 高赞榜：近 30 天，只看重点类型（AI音乐 / MV / 歌手艺人 / 鬼畜 / 影视 / 换人），抖音按点赞、B站按播放 ----
  const TOPN = { douyin: 8, bilibili: 5 };
  const topCand = ['douyin', 'bilibili'].flatMap((s) => all30
    .filter((x) => isFocus(x) && x.src === s && x.pubAt > now - 30 * DAY)
    .sort((a, b) => (b.heat || 0) - (a.heat || 0)).slice(0, 25).map(withVel));
  const tops = await step('高赞榜', () => pickTop(topCand, now), () => [], errors);
  const topHits = tops.map((t) => topCand[+t.i] && { ...topCand[+t.i], ai: { ...topCand[+t.i].ai, hook: t.hook || topCand[+t.i].ai.hook, tip: t.tip || topCand[+t.i].ai.tip } })
    .filter(Boolean).filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i);
  for (const s of ['douyin', 'bilibili']) {
    let have = topHits.filter((x) => x.src === s).length;
    for (const x of topCand.filter((c) => c.src === s && !topHits.some((h) => h.id === c.id))) { if (have >= TOPN[s]) break; topHits.push(x); have++; }
  }
  for (const s of ['douyin', 'bilibili']) {
    videos[`${s}Top`] = topHits.filter((x) => x.src === s).sort((a, b) => (b.heat || 0) - (a.heat || 0)).slice(0, TOPN[s]).map((x) => slim(x, now));
  }

  // ---- 选题素材：四个时间段 ----
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

  // 抖音、B站各准备一份素材：只放本平台的作品 / 热搜 / 热歌，微博热梗两边都可以借势
  function platformBlocks(s) {
    const refs = {};
    const line = (code, x) => {
      refs[code] = x;
      const what = x.cat === 'video' ? `${typeOf(x)}｜${x.title}｜${stats(x)}${x.vel ? `｜每小时+${fmtNum(x.vel)}` : ''}${x.ai.hook ? `｜爆点：${x.ai.hook}` : ''}`
        : x.cat === 'trend' ? `${PLATFORM[x.src]}热搜｜${x.kind || x.ai?.tag || ''}｜${x.title}${x.daysSeen > 1 ? `｜在榜${x.daysSeen}天` : ''}${x.kind && x.m?.fetched ? `｜参与视频 ${x.m.aiVideos || 0}/${x.m.fetched} 条是 AI 做的` : ''}｜${x.ai?.why || ''}`
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
    const blocks = [
      `【24小时飙升】\n${[...h24.map((x, i) => line(`A${i}`, x)), ...pm.map((x, i) => line(`T${i}`, x)), ...pc.map((x, i) => line(`K${i}`, x))].join('\n') || '（无）'}`,
      `【近3天爆款】\n${h3.map((x, i) => line(`B${i}`, x)).join('\n') || '（无）'}`,
      `【本周热点】\n${[...h7.map((x, i) => line(`C${i}`, x)), ...lt.map((x, i) => line(`L${i}`, x))].join('\n') || '（无）'}${tags7.length ? `\n抖音 AIGC 话题标签（7天内视频数/总赞）：${tags7.map(([t, e]) => `#${t} ${e.n}条/${fmtNum(e.likes)}赞`).join('，')}` : ''}`,
      `【长期热点（30天）】\n${h30.map((x, i) => line(`D${i}`, x)).join('\n') || '（无）'}${typeCount.length ? `\n30 天 AIGC 作品类型分布：${typeCount.map(([t, n]) => `${t} ${n}`).join('，')}` : ''}`,
      songs.length ? `【可借势的热歌】\n${songs.map((x, i) => line(`S${i}`, x)).join('\n')}` : '',
      trendKw.length ? `【近期新冒出的 AIGC 玩法】\n${trendKw.map((t) => `${t.kw}：${t.why || ''}（${Math.max(1, Math.round((now - t.first) / DAY))} 天内出现 ${t.n} 次）`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    console.log(`${PLATFORM[s]}选题素材：24h ${h24.length}+热梗 ${pm.length}+挑战 ${pc.length}，3天 ${h3.length}，本周 ${h7.length}+长热搜 ${lt.length}，30天 ${h30.length}，热歌 ${songs.length}`);
    return { blocks, refs };
  }
  const pb = { douyin: platformBlocks('douyin'), bilibili: platformBlocks('bilibili') };

  // ---- AI 圈大事件 ----
  const news = all1
    .filter((x) => x.cat === 'news' && (x.pubAt || x.firstSeen) >= now - 30 * HOUR && x.board !== 'HF 热门模型')
    .sort((a, b) => (b.pubAt || b.firstSeen) - (a.pubAt || a.firstSeen))
    .slice(0, 140);
  const hf = all1
    .filter((x) => x.board === 'HF 热门模型' && x.lastSeen >= since && (!x.pubAt || x.pubAt > now - 21 * DAY))
    .sort((a, b) => (a.rank || 99) - (b.rank || 99))
    .slice(0, 12);

  const [dyPicks, blPicks, events] = await Promise.all([
    step('抖音选题', () => makePicks(pb.douyin.blocks, 'douyin'), () => [], errors),
    step('B站选题', () => makePicks(pb.bilibili.blocks, 'bilibili'), () => [], errors),
    step('资讯归并', () => mergeNews(news, hf, now), () => news.filter((x) => isAI(x.title)).slice(0, 12).map((x) => ({ title: x.title, summary: '', ids: [news.indexOf(x)] })), errors),
  ]);
  const refOf = (id) => (String(id).startsWith('H') ? hf[+String(id).slice(1)] : news[+id]);
  const newsOut = events.map((e) => ({
    title: e.title, summary: e.summary, kind: e.kind, level: e.level,
    refs: (e.ids || []).map(refOf).filter(Boolean).map((x) => ({ id: x.id, title: x.title, url: x.url, src: x.src })),
  })).filter((e) => e.refs.length);

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

  const out = {
    date: bjDate(now), generatedAt: now, window: [since, now],
    ai: hasKey() ? DEEPSEEK_MODEL : null, errors,
    // 今日选题：抖音 10 个、B站 10 个
    picks: Object.fromEntries([['douyin', dyPicks], ['bilibili', blPicks]].map(([s, list]) => [s, list.map((p) => ({
      title: p.title, horizon: p.horizon, why: p.why, how: p.how,
      refs: (p.refs || []).map((c) => pb[s].refs[c]).filter(Boolean).map((x) => ({ kind: x.cat, title: x.cat === 'music' ? `${x.title} - ${x.author}` : x.title, url: x.url })),
    }))])),
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

  // 爆款的精修点评、事件归属写回当天数据，网页上也能看到
  const file = dayPath(now);
  const day = readJSON(file);
  if (day) {
    const put = (id, ai) => { if (day.items[id]) day.items[id].ai = { ...day.items[id].ai, ...ai }; };
    hits.forEach((v) => put(v.id, { hook: v.ai.hook, tip: v.ai.tip, top: 1 }));
    newsOut.forEach((e) => e.refs.forEach((r) => put(r.id, { event: e.title, kind: e.kind, level: e.level })));
    writeJSON(file, day);
  }
  console.log(`日报完成：选题 抖音 ${out.picks.douyin.length} / B站 ${out.picks.bilibili.length}，高赞榜 抖音 ${videos.douyinTop?.length || 0} / B站 ${videos.bilibiliTop?.length || 0}，抖音挑战 ${out.challenges.length}，爆款 抖音 ${videos.douyin.length} / B站 ${videos.bilibili.length}，热梗 ${out.memes.length}，事件 ${newsOut.length}${errors.length ? `；AI 出错 ${errors.length} 处` : ''}`);
  return out;
}

if (isMain(import.meta.url)) {
  loadEnv();
  const what = process.argv[2] || 'all';
  (async () => {
    if (what === 'annotate' || what === 'all') await annotate();
    if (what === 'digest' || what === 'all') await digest();
  })().catch((e) => { console.error(e); process.exit(1); });
}
