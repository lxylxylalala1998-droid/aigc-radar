import { http, clean } from '../util.js';
import { DOUYIN_MUSIC_CHART, MUSIC_TOP_N } from '../config.js';

const LABEL = { 1: '新', 2: '荐', 3: '热', 4: '首发', 5: '独家', 8: '辟谣', 16: '直播' };

// 抖音热榜（热搜词）
export async function douyinHot() {
  const j = await http('https://aweme.snssdk.com/aweme/v1/hot/search/list/');
  const list = j?.data?.word_list || [];
  return list.map((x, i) => ({
    id: `douyin:${x.word}`,
    cat: 'trend', src: 'douyin', board: '抖音热榜',
    title: x.word,
    url: `https://www.douyin.com/search/${encodeURIComponent(x.word)}`,
    heat: x.hot_value || 0,
    rank: x.position || i + 1,
    label: LABEL[x.label] || '',
    pubAt: x.event_time ? x.event_time * 1000 : undefined,
    m: { videos: x.video_count || 0 },
  }));
}

// 抖音热歌榜
export async function douyinMusic() {
  const j = await http(`https://aweme.snssdk.com/aweme/v1/chart/music/list/?chart_id=${DOUYIN_MUSIC_CHART}&count=${MUSIC_TOP_N}`);
  const list = j?.music_list || [];
  if (!list.length) throw new Error('抖音热歌榜为空');
  return list.map((x, i) => {
    const mi = x.music_info || {};
    const mid = mi.mid || mi.id_str || String(mi.id);
    return {
      id: `douyin:热歌榜:${mid}`,
      cat: 'music', src: 'douyin', board: '抖音热歌榜',
      title: clean(mi.title),
      author: clean(mi.author),
      url: `https://www.douyin.com/music/${mid}`,
      heat: x.heat || x.hot_value || 0,
      rank: i + 1,
      label: x.is_new ? '新' : '',
      m: { rankDiff: x.rank_diff ?? null, users: mi.user_count || 0 },
    };
  });
}
