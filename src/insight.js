// 给博主看的数据画像：低粉爆款、互动率标签、爆款用的工具、爆款用的 BGM
// 全部由程序直接算，不花 AI 的钱
import { AI_TOOLS } from './config.js';
import { DAY } from './util.js';

// 低粉爆款：作者粉丝很少，作品却爆了——说明靠的是内容本身，小号也能做
//   AIGC 爆款里小号本来就多，门槛定在大约 1 成作品能标上，才有区分度：
//   抖音：粉丝不到 5 万、点赞过 10 万且是粉丝数的 2 倍以上；B站：粉丝不到 3 万、播放过 30 万且是粉丝数的 20 倍以上
//   品牌官方号不算：粉丝少但播放高多半是投流推广，不是内容本身爆
export function lowFan(x) {
  const f = x.m?.fans;
  if (!f || /官方|旗舰店|品牌/.test(x.author || '')) return false;
  if (x.src === 'douyin') return f < 5e4 && (x.heat || 0) >= 1e5 && x.heat >= 2 * f;
  if (x.src === 'bilibili') return f < 3e4 && (x.heat || 0) >= 3e5 && x.heat >= 20 * f;
  return false;
}

// 互动率标签：某项比例排进同平台、数据够大的作品里的前 10% 才标（分布很偏，用「中位数几倍」会标得太多）
const RATIOS = {
  douyin: [['分享率高', (m) => m.share / m.like], ['收藏率高', (m) => m.fav / m.like], ['评论多', (m) => m.comment / m.like]],
  bilibili: [['点赞率高', (m) => m.like / m.play], ['收藏率高', (m) => m.fav / m.play], ['弹幕多', (m) => m.danmaku / m.play]],
};
// 数据太小的不算比例（几百个赞的分享率没有参考意义）
const BIG = { douyin: (m) => (m.like || 0) >= 1e4, bilibili: (m) => (m.play || 0) >= 5e4 };
// 每个标签对博主意味着什么（网页悬停、邮件图例用）
export const PT_WHY = {
  低粉爆款: '作者粉丝很少（抖音不到 5 万 / B站不到 3 万）也爆了：靠内容本身，小号也能做',
  分享率高: '分享 / 点赞远高于同类：社交货币，大家想转给朋友，适合情绪共鸣、反差、梗',
  收藏率高: '收藏远高于同类：干货或想反复看，适合教程、合集、高质量画面',
  评论多: '评论远高于同类：有争议或强互动，适合抛问题、站队、求续集',
  点赞率高: '点赞 / 播放远高于同类：完成度和情绪都到位',
  弹幕多: '弹幕远高于同类：有名场面、梗密度高，适合鬼畜、二创',
};

export function ratioMedians(list) {
  const med = {};
  for (const [s, rs] of Object.entries(RATIOS)) {
    const pool = list.filter((x) => x.cat === 'video' && x.src === s && x.m && BIG[s](x.m));
    med[s] = rs.map(([, f]) => {
      const v = pool.map((x) => f(x.m)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
      return v.length >= 20 ? v[Math.floor(v.length * 0.9)] : null; // 第 90 百分位
    });
  }
  return med;
}

export function portrait(x, med) {
  const out = [];
  if (lowFan(x)) out.push('低粉爆款');
  const rs = RATIOS[x.src];
  if (!rs || !x.m || !BIG[x.src](x.m)) return out;
  rs.forEach(([k, f], i) => {
    const m = med[x.src]?.[i];
    const v = f(x.m);
    if (m && Number.isFinite(v) && v >= m) out.push(k);
  });
  return out;
}

// B站粉丝数从缓存补到作品上（抖音的粉丝数采集时就带了）
export function withFans(x, biliFans = {}) {
  if (x.src !== 'bilibili' || x.m?.fans || !x.m?.mid || biliFans[x.m.mid] == null) return x;
  return { ...x, m: { ...x.m, fans: biliFans[x.m.mid] } };
}

// 作品标题 / 话题 / 简介里提到的 AI 工具
export function toolsOf(x) {
  const t = `${x.title || ''} ${x.tags || ''} ${x.desc || ''}`;
  return AI_TOOLS.filter(([, re]) => re.test(t)).map(([n]) => n);
}

const brief = (x) => ({ title: x.title, url: x.url, src: x.src, heat: x.heat });

// 爆款工具榜：按发布时间分本期（近 days 天）和上期（再往前 days 天），统计提到每个工具的 AIGC 作品数
//   compare=false 时不算上期（比如 30 天窗口，数据只留 40 天，上期不完整）
export function toolRank(works, now, days, { compare = true } = {}) {
  const m = new Map();
  for (const x of works) {
    const age = now - (x.pubAt || 0);
    if (!(age >= 0 && age < (compare ? 2 : 1) * days * DAY)) continue;
    const cur = age < days * DAY;
    for (const t of toolsOf(x)) {
      const e = m.get(t) || { name: t, n: 0, prev: 0, douyin: 0, bilibili: 0, dy: null, bl: null };
      if (cur) {
        e.n++;
        e[x.src] = (e[x.src] || 0) + 1;
        const k = x.src === 'douyin' ? 'dy' : 'bl';
        if (!e[k] || (x.heat || 0) > e[k].heat) e[k] = brief(x);
      } else e.prev++;
      m.set(t, e);
    }
  }
  // 代表作：抖音点赞最高的那条过 1 万赞就用它，否则用 B站播放最高的（两个平台的数字口径不同，不混比）
  return [...m.values()].filter((e) => e.n).sort((a, b) => b.n - a.n || b.prev - a.prev)
    .map(({ dy, bl, ...e }) => ({ ...e, best: dy && (dy.heat >= 1e4 || !bl) ? dy : bl, prev: compare ? e.prev : undefined }));
}

// 爆款 BGM 榜：抖音 AIGC 作品用得最多的配乐（用原声的不算）
export function bgmRank(works) {
  const m = new Map();
  for (const x of works) {
    // 原声、剪映模板配乐不算（旧数据里还存着这些）
    if (x.src !== 'douyin' || !x.m?.bgm || /原声|创作的|模板音乐|模板创作人|教程在主页|^@/.test(x.m.bgm)) continue;
    const e = m.get(x.m.bgm) || { title: x.m.bgm, n: 0, likes: 0, best: null };
    e.n++;
    e.likes += x.heat || 0;
    if (!e.best || x.heat > e.best.heat) e.best = brief(x);
    m.set(x.m.bgm, e);
  }
  // 只用过一次的，要单条够爆（10 万赞以上）才算
  return [...m.values()].filter((e) => e.n >= 2 || e.likes >= 1e5).sort((a, b) => b.n - a.n || b.likes - a.likes);
}
