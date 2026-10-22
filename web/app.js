(() => {
  const $ = (s) => document.querySelector(s);
  const PLAT = { weibo: '微博', douyin: '抖音', bilibili: 'B站', youtube: 'YouTube', qqmusic: 'QQ音乐', netease: '网易云' };
  const VTYPES = ['AI音乐', 'AI MV', 'AI歌手/艺人', 'AI鬼畜', 'AI影视', 'AI换人', 'AI动画', 'AI特效玩法', 'AI整活', 'AI教程测评'];
  const TTAGS = ['热梗', 'AI相关', '可借势'];
  const TKINDS = ['抖音挑战', '话题互动'];
  const trendHas = (x, k) => x.kind === k || x.ai?.tag === k;
  const MPLAT = ['抖音', 'B站', 'QQ音乐', '网易云'];
  const PAGE = 40;

  const state = { w: 1, tab: 'video', f1: '', f2: '', q: '', sort: '', pickDay: 0, shown: PAGE };
  const cache = {};

  // ---------- 工具 ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (!n ? '0' : n >= 1e8 ? (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿' : n >= 1e4 ? (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万' : String(Math.round(n)));
  // 数字部分用记分牌字体，「万 / 亿」留给正文字体
  const N = (n) => { const s = num(n); const m = s.match(/^([\d.]+)(.*)$/); return m ? `<b class="num">${m[1]}</b>${m[2]}` : s; };
  const ago = (ts) => {
    if (!ts) return '';
    const m = (Date.now() - ts) / 60e3;
    if (m < 60) return `${Math.max(1, Math.round(m))}分钟前`;
    if (m < 60 * 24) return `${Math.round(m / 60)}小时前`;
    if (m < 60 * 24 * 7) return `${Math.round(m / 1440)}天前`;
    const d = new Date(ts); return `${d.getMonth() + 1}-${d.getDate()}`;
  };
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const WEEK = '日一二三四五六';
  const pb = (src) => (PLAT[src] ? `<span class="tag p ${src}">${PLAT[src]}</span>` : `<span class="tag">${esc(src)}</span>`);
  const tag = (text, cls = '') => (text ? `<span class="tag ${cls}">${esc(text)}</span>` : '');
  const link = (url, inner) => `<a href="${esc(url)}" target="_blank" rel="noopener">${inner}</a>`;
  const cover = (u, src) => (!u ? '' : src === 'bilibili' && /hdslb\.com/.test(u) && !u.includes('@') ? `${u}@320w_200h_1c.webp` : u);
  const ana = (label, text) => (text ? `<div class="ana"><span class="mk">${label}</span>${esc(text)}</div>` : '');
  const match = (x, q) => !q || [x.title, x.author, x.desc, x.board, x.ai?.why, x.ai?.hook, x.ai?.tip, x.ai?.idea, x.ai?.use, x.ai?.event].join(' ').toLowerCase().includes(q);
  const musicPlat = (x) => PLAT[x.src];
  const musicKind = (x) => (x.board.includes('飙升') ? '飙升榜' : '热歌榜');

  async function load(w) {
    if (!cache[w]) cache[w] = fetch(`data/w${w}.json?t=${Math.floor(Date.now() / 6e5)}`).then((r) => r.json());
    return cache[w];
  }

  // ---------- 今日选题：头号选题整块反白，其余四个排在右侧 ----------
  function renderPicks(d) {
    const ds = d.digests || [];
    if (!ds.length) { $('#picks').innerHTML = '<div class="empty-note">这个时间段还没有 AI 选题日报，每天早上 9 点前生成。</div>'; return; }
    const i = Math.min(state.pickDay, ds.length - 1);
    const dg = ds[i];
    const dayChips = ds.length > 1 ? `<div class="day-chips">${ds.map((x, k) => `<button class="chip ${k === i ? 'on' : ''}" data-pickday="${k}">${+x.date.slice(5, 7)}月${+x.date.slice(8)}日</button>`).join('')}</div>` : '';
    const cards = (dg.picks || []).map((p, k) => `
      <article class="pick ${k === 0 ? 'lead' : ''}">
        <div class="no">${pad(k + 1)}</div>
        <div class="tags">${tag(p.horizon, 'mark')}${tag(p.platform)}</div>
        <h3>${esc(p.title)}</h3>
        <p><span class="mk">为什么能火</span>${esc(p.why)}</p>
        <p><span class="mk">怎么做</span>${esc(p.how)}</p>
        ${p.refs?.length ? `<div class="refs">${p.refs.map((r) => link(r.url, esc(r.title))).join('')}</div>` : ''}
      </article>`).join('');
    $('#picks').innerHTML = `
      <div class="sec-head"><h2>${ds.length > 1 ? 'AI 选题日报' : '今日选题'}</h2><small>AI 编辑${dg.ai ? `（${esc(dg.ai)}）` : ''}按 24 小时 / 3 天 / 7 天 / 30 天热度挑的 · ${clock(dg.generatedAt)}</small></div>
      ${dayChips}
      ${cards ? `<div class="pick-grid">${cards}</div>` : '<div class="empty-note">这一天没有生成选题（AI 分析未开启或出错）。</div>'}`;
  }

  // ---------- 各分类 ----------
  const TABS = {
    video: {
      chips: (d) => counts(d.videos, (x) => PLAT[x.src] || x.src, ['抖音', 'B站', 'YouTube']),
      chips2: (d) => counts(d.videos, (x) => x.ai?.type || '未分类', VTYPES.concat('未分类')),
      sorts: [['vel', '飙升最快'], ['heat', '点赞 / 播放最高'], ['time', '最新发布']],
      render(d) {
        let items = d.videos.filter((x) => (!state.f1 || PLAT[x.src] === state.f1) && (!state.f2 || (x.ai?.type || '未分类') === state.f2) && match(x, state.q));
        const s = state.sort || (state.w === 1 ? 'vel' : 'heat');
        // 抖音按点赞、B站/YouTube 按播放，量级不同：混排时按平台内名次交错
        const key = s === 'vel' ? (x) => x.vel || 0 : s === 'heat' ? (x) => x.heat || 0 : (x) => x.pubAt || 0;
        if (s === 'time' || state.f1) items.sort((a, b) => key(b) - key(a));
        else {
          const byP = {};
          for (const x of items.sort((a, b) => key(b) - key(a))) (byP[x.src] ||= []).push(x);
          const lists = Object.values(byP);
          items = [];
          for (let i = 0; lists.some((l) => l[i]); i++) for (const l of lists) if (l[i]) items.push(l[i]);
        }
        return page(items, (x) => {
          const dy = x.src === 'douyin';
          return `
          <article class="item vid">
            <a class="th ${x.cover ? '' : `ph ${x.src}`}" href="${esc(x.url)}" target="_blank" rel="noopener" aria-label="打开视频">${x.cover ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(cover(x.cover, x.src))}" alt="">` : `<span>${PLAT[x.src] || ''}</span>`}${x.ai?.type ? `<span class="ty">${esc(x.ai.type)}</span>` : ''}</a>
            <div>
              <div class="tt">${link(x.url, esc(x.title))}</div>
              <div class="meta">${pb(x.src)}${x.ai?.top ? tag('今日精选', 'hot') : ''}${x.m?.aiCorner ? tag('AI角标', 'solid') : ''}<span>${esc(x.author || '')}</span>${x.m?.noDate ? '' : `<span>${ago(x.pubAt)}</span>`}${dy && /^(话题|热门视频榜)/.test(x.board) ? `<span>${esc(x.board.replace('话题·', ''))}</span>` : ''}</div>
              <div class="stat">${x.m?.play && dy ? `<span>${N(x.m.play)}播放</span>` : ''}<span>${N(x.heat)}${dy ? '赞' : '播放'}</span>${x.vel ? `<span class="up">+${N(x.vel)}${dy ? '赞' : ''}/小时</span>` : ''}${!dy && x.m?.like ? `<span>${N(x.m.like)}赞</span>` : ''}${dy && x.m?.share ? `<span>${N(x.m.share)}分享</span>` : ''}</div>
              ${ana('爆点', x.ai?.hook)}${ana('参考', x.ai?.tip)}
            </div>
          </article>`;
        });
      },
    },
    trend: {
      chips: (d) => counts(d.trends, (x) => PLAT[x.src], ['抖音', 'B站', '微博']),
      // 抖音挑战 / 话题互动是抖音官方的分类，热梗 / AI相关 / 可借势是 AI 打的标签，一条可能两种都有
      chips2: (d) => TKINDS.concat(TTAGS).map((k) => [k, d.trends.filter((x) => trendHas(x, k)).length]).filter(([, n]) => n),
      sorts: [['rank', '排名'], ['heat', '热度'], ['days', '在榜天数']],
      render(d) {
        let items = d.trends.filter((x) => (!state.f1 || PLAT[x.src] === state.f1) && (!state.f2 || trendHas(x, state.f2)) && match(x, state.q));
        const s = state.sort || 'rank';
        if (s === 'heat') items.sort((a, b) => (b.peakHeat || b.heat || 0) - (a.peakHeat || a.heat || 0));
        else if (s === 'days') items.sort((a, b) => (b.daysSeen || 0) - (a.daysSeen || 0) || (a.peakRank || 99) - (b.peakRank || 99));
        else if (!state.f1) items.sort((a, b) => (a.peakRank || 99) - (b.peakRank || 99) || (b.heat || 0) - (a.heat || 0));
        // 抖音挑战、有 AI 标签的（热梗 / AI相关 / 可借势）先看
        if (!state.f2 && s === 'rank') items.sort((a, b) => (b.ai?.tag || b.kind ? 1 : 0) - (a.ai?.tag || a.kind ? 1 : 0));
        return page(items, (x) => {
          const r = x.peakRank || x.rank;
          return `
          <article class="item row">
            <div class="rk ${r ? (r <= 3 ? 'top' : '') : 'up'}">${r || '↑'}</div>
            <div>
              <div class="tt">${link(x.url, esc(x.title))}</div>
              <div class="meta">${pb(x.src)}${tag(x.kind, 'solid')}${tag(x.ai?.tag, 'mark')}${x.label ? tag(x.label, 'hot') : ''}${x.heat ? `<span>热度 ${N(x.peakHeat || x.heat)}</span>` : ''}${x.kind && x.m?.fetched ? `<span>参与视频 ${x.m.aiVideos || 0}/${x.m.fetched} 条是 AI 做的</span>` : ''}${state.w > 1 && x.daysSeen > 1 ? `<span>在榜 ${x.daysSeen} 天</span>` : ''}${state.w > 1 ? `<span>${ago(x.lastSeen)}</span>` : ''}</div>
              ${ana('为什么火', x.ai?.why)}${ana(x.kind ? 'AI 跟拍' : 'AI 做法', x.ai?.idea)}
              ${(x.top || []).map((v) => link(v.url, `${N(v.like)}赞 ${v.ai ? tag('AI', 'mark') : ''}${esc(v.title || '（无文案）')}`).replace('<a ', '<a class="tv" ')).join('')}
            </div>
          </article>`;
        });
      },
    },
    music: {
      chips: (d) => counts(d.music, musicPlat, MPLAT),
      chips2: (d) => counts(d.music.filter((x) => !state.f1 || musicPlat(x) === state.f1), musicKind, ['热歌榜', '飙升榜']),
      sorts: [['rank', '排名'], ['days', '在榜天数']],
      render(d) {
        let items = d.music.filter((x) => (!state.f1 || musicPlat(x) === state.f1) && (!state.f2 || musicKind(x) === state.f2) && match(x, state.q));
        if (state.sort === 'days') items.sort((a, b) => (b.daysSeen || 0) - (a.daysSeen || 0));
        if (!items.length) return '<div class="none">没有符合条件的内容</div>';
        const row = (x) => {
          const r = state.w > 1 ? (x.peakRank || x.rank) : x.rank;
          return `
          <article class="item row">
            <div class="rk ${r <= 3 ? 'top' : ''}">${r}</div>
            <div>
              <div class="tt">${link(x.url, esc(x.title))} <small>— ${esc(x.author)}</small></div>
              <div class="meta">${state.sort === 'days' ? pb(x.src) + `<span>${esc(x.board)}</span>` : ''}${x.label ? tag(x.label, 'hot') : ''}${state.w > 1 ? `<span>最高第 ${x.peakRank || x.rank} 名</span>${x.daysSeen > 1 ? `<span>在榜 ${x.daysSeen} 天</span>` : ''}` : ''}</div>
              ${ana('为什么火', x.ai?.why)}${ana('可以做', x.ai?.use)}
            </div>
          </article>`;
        };
        const shown = items.slice(0, state.shown);
        let html;
        if (state.sort === 'days') html = `<div class="sheet">${shown.map(row).join('')}</div>`;
        else {
          // 按「平台 · 榜单」分组，每组一张纸
          const groups = [];
          for (const x of shown) {
            const g = `${musicPlat(x)} · ${musicKind(x)}`;
            if (groups.at(-1)?.g !== g) groups.push({ g, src: x.src, weekly: /抖音|B站/.test(x.board), list: [] });
            groups.at(-1).list.push(x);
          }
          html = groups.map((g) => `<div class="group-h">${pb(g.src)}${esc(g.g.split(' · ')[1])}${g.weekly ? '<small>周榜</small>' : '<small>日更</small>'}</div><div class="sheet">${g.list.map(row).join('')}</div>`).join('');
        }
        if (items.length > state.shown) html += `<button class="more" data-more>再看 ${Math.min(PAGE, items.length - state.shown)} 首（共 ${items.length} 首）</button>`;
        return html;
      },
    },
    news: {
      chips: (d) => counts(d.news, (x) => x.src),
      chips2: () => [],
      sorts: [['time', '最新发布'], ['heat', '热度']],
      render(d) {
        const q = state.q;
        let html = '';
        if (!state.f1) {
          const evs = (d.digests || []).flatMap((g) => (g.news || []).map((e) => ({ ...e, date: g.date }))).filter((e) => match({ title: e.title, desc: e.summary }, q));
          if (evs.length) {
            html += `<div class="group-h">AI 归并的大事件<small>${evs.length} 件，同一件事的多篇报道已合并</small></div><div class="sheet">` + evs.map((e) => `
              <article class="item event lv-${esc(e.level || '')}">
                <div class="meta">${e.level === '重磅' ? tag('重磅', 'hot') : tag(e.level)}${tag(e.kind)}${(d.digests || []).length > 1 ? `<span>${e.date.slice(5)}</span>` : ''}</div>
                <h3>${esc(e.title)}</h3>
                ${e.summary ? `<p>${esc(e.summary)}</p>` : ''}
                <div class="srcs">${(e.refs || []).map((r) => link(r.url, `<b>${esc(r.src)}</b>${esc(r.title)}`)).join('')}</div>
              </article>`).join('') + '</div>';
          }
        }
        let items = d.news.filter((x) => (!state.f1 || x.src === state.f1) && match(x, q));
        items = state.sort === 'heat' ? items.sort((a, b) => (b.heat || 0) - (a.heat || 0)) : items;
        html += `<div class="group-h">全部资讯<small>${items.length} 篇</small></div>` + page(items, (x) => `
          <article class="item">
            <div class="tt">${link(x.url, esc(x.title))}</div>
            ${x.desc && x.board === 'HF 热门模型' ? `<div class="meta">${esc(x.desc)}</div>` : ''}
            <div class="meta">${tag(x.src)}<span>${ago(x.pubAt || x.firstSeen)}</span>${x.heat ? `<span>${x.board === 'HF 热门模型' ? '❤' : '▲'} ${N(x.heat)}</span>` : ''}${x.ai?.level ? tag(x.ai.kind || 'AI 事件', 'mark') : ''}</div>
          </article>`);
        return html;
      },
    },
  };

  function counts(list, key, order) {
    const m = new Map();
    for (const x of list) { const k = key(x); if (k) m.set(k, (m.get(k) || 0) + 1); }
    const keys = order ? order.filter((k) => m.has(k)) : [...m.keys()];
    return keys.map((k) => [k, m.get(k)]);
  }

  function page(items, tpl) {
    if (!items.length) return '<div class="none">没有符合条件的内容</div>';
    const html = `<div class="sheet">${items.slice(0, state.shown).map(tpl).join('')}</div>`;
    return html + (items.length > state.shown ? `<button class="more" data-more>再看 ${Math.min(PAGE, items.length - state.shown)} 条（共 ${items.length} 条）</button>` : '');
  }

  function chipRow(el, list, cur, attr) {
    el.innerHTML = list.length ? [`<button class="chip ${!cur ? 'on' : ''}" data-${attr}="">全部</button>`, ...list.map(([k, n]) => `<button class="chip ${cur === k ? 'on' : ''}" data-${attr}="${esc(k)}">${esc(k)}<span class="n">${n}</span></button>`)].join('') : '';
  }

  async function render() {
    const d = await load(state.w);
    const T = TABS[state.tab];
    const g = new Date(d.generatedAt);
    $('#updated').innerHTML = `<b class="num">${g.getMonth() + 1}.${g.getDate()}</b> 周${WEEK[g.getDay()]} · 最近一次扫描 <b class="num">${pad(g.getHours())}:${pad(g.getMinutes())}</b>`;
    document.querySelectorAll('#win button').forEach((b) => b.classList.toggle('on', +b.dataset.w === state.w));
    const n = { news: d.news.length, video: d.videos.length, trend: d.trends.length, music: d.music.length };
    document.querySelectorAll('#tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === state.tab);
      b.innerHTML = `${b.textContent.replace(/\d+$/, '').trim()}<span class="n">${n[b.dataset.tab]}</span>`;
    });
    renderPicks(d);
    chipRow($('#chips'), T.chips(d), state.f1, 'f1');
    chipRow($('#chips2'), T.chips2(d), state.f2, 'f2');
    $('#sort').innerHTML = T.sorts.map(([v, l]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${l}</option>`).join('');
    $('#list').innerHTML = T.render(d);
    history.replaceState(null, '', `#w=${state.w}&tab=${state.tab}`);
  }

  async function renderStatus() {
    try {
      const st = await fetch(`data/status.json?t=${Math.floor(Date.now() / 6e5)}`).then((r) => r.json());
      $('#status').innerHTML = `<div class="st">${Object.values(st.sources).map((s) => `<div><span>${esc(s.name)}</span><span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? `${s.count} 条` : `失败${s.lastOk ? `，上次成功 ${ago(s.lastOk)}` : ''}`}</span></div>`).join('')}</div><p>最近采集：${clock(st.runAt)}</p>`;
    } catch { $('#status').textContent = '暂无'; }
  }

  // ---------- 交互 ----------
  const reset = () => { state.f1 = ''; state.f2 = ''; state.sort = ''; state.shown = PAGE; };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.w) { state.w = +b.dataset.w; state.pickDay = 0; state.shown = PAGE; render(); }
    else if (b.dataset.tab) { state.tab = b.dataset.tab; reset(); render(); }
    else if ('f1' in b.dataset) { state.f1 = b.dataset.f1; if (state.tab === 'music') state.f2 = ''; state.shown = PAGE; render(); }
    else if ('f2' in b.dataset) { state.f2 = b.dataset.f2; state.shown = PAGE; render(); }
    else if ('pickday' in b.dataset) { state.pickDay = +b.dataset.pickday; render(); }
    else if ('more' in b.dataset) { state.shown += PAGE; render(); }
  });
  let t;
  $('#q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); state.shown = PAGE; render(); }, 200); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });

  const h = new URLSearchParams(location.hash.slice(1));
  if ([1, 3, 7, 30].includes(+h.get('w'))) state.w = +h.get('w');
  if (TABS[h.get('tab')]) state.tab = h.get('tab');
  render().catch((e) => { $('#list').innerHTML = `<div class="none">数据加载失败：${esc(e.message)}，刷新一下试试。</div>`; });
  renderStatus();
})();
