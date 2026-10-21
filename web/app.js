(() => {
  const $ = (s) => document.querySelector(s);
  const PLAT = { weibo: '微博', douyin: '抖音', bilibili: 'B站', youtube: 'YouTube', qqmusic: 'QQ音乐', netease: '网易云' };
  const VTYPES = ['AI音乐', 'AI MV', 'AI动画', 'AI剧情', 'AI短片', 'AI整活', 'AI教程测评'];
  const TTAGS = ['热梗', 'AI相关', '可借势'];
  const PAGE = 40;

  const state = { w: 1, tab: 'news', f1: '', f2: '', q: '', sort: '', pickDay: 0, shown: PAGE };
  const cache = {};

  // ---------- 工具 ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (!n ? '0' : n >= 1e8 ? (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿' : n >= 1e4 ? (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万' : String(Math.round(n)));
  const ago = (ts) => {
    if (!ts) return '';
    const m = (Date.now() - ts) / 60e3;
    if (m < 60) return `${Math.max(1, Math.round(m))}分钟前`;
    if (m < 60 * 24) return `${Math.round(m / 60)}小时前`;
    if (m < 60 * 24 * 7) return `${Math.round(m / 1440)}天前`;
    const d = new Date(ts); return `${d.getMonth() + 1}-${d.getDate()}`;
  };
  const clock = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const pb = (src) => (PLAT[src] ? `<span class="badge p ${src}">${PLAT[src]}</span>` : `<span class="badge">${esc(src)}</span>`);
  const link = (url, inner) => `<a href="${esc(url)}" target="_blank" rel="noopener">${inner}</a>`;
  const cover = (u, src) => (!u ? '' : src === 'bilibili' && /hdslb\.com/.test(u) && !u.includes('@') ? `${u}@320w_200h_1c.webp` : u);
  const match = (x, q) => !q || [x.title, x.author, x.desc, x.ai?.note, x.ai?.why, x.ai?.event, x.board].join(' ').toLowerCase().includes(q);

  async function load(w) {
    if (!cache[w]) cache[w] = fetch(`data/w${w}.json?t=${Math.floor(Date.now() / 6e5)}`).then((r) => r.json());
    return cache[w];
  }

  // ---------- 选题 ----------
  function renderPicks(d) {
    const ds = d.digests || [];
    if (!ds.length) { $('#picks').innerHTML = '<div class="empty-picks">这个时间段还没有 AI 选题日报（每天早上生成）。</div>'; return; }
    const i = Math.min(state.pickDay, ds.length - 1);
    const dg = ds[i];
    const dayChips = ds.length > 1 ? `<div class="day-chips">${ds.map((x, k) => `<button class="chip ${k === i ? 'on' : ''}" data-pickday="${k}">${x.date.slice(5).replace('-', '月')}日</button>`).join('')}</div>` : '';
    const cards = (dg.picks || []).map((p, k) => `
      <article class="pick">
        <span class="no">0${k + 1}</span>
        <h3>${esc(p.title)}</h3>
        <p><b>为什么</b>${esc(p.why)}</p>
        <p><b>怎么做</b>${esc(p.how)}</p>
        ${p.refs?.length ? `<div class="refs">${p.refs.map((r) => link(r.url, esc(r.title))).join('')}</div>` : ''}
      </article>`).join('');
    $('#picks').innerHTML = `
      <div class="sec-h"><h2>${ds.length > 1 ? 'AI 选题日报' : '今日选题'}</h2><small>${dg.ai ? `由 ${esc(dg.ai)} 生成 · ` : ''}${clock(dg.generatedAt)}</small></div>
      ${dayChips}
      ${cards ? `<div class="pick-grid">${cards}</div>` : '<div class="empty-picks">这一天没有生成选题（AI 点评未开启或出错）。</div>'}`;
  }

  // ---------- 各分类 ----------
  const TABS = {
    news: {
      chips: (d) => counts(d.news, (x) => x.src),
      chips2: () => [],
      sorts: [['time', '最新发布'], ['heat', '热度']],
      render(d) {
        const q = state.q;
        // 先放 AI 归并好的事件，再放全部资讯
        let html = '';
        if (!state.f1) {
          const evs = (d.digests || []).flatMap((g) => (g.news || []).map((e) => ({ ...e, date: g.date }))).filter((e) => match({ title: e.title, desc: e.summary }, q));
          if (evs.length) {
            html += `<div class="group-h">AI 归并的大事件 · ${evs.length}</div>` + evs.map((e) => `
              <article class="card event">
                <div class="meta">${e.level ? `<span class="badge lv-${esc(e.level)}">${esc(e.level)}</span>` : ''}${e.kind ? `<span class="badge">${esc(e.kind)}</span>` : ''}${(d.digests || []).length > 1 ? `<span>${e.date.slice(5)}</span>` : ''}</div>
                <h3>${esc(e.title)}</h3>
                ${e.summary ? `<p>${esc(e.summary)}</p>` : ''}
                <div class="srcs">${(e.refs || []).map((r) => link(r.url, `<b>${esc(r.src)}</b>${esc(r.title)}`)).join('')}</div>
              </article>`).join('');
          }
        }
        let items = d.news.filter((x) => (!state.f1 || x.src === state.f1) && match(x, q));
        items = state.sort === 'heat' ? items.sort((a, b) => (b.heat || 0) - (a.heat || 0)) : items;
        html += `<div class="group-h">全部资讯 · ${items.length}</div>` + page(items, (x) => `
          <article class="card">
            <div class="tt">${link(x.url, esc(x.title))}</div>
            ${x.desc && x.board === 'HF 热门模型' ? `<div class="meta">${esc(x.desc)}</div>` : ''}
            <div class="meta"><span class="badge">${esc(x.src)}</span><span>${ago(x.pubAt || x.firstSeen)}</span>${x.heat ? `<span>${x.board === 'HF 热门模型' ? '❤' : '▲'} ${num(x.heat)}</span>` : ''}${x.ai?.level ? `<span class="badge ai">${esc(x.ai.kind || 'AI 事件')}</span>` : ''}</div>
          </article>`);
        return html;
      },
    },
    video: {
      chips: (d) => counts(d.videos, (x) => x.ai?.type || '未分类', VTYPES.concat('未分类')),
      chips2: (d) => counts(d.videos, (x) => PLAT[x.src] || x.src),
      sorts: [['vel', '蹿升最快'], ['heat', '播放最多'], ['time', '最新发布']],
      render(d) {
        let items = d.videos.filter((x) => (!state.f1 || (x.ai?.type || '未分类') === state.f1) && (!state.f2 || PLAT[x.src] === state.f2) && match(x, state.q));
        const s = state.sort || (state.w === 1 ? 'vel' : 'heat');
        items.sort(s === 'vel' ? (a, b) => (b.vel || 0) - (a.vel || 0) : s === 'heat' ? (a, b) => (b.heat || 0) - (a.heat || 0) : (a, b) => (b.pubAt || 0) - (a.pubAt || 0));
        return page(items, (x) => `
          <article class="card vid">
            <a class="th" href="${esc(x.url)}" target="_blank" rel="noopener">${x.cover ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(cover(x.cover, x.src))}" alt="">` : ''}${x.ai?.type ? `<span class="ty">${esc(x.ai.type)}</span>` : ''}</a>
            <div class="bd">
              <div class="tt">${link(x.url, esc(x.title))}</div>
              <div class="meta">${pb(x.src)}<span>${esc(x.author || '')}</span><span>${ago(x.pubAt)}</span></div>
              <div class="stat"><span>▶ ${num(x.heat)}</span>${x.vel ? `<span class="up">🔥 +${num(x.vel)}/小时</span>` : ''}${x.m?.like ? `<span>👍 ${num(x.m.like)}</span>` : ''}</div>
              ${x.ai?.why ? `<div class="note">${esc(x.ai.why)}</div>` : ''}
            </div>
          </article>`);
      },
    },
    trend: {
      chips: (d) => counts(d.trends, (x) => PLAT[x.src]),
      chips2: (d) => counts(d.trends, (x) => x.ai?.tag || '', TTAGS),
      sorts: [['rank', '排名'], ['heat', '热度'], ['days', '在榜天数']],
      render(d) {
        let items = d.trends.filter((x) => (!state.f1 || PLAT[x.src] === state.f1) && (!state.f2 || x.ai?.tag === state.f2) && match(x, state.q));
        const s = state.sort || 'rank';
        if (s === 'heat') items.sort((a, b) => (b.peakHeat || b.heat || 0) - (a.peakHeat || a.heat || 0));
        else if (s === 'days') items.sort((a, b) => (b.daysSeen || 0) - (a.daysSeen || 0) || (a.peakRank || 99) - (b.peakRank || 99));
        else if (!state.f1) items.sort((a, b) => (a.peakRank || 99) - (b.peakRank || 99) || (b.heat || 0) - (a.heat || 0));
        // 有 AI 标签的先看
        if (!state.f2 && s === 'rank') items.sort((a, b) => (b.ai?.tag ? 1 : 0) - (a.ai?.tag ? 1 : 0));
        return page(items, (x) => {
          const r = x.peakRank || x.rank;
          return `
          <article class="card row">
            <div class="rk ${r <= 3 ? 'top' : ''}">${r || '·'}</div>
            <div class="bd">
              <div class="tt">${link(x.url, esc(x.title))}</div>
              <div class="meta">${pb(x.src)}${x.label ? `<span class="badge hot">${esc(x.label)}</span>` : ''}${x.heat ? `<span>热度 ${num(x.peakHeat || x.heat)}</span>` : ''}${state.w > 1 && x.daysSeen > 1 ? `<span>在榜 ${x.daysSeen} 天</span>` : ''}${state.w > 1 ? `<span>${ago(x.lastSeen)}</span>` : ''}${x.ai?.tag ? `<span class="badge ai">${esc(x.ai.tag)}</span>` : ''}</div>
              ${x.ai?.note ? `<div class="note">${esc(x.ai.note)}</div>` : ''}
            </div>
          </article>`;
        });
      },
    },
    music: {
      chips: (d) => counts(d.music, (x) => x.board),
      chips2: () => [],
      sorts: [['rank', '排名'], ['days', '在榜天数']],
      render(d) {
        let html = '';
        const songs = (d.digests || [])[0]?.songs || [];
        if (!state.f1 && songs.length && !state.q) {
          html += `<div class="group-h">AI 推荐：适合做 AI 翻唱 / MV 的歌</div>` + songs.map((x) => `
            <article class="card row">
              <div class="rk">♪</div>
              <div class="bd">
                <div class="tt">${link(x.url, esc(x.title))} <small>— ${esc(x.author)}</small></div>
                <div class="meta">${pb(x.src)}<span>${esc(x.board)} 第 ${x.rank} 名</span>${x.label ? `<span class="badge hot">${esc(x.label)}</span>` : ''}</div>
                ${x.note ? `<div class="note">${esc(x.note)}</div>` : ''}
              </div>
            </article>`).join('');
          html += '<div class="group-h">各平台榜单</div>';
        }
        let items = d.music.filter((x) => (!state.f1 || x.board === state.f1) && match(x, state.q));
        if (state.sort === 'days') items.sort((a, b) => (b.daysSeen || 0) - (a.daysSeen || 0));
        return html + page(items, (x) => {
          const r = state.w > 1 ? (x.peakRank || x.rank) : x.rank;
          return `
          <article class="card row">
            <div class="rk ${r <= 3 ? 'top' : ''}">${r}</div>
            <div class="bd">
              <div class="tt">${link(x.url, esc(x.title))} <small>— ${esc(x.author)}</small></div>
              <div class="meta">${state.f1 ? '' : pb(x.src)}${state.f1 ? '' : `<span>${esc(x.board)}</span>`}${x.label ? `<span class="badge hot">${esc(x.label)}</span>` : ''}${state.w > 1 ? `<span>最高第 ${x.peakRank || x.rank} 名</span>${x.daysSeen > 1 ? `<span>在榜 ${x.daysSeen} 天</span>` : ''}` : ''}${x.ai?.note ? `<span class="badge ai">AI 推荐</span>` : ''}</div>
            </div>
          </article>`;
        });
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
    const html = items.slice(0, state.shown).map(tpl).join('');
    return html + (items.length > state.shown ? `<button class="more" data-more>再看 ${Math.min(PAGE, items.length - state.shown)} 条（共 ${items.length}）</button>` : '');
  }

  function chipRow(el, list, cur, attr) {
    el.innerHTML = list.length ? [`<button class="chip ${!cur ? 'on' : ''}" data-${attr}="">全部</button>`, ...list.map(([k, n]) => `<button class="chip ${cur === k ? 'on' : ''}" data-${attr}="${esc(k)}">${esc(k)}<span class="n">${n}</span></button>`)].join('') : '';
  }

  async function render() {
    const d = await load(state.w);
    const T = TABS[state.tab];
    $('#updated').textContent = `更新于 ${clock(d.generatedAt)}`;
    document.querySelectorAll('#win button').forEach((b) => b.classList.toggle('on', +b.dataset.w === state.w));
    document.querySelectorAll('#tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === state.tab);
      const n = { news: d.news.length, video: d.videos.length, trend: d.trends.length, music: d.music.length }[b.dataset.tab];
      b.innerHTML = `${b.textContent.replace(/\d+$/, '').trim()}<span class="n">${n}</span>`;
    });
    renderPicks(d);
    chipRow($('#chips'), T.chips(d), state.f1, 'f1');
    chipRow($('#chips2'), T.chips2(d), state.f2, 'f2');
    $('#sort').innerHTML = T.sorts.map(([v, l]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${l}</option>`).join('');
    $('#list').innerHTML = T.render(d);
    location.replace(`#w=${state.w}&tab=${state.tab}`);
  }

  async function renderStatus() {
    try {
      const st = await fetch(`data/status.json?t=${Math.floor(Date.now() / 6e5)}`).then((r) => r.json());
      $('#status').innerHTML = `<div class="st">${Object.values(st.sources).map((s) => `<div><span>${esc(s.name)}</span><span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? `✓ ${s.count} 条` : `✗ 失败${s.lastOk ? `（上次成功 ${ago(s.lastOk)}）` : ''}`}</span></div>`).join('')}</div><div>最近采集：${clock(st.runAt)}</div>`;
    } catch { $('#status').textContent = '暂无'; }
  }

  // ---------- 交互 ----------
  const reset = () => { state.f1 = ''; state.f2 = ''; state.sort = ''; state.shown = PAGE; };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.w) { state.w = +b.dataset.w; state.pickDay = 0; state.shown = PAGE; render(); }
    else if (b.dataset.tab) { state.tab = b.dataset.tab; reset(); render(); }
    else if ('f1' in b.dataset) { state.f1 = b.dataset.f1; state.shown = PAGE; render(); }
    else if ('f2' in b.dataset) { state.f2 = b.dataset.f2; state.shown = PAGE; render(); }
    else if ('pickday' in b.dataset) { state.pickDay = +b.dataset.pickday; render(); }
    else if ('more' in b.dataset) { state.shown += PAGE; render(); }
  });
  let t;
  $('#q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); state.shown = PAGE; render(); }, 200); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });

  const setHeaderH = () => document.documentElement.style.setProperty('--hh', `${$('.top').offsetHeight}px`);
  addEventListener('resize', setHeaderH);
  setHeaderH();

  const h = new URLSearchParams(location.hash.slice(1));
  if ([1, 3, 7, 30].includes(+h.get('w'))) state.w = +h.get('w');
  if (TABS[h.get('tab')]) state.tab = h.get('tab');
  render().catch((e) => { $('#list').innerHTML = `<div class="none">数据加载失败：${esc(e.message)}</div>`; });
  renderStatus();
})();
