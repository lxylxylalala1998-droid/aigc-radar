// 扎堆同款：同一个时间段里，很多不同作者在做的同一个题材 / 模板（比如一堆人拿《Uptown Funk》做 AI 换人演唱）
//   从标题、话题标签、BGM 里找「大家共有的词」：书名号里的歌名 / IP、英文歌名、主题标签、同一首 BGM、标题里反复出现的中文短语
//   同一个词至少 MIN_AUTHORS 位不同作者用过才算（一个人自己更新的系列不算）；覆盖同一批作品的几个词合并成一个题材
//   排序：每位作者最火那条的热度加起来（人多、又出了爆款的排前面）
//   名字和玩法说明由 AI 写（annotate 里按题材缓存，见 curate.js nameClusters），AI 判断是碰巧撞词的不展示
import path from 'node:path';
import { DATA, readJSON } from './util.js';
import { WEB_VIDEO_LIMIT } from './config.js';
import { loadWindow, slim, labelOk } from './rank.js';

const DAY = 864e5;
export const MIN_AUTHORS = 3;
const MAX_CLUSTERS = 30;
export const CLUSTER_FILE = path.join(DATA, 'clusters.json'); // AI 写的题材名 / 说明，按「平台|题材键」缓存

// 网页某个时间窗口里某个平台展示的作品：和 build.js windowData 的挑法一致（近 31 天发布、带官方 AI 标，24 小时按增速、其余按热度，取前 WEB_VIDEO_LIMIT 条）
// AI 标注（给题材起名）、封面续期都按这个算，保证和网页上看到的是同一批
export function webVideos(days, now, src) {
  return loadWindow(days, now)
    .filter((x) => x.cat === 'video' && x.src === src && !x.gone && x.pubAt >= now - 31 * DAY && x.ai?.type !== '非AIGC' && labelOk(x))
    .map((x) => slim(x, now))
    .sort(days === 1 ? (a, b) => (b.vel || 0) - (a.vel || 0) : (a, b) => (b.heat || 0) - (a.heat || 0))
    .slice(0, WEB_VIDEO_LIMIT);
}

// 网页用：只展示 AI 看过、确认是「很多人在做同一种东西」的题材，带上 AI 起的名字和说明
export function withClusterAI(list, src, cache = readJSON(CLUSTER_FILE, {})) {
  return list.map((c) => ({ c, ai: cache[`${src}|${c.key}`] })).filter(({ ai }) => ai?.ok)
    .map(({ c, ai }) => ({ ...c, name: ai.name || c.label, what: ai.what, why: ai.why, how: ai.how }));
}

// 不算题材的词：AI 工具名、泛词、集数
const EN_STOP = new Set(['ai', 'aigc', 'mv', 'dj', 'the', 'and', 'you', 'for', 'with', 'from', 'this', 'that', 'my', 'me', 'we', 'is', 'are', 'of', 'to', 'in', 'on', 'it', 'pt', 'ep', 'vs', 'cp', 'pv', 'ost', 'bgm', 'cover', 'remix', 'live', 'video', 'music', 'official', 'version', 'full', 'part', 'new', 'hd', '4k', '8k',
  'seedance', 'oiioii', 'libtv', 'kling', 'vidu', 'sora', 'veo', 'runway', 'midjourney', 'suno', 'udio', 'hailuo', 'jimeng', 'doubao', 'pixverse', 'pika', 'deepseek', 'chatgpt', 'gpt', 'gemini', 'nano', 'banana', 'flux', 'comfyui', 'capcut', 'tiktok', 'douyin', 'bilibili', 'updream', 'dou', 'vlog', 'meme', 'pov', 'emo']);
