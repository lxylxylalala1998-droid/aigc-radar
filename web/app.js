(() => {
  const $ = (s) => document.querySelector(s);
  const PLAT = { weibo: '微博', douyin: '抖音', bilibili: 'B站', qqmusic: 'QQ音乐', netease: '网易云' };
  const PSRC = { 抖音: 'douyin', B站: 'bilibili', 微博: 'weibo', QQ音乐: 'qqmusic', 网易云: 'netease' };
  const VTYPES = ['AI音乐', 'AI MV', 'AI歌手/艺人', 'AI鬼畜', 'AI影视', 'AI换人', 'AI动画', 'AI特效玩法', 'AI整活', 'AI教程测评'];
  const PAGE = 40;

  // day：在看哪一天的往期数据（'' = 不在往期模式）。往期按 24 小时的方式展示，所以 w 固定为 1
  const state = { w: 1, day: '', tab: 'douyin', sub: '', chip: '', q: '', sort: '', pickDay: 0, picksOpen: {}, shown: PAGE };
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
  const link = (url, inner, cls = '') => `<a href="${esc(url)}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ''}>${inner}</a>`;
  const cover = (u, src) => (!u ? '' : src === 'bilibili' && /hdslb\.com/.test(u) && !u.includes('@') ? `${u}@320w_200h_1c.webp` : u);
  const ana = (label, text) => (text ? `<div class="ana"><span class="mk">${label}</span>${esc(text)}</div>` : '');
  const match = (x, q) => !q || [x.title, x.author, x.desc, x.board, x.ai?.why, x.ai?.hook, x.ai?.tip, x.ai?.idea, x.ai?.use, x.ai?.event, x.summary].join(' ').toLowerCase().includes(q);
  const vtype = (x) => x.ai?.type || '未分类';
  const rankOf = (x) => x.peakRank || x.rank || 999;
  const more = (total, unit = '条') => (total > state.shown ? `<button class="more" data-more>再看 ${Math.min(PAGE, total - state.shown)} ${unit}（共 ${total} ${unit}）</button>` : '');
  const sheet = (rows) => (rows ? `<div class="sheet">${rows}</div>` : '<div class="none">没有符合条件的内容</div>');

  // key：w1 / w3 / w7 / w30，往期是 d/日期；days 是往期日期索引
  async function load(key) {
    if (!cache[key]) cache[key] = fetch(`data/${key}.json?t=${Math.floor(Date.now() / 6e5)}`).then((r) => { if (!r.ok) throw new Error(`没有这份数据（${r.status}）`); return r.json(); });
    return cache[key];
  }
  const dayLabel = (date) => { const d = new Date(`${date}T12:00:00+08:00`); return `${d.getMonth() + 1}月${d.getDate()}日`; };
  const weekOf = (date) => `周${WEEK[new Date(`${date}T12:00:00+08:00`).getDay()]}`;

  // ---------- 今日选题：抖音 10 个在左、B站 10 个在右，各用平台代表色框住；手机上上下排、各展开前 5 个 ----------
  function renderPicks(d) {
    const ds = d.digests || [];
    if (!ds.length) { $('#picks').innerHTML = `<div class="empty-note">${state.day ? `${dayLabel(state.day)}没有生成早报（那天 AI 日报没跑成），下面各板块的数据照常可以看。` : '这个时间段还没有 AI 选题日报，每天早上 9 点前生成。'}</div>`; return; }
    const i = Math.min(state.pickDay, ds.length - 1);
    const dg = ds[i];
    // 旧日报是一个混合列表（带 platform 字段），新日报按平台分开
    const byPlat = Array.isArray(dg.picks)
      ? { douyin: dg.picks.filter((p) => p.platform !== 'B站'), bilibili: dg.picks.filter((p) => p.platform === 'B站' || p.platform === '双平台') }
      : { douyin: dg.picks?.douyin || [], bilibili: dg.picks?.bilibili || [] };
    const dayChips = ds.length > 1 ? `<div class="day-chips">${ds.map((x, k) => `<button class="chip ${k === i ? 'on' : ''}" data-pickday="${k}">${+x.date.slice(5, 7)}月${+x.date.slice(8)}日</button>`).join('')}</div>` : '';
    const original = link(`archive/${dg.date}.html`, `看${state.day ? '当天' : ` ${+dg.date.slice(5, 7)}月${+dg.date.slice(8)}日 `}早报原文 →`, 'arch-link');
    const refs = (p) => (p.refs?.length ? `<div class="refs">${p.refs.map((r) => link(r.url, esc(r.title))).join('')}</div>` : '');
    const item = (p, k) => `
      <article class="pm ${k === 0 ? 'first' : ''}">
        <div class="no">${pad(k + 1)}</div>
        <div>
          <div class="tags">${tag(p.horizon, 'mark')}</div>
          <h3>${esc(p.title)}</h3>
          <p><span class="mk">为什么能火</span>${esc(p.why)}</p>
          <p><span class="mk">怎么做</span>${esc(p.how)}</p>
          ${refs(p)}
        </div>
      </article>`;
    const box = (s) => {
      const list = byPlat[s];
      const open = state.picksOpen[s];
      return `
      <section class="pbox ${s}">
        <header class="pbox-h"><h3>${PLAT[s]} · 今日选题</h3><span><b class="num">${list.length}</b> 个</span></header>
        ${list.length ? `<div class="pbox-list">${list.slice(0, 5).map(item).join('')}<div class="pbox-more ${open ? 'open' : ''}">${list.slice(5).map((p, k) => item(p, k + 5)).join('')}</div></div>
        ${list.length > 5 ? `<button class="more picks-toggle" data-picks="${s}">${open ? '收起' : `展开其余 ${list.length - 5} 个`}</button>` : ''}` : '<div class="none">这一天没有生成选题（AI 分析未开启或出错）</div>'}
      </section>`;
    };
    $('#picks').innerHTML = `
      <div class="sec-head"><h2>${state.day ? `${dayLabel(state.day)}选题` : ds.length > 1 ? 'AI 选题日报' : '今日选题'}</h2><small>AI 编辑${dg.ai ? `（${esc(dg.ai)}）` : ''}分别从抖音、B站的 24 小时 / 3 天 / 7 天 / 30 天热点里挑 · ${clock(dg.generatedAt)} · ${original}</small></div>
      ${dayChips}
      <div class="pick-cols">${box('douyin')}${box('bilibili')}</div>`;
  }

  // ---------- 视频条目（抖音 / B站共用）----------
  function videoRow(x) {
    const dy = x.src === 'douyin';
    return `
      <article class="item vid">
        <a class="th ph ${x.src}" href="${esc(x.url)}" target="_blank" rel="noopener" aria-label="打开视频"><span>${PLAT[x.src] || ''}</span>${x.cover ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(cover(x.cover, x.src))}" alt="" onerror="this.remove()">` : ''}${x.ai?.type ? `<span class="ty">${esc(x.ai.type)}</span>` : ''}</a>
        <div>
          <div class="tt">${link(x.url, esc(x.title))}</div>
          <div class="meta">${x.ai?.top ? tag('今日精选', 'hot') : ''}${x.m?.aiLabel ? tag({ 作者声明: '作者声明AI', 平台识别: '平台识别AI', AI特效: 'AI特效角标' }[x.m.aiLabel] || 'AI标', 'solid') : ''}<span>${esc(x.author || '')}</span>${x.m?.noDate ? '' : `<span>${ago(x.pubAt)}</span>`}${dy && /^(话题|热门视频榜|热点宝)/.test(x.board) ? `<span>${esc(x.board.replace('话题·', ''))}</span>` : ''}</div>
          <div class="stat">${dy && x.m?.play ? `<span>${x.m.playWin ? `近${x.m.playWin}天` : ''}${N(x.m.play)}播放</span>` : ''}<span>${N(x.heat)}${dy ? '赞' : '播放'}</span>${x.vel ? `<span class="up">+${N(x.vel)}${dy ? '赞' : ''}/小时</span>` : ''}${!dy && x.m?.like ? `<span>${N(x.m.like)}赞</span>` : ''}${dy && x.m?.share ? `<span>${N(x.m.share)}分享</span>` : ''}</div>
          ${ana('爆点', x.ai?.hook)}${ana('参考', x.ai?.tip)}
        </div>
      </article>`;
  }

  function videoTab(src) {
    const dy = src === 'douyin';
    return {
      lede: dy
        ? '抖音上的 AIGC 爆款，只收抖音官方标了 AI 的视频（作者声明「内容由 AI 生成」、平台识别为 AI 内容、AI 特效角标）。来源：抖音热点宝·视频热榜（近 1 / 3 / 7 天，标题含 AI / 即梦 / 可灵 / 豆包）+ 热榜话题下的视频。热度按点赞，热点宝的视频带真实播放数。'
        : 'B站上的 AIGC 爆款：关键词搜索 + 分区排行 + 综合热门。热度按播放。',
      subs: (d) => {
        const list = d.videos.filter((x) => x.src === src);
        return [['', '全部', list.length], ...VTYPES.concat('未分类').map((t) => [t, t, list.filter((x) => vtype(x) === t).length]).filter(([, , n]) => n)];
      },
      sorts: [['vel', '飙升最快'], ['heat', dy ? '点赞最高' : '播放最高'], ['time', '最新发布']],
      render(d) {
        const s = state.sort || (state.w === 1 ? 'vel' : 'heat');
        const key = s === 'vel' ? (x) => x.vel || 0 : s === 'heat' ? (x) => x.heat || 0 : (x) => x.pubAt || 0;
        const items = d.videos.filter((x) => x.src === src && (!state.sub || vtype(x) === state.sub) && match(x, state.q)).sort((a, b) => key(b) - key(a));
        return sheet(items.slice(0, state.shown).map(videoRow).join('')) + more(items.length);
      },
    };
  }

  // ---------- 热梗热搜：每个平台单独一张榜，按平台自己的排名连续编号 ----------
  const TREND_SUBS = [
    ['抖音热搜', (x) => x.src === 'douyin'],
    ['B站热搜', (x) => x.src === 'bilibili'],
    ['微博热搜', (x) => x.src === 'weibo'],
    ['抖音挑战', (x) => !!x.kind],
    ['热梗精选', (x) => !!x.ai?.tag],
  ];
  const TAG_ORDER = { 热梗: 0, AI相关: 1, 可借势: 2 };
  function trendRow(x, i, showPlat) {
    const r = x.peakRank || x.rank;
    const where = r ? `${showPlat ? PLAT[x.src] : ''}${state.w > 1 ? '最高' : ''}第 ${r} 名` : '实时上升';
    return `
      <article class="item row">
        <div class="rk ${i < 3 ? 'top' : ''}">${i + 1}</div>
        <div>
          <div class="tt">${link(x.url, esc(x.title))}</div>
          <div class="meta">${showPlat ? pb(x.src) : ''}<span>${where}</span>${tag(x.kind, 'solid')}${tag(x.ai?.tag, 'mark')}${x.label ? tag(x.label, 'hot') : ''}${x.heat ? `<span>热度 ${N(x.peakHeat || x.heat)}</span>` : ''}${x.kind && x.m?.fetched ? `<span>参与视频 ${x.m.aiVideos || 0}/${x.m.fetched} 条是 AI 做的</span>` : ''}${state.w > 1 && x.daysSeen > 1 ? `<span>在榜 ${x.daysSeen} 天</span>` : ''}${state.w > 1 ? `<span>${ago(x.lastSeen)}</span>` : ''}</div>
          ${ana('为什么火', x.ai?.why)}${ana(x.kind ? 'AI 跟拍' : 'AI 做法', x.ai?.idea)}
          ${(x.top || []).map((v) => link(v.url, `${N(v.like)}赞 ${v.ai ? tag('AI', 'mark') : ''}${esc(v.title || '（无文案）')}`, 'tv')).join('')}
        </div>
      </article>`;
  }

  // ---------- 热歌飙升：每个平台热歌榜 / 飙升榜各 TOP20，左右并排 ----------
  const MUSIC_SUBS = ['抖音', 'B站', 'QQ音乐', '网易云'];
  function songRow(x) {
    const r = state.w > 1 ? (x.peakRank || x.rank) : x.rank;
    return `
      <article class="item row">
        <div class="rk ${r <= 3 ? 'top' : ''}">${r}</div>
        <div>
          <div class="tt">${link(x.url, esc(x.title))} <small>— ${esc(x.author)}</small></div>
          <div class="meta">${x.label ? tag(x.label, x.label.startsWith('↓') ? '' : 'hot') : ''}${state.w > 1 ? `<span>最高第 ${x.peakRank || x.rank} 名</span>${x.daysSeen > 1 ? `<span>在榜 ${x.daysSeen} 天</span>` : ''}` : ''}</div>
          ${ana('为什么火', x.ai?.why)}${ana('可以做', x.ai?.use)}
        </div>
      </article>`;
  }

  const TABS = {
    douyin: videoTab('douyin'),
    bilibili: videoTab('bilibili'),
    trend: {
      lede: '抖音、B站、微博各自的热搜榜，按平台自己的排名编号；「抖音挑战」是抖音官方归类为玩法 / 挑战的词条；「热梗精选」是 AI 从三个平台里挑出的热梗、AI 相关和可借势的话题。',
      subs: (d) => TREND_SUBS.map(([k, f]) => [k, k, d.trends.filter(f).length]),
      defaultSub: '抖音热搜',
      sorts: [['rank', '排名'], ['days', '在榜天数']],
      render(d) {
        const f = (TREND_SUBS.find(([k]) => k === state.sub) || TREND_SUBS[0])[1];
        const cross = state.sub === '抖音挑战' || state.sub === '热梗精选';
        let items = d.trends.filter((x) => f(x) && match(x, state.q));
        if (state.sort === 'days') items.sort((a, b) => (b.daysSeen || 0) - (a.daysSeen || 0) || rankOf(a) - rankOf(b));
        else if (state.sub === '热梗精选') items.sort((a, b) => (TAG_ORDER[a.ai.tag] ?? 9) - (TAG_ORDER[b.ai.tag] ?? 9) || rankOf(a) - rankOf(b));
        else if (state.sub === '抖音挑战') items.sort((a, b) => (a.kind === '抖音挑战' ? 0 : 1) - (b.kind === '抖音挑战' ? 0 : 1) || rankOf(a) - rankOf(b));
        else items.sort((a, b) => rankOf(a) - rankOf(b));
        return sheet(items.slice(0, state.shown).map((x, i) => trendRow(x, i, cross)).join('')) + more(items.length);
      },
    },
    music: {
      lede: '四个平台的热歌榜和飙升榜各取前 20。QQ音乐、网易云日更；抖音、B站是周榜（B站没有官方飙升榜，按上期排名的升幅算）。',
      subs: (d) => MUSIC_SUBS.map((p) => [p, p, d.music.filter((x) => PLAT[x.src] === p).length]),
      defaultSub: '抖音',
      sorts: [],
      render(d) {
        const src = PSRC[state.sub] || 'douyin';
        const col = (kind) => {
          const list = d.music.filter((x) => x.src === src && (kind === '飙升榜') === x.board.includes('飙升') && match(x, state.q))
            .sort((a, b) => (state.w > 1 ? rankOf(a) - rankOf(b) : (a.rank || 99) - (b.rank || 99))).slice(0, 20);
          const weekly = src === 'douyin' || src === 'bilibili';
          return `<div class="col"><div class="group-h">${pb(src)}${kind} TOP20<small>${weekly ? '周榜' : '日更'}</small></div>${sheet(list.map(songRow).join(''))}</div>`;
        };
        return `<div class="cols">${col('热歌榜')}${col('飙升榜')}</div>`;
      },
    },
    news: {
      lede: '汇总量子位、36氪、IT之家、OpenAI、Google、DeepMind、Hugging Face、TechCrunch、The Verge、Hacker News 等来源，AI 把同一件事的多篇报道合并成一个事件。',
      subs: (d) => [['大事件', 'AI 归并的大事件', (d.digests || []).reduce((n, g) => n + (g.news || []).length, 0)], ['全部资讯', '全部资讯', d.news.length]],
      defaultSub: '大事件',
      sorts: [['time', '最新发布'], ['heat', '热度']],
      chips: (d) => (state.sub === '全部资讯' ? counts(d.news, (x) => x.src) : []),
      render(d) {
        if (state.sub !== '全部资讯') {
          const evs = (d.digests || []).flatMap((g) => (g.news || []).map((e) => ({ ...e, date: g.date }))).filter((e) => match({ title: e.title, summary: e.summary }, state.q));
          return sheet(evs.map((e) => `
            <article class="item event lv-${esc(e.level || '')}">
              <div class="meta">${e.level === '重磅' ? tag('重磅', 'hot') : tag(e.level)}${tag(e.kind)}${(d.digests || []).length > 1 ? `<span>${e.date.slice(5)}</span>` : ''}</div>
              <h3>${esc(e.title)}</h3>
              ${e.summary ? `<p>${esc(e.summary)}</p>` : ''}
              <div class="srcs">${(e.refs || []).map((r) => link(r.url, `<b>${esc(r.src)}</b>${esc(r.title)}`)).join('')}</div>
            </article>`).join(''));
        }
        let items = d.news.filter((x) => (!state.chip || x.src === state.chip) && match(x, state.q));
        if (state.sort === 'heat') items = items.sort((a, b) => (b.heat || 0) - (a.heat || 0));
        return sheet(items.slice(0, state.shown).map((x) => `
          <article class="item">
            <div class="tt">${link(x.url, esc(x.title))}</div>
            ${x.desc && x.board === 'HF 热门模型' ? `<div class="meta">${esc(x.desc)}</div>` : ''}
            <div class="meta">${tag(x.src)}<span>${ago(x.pubAt || x.firstSeen)}</span>${x.heat ? `<span>${x.board === 'HF 热门模型' ? '❤' : '▲'} ${N(x.heat)}</span>` : ''}${x.ai?.level ? tag(x.ai.kind || 'AI 事件', 'mark') : ''}</div>
          </article>`).join('')) + more(items.length, '篇');
      },
    },
  };

  function counts(list, key) {
    const m = new Map();
    for (const x of list) { const k = key(x); if (k) m.set(k, (m.get(k) || 0) + 1); }
    return [...m].map(([k, n]) => [k, n]);
  }

  // 往期日期条：只放最近 7 天的标签（新的在左），更早的（最多到 30 天前）用「更早」里的日期选择器选
  // 透明的日期输入框盖在「更早」上：手机点一下直接弹系统日期选择；电脑上点击时用 showPicker 弹出
  const RECENT_DAYS = 7;
  async function renderDays() {
    const box = $('#days');
    box.hidden = !state.day;
    if (!state.day) return;
    const days = await load('days');
    const recent = days.slice(0, RECENT_DAYS);
    const older = days.slice(RECENT_DAYS);
    const chip = (x) => `<button class="chip ${x.date === state.day ? 'on' : ''}" data-day="${x.date}">${dayLabel(x.date)}<small>${weekOf(x.date)}${x.digest ? '' : ' · 无早报'}</small></button>`;
    const picked = older.find((x) => x.date === state.day);
    const more = older.length ? `<span class="chip older ${picked ? 'on' : ''}">${picked ? `${dayLabel(picked.date)}<small>${weekOf(picked.date)}${picked.digest ? '' : ' · 无早报'}</small>` : `更早<small>最多 30 天前</small>`} ▾<input type="date" id="older-day" aria-label="选择更早的日期" min="${older[older.length - 1].date}" max="${older[0].date}" value="${picked ? picked.date : ''}"></span>` : '';
    box.innerHTML = recent.map(chip).join('') + more + (state.dayMiss ? `<span class="miss">${dayLabel(state.dayMiss)}那天没有数据（当天采集没跑成），换一天看看</span>` : '');
    box.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function render() {
    const d = await load(state.day ? `d/${state.day}` : `w${state.w}`);
    const T = TABS[state.tab];
    if (!state.sub && T.defaultSub) state.sub = T.defaultSub;
    const g = new Date(d.generatedAt);
    $('#updated').innerHTML = `<b class="num">${g.getMonth() + 1}.${g.getDate()}</b> 周${WEEK[g.getDay()]} · ${state.day ? '正在看往期 · 当天最后一次扫描' : '最近一次扫描'} <b class="num">${pad(g.getHours())}:${pad(g.getMinutes())}</b>`;
    document.querySelectorAll('#win button').forEach((b) => b.classList.toggle('on', state.day ? 'arch' in b.dataset : +b.dataset.w === state.w));
    await renderDays();
    const n = {
      douyin: d.videos.filter((x) => x.src === 'douyin').length, bilibili: d.videos.filter((x) => x.src === 'bilibili').length,
      trend: d.trends.length, music: d.music.length, news: (d.digests || []).reduce((s, x) => s + (x.news || []).length, 0) || d.news.length,
    };
    document.querySelectorAll('#tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === state.tab);
      b.innerHTML = `${b.textContent.replace(/\d+$/, '').trim()}<span class="n">${n[b.dataset.tab]}</span>`;
    });
    renderPicks(d);
    $('#subnav').innerHTML = T.subs(d).map(([k, label, c]) => `<button class="${state.sub === k ? 'on' : ''}" data-sub="${esc(k)}">${esc(label)}<span class="n">${c}</span></button>`).join('');
    $('#lede').textContent = T.lede;
    const chips = T.chips ? T.chips(d) : [];
    $('#chips').innerHTML = chips.length ? [`<button class="chip ${!state.chip ? 'on' : ''}" data-chip="">全部</button>`, ...chips.map(([k, c]) => `<button class="chip ${state.chip === k ? 'on' : ''}" data-chip="${esc(k)}">${esc(k)}<span class="n">${c}</span></button>`)].join('') : '';
    $('#sort').innerHTML = T.sorts.map(([v, l]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${l}</option>`).join('');
    $('#list').innerHTML = T.render(d);
    history.replaceState(null, '', `#w=${state.w}${state.day ? `&day=${state.day}` : ''}&tab=${state.tab}${state.sub ? `&sub=${encodeURIComponent(state.sub)}` : ''}`);
  }

  async function renderStatus() {
    try {
      const st = await fetch(`data/status.json?t=${Math.floor(Date.now() / 6e5)}`).then((r) => r.json());
      $('#status').innerHTML = `<div class="st">${Object.values(st.sources).map((s) => `<div><span>${esc(s.name)}</span><span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? `${s.count} 条` : `失败${s.lastOk ? `，上次成功 ${ago(s.lastOk)}` : ''}`}</span></div>`).join('')}</div><p>最近采集：${clock(st.runAt)}</p>`;
    } catch { $('#status').textContent = '暂无'; }
  }

  // ---------- 交互 ----------
  // 进入往期：默认看昨天（今天的就是「24 小时」）
  async function openArchive(fromTop) {
    const days = await load('days');
    if (!days.length) return;
    state.day ||= (days[1] || days[0]).date;
    state.w = 1; state.pickDay = 0; state.shown = PAGE; state.sort = '';
    await render();
    if (fromTop) $('#bar').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if ('arch' in b.dataset) openArchive(!!b.closest('.mast'));
    else if (b.dataset.day) { state.day = b.dataset.day; state.dayMiss = ''; state.pickDay = 0; state.shown = PAGE; render(); }
    else if (b.dataset.w) { state.day = ''; state.dayMiss = ''; state.w = +b.dataset.w; state.pickDay = 0; state.shown = PAGE; render(); }
    else if (b.dataset.tab) { state.tab = b.dataset.tab; state.sub = ''; state.chip = ''; state.sort = ''; state.shown = PAGE; render(); }
    else if ('sub' in b.dataset) { state.sub = b.dataset.sub; state.chip = ''; state.shown = PAGE; render(); }
    else if ('chip' in b.dataset) { state.chip = b.dataset.chip; state.shown = PAGE; render(); }
    else if ('pickday' in b.dataset) { state.pickDay = +b.dataset.pickday; render(); }
    else if ('picks' in b.dataset) { const k = b.dataset.picks; state.picksOpen[k] = !state.picksOpen[k]; render(); }
    else if ('more' in b.dataset) { state.shown += PAGE; render(); }
  });
  let t;
  $('#q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); state.shown = PAGE; render(); }, 200); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  // 「更早」日期选择器
  $('#days').addEventListener('click', (e) => {
    if (e.target.id !== 'older-day') return;
    try { e.target.showPicker(); } catch { /* 手机上点了本来就会弹，老浏览器不支持就退回默认行为 */ }
  });
  $('#days').addEventListener('change', async (e) => {
    if (e.target.id !== 'older-day' || !e.target.value) return;
    const days = await load('days');
    const v = e.target.value;
    if (days.some((x) => x.date === v)) { state.day = v; state.dayMiss = ''; state.pickDay = 0; state.shown = PAGE; }
    else state.dayMiss = v;
    render();
  });

  const h = new URLSearchParams(location.hash.slice(1));
  if ([1, 3, 7, 30].includes(+h.get('w'))) state.w = +h.get('w');
  if (/^\d{4}-\d{2}-\d{2}$/.test(h.get('day') || '')) { state.day = h.get('day'); state.w = 1; }
  if (TABS[h.get('tab')]) state.tab = h.get('tab');
  if (h.get('sub')) state.sub = h.get('sub');
  render().catch((e) => { $('#list').innerHTML = `<div class="none">数据加载失败：${esc(e.message)}，刷新一下试试。</div>`; });
  renderStatus();
})();
