import { http, clean } from '../util.js';
import { QQ_TOPS, NETEASE_TOPS, MUSIC_TOP_N } from '../config.js';

// QQ音乐榜单
export async function qqMusic() {
  const out = [];
  for (const top of QQ_TOPS) {
    const data = { detail: { module: 'musicToplist.ToplistInfoServer', method: 'GetDetail', param: { topId: top.id, offset: 0, num: MUSIC_TOP_N } } };
    const j = await http(`https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(JSON.stringify(data))}`, { headers: { Referer: 'https://y.qq.com/' } });
    const d = j?.detail?.data;
    const songs = d?.data?.song || [];
    const mids = new Map((d?.songInfoList || []).map((s) => [s.id, s.mid]));
    for (const s of songs) {
      const mid = mids.get(s.songId);
      out.push({
        id: `qqmusic:${top.name}:${s.songId}`,
        cat: 'music', src: 'qqmusic', board: `QQ音乐${top.name}`,
        title: clean(s.title), author: clean(s.singerName),
        url: mid ? `https://y.qq.com/n/ryqq/songDetail/${mid}` : `https://i.y.qq.com/v8/playsong.html?songid=${s.songId}`,
        cover: s.cover, rank: s.rank,
        // rankType 6 = 飙升百分比，其它是名次变化
        label: s.rankType === 6 ? `↑${s.rankValue}` : (s.rankValue && s.rankValue !== '0' ? s.rankValue : ''),
      });
    }
  }
  return out;
}

// 网易云音乐榜单
export async function netease() {
  const out = [];
  for (const top of NETEASE_TOPS) {
    const j = await http(`https://music.163.com/api/playlist/detail?id=${top.id}`, { headers: { Referer: 'https://music.163.com/' } });
    const tracks = (j?.result?.tracks || []).slice(0, MUSIC_TOP_N);
    tracks.forEach((t, i) => out.push({
      id: `netease:${top.name}:${t.id}`,
      cat: 'music', src: 'netease', board: `网易云${top.name}`,
      title: clean(t.name), author: (t.artists || []).map((a) => a.name).join(' / '),
      url: `https://music.163.com/#/song?id=${t.id}`,
      cover: t.album?.picUrl ? `${t.album.picUrl}?param=120y120` : undefined,
      rank: i + 1,
    }));
  }
  return out;
}