const CN_STOP = /生成|制作|视频|作品|合集|全集|大结局|一口气|看完|本视频|声明|内容由|创作|原创|制作人|大赛|短剧|漫剧|动画|特效|模板|一键|同款|教程|推荐|热门|人工智能|即梦|可灵|豆包|海螺|剪映|集|第|期|篇|季|版本|系列|更新|求|关注|点赞|评论|转发|收藏|粉丝|宝宝|大家|我们|你们|他们|自己|真的|就是|这个|那个|没有|还是|可以|不是|知道|时候|现在|已经|一下|起来|出来|一起|什么|怎么|为什么|如果|一个|这样|那样|原来|竟然|居然|终于|今天|明天|昨天|一定|不要|不会|可能|应该|还有|所有|如何|之后|以后|之前|最后|开始|全网|网友|抖音|b站|哔哩/;
// 文案套话（「谢谢大家喜欢」「全片由 xx 制作」「本作品使用 LibTV」「建议收藏」「纯属虚构」「升级后可展开」……）
const CN_BOILER = /喜欢|全片|使用|收藏|虚构|升级|展开|引导|灵感|来源|纯享|纯属|娱乐|改编|经历|仅供|请勿|模仿|免责|观看|分享|完整|一天|告诉|以为|从来|不良|过低|希望|感谢|谢谢|支持|评论区|主页|链接|同名|搜索|出品|导演|编剧|配音|剪辑|后期|字幕|建议|精选|超长|循环|歌单|分钟|秒钟|小时/;
// 中文短语不能以虚词开头或结尾（「的照片」「有人在」「都以为」是碰巧挨在一起的字，「以前的小孩」才是完整的词）
const CN_EDGE = /^[的了是在有我你他她它这那就都也还和与被把给让从对向跟及或而但却只又再很太最更才已吗呢吧啊呀哦嘛么个们着过地得之其]|[的了是在有我你他她它这那就都也还和与被把给让从对向跟及或而但却只又再很太最更才已吗呢吧啊呀哦嘛么个们着过地得之其没不]$/;
const CN_CUT = new RegExp(`${CN_STOP.source}|${CN_BOILER.source}|展示|全部|一次`, 'g');
const BGM_STOP = /模板|原声|创作的|热门音乐|抖音音乐|背景音乐|纯音乐/;

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// 一条作品带出来的候选词：[{ k: 归一化的词, label: 原样, kind }]
function keysOf(x, genericTags) {
  const out = [];
  const title = /^（无文案）$/.test(x.title || '') ? '' : String(x.title || '');
  const body = title.replace(/【[^】]*】/g, ' ').replace(/#[^#\s]+/g, ' ');
  for (const m of body.matchAll(/《([^》]{2,24})》/g)) out.push({ k: norm(m[1]), label: `《${m[1].trim()}》`, kind: 'q' });
  for (const m of body.replace(/《|》/g, ' ').matchAll(/[a-z][a-z0-9'’]*(?:[ \-&][a-z][a-z0-9'’]*){0,3}/gi)) {
    const words = m[0].toLowerCase().split(/[ \-&]+/).filter(Boolean);
    const kept = words.filter((w) => !EN_STOP.has(w));
    if (!kept.length || (words.length === 1 && kept[0].length < 3)) continue;
    out.push({ k: norm(kept.join(' ')), label: m[0].trim(), kind: 'en' });
  }
  for (const t of String(x.tags || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (genericTags.has(t.toLowerCase())) continue;
    const k = norm(t);
    if (k.length < 2 || EN_STOP.has(k) || CN_STOP.test(t.replace(/[a-z0-9]/gi, '')) && !/[a-z]{3,}/i.test(t)) continue;
    out.push({ k, label: `#${t}`, kind: 'tag' });
  }
  const bgm = String(x.m?.bgm || '').split(' - ')[0].trim();
  if (bgm && !BGM_STOP.test(bgm)) out.push({ k: `bgm:${norm(bgm)}`, label: `BGM《${bgm}》`, kind: 'bgm' });
  // 中文短语：标题里 3~6 个字的片段（去掉活动标签 / 话题）。泛词、套话先整个切掉再取片段，免得留下「级后可展」这种半截词
  for (const seg of body.replace(/[^一-龥]+/g, ' ').replace(CN_CUT, ' ').split(' ')) {
    for (let len = 3; len <= 6; len++) {
      for (let i = 0; i + len <= seg.length; i++) {
        const p = seg.slice(i, i + len);
        if (!CN_EDGE.test(p) && !/(.)\1\1/.test(p)) out.push({ k: p, label: p, kind: 'cn' });
      }
    }
  }
  // 同一条作品里同一个词只算一次
  const seen = new Set();
  return out.filter((o) => o.k && !seen.has(o.k) && seen.add(o.k));
}

const RANK = { q: 0, en: 1, tag: 2, cn: 3, bgm: 4 };

// 其他关键词：去掉和题材名 / 已经列出的词有 3 个字以上重叠的残字（「以前的小孩」在，就不要「以前的小」「前的小孩」），最多 4 个
function cleanAlias(labels, label) {
  const bare = (s) => norm(s.replace(/^#|^BGM/, ''));
  const overlap = (a, b) => { for (let i = 0; i + 3 <= a.length; i++) if (b.includes(a.slice(i, i + 3))) return true; return false; };
  const all = [...new Set(labels)].sort((a, b) => bare(b).length - bare(a).length);
  return all.filter((l, i) => l !== label && !overlap(bare(l), bare(label)) && !all.slice(0, i).some((k) => overlap(bare(l), bare(k)))).slice(0, 4);
}

// videos：同一平台、同一时间窗口里网页会展示的作品（build.js windowData 的 videos 按平台筛出来的）
export function findClusters(videos, now = Date.now()) {
  if (videos.length < MIN_AUTHORS) return [];
  // 窗口里 2 成以上作品都带的标签算通用标签（#ai创作 #抖音ai创作 这类）
  const tagN = new Map();
  for (const x of videos) for (const t of new Set(String(x.tags || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))) tagN.set(t, (tagN.get(t) || 0) + 1);
  const genericTags = new Set([...tagN].filter(([, n]) => n >= Math.max(5, videos.length * 0.2)).map(([t]) => t));

  const byKey = new Map(); // k → { labels: Map(label → { n, kind }), vids: Set }
  for (const x of videos) {
    for (const o of keysOf(x, genericTags)) {
      const e = byKey.get(o.k) || { k: o.k, labels: new Map(), vids: new Set() };
      const l = e.labels.get(o.label) || { n: 0, kind: o.kind };
      l.n++;
      e.labels.set(o.label, l);
      e.vids.add(x);
      byKey.set(o.k, e);
    }
  }
  const authorsOf = (vids) => new Set([...vids].map((x) => x.author || x.id));
  // 每位作者只算最火的一条，加起来当题材热度
  const score = (vids) => {
    const best = new Map();
    for (const x of vids) { const a = x.author || x.id; best.set(a, Math.max(best.get(a) || 0, x.heat || 0)); }
    return [...best.values()].reduce((s, v) => s + v, 0);
  };
  // 同一个词出现在超过 4 成作品里，多半是泛词（「激情」「当你」这种碰巧到处都有的不会有这么多）
  const cands = [...byKey.values()]
    .map((e) => ({ ...e, authors: authorsOf(e.vids).size, kind: [...e.labels.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind])[0].kind }))
    .filter((e) => e.authors >= MIN_AUTHORS && e.vids.size <= videos.length * 0.4)
    .map((e) => ({ ...e, score: score(e.vids) }))
    .sort((a, b) => b.score - a.score || RANK[a.kind] - RANK[b.kind] || b.k.length - a.k.length);

  // 合并：两个词覆盖的作品有 6 成以上重合，算同一个题材
  const clusters = [];
  for (const e of cands) {
    const c = clusters.find((g) => { let n = 0; for (const x of e.vids) if (g.vids.has(x)) n++; return n / Math.min(e.vids.size, g.vids.size) >= 0.6; });
    if (c) { c.keys.push(e); for (const x of e.vids) c.vids.add(x); }
    else clusters.push({ keys: [e], vids: new Set(e.vids) });
  }

  return clusters.map((c) => {
    const vids = [...c.vids].sort((a, b) => (b.heat || 0) - (a.heat || 0));
    // 题材名：覆盖了一半以上作品的词里，书名号 / 英文歌名 > 标签 > 中文短语 > BGM；同类里作者数差不多（7 成以上）的取字数长的
    //   （AI 会另起名字，这里只是 AI 还没看过时的临时名字，也是缓存的键）
    const wide = c.keys.filter((k) => k.vids.size >= c.vids.size * 0.5);
    const pool = wide.length ? wide : c.keys;
    const best = Math.min(...pool.map((k) => RANK[k.kind]));
    const same = pool.filter((k) => RANK[k.kind] === best);
    const top = Math.max(...same.map((k) => k.authors));
    const main = same.filter((k) => k.authors >= top * 0.7).sort((a, b) => b.k.length - a.k.length || b.authors - a.authors)[0];
    const label = [...main.labels].sort((a, b) => b[1].n - a[1].n)[0][0];
    const pubs = vids.map((x) => x.pubAt || 0).filter(Boolean);
    const first = Math.min(...pubs), last = Math.max(...pubs);
    const new3 = vids.filter((x) => x.pubAt > now - 3 * DAY).length;
    const authors = authorsOf(vids).size;
    // 时效：最早一条不超过 3 天 = 刚起势；近 3 天没有新作品，或者已经很多人做了一周以上 = 已饱和；其余 = 高峰期
    const stage = now - first <= 3 * DAY ? '刚起势' : !new3 || (authors >= 15 && now - first > 7 * DAY) ? '已饱和' : '高峰期';
    return {
      key: main.k, label, alias: cleanAlias(c.keys.map((k) => [...k.labels.keys()][0]), label),
      n: vids.length, authors, heat: score(vids), first, last, new3, stage,
      ids: vids.map((x) => x.id),
    };
  }).filter((c) => c.authors >= MIN_AUTHORS).sort((a, b) => b.heat - a.heat).slice(0, MAX_CLUSTERS);
}
