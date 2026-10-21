// AI 点评，分两步：
//   annotate —— 每次采集后跑：给新出现的视频判断是否 AIGC + 分类，给新上榜的热搜打「热梗 / AI相关 / 可借势」标签
//   digest   —— 每天早上跑：资讯归并成事件、挑爆款并点评、出「今日选题」和推荐歌，产出 data/digests/YYYY-MM-DD.json
import path from 'node:path';
import { DATA, HOUR, DAY, bjDate, readJSON, writeJSON, loadEnv, isMain, isAI, fmtNum } from './util.js';
import { DEEPSEEK_BASE, DEEPSEEK_MODEL } from './config.js';
import { loadWindow, velocity, slim, PLATFORM } from './rank.js';

const SYSTEM = `你是一位资深的 AIGC 自媒体选题编辑，服务对象是做 AI 相关内容的 B站 / 抖音 / 小红书 / 视频号博主。
你的任务是从海量热点里帮他们快速判断：今天 AI 圈发生了什么、哪些 AI 作品在爆、哪些热梗能借势、能做什么内容。
要求：判断准确、语言精炼口语化、不说空话套话。只输出 JSON，不要任何其它文字。`;

const hasKey = () => !!process.env.DEEPSEEK_API_KEY;

async function ask(prompt, { maxTokens = 6000 } = {}) {
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
      const j = await res.json();
      if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${j?.error?.message || JSON.stringify(j).slice(0, 200)}`);
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

// AI 写说明时爱先复述一遍词条，裁掉
const dropEcho = (note = '', title = '') => (note.startsWith(title) ? note.slice(title.length).replace(/^[，,：:；;。\s]+/, '') : note);

const hoursAgo = (ts, now) => (ts ? Math.max(0, Math.round((now - ts) / HOUR)) : '?');
const dayPath = (now) => path.join(DATA, 'days', `${bjDate(now)}.json`);

// ====================== annotate ======================
const VIDEO_TYPES = 'AI音乐（AI 作曲 / AI 翻唱 / AI 歌手）、AI MV、AI动画、AI剧情（短剧、漫剧、剧情短片）、AI短片（概念片、预告片、特效大片）、AI整活（鬼畜、恶搞、梗视频）';

async function classifyVideos(list, now) {
  const lines = list.map((x, i) => [
    i, PLATFORM[x.src], x.m?.part || '', x.title, x.tags ? `标签:${x.tags}` : '', x.desc ? `简介:${x.desc.slice(0, 50)}` : '',
    `播放${fmtNum(x.heat)}`, `发布${hoursAgo(x.pubAt, now)}h`,
  ].filter(Boolean).join('|'));
  const r = await ask(`下面是 B站 / YouTube 上近期可能跟 AI 有关的视频（编号|平台|分区|标题|标签|简介|播放|发布时长）。
关键词搜索会混进很多不是 AI 生成的视频（讲 AI 的新闻、真人实拍里提到 AI、标题党），请严格判断：
1. 「内容本身主要由 AI 生成 / AI 参与创作」的 AIGC 作品，给出类型：${VIDEO_TYPES}
2. AI 工具教程、模型评测、AI 新闻解读这类「讲 AI 的」视频，类型为「AI教程测评」
3. 跟 AI 生成无关的视频不要输出

输出格式：{"items":[{"i":编号,"type":"AI音乐"}]}

视频：
${lines.join('\n')}`, { maxTokens: 4000 });
  return r.items || [];
}

async function tagTrends(list) {
  const lines = list.map((x, i) => `${i}|${PLATFORM[x.src]}|${x.rank || ''}|${x.title}${x.label ? `|${x.label}` : ''}`);
  const r = await ask(`下面是微博、抖音、B站热搜上新出现的词条（编号|平台|排名|词条|标签）。
请找出对 AIGC 自媒体有用的词条，分三种：
- 热梗：网络流行梗、名场面、魔性台词 / BGM、新造词、全网模仿的段子，适合用 AI 做二创 / 整活。这一类最重要，尽量找全
- AI相关：词条本身就在说 AI（大模型、AI 产品、AI 生成内容、AI 争议）或机器人 / 具身智能。普通数码产品（手机、电脑评测）不算
- 可借势：热度很高的影视剧、综艺、游戏、体育、节日事件，适合用 AI 做同人、恶搞、预告片、MV 来蹭热度
（纯政治、外交、灾难、刑事、负面社会新闻一律不要；不同平台说同一件事的只选排名最高的那条）
每个给出 note：先用半句话说清楚这是什么梗 / 什么事（不要重复词条原文），再说可以怎么用 AI 来做，合计 ≤40 字。
没用的词条不要输出。

输出格式：{"items":[{"i":编号,"tag":"热梗","note":""}]}

词条：
${lines.join('\n')}`, { maxTokens: 3000 });
  return r.items || [];
}

const TYPE_RE = [
  ['AI MV', /MV/i], ['AI音乐', /音乐|翻唱|歌|song|music|cover|Suno|Udio/i], ['AI动画', /动画|animation|anime/i],
  ['AI剧情', /短剧|漫剧|剧情|剧场/], ['AI短片', /短片|film|trailer|预告|Sora|Veo|可灵|Kling|即梦|Seedance/i],
];
const guessType = (x) => (TYPE_RE.find(([, re]) => re.test(x.title)) || ['未分类'])[0];

export async function annotate(now = Date.now()) {
  const file = dayPath(now);
  const day = readJSON(file);
  if (!day) { console.log('今天还没有数据，跳过标注'); return []; }
  const errors = [];
  const items = Object.values(day.items);

  const videos = items
    .filter((x) => x.cat === 'video' && !x.ai?.checked && x.pubAt > now - 7 * DAY)
    .map((x) => ({ x, vel: velocity(x, now).perHour }))
    .sort((a, b) => b.vel - a.vel)
    .slice(0, 450)
    .map((v) => v.x);
  const trends = items
    .filter((x) => x.cat === 'trend' && !x.ai?.checked && x.lastSeen >= now - 2 * HOUR)
    .sort((a, b) => (a.rank || 99) - (b.rank || 99));
  console.log(`标注：新视频 ${videos.length}，新热搜 ${trends.length}；${hasKey() ? DEEPSEEK_MODEL : '未配置 Key，用规则兜底'}`);

  const batches = [];
  for (let i = 0; i < videos.length; i += 150) batches.push(videos.slice(i, i + 150));
  const [vres, tres] = await Promise.all([
    Promise.all(batches.map((b, k) => step(`视频分类 ${k + 1}/${batches.length}`,
      async () => ({ ok: true, items: await classifyVideos(b, now) }),
      () => ({ ok: false, items: b.map((x, i) => (isAI(`${x.title} ${x.tags || ''}`) ? { i, type: guessType(x) } : null)).filter(Boolean) }),
      errors))),
    trends.length
      ? step('热搜打标', async () => ({ ok: true, items: await tagTrends(trends) }),
        () => ({ ok: false, items: trends.map((x, i) => (isAI(x.title) ? { i, tag: 'AI相关', note: '' } : null)).filter(Boolean) }), errors)
      : { ok: true, items: [] },
  ]);

  // 写回。AI 判断过的打 checked，下次不再重复送；规则兜底的不打，等 AI 恢复后再判
  batches.forEach((b, k) => {
    const r = vres[k];
    const type = new Map(r.items.map((x) => [+x.i, x.type]));
    b.forEach((x, i) => {
      const t = type.get(i);
      if (t || r.ok) day.items[x.id].ai = { ...x.ai, type: t || '非AIGC', ...(r.ok ? { checked: 1 } : {}) };
    });
  });
  const tag = new Map(tres.items.map((x) => [+x.i, x]));
  trends.forEach((x, i) => {
    const t = tag.get(i);
    if (t || tres.ok) day.items[x.id].ai = { ...x.ai, ...(t ? { tag: t.tag, note: dropEcho(t.note, x.title) } : {}), ...(tres.ok ? { checked: 1 } : {}) };
  });
  writeJSON(file, day);
  const n = Object.values(day.items);
  console.log(`  当天 AIGC 作品 ${n.filter((x) => x.ai?.type && !['非AIGC', 'AI教程测评'].includes(x.ai.type)).length}，有标签热搜 ${n.filter((x) => x.ai?.tag).length}`);
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

async function pickVideos(list, now) {
  const lines = list.map((x, i) => `${i}|${PLATFORM[x.src]}|${x.ai.type}|${x.title}|播放${fmtNum(x.heat)}|发布${hoursAgo(x.pubAt, now)}h|每小时+${fmtNum(x.vel)}`);
  const r = await ask(`下面是过去 24 小时增长最快的 AIGC 作品（编号|平台|类型|标题|播放|发布时长|每小时增长）。
挑出最多 10 个最值得 AI 自媒体参考的爆款（优先增长快、题材有代表性、可复制的；同一系列只选一个），
每个用一句话说它为什么火、有什么可以借鉴的（≤40 字）。

输出格式：{"top":[{"i":编号,"why":""}]}

${lines.join('\n')}`, { maxTokens: 2000 });
  return r.top || [];
}

async function makePicks({ events, topVideos, memes, music }) {
  const r = await ask(`你已经整理出今天的 AI 大事件、AIGC 爆款视频、可用热梗和热歌，如下。
请为 AIGC 自媒体博主给出「今日最值得做的 5 个选题」，要具体、可执行，五个选题尽量覆盖不同方向（资讯解读 / AI 作品创作 / 热梗二创 / AI 音乐等）：
- title：选题标题，像一个能直接用的视频标题，≤24 字
- why：为什么现在做（借什么势、热度如何），≤40 字，不要出现方括号编号
- how：建议怎么做（形式 + 推荐工具，比如「用 Suno 做 xx 风格改编 + 即梦生成 MV 画面」），≤50 字
- refs：参考的素材编号数组（用下面方括号里的编号，如 ["E1","V3"]）

另外从热歌里挑最多 5 首适合拿来做 AI 翻唱 / AI MV / 二创的歌，给出 i（M 编号）和 note（为什么适合 + 怎么做，≤30 字）。

输出格式：{"picks":[{"title":"","why":"","how":"","refs":[]}],"songs":[{"i":"M0","note":""}]}

【AI 大事件】
${events.map((e, i) => `[E${i}] ${e.title}：${e.summary}`).join('\n') || '（无）'}

【AIGC 爆款视频】
${topVideos.map((v, i) => `[V${i}] ${v.ai.type}｜${v.title}｜播放${fmtNum(v.heat)}｜${v.why || ''}`).join('\n') || '（无）'}

【热梗 / 可借势热搜】
${memes.map((t, i) => `[T${i}] ${t.ai.tag}｜${t.title}｜${t.ai.note || ''}`).join('\n') || '（无）'}

【热歌】
${music.map((m, i) => `[M${i}] ${m.board}#${m.rank}｜${m.title} - ${m.author}${m.label ? `｜${m.label}` : ''}`).join('\n')}`, { maxTokens: 3000 });
  return { picks: r.picks || [], songs: r.songs || [] };
}

export async function digest(now = Date.now()) {
  const errors = [];
  const all = loadWindow(1.25, now);
  const since = now - DAY;

  const news = all
    .filter((x) => x.cat === 'news' && (x.pubAt || x.firstSeen) >= now - 30 * HOUR && x.board !== 'HF 热门模型')
    .sort((a, b) => (b.pubAt || b.firstSeen) - (a.pubAt || a.firstSeen))
    .slice(0, 140);
  const hf = all
    .filter((x) => x.board === 'HF 热门模型' && x.lastSeen >= since && (!x.pubAt || x.pubAt > now - 21 * DAY))
    .sort((a, b) => (a.rank || 99) - (b.rank || 99))
    .slice(0, 12);
  const works = all
    .filter((x) => x.cat === 'video' && x.lastSeen >= since && x.pubAt > now - 7 * DAY && x.ai?.type && !['非AIGC', 'AI教程测评'].includes(x.ai.type))
    .map((x) => ({ ...x, vel: velocity(x, now).perHour }))
    .sort((a, b) => b.vel - a.vel);
  const TAG_ORDER = { 热梗: 0, AI相关: 1, 可借势: 2 };
  const memes = all
    .filter((x) => x.cat === 'trend' && x.lastSeen >= since && x.ai?.tag)
    .sort((a, b) => (TAG_ORDER[a.ai.tag] ?? 9) - (TAG_ORDER[b.ai.tag] ?? 9) || (a.peakRank || 99) - (b.peakRank || 99))
    .slice(0, 30);
  const latest = Math.max(0, ...all.filter((x) => x.cat === 'music').map((x) => x.lastSeen));
  const music = all.filter((x) => x.cat === 'music' && x.lastSeen >= latest - 6 * HOUR)
    .sort((a, b) => a.board.localeCompare(b.board) || (a.rank || 99) - (b.rank || 99));
  const musicForAI = music.filter((m) => /飙升|新歌|抖音|B站/.test(m.board) && (m.rank || 99) <= 10);
  console.log(`日报候选：资讯 ${news.length}，HF ${hf.length}，AIGC 作品 ${works.length}，热梗 ${memes.length}，热歌 ${music.length}`);

  const [events, top] = await Promise.all([
    step('资讯归并', () => mergeNews(news, hf, now), () => news.filter((x) => isAI(x.title)).slice(0, 12).map((x) => ({ title: x.title, summary: '', ids: [news.indexOf(x)] })), errors),
    step('爆款点评', () => pickVideos(works.slice(0, 40), now), () => works.slice(0, 10).map((x, i) => ({ i, why: '' })), errors),
  ]);

  const refOf = (id) => (String(id).startsWith('H') ? hf[+String(id).slice(1)] : news[+id]);
  const newsOut = events.map((e) => ({
    title: e.title, summary: e.summary, kind: e.kind, level: e.level,
    refs: (e.ids || []).map(refOf).filter(Boolean).map((x) => ({ id: x.id, title: x.title, url: x.url, src: x.src })),
  })).filter((e) => e.refs.length);

  const topVideos = top.map((t) => works[+t.i] && { ...works[+t.i], why: t.why }).filter(Boolean);
  const videos = [...topVideos, ...works.filter((x) => !topVideos.some((t) => t.id === x.id))].slice(0, 30)
    .map((x) => ({ ...slim(x, now), why: x.why }));

  const { picks, songs } = await step('今日选题', () => makePicks({ events: newsOut, topVideos, memes, music: musicForAI }), () => ({ picks: [], songs: [] }), errors);
  const refMap = (r) => {
    const m = String(r).match(/^([EVTM])(\d+)$/);
    if (!m) return null;
    const n = +m[2];
    if (m[1] === 'E') return newsOut[n] && { kind: 'news', title: newsOut[n].title, url: newsOut[n].refs[0]?.url };
    if (m[1] === 'V') return topVideos[n] && { kind: 'video', title: topVideos[n].title, url: topVideos[n].url };
    if (m[1] === 'T') return memes[n] && { kind: 'trend', title: memes[n].title, url: memes[n].url };
    return musicForAI[n] && { kind: 'music', title: `${musicForAI[n].title} - ${musicForAI[n].author}`, url: musicForAI[n].url };
  };

  const boards = {};
  for (const m of music) if ((boards[m.board] ||= []).length < 10) boards[m.board].push(slim(m, now));
  const trends = Object.fromEntries(['weibo', 'douyin', 'bilibili'].map((src) => [src, all
    .filter((x) => x.cat === 'trend' && x.src === src && x.lastSeen >= since)
    .sort((a, b) => (a.peakRank || 99) - (b.peakRank || 99) || (b.peakHeat || 0) - (a.peakHeat || 0))
    .slice(0, 20).map((x) => slim(x, now))]));

  const out = {
    date: bjDate(now), generatedAt: now, window: [since, now],
    ai: hasKey() ? DEEPSEEK_MODEL : null, errors,
    picks: picks.map((p) => ({ title: p.title, why: p.why, how: p.how, refs: (p.refs || []).map(refMap).filter(Boolean) })),
    news: newsOut,
    videos,
    memes: memes.map((x) => slim(x, now)),
    trends,
    music: {
      highlights: songs.map((s) => { const m = musicForAI[+String(s.i).replace('M', '')]; return m && { ...slim(m, now), note: s.note }; }).filter(Boolean),
      boards,
    },
  };
  writeJSON(path.join(DATA, 'digests', `${out.date}.json`), out, true);

  // 爆款点评、事件归属写回当天数据，网页上也能看到
  const file = dayPath(now);
  const day = readJSON(file);
  if (day) {
    const put = (id, ai) => { if (day.items[id]) day.items[id].ai = { ...day.items[id].ai, ...ai }; };
    topVideos.forEach((v) => put(v.id, { why: v.why }));
    newsOut.forEach((e) => e.refs.forEach((r) => put(r.id, { event: e.title, kind: e.kind, level: e.level })));
    writeJSON(file, day);
  }
  console.log(`日报完成：选题 ${out.picks.length}，事件 ${newsOut.length}，爆款 ${videos.length}，热梗 ${memes.length}，推荐歌 ${out.music.highlights.length}${errors.length ? `；AI 出错 ${errors.length} 处` : ''}`);
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
