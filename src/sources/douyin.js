import { http, clean, isAI, sleep } from '../util.js';
import { DOUYIN_MUSIC_CHARTS, MUSIC_TOP_N } from '../config.js';

const LABEL = { 1: '新', 2: '荐', 3: '热', 4: '首发', 5: '独家', 8: '辟谣', 16: '直播' };
// 抖音移动端接口（aweme.snssdk.com）对热点相关的请求不要求签名；搜索、话题页都要签名，拿不到
const API = 'https://aweme.snssdk.com/aweme/v1';

// 热榜词条的分类编号（sentence_tag）：1000~1004 是抖音标的「站内玩法」（挑战、玩法、BGM 文案梗），20000~20006 是「话题互动」
const KIND = (t) => (t >= 1000 && t <= 1004 ? '抖音挑战' : t >= 20000 && t <= 20006 ? '话题互动' : undefined);

// 抖音官方的 AI 标记，三种任一即算 AIGC：
//   作者声明：视频底部「作者声明：内容由 AI 生成」（risk_infos）
//   平台识别：平台判定含 AI 生成内容、禁止下载（download_info.fail_info.reason = aigc_forbidden）
//   AI 特效：AI 特效模板的角标（show_ai_corner）
export function aiLabel(a) {
  if (/AI\s*生成/.test(a.risk_infos?.content || '')) return '作者声明';
  if (a.video_control?.download_info?.fail_info?.reason === 'aigc_forbidden') return '平台识别';
  if (a.video_control?.show_ai_corner) return 'AI特效';
  return '';
}

