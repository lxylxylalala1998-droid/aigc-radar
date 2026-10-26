import { http } from '../util.js';

// 微博热搜榜（实时）
export async function weibo() {
  const j = await http('https://weibo.com/ajax/side/hotSearch', { headers: { Referer: 'https://weibo.com/' } });
  const list = j?.data?.realtime || [];
  return list
    .filter((x) => !x.is_ad && x.word)
    .map((x, i) => ({
      id: `weibo:${x.word}`,
      cat: 'trend', src: 'weibo', board: '微博热搜',
      title: x.word,
      url: `https://s.weibo.com/weibo?q=${encodeURIComponent(`#${x.word}#`)}`,
      heat: x.num || 0,
      rank: x.realpos || i + 1,
      label: x.label_name || x.icon_desc || '',
      desc: x.flag_desc || '',
    }));
}
