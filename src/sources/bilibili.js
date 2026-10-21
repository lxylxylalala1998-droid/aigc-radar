import { http, clean, isAI, sleep, DAY } from '../util.js';
import { BILI_KEYWORDS, BILI_RANK_RIDS } from '../config.js';

let cookie = '';
async function bili(url) {
  if (!cookie) {
    // 先领一个游客 buvid，海外 IP 不带它容易被 -412 风控
    try {
      const j = await http('https://api.bilibili.com/x/frontend/finger/spi', { retries: 1 });
      cookie = `buvid3=${j.data.b_3}; buvid4=${j.data.b_4}`;
    } catch { cookie = ' '; }
  }
  const j = await http(url, { headers: { Referer: 'https://www.bilibili.com/', Cookie: cookie } });
  if (j.code !== 0) throw new Error(`B站接口 code=${j.code} ${j.message || ''}`);
  return j.data;
}

const fixPic = (u) => (u && u.startsWith('//') ? 'https:' + u : u?.replace(/^http:/, 'https:'));

function video(v, board) {
  const st = v.stat || {};
  return {
    id: `bili:${v.bvid}`,
    cat: 'video', src: 'bilibili', board,
    title: clean(v.title),
    url: `https://www.bilibili.com/video/${v.bvid}`,
    author: v.author || v.owner?.name || '',
    cover: fixPic(v.pic),
    heat: v.play ?? st.view ?? 0,
    pubAt: (v.pubdate || 0) * 1000,
    desc: clean(v.description || v.desc || '').slice(0, 80),
    tags: (v.tag || '').split(',').slice(0, 8).join(','),
    m: {
      play: v.play ?? st.view ?? 0,
      like: v.like ?? st.like ?? 0,
      danmaku: v.video_review ?? st.danmaku ?? 0,
      fav: v.favorites ?? st.favorite ?? 0,
      part: v.typename || v.tname || '',
    },
  };
}

// B站热搜
export async function biliHot() {
  const d = await bili('https://api.bilibili.com/x/web-interface/search/square?limit=50');
  return (d?.trending?.list || []).map((x, i) => ({
    id: `bili:${x.keyword}`,
    cat: 'trend', src: 'bilibili', board: 'B站热搜',
    title: x.show_name || x.keyword,
    url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(x.keyword)}`,
    heat: x.heat_score || 0,
    rank: i + 1,
  }));
}

// B站 AI 稿件：关键词搜索（近 3 天 / 近 7 天，按播放） + 分区排行 + 综合热门里挑 AI 相关
export async function biliAI() {
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  const errors = [];
  const jobs = [];
  for (const k of BILI_KEYWORDS) {
    jobs.push({ kw: k.kw, days: 3 });
    if (k.core) jobs.push({ kw: k.kw, days: 7 });
  }
  let blocked = false;
  for (const job of jobs) {
    if (blocked) break;
    const url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&order=click&page=1'
      + `&keyword=${encodeURIComponent(job.kw)}&pubtime_begin_s=${now - job.days * 86400}&pubtime_end_s=${now}`;
    try {
      const d = await bili(url);
      for (const v of d?.result || []) out.push(video(v, `搜索·${job.kw}`));
    } catch (e) {
      errors.push(`${job.kw}: ${e.message}`);
      // 412 = 被风控了，后面的搜索不要再打，留给排行榜接口
      if (e.status === 412) { blocked = true; errors.push(`搜索被 B站风控（412），跳过剩余 ${jobs.length - jobs.indexOf(job) - 1} 个关键词`); }
    }
    await sleep(1500);
  }
  for (const rid of BILI_RANK_RIDS) {
    try {
      const d = await bili(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`);
      for (const v of d?.list || []) {
        if (isAI(v.title) || /AI/.test(v.tname || '')) out.push(video(v, `排行·${v.tname || rid}`));
      }
    } catch (e) { errors.push(`rank ${rid}: ${e.message}`); }
    await sleep(400);
  }
  for (let pn = 1; pn <= 3; pn++) {
    try {
      const d = await bili(`https://api.bilibili.com/x/web-interface/popular?ps=50&pn=${pn}`);
      for (const v of d?.list || []) if (isAI(v.title)) out.push(video(v, '综合热门'));
    } catch (e) { errors.push(`popular ${pn}: ${e.message}`); }
    await sleep(400);
  }
  // 太老的稿件（分区排行里偶尔混进来）不要
  const fresh = out.filter((v) => v.pubAt > Date.now() - 10 * DAY);
  if (!fresh.length && errors.length) throw new Error(errors.slice(0, 3).join('; '));
  fresh.warnings = errors;
  return fresh;
}

// B站全站音乐榜（周榜，每周五更新）
export async function biliMusic() {
  const p = await bili('https://api.bilibili.com/x/copyright-music-publicity/toplist/all_period?list_type=1');
  const all = Object.values(p?.list || {}).flat().sort((a, b) => b.publish_time - a.publish_time);
  if (!all.length) throw new Error('B站音乐榜期数为空');
  const latest = all[0];
  const d = await bili(`https://api.bilibili.com/x/copyright-music-publicity/toplist/music_list?list_id=${latest.ID}`);
  return (d?.list || []).map((x) => ({
    id: `bili:音乐榜:${x.music_id}`,
    cat: 'music', src: 'bilibili', board: 'B站音乐榜(周)',
    title: clean(x.music_title), author: clean(x.singer),
    url: x.creation_bvid ? `https://www.bilibili.com/video/${x.creation_bvid}` : 'https://music.bilibili.com/pc/music-center/',
    cover: fixPic(x.mv_cover || x.creation_cover),
    heat: x.heat || 0, rank: x.rank,
    desc: x.creation_title ? `代表稿件：${clean(x.creation_title)}` : '',
    m: { period: latest.priod },
  }));
}