export const hashtags = (a) => (a.text_extra || []).map((t) => t.hashtag_name).filter(Boolean);
// 文案去掉 #话题 和 @，留下正文当标题
export const plain = (desc = '') => clean(desc.replace(/#\S+/g, ' ').replace(/@\S+/g, ' ')) || clean(desc);

function videoItem(a, topic) {
  const st = a.statistics || {};
  const tags = hashtags(a);
  return {
    id: `dy:${a.aweme_id}`,
    cat: 'video', src: 'douyin', board: `热点·${topic}`,
    title: plain(a.desc).slice(0, 80) || '（无文案）',
    url: `https://www.douyin.com/video/${a.aweme_id}`,
    author: a.author?.nickname || '',
    // 封面链接带签名，约 14 天有效；同一条视频每次抓到都会刷新
    cover: a.video?.cover?.url_list?.[0] || a.video?.origin_cover?.url_list?.[0],
    heat: st.digg_count || 0, // 抖音隐藏播放数，热度用点赞
    pubAt: (a.create_time || 0) * 1000,
    tags: tags.slice(0, 8).join(','),
    desc: clean(a.desc).slice(0, 120),
    m: {
      like: st.digg_count || 0, comment: st.comment_count || 0, share: st.share_count || 0, fav: st.collect_count || 0,
      aiCorner: a.video_control?.show_ai_corner ? 1 : 0,
      aiLabel: aiLabel(a) || undefined, // 抖音官方 AI 标：只有带标的才算 AIGC
      bgm: a.music?.title ? clean(a.music.title) : undefined,
    },
  };
}

// 抖音热榜 + 每个热点话题下的视频：
//   热搜词条（带上话题下热门视频的文案，给 AI 分析「为什么上热搜」当依据）
//   话题视频里的 AIGC 稿件（官方 AI 角标 或 文案 / 话题带 AI 关键词）
//   话题视频里用到的 BGM（给热歌分析当依据）
export async function douyinHot() {
  const j = await http(`${API}/hot/search/list/`);
  const words = (j?.data?.word_list || []).map((x, i) => ({ ...x, _rank: x.position || i + 1 }));
  const rising = (j?.data?.trending_list || []).map((x) => ({ ...x, _rising: true }));
  if (!words.length) throw new Error('抖音热榜为空');
  const out = [];
  const errors = [];
  const bgm = new Map();
  const seen = new Set();

  for (const w of [...words, ...rising]) {
    let videos = [];
    try {
      const v = await http(`${API}/hot/search/video/list/?hotword=${encodeURIComponent(w.word)}&sentence_id=${w.sentence_id}&count=20`, { retries: 1 });
      videos = v?.aweme_list || [];
    } catch (e) { errors.push(`${w.word}: ${e.message}`); }
    await sleep(300);

    const top = [...videos].sort((a, b) => (b.statistics?.digg_count || 0) - (a.statistics?.digg_count || 0));
    const kind = KIND(w.sentence_tag);
    const aiish = (a) => !!aiLabel(a);
    out.push({
      id: `douyin:${w.word}`,
      cat: 'trend', src: 'douyin', board: w._rising ? '抖音实时上升' : '抖音热榜',
      title: w.word,
      url: `https://www.douyin.com/search/${encodeURIComponent(w.word)}`,
      heat: w.hot_value || 0,
      rank: w._rising ? undefined : w._rank,
      label: w._rising ? '上升' : LABEL[w.label] || '',
      pubAt: w.event_time ? w.event_time * 1000 : undefined,
      ctx: top.slice(0, 3).map((a) => clean(a.desc).slice(0, 60)).filter(Boolean),
      kind,
      // 挑战 / 玩法类：存参与视频里点赞最高的 3 条，以及其中有几条是 AI 做的
      top: kind ? top.slice(0, 3).map((a) => ({ title: plain(a.desc).slice(0, 50), url: `https://www.douyin.com/video/${a.aweme_id}`, like: a.statistics?.digg_count || 0, ai: aiish(a) ? 1 : 0 })) : undefined,
      m: { videos: w.video_count || videos.length, stag: w.sentence_tag, fetched: videos.length, aiVideos: kind ? videos.filter(aiish).length : undefined },
    });

    for (const a of videos) {
      if (seen.has(a.aweme_id)) continue;
      seen.add(a.aweme_id);
      // 只收抖音官方标了 AI 的视频
      if (aiLabel(a)) out.push(videoItem(a, w.word));
      const t = a.music?.title && clean(a.music.title);
      if (t && !/原声|创作的/.test(t)) {
        const k = `${t}|${clean(a.music.author || '')}`;
        const b = bgm.get(k) || { title: t, author: clean(a.music.author || ''), n: 0, likes: 0, sample: '' };
        b.n++;
        b.likes += a.statistics?.digg_count || 0;
        if (!b.sample) b.sample = clean(a.desc).slice(0, 50);
        bgm.set(k, b);
      }
    }
  }

  // BGM 只当分析依据，不单独展示
  for (const [k, b] of bgm) {
    out.push({ id: `dybgm:${k}`, cat: 'bgm', src: 'douyin', board: '抖音热点BGM', title: b.title, author: b.author, heat: b.likes, desc: b.sample, m: { videos: b.n } });
  }
  if (errors.length > words.length / 2) throw new Error(`抖音话题视频大面积失败：${errors.slice(0, 2).join('; ')}`);
  out.warnings = errors.slice(0, 5);
  return out;
}

// 抖音热歌榜 + 飙升榜（周更）
export async function douyinMusic() {
  const out = [];
  for (const c of DOUYIN_MUSIC_CHARTS) {
    const j = await http(`${API}/chart/music/list/?chart_id=${c.id}&count=100&cursor=0&aid=1128&version_code=130200&version_name=13.2.0`);
    const list = (j?.music_list || []).slice(0, MUSIC_TOP_N);
    if (!list.length) throw new Error(`抖音${c.name}为空`);
    list.forEach((x, i) => {
      const mi = x.music_info || {};
      const mid = mi.id_str || mi.mid || String(mi.id);
      out.push({
        id: `douyin:${c.name}:${mid}`,
        cat: 'music', src: 'douyin', board: `抖音${c.name}`,
        title: clean(mi.title), author: clean(mi.author),
        url: `https://www.douyin.com/music/${mid}`,
        heat: x.heat || 0, rank: i + 1,
        label: x.is_new ? '新' : '',
        m: { week: j.release_date, users: mi.user_count || 0 },
      });
    });
  }
  return out;
}
