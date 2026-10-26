(() => {
  const $ = (s) => document.querySelector(s);
  const PLAT = { weibo: '微博', douyin: '抖音', bilibili: 'B站', xiaohongshu: '小红书', qqmusic: 'QQ音乐', netease: '网易云' };
  const PSRC = { 抖音: 'douyin', B站: 'bilibili', 微博: 'weibo', 小红书: 'xiaohongshu', QQ音乐: 'qqmusic', 网易云: 'netease' };
  // 视频热度的单位：B站按播放，抖音、小红书按点赞
  const unit = (src) => (src === 'bilibili' ? '播放' : '赞');
  const VTYPES = ['AI音乐', 'AI MV', 'AI歌手/艺人', 'AI鬼畜', 'AI影视', 'AI换人', 'AI动画', 'AI特效玩法', 'AI整活', 'AI教程测评'];
  const PAGE = 40;

  // day：在看哪一天的往期数据（'' = 不在往期模式）。往期按 24 小时的方式展示，所以 w 固定为 1
  // picksOpen：手机上某个平台的选题框展开了后 5 个；pickOpen：哪些选题点开了完整做法
  const state = { w: 1, day: '', tab: 'picks', sub: '', chip: '', q: '', sort: '', pickDay: 0, picksOpen: {}, pickOpen: new Set(), shown: PAGE };
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

  // key：w1 / w3 / w7 / w30（往期是 d/日期）是「核心」：选题 + 各板块条数，几十 KB，先下；
  //      加 .v / .t / .m / .n 是视频 / 热搜 / 热歌 / 资讯，点到哪个板块再下；dg/日期 是某一天的选题；days 是往期日期索引
  async function load(key) {
    if (!cache[key]) {
      cache[key] = fetch(`data/${key}.json?t=${Math.floor(Date.now() / 6e5)}`)
        .then((r) => { if (!r.ok) throw new Error(`没有这份数据（${r.status}）`); return r.json(); })
        .catch((e) => { delete cache[key]; throw e; }); // 失败了不缓存，下次还能重试
    }
    return cache[key];
  }
  const PART = { douyin: 'v', bilibili: 'v', xiaohongshu: 'v', trend: 't', music: 'm', news: 'n' };
  const baseKey = () => (state.day ? `d/${state.day}` : `w${state.w}`);
  // 首屏出来后，后台把其它板块也下好，切换时不用等
  let prefetched = '';
  function prefetch(base) {
    if (prefetched === base) return;
    prefetched = base;
    setTimeout(() => ['v', 't', 'm', 'n'].forEach((p) => load(`${base}.${p}`).catch(() => {})), 1200);
  }

  // ---------- 小提示：点标签看含义（手机上没法鼠标悬停）----------
  let toastTimer;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  // ---------- 待做清单：存在自己的浏览器里，可以一键复制成选题单 ----------
  const TODO_KEY = 'aigc-radar-todo';
  const readTodo = () => { try { return JSON.parse(localStorage.getItem(TODO_KEY) || '[]'); } catch { return []; } };
  let todo = readTodo();
  const writeTodo = () => { try { localStorage.setItem(TODO_KEY, JSON.stringify(todo)); } catch { /* 无痕模式等存不了，只在这次打开期间有效 */ } };
  const savable = new Map(); // 渲染时登记：key → 存进清单的内容
  const saveBtn = (key, item) => {
    savable.set(key, item);
    const on = todo.some((t) => t.key === key);
    return `<button class="save ${on ? 'on' : ''}" data-save="${esc(key)}" title="${on ? '移出待做清单' : '加入待做清单'}" aria-label="${on ? '移出待做清单' : '加入待做清单'}">${on ? '★ 已加入' : '☆ 待做'}</button>`;
  };
  function todoCount() {
    $('#todo-n').textContent = todo.length;
    $('#todo-btn').hidden = !todo.length && $('#todo').hidden;
  }
  function toggleSave(key) {
    const had = todo.some((t) => t.key === key);
    if (had) todo = todo.filter((t) => t.key !== key);
    else if (savable.has(key)) { todo.unshift({ ...savable.get(key), key, savedAt: Date.now() }); if (todo.length === 1) toast('已加入待做清单，右下角可以查看、复制'); }
    writeTodo();
    document.querySelectorAll('[data-save]').forEach((b) => {
      if (b.dataset.save !== key) return;
      b.classList.toggle('on', !had);
      b.textContent = had ? '☆ 待做' : '★ 已加入';
    });
    todoCount();
    if (!$('#todo').hidden) renderTodo();
  }
  const todoText = () => ['【AIGC 选题待做清单】', ...todo.map((t, i) => [
    `${i + 1}. [${PLAT[t.src] || ''}] ${t.kind}：${t.title}`,
    t.why && `   为什么能火：${t.why}`, t.how && `   怎么做：${t.how}`, t.flow && `   工作流程：${t.flow}`, t.tools && `   工具链：${t.tools}`,
    t.hook && `   爆点：${t.hook}`, t.tip && `   参考：${t.tip}`, t.url && `   链接：${t.url}`,
  ].filter(Boolean).join('\n'))].join('\n\n');
  function renderTodo() {
    $('#todo-list').innerHTML = todo.length ? todo.map((t) => `
      <div class="td">
        <div class="td-h">${pb(t.src)}<span class="tag">${esc(t.kind)}</span><button class="td-x" data-save="${esc(t.key)}" aria-label="移出">移出</button></div>
        <div class="td-t">${t.url ? link(t.url, esc(t.title)) : esc(t.title)}</div>
        ${t.how || t.tip ? `<div class="td-s">${esc(t.how || t.tip)}</div>` : ''}
      </div>`).join('') : '<div class="none">还没有加入任何内容。选题和视频旁边点「☆ 待做」就能加进来。</div>';
  }
  const fmtDur = (s) => (!s ? '' : s >= 60 ? `${Math.floor(s / 60)}分${s % 60 ? `${s % 60}秒` : '钟'}` : `${s}秒`);
  const pct = (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;
  // 数据画像标签的含义（悬停显示）
  const PT_WHY = {
    低粉爆款: '作者粉丝很少（抖音不到 5 万 / B站不到 3 万 / 小红书不到 1 万）也爆了：靠内容本身，小号也能做',
    分享率高: '分享 / 点赞远高于同类：社交货币，大家想转给朋友，适合情绪共鸣、反差、梗',
    收藏率高: '收藏远高于同类：干货或想反复看，适合教程、合集、高质量画面',
    评论多: '评论远高于同类：有争议或强互动，适合抛问题、站队、求续集',
    点赞率高: '点赞 / 播放远高于同类：完成度和情绪都到位',
    弹幕多: '弹幕远高于同类：有名场面、梗密度高，适合鬼畜、二创',
  };
  const ptTags = (x) => (x.pt || []).map((k) => `<span class="tag pt ${k === '低粉爆款' ? 'low' : ''}" title="${esc(PT_WHY[k] || '')}" data-tip="${esc(`${k}：${PT_WHY[k] || ''}`)}">${esc(k)}</span>`).join('');
  // 时效标签颜色：刚起势橙、高峰期红、已饱和灰
  const TIMING_CLS = { 刚起势: 'warm', 高峰期: 'hot', 已饱和: '' };
  const dayLabel = (date) => { const d = new Date(`${date}T12:00:00+08:00`); return `${d.getMonth() + 1}月${d.getDate()}日`; };
  const weekOf = (date) => `周${WEEK[new Date(`${date}T12:00:00+08:00`).getDay()]}`;

  // ---------- 今日选题：抖音 10 个在左、B站 10 个在右，各用平台代表色框住；手机上上下排、各展开前 5 个 ----------
  // ---------- 3 分钟速览：今天最该做的 3 个 + 一句话风向 + 低粉爆款 + 信息差 ----------
  function briefHtml(dg) {
    const br = dg.brief;
    if (!br || !(br.top?.length || br.wind)) return '';
    return `
      <section class="brief">
        <div class="sec-head"><h2>3 分钟速览</h2><small>${dayLabel(dg.date)} · 先看这一块，点选题跳到下面的完整说明</small></div>
        ${br.wind ? `<p class="wind">${esc(br.wind)}</p>` : ''}
        <div class="brief-top">${(br.top || []).map((t, k) => `
          <button class="bt" data-jump="${t.src}:${t.i}">
            <span class="bt-no">${k + 1}</span>
            <span class="bt-body">
              <span class="tags">${pb(t.src)}${t.timing ? `<span class="tag ${TIMING_CLS[t.timing] ?? ''}">${esc(t.timing)}</span>` : ''}${t.kind === '教程测评' ? tag('教程测评', 'solid') : ''}${t.level ? tag(`难度${t.level}${t.time ? ` · ${t.time}` : ''}`) : ''}</span>
              <b>${esc(t.title)}</b>
              ${t.why ? `<span class="bt-why">${esc(t.why)}</span>` : ''}
            </span>
          </button>`).join('')}</div>
        ${br.low || br.gap ? `<div class="brief-more">
          ${br.low ? `<div><span class="mk">低粉爆款</span>${link(br.low.url, esc(br.low.title))}<small>${pb(br.low.src)} ${num(br.low.heat)}${unit(br.low.src)}${br.low.fans ? ` · 作者粉丝只有 ${num(br.low.fans)}` : ''}</small></div>` : ''}
          ${br.gap ? `<div><span class="mk">信息差</span>${link(br.gap.url, esc(br.gap.title))}<small>${PLAT[br.gap.src]}爆了、${PLAT[br.gap.to]}还没人做${br.gap.how ? `：${esc(br.gap.how)}` : ''}</small></div>` : ''}
        </div>` : ''}
      </section>`;
  }

  async function renderPicks(d) {
    const ds = d.digests || [];
    if (!ds.length) { $('#picks').innerHTML = `<div class="empty-note">${state.day ? `${dayLabel(state.day)}没有生成早报（那天 AI 日报没跑成），下面各板块的数据照常可以看。` : '这个时间段还没有 AI 选题日报，每天早上 9 点前生成。'}</div>`; return; }
    const i = Math.min(state.pickDay, ds.length - 1);
    // 最新一天的选题在核心数据里；切到别的日期再单独下那一天的
    const dg = i === 0 && d.dg0 ? d.dg0 : await load(`dg/${ds[i].date}`).catch(() => null);
    if (!dg) { $('#picks').innerHTML = '<div class="empty-note">这一天的选题加载失败，刷新一下试试。</div>'; return; }
    // 旧日报是一个混合列表（带 platform 字段），新日报按平台分开
    const byPlat = Array.isArray(dg.picks)
      ? { douyin: dg.picks.filter((p) => p.platform !== 'B站'), bilibili: dg.picks.filter((p) => p.platform === 'B站' || p.platform === '双平台') }
      : { douyin: dg.picks?.douyin || [], bilibili: dg.picks?.bilibili || [] };
    const dayChips = ds.length > 1 ? `<div class="day-chips">${ds.map((x, k) => `<button class="chip ${k === i ? 'on' : ''}" data-pickday="${k}">${+x.date.slice(5, 7)}月${+x.date.slice(8)}日</button>`).join('')}</div>` : '';
    const original = link(`archive/${dg.date}.html`, `看${state.day ? '当天' : ` ${+dg.date.slice(5, 7)}月${+dg.date.slice(8)}日 `}早报原文 →`, 'arch-link');
    const refs = (p) => (p.refs?.length ? `<div class="refs">${p.refs.map((r) => link(r.url, esc(r.title))).join('')}</div>` : '');
    // 选题卡片：左边是主要依据那条作品的封面（抖音竖版、B站横版），编号压在封面左上角，点封面直接看视频；
    // 右边从上到下：标题 → 标签 → 为什么能火 → 底部一行（展开做法 / 主要依据的数据 / 待做）。完整做法默认收起
    // 没有作品参考的选题（只借热搜 / 热歌的势），封面位置显示平台色块，写「热搜」「热歌」，点开是那条热搜 / 热歌
    const item = (p, k, s) => {
      const key = `${dg.date}:${s}:${k}`;
      const open = state.pickOpen.has(key);
      const mv = p.main?.url ? p.main : p.refs?.find((r) => r.kind === 'video');
      const r0 = p.refs?.[0];
      const src = mv?.src || s;
      const target = mv || r0;
      const label = mv ? PLAT[src] : r0?.kind === 'music' ? '热歌' : r0?.kind === 'trend' ? '热搜' : '选题';
      const inner = `<span class="ph-l">${label}</span>${mv?.cover ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(cover(mv.cover, src))}" alt="" onerror="this.remove()" onload="if(this.naturalWidth>this.naturalHeight)this.classList.add('wide')">` : ''}<b class="pm-no">${pad(k + 1)}</b>${mv ? '<i class="play" aria-hidden="true">▶</i>' : ''}`;
      return `
      <article class="pm ${open ? 'open' : ''}" id="pick-${s}-${k}">
        ${target ? `<a class="pm-cover th ph ${s}" href="${esc(target.url)}" target="_blank" rel="noopener" title="${esc(`${mv ? '主要依据：' : ''}${target.title}`)}">${inner}</a>` : `<div class="pm-cover th ph ${s}">${inner}</div>`}
        <div class="pm-body">
          <h3>${esc(p.title)}</h3>
          <div class="tags">${tag(p.horizon, 'line')}${p.timing ? `<span class="tag ${TIMING_CLS[p.timing.label] ?? ''}" title="${esc(p.timing.basis)}" data-tip="时效依据：${esc(p.timing.basis)}">${esc(p.timing.label)}</span>` : ''}${p.repeat ? `<span class="tag line" data-tip="前几天推荐过，但还在加速涨，今天新题材不够所以继续推">连续推荐</span>` : ''}${p.kind === '教程测评' ? tag('教程测评', 'solid') : ''}${p.form === '系列' ? tag('系列追更') : ''}${p.level ? tag(`难度${p.level}${p.time ? ` · ${p.time}` : ''}`) : ''}</div>
          <p><span class="mk">为什么能火</span>${esc(p.why)}</p>
          <div class="pm-more">
            <p><span class="mk">怎么做</span>${esc(p.how)}</p>
            ${p.flow || p.tools ? `<p><span class="mk">${p.flow ? '工作流程' : '工具链'}</span>${esc(p.flow || p.tools)}</p>` : ''}
            ${p.formula ? `<p><span class="mk">公式</span>${esc(p.formula)}${p.variants?.length ? `<span class="vars">换皮：${p.variants.map(esc).join(' / ')}</span>` : ''}</p>` : ''}
            ${p.risk ? `<p class="risk"><span class="mk">风险</span>${esc(p.risk)}</p>` : ''}
            ${p.timing ? `<p class="tmb">时效：${esc(p.timing.label)} · ${esc(p.timing.basis)}</p>` : ''}
            ${refs(p)}
          </div>
          <div class="pm-foot">
            <button class="pm-toggle" data-pexp="${esc(key)}" aria-expanded="${open}">${open ? '收起 ▴' : '展开做法 ▾'}</button>
            ${mv?.heat ? `<span class="pm-src">主要依据 ${num(mv.heat)}${unit(src)}</span>` : ''}
            ${saveBtn(`p:${dg.date}:${s}:${p.title}`, { kind: '选题', src: s, title: p.title, why: p.why, how: p.how, flow: p.flow, tools: p.flow ? undefined : p.tools, url: mv?.url || r0?.url })}
          </div>
        </div>
      </article>`;
    };
    const box = (s) => {
      const list = byPlat[s];
      const open = state.picksOpen[s];
      return `
      <section class="pbox ${s}">
        <header class="pbox-h"><h3>${PLAT[s]} · 今日选题</h3><span><b class="num">${list.length}</b> 个</span></header>
        ${list.length ? `<div class="pbox-list">${list.slice(0, 5).map((p, k) => item(p, k, s)).join('')}<div class="pbox-more ${open ? 'open' : ''}">${list.slice(5).map((p, k) => item(p, k + 5, s)).join('')}</div></div>
        ${list.length > 5 ? `<button class="more picks-toggle" data-picks="${s}">${open ? '收起' : `展开其余 ${list.length - 5} 个`}</button>` : ''}` : '<div class="none">这一天没有生成选题（AI 分析未开启或出错）</div>'}
        ${dg.rising?.[s]?.length ? `<div class="pbox-rising"><span class="mk">前几天推过 · 还在涨</span>${dg.rising[s].map((r) => (r.url ? link(r.url, esc(r.title)) : esc(r.title))).join('<i>·</i>')}</div>` : ''}
      </section>`;
    };
    // 跨平台信息差：一个平台爆了、另一个平台还没人做的题材
    const gapCol = (list, from, to) => (list?.length ? `<div class="gcol"><h4>${PLAT[from]}爆了 · ${PLAT[to]}还没人做</h4>${list.map((x) => `
        <div class="gap">
          <div class="tt">${link(x.url, esc(x.title))}</div>
          <div class="meta">${pb(x.src)}<span>${N(x.heat)}${unit(x.src)}</span>${x.ai?.type ? `<span>${esc(x.ai.type)}</span>` : ''}${ptTags(x)}</div>
          ${ana('为什么值得做', x.why)}${ana(`搬到${PLAT[to]}`, x.how)}
        </div>`).join('')}</div>` : '');
    const g = dg.gaps;
    const gaps = g && (g.toBilibili?.length || g.toDouyin?.length) ? `
      <section class="gaps">
        <div class="sub-head"><h3>跨平台信息差</h3><small>一个平台近 7 天的 AIGC 爆款，在另一个平台近 30 天的 AI 稿件里没找到同题材的。用同样的题材做原创，不是搬运</small></div>
        <div class="gap-cols">${gapCol(g.toBilibili, 'douyin', 'bilibili')}${gapCol(g.toDouyin, 'bilibili', 'douyin')}</div>
      </section>` : '';
    // 选题复盘：前几天推荐的选题，参考作品后来又涨了多少
    const rv = dg.review;
    const avg = rv?.items?.length ? rv.items.reduce((s, r) => s + r.perDay, 0) / rv.items.length : 0;
    const review = rv?.items?.length ? `
      <details class="review">
        <summary><b>选题复盘</b>　${dayLabel(rv.date)}推荐的 ${rv.items.length} 个选题，参考作品之后平均每天又涨 ${pct(avg)}${rv.byHorizon?.length ? `；按信号看：${rv.byHorizon.map((h) => `${esc(h.horizon)} ${pct(h.avg)}/天`).join('，')}` : ''}</summary>
        <div class="rv-list">${rv.items.map((r) => `
          <div class="rv"><span class="tag ${r.status === '继续涨' ? 'hot' : r.status === '放缓' ? 'mark' : ''}">${r.status}</span>${pb(r.src)}<span class="rv-t">${esc(r.title)}</span><span class="rv-n">${N(r.from)} → ${N(r.to)}　${pct(r.perDay)}/天</span>${link(r.ref.url, '参考作品 ↗', 'rv-a')}</div>`).join('')}</div>
        <p class="rv-note">每个选题按涨得最多的那条参考作品算（抖音、小红书按点赞，B站按播放）。「按信号看」统计了 ${rv.days.map(dayLabel).join('、')} 的选题，看哪类信号推荐的选题后劲更足。</p>
      </details>` : '';
    $('#picks').innerHTML = `${briefHtml(dg)}
      <div class="sec-head"><h2>${state.day ? `${dayLabel(state.day)}选题` : ds.length > 1 ? 'AI 选题日报' : '今日选题'}</h2><small>从抖音、B站 24 小时 / 3 天 / 7 天 / 30 天的热点里挑，也借鉴小红书爆款 · ${clock(dg.generatedAt)} · ${original}</small></div>
      ${dayChips}
      <div class="pick-cols">${box('douyin')}${box('bilibili')}</div>
      ${gaps}${review}`;
  }

  // ---------- 视频条目（抖音 / B站 / 小红书共用）----------
  function videoRow(x) {
    const dy = x.src === 'douyin';
    const bl = x.src === 'bilibili';
    const xhs = x.src === 'xiaohongshu';
    return `
      <article class="item vid ${x.src}">
        <a class="th ph ${x.src}" href="${esc(x.url)}" target="_blank" rel="noopener" aria-label="打开视频"><span>${PLAT[x.src] || ''}</span>${x.cover ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(cover(x.cover, x.src))}" alt="" onerror="this.remove()" onload="if(this.naturalWidth>this.naturalHeight)this.classList.add('wide')">` : ''}${x.ai?.type ? `<span class="ty">${esc(x.ai.type)}</span>` : ''}</a>
        <div>
          <div class="tt">${link(x.url, esc(x.title))}</div>
          <div class="meta">${x.ai?.top ? tag('今日精选', 'hot') : ''}${x.m?.aiLabel ? tag({ 作者声明: '作者声明AI', 平台识别: '平台识别AI', AI特效: 'AI特效角标' }[x.m.aiLabel] || 'AI标', 'solid') : ''}${ptTags(x)}<span>${esc(x.author || '')}</span>${x.m?.fans ? `<span>粉丝 ${num(x.m.fans)}</span>` : ''}${x.m?.noDate ? '' : `<span>${ago(x.pubAt)}</span>`}${x.m?.dur ? `<span>${fmtDur(x.m.dur)}</span>` : ''}${dy && /^(话题|热门视频榜|热点宝)/.test(x.board) ? `<span>${esc(x.board.replace('话题·', ''))}</span>` : ''}</div>
          <div class="stat">${dy && x.m?.play ? `<span>${x.m.playWin ? `近${x.m.playWin}天` : ''}${N(x.m.play)}播放</span>` : ''}${xhs && x.m?.read ? `<span>${N(x.m.read)}阅读</span>` : ''}<span>${N(x.heat)}${unit(x.src)}</span>${x.vel ? `<span class="up">+${N(x.vel)}${bl ? '' : '赞'}/小时</span>` : ''}${bl && x.m?.like ? `<span>${N(x.m.like)}赞</span>` : ''}${dy && x.m?.share ? `<span>${N(x.m.share)}分享</span>` : ''}${x.m?.fav ? `<span>${N(x.m.fav)}收藏</span>` : ''}${xhs && x.m?.comment ? `<span>${N(x.m.comment)}评论</span>` : ''}${saveBtn(`v:${x.id}`, { kind: '参考作品', src: x.src, title: x.title, url: x.url, hook: x.ai?.hook, tip: x.ai?.tip })}</div>
          ${x.m?.bgm ? `<div class="bgm">♪ BGM：${esc(x.m.bgm)}</div>` : ''}
          ${ana('爆点', x.ai?.hook)}${ana('参考', x.ai?.tip)}

        </div>
      </article>`;
  }

  const VIDEO_LEDE = {
    xiaohongshu: '小红书上的 AIGC 爆款，只收作者声明了「内容含 AI 生成」的视频笔记。来源：蒲公英内容广场「小红书热门」榜（近 7 天、标题或正文含 AI 的视频笔记 Top 100，经 TikHub），每天早上更新一次。热度按累计点赞，阅读量是小红书公开的累计阅读。「低粉爆款」= 作者粉丝不到 1 万、点赞过 5 万；「收藏率高 / 评论多」= 这项比例排进同类作品前 10%。',
  };
  function videoTab(src) {
    const dy = src === 'douyin';
    return {
      lede: VIDEO_LEDE[src] || (dy
        ? '抖音上的 AIGC 爆款，只收抖音官方标了 AI 的视频（作者声明「内容由 AI 生成」、平台识别为 AI 内容、AI 特效角标）。来源：抖音热点宝·视频热榜（近 1 / 3 / 7 天，标题含 AI 或常用 AI 工具名）+ 热榜话题下的视频。热度按累计点赞。「低粉爆款」= 作者粉丝不到 5 万、点赞过 10 万；「分享率高 / 收藏率高 / 评论多」= 这项比例排进同类作品前 10%，鼠标悬停看含义。'
        : 'B站上的 AIGC 爆款：关键词搜索 + 分区排行 + 综合热门（标题带 AI、投在 AI 分区、或 B站标了「含AI生成内容」的都收）。热度按播放。「低粉爆款」= UP 主粉丝不到 3 万、播放过 30 万；「点赞率高 / 收藏率高 / 弹幕多」= 这项比例排进同类作品前 10%。'),
      subs: (d) => {
        const list = d.videos.filter((x) => x.src === src);
        const low = list.filter((x) => x.pt?.includes('低粉爆款')).length;
        return [['', '全部', list.length], ...(low ? [['低粉爆款', '低粉爆款', low]] : []), ...VTYPES.concat('未分类').map((t) => [t, t, list.filter((x) => vtype(x) === t).length]).filter(([, , n]) => n)];
      },
      sorts: [['vel', '飙升最快'], ['heat', `${unit(src) === '赞' ? '点赞' : '播放'}最高`], ['time', '最新发布']],
      render(d) {
        const s = state.sort || (state.w === 1 ? 'vel' : 'heat');
        const key = s === 'vel' ? (x) => x.vel || 0 : s === 'heat' ? (x) => x.heat || 0 : (x) => x.pubAt || 0;
        const inSub = (x) => !state.sub || (state.sub === '低粉爆款' ? x.pt?.includes('低粉爆款') : vtype(x) === state.sub);
        const items = d.videos.filter((x) => x.src === src && inSub(x) && match(x, state.q)).sort((a, b) => key(b) - key(a));
        return sheet(items.slice(0, state.shown).map(videoRow).join('')) + more(items.length);
      },
    };
  }

  // ---------- 热梗热搜：每个平台单独一张榜，按平台自己的排名连续编号 ----------
  const TREND_SUBS = [
    ['抖音热搜', (x) => x.src === 'douyin'],
    ['B站热搜', (x) => x.src === 'bilibili'],
    ['微博热搜', (x) => x.src === 'weibo'],
    ['小红书热点', (x) => x.src === 'xiaohongshu'],
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
    xiaohongshu: videoTab('xiaohongshu'),
    trend: {
      lede: '抖音、B站、微博各自的热搜榜和小红书热点榜，按平台自己的排名编号（小红书热点每天早上更新一次，热度是「多少人在看」）；「抖音挑战」是抖音官方归类为玩法 / 挑战的词条；「热梗精选」是 AI 从各平台里挑出的热梗、AI 相关和可借势的话题。',
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
      lede: '四个平台的热歌榜和飙升榜各取前 20。QQ音乐、网易云日更；抖音、B站是周榜（B站没有官方飙升榜，按上期排名的升幅算）。「爆款BGM」是这个时间段里抖音 AIGC 作品用得最多的配乐（用原声的不算）。',
      subs: (d) => [...MUSIC_SUBS.map((p) => [p, p, d.music.filter((x) => PLAT[x.src] === p).length]), ['爆款BGM', 'AIGC 爆款BGM', (d.bgms || []).length]],
      defaultSub: '抖音',
      sorts: [],
      render(d) {
        if (state.sub === '爆款BGM') {
          const list = (d.bgms || []).filter((b) => match({ title: b.title, desc: b.best?.title }, state.q));
          return sheet(list.map((b, i) => `
            <article class="item row">
              <div class="rk ${i < 3 ? 'top' : ''}">${i + 1}</div>
              <div>
                <div class="tt">${link(`https://www.douyin.com/search/${encodeURIComponent(b.title.split(' - ')[0])}`, esc(b.title))}</div>
                <div class="meta"><span>${b.n} 条 AIGC 作品在用</span><span>合计 ${N(b.likes)} 赞</span></div>
                ${b.best ? `<div class="ana"><span class="mk">代表作</span>${link(b.best.url, esc(b.best.title))}　${N(b.best.heat)}赞</div>` : ''}
              </div>
            </article>`).join(''));
        }
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
      subs: (d) => [['大事件', 'AI 归并的大事件', (d.events || []).length], ['工具热度', '爆款工具榜', (d.tools || []).length], ['全部资讯', '全部资讯', d.news.length]],
      defaultSub: '大事件',
      sorts: [['time', '最新发布'], ['heat', '热度']],
      chips: (d) => (state.sub === '全部资讯' ? counts(d.news, (x) => x.src) : []),
      render(d) {
        // 爆款工具榜：这个时间段发布的 AIGC 作品里，标题 / 话题 / 简介提到各工具的作品数
        if (state.sub === '工具热度') {
          const list = d.tools || [];
          const max = Math.max(1, ...list.map((t) => t.n));
          const vs = (t) => (t.prev == null ? '' : !t.prev ? '<span class="up">新上榜</span>' : `<span class="${t.n >= t.prev ? 'up' : 'down'}">上期 ${t.prev}　${pct((t.n - t.prev) / t.prev)}</span>`);
          const hasPrev = list.some((t) => t.prev != null);
          return `<p class="list-note">只统计在标题、话题、简介里写了工具名的作品，大多数作品不写，所以看相对热度和涨跌。${hasPrev ? '「上期」是再往前同样天数里发布的作品。' : state.w === 3 || state.w === 7 ? '数据攒够两期后会显示和上一期的对比。' : '3 天、7 天范围会和上一期对比。'}</p>` + sheet(list.map((t, i) => `
            <article class="item row">
              <div class="rk ${i < 3 ? 'top' : ''}">${i + 1}</div>
              <div>
                <div class="tt"><b>${esc(t.name)}</b>　<span class="tool-n">${N(t.n)} 条作品</span>　${vs(t)}</div>
                <div class="bar-mini"><i style="width:${Math.round((t.n / max) * 100)}%"></i></div>
                <div class="meta"><span>抖音 ${t.douyin || 0}</span><span>B站 ${t.bilibili || 0}</span>${t.xiaohongshu ? `<span>小红书 ${t.xiaohongshu}</span>` : ''}</div>
                ${t.best ? `<div class="ana"><span class="mk">代表作</span>${pb(t.best.src)} ${link(t.best.url, esc(t.best.title))}　${N(t.best.heat)}${unit(t.best.src)}</div>` : ''}
              </div>
            </article>`).join(''));
        }
        if (state.sub !== '全部资讯') {
          const evs = (d.events || []).filter((e) => match({ title: e.title, summary: e.summary }, state.q));
          const multiDay = new Set((d.events || []).map((e) => e.date)).size > 1;
          return sheet(evs.map((e) => `
            <article class="item event lv-${esc(e.level || '')}">
              <div class="meta">${e.level === '重磅' ? tag('重磅', 'hot') : tag(e.level)}${tag(e.kind)}${multiDay ? `<span>${e.date.slice(5)}</span>` : ''}</div>
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

  // 已经往下翻过的话，回到当前板块开头：内容顶端刚好贴在固定菜单下面（固定元素的 offsetTop 会跟着滚动变，不能用）
  function toContentTop() {
    const el = state.tab === 'picks' ? $('#picks') : $('#listing');
    const y = el.getBoundingClientRect().top + window.scrollY - $('#bar').offsetHeight;
    if (window.scrollY > y) window.scrollTo({ top: Math.max(0, y) });
  }

  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    const base = baseKey();
    const d = await load(base);
    // 「今日选题」是菜单第一项：只显示速览 + 选题；其它菜单只显示对应板块的列表
    const isPicks = state.tab === 'picks';
    const T = TABS[state.tab];
    if (!isPicks && !state.sub && T.defaultSub) state.sub = T.defaultSub;
    const g = new Date(d.generatedAt);
    $('#updated').innerHTML = `<b class="num">${g.getMonth() + 1}.${g.getDate()}</b> 周${WEEK[g.getDay()]} · ${state.day ? '正在看往期 · 当天最后一次扫描' : '最近一次扫描'} <b class="num">${pad(g.getHours())}:${pad(g.getMinutes())}</b>`;
    document.querySelectorAll('#win button').forEach((b) => b.classList.toggle('on', state.day ? 'arch' in b.dataset : +b.dataset.w === state.w));
    await renderDays();
    const n = { ...(d.counts || {}), picks: (d.dg0?.picks?.douyin?.length || 0) + (d.dg0?.picks?.bilibili?.length || 0) || '' };
    document.querySelectorAll('#tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === state.tab);
      b.innerHTML = `${b.textContent.replace(/\d+$/, '').trim()}<span class="n">${n[b.dataset.tab] ?? ''}</span>`;
    });
    // 手机上菜单是横向滑动的一行：当前菜单滑到看得见的位置
    $('#tabs .on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    $('#picks').hidden = !isPicks;
    $('#listing').hidden = isPicks;
    if (isPicks) {
      await renderPicks(d);
      history.replaceState(null, '', `#w=${state.w}${state.day ? `&day=${state.day}` : ''}&tab=picks`);
      prefetch(base);
      return;
    }
    $('#lede').textContent = T.lede;
    // 当前板块的数据：没下过就先显示「加载中」
    const partKey = `${base}.${PART[state.tab]}`;
    if (!cache[partKey]) { $('#subnav').innerHTML = ''; $('#chips').innerHTML = ''; $('#list').innerHTML = '<div class="none">正在加载这个板块…</div>'; }
    const part = await load(partKey);
    if (seq !== renderSeq) return; // 加载期间又切到别处了，以最新的为准
    Object.assign(d, part);
    $('#subnav').innerHTML = T.subs(d).map(([k, label, c]) => `<button class="${state.sub === k ? 'on' : ''}" data-sub="${esc(k)}">${esc(label)}<span class="n">${c}</span></button>`).join('');
    $('#lede').textContent = T.lede;
    const chips = T.chips ? T.chips(d) : [];
    $('#chips').innerHTML = chips.length ? [`<button class="chip ${!state.chip ? 'on' : ''}" data-chip="">全部</button>`, ...chips.map(([k, c]) => `<button class="chip ${state.chip === k ? 'on' : ''}" data-chip="${esc(k)}">${esc(k)}<span class="n">${c}</span></button>`)].join('') : '';
    $('#sort').innerHTML = T.sorts.map(([v, l]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${l}</option>`).join('');
    $('#list').innerHTML = T.render(d);
    history.replaceState(null, '', `#w=${state.w}${state.day ? `&day=${state.day}` : ''}&tab=${state.tab}${state.sub ? `&sub=${encodeURIComponent(state.sub)}` : ''}`);
    prefetch(base);
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

  // 点带 data-tip 的标签（数据画像、时效）弹出含义
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) toast(t.dataset.tip);
  });

  function openGuide() {
    const g = $('#guide');
    g.hidden = false;
    g.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if ('save' in b.dataset) toggleSave(b.dataset.save);
    else if (b.dataset.pexp) {
      // 展开 / 收起一个选题的完整做法：只改这一条，不重画整页
      const key = b.dataset.pexp;
      const open = !state.pickOpen.has(key);
      if (open) state.pickOpen.add(key); else state.pickOpen.delete(key);
      b.closest('.pm').classList.toggle('open', open);
      b.setAttribute('aria-expanded', open);
      b.textContent = open ? '收起 ▴' : '展开做法 ▾';
    }
    else if ('themeToggle' in b.dataset) setTheme(THEMES[(THEMES.findIndex(([v]) => v === currentTheme()) + 1) % THEMES.length][0]);
    else if ('todo' in b.dataset) { const p = $('#todo'); p.hidden = !p.hidden; if (!p.hidden) renderTodo(); todoCount(); }
    else if ('todoCopy' in b.dataset) {
      const text = todoText();
      const fallback = () => { const ta = $('#todo-text'); ta.hidden = false; ta.value = text; ta.select(); toast('自动复制不了，文字已经选中，长按或 Ctrl+C 复制'); };
      if (!todo.length) toast('清单是空的');
      else if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast('已复制，可以直接粘贴到微信 / 飞书 / 备忘录'), fallback);
      else fallback();
    }
    else if ('todoClear' in b.dataset) { if (todo.length) { todo = []; writeTodo(); renderTodo(); todoCount(); render(); toast('清单已清空'); } }
    else if ('guide' in b.dataset) openGuide();
    else if ('guideClose' in b.dataset) { $('#guide').hidden = true; }
    else if (b.dataset.jump) {
      // 速览里点选题：展开对应平台的选题框，滚到那一条
      const [s, i] = b.dataset.jump.split(':');
      // 顺便把这个选题的完整做法展开
      const el0 = document.getElementById(`pick-${s}-${i}`);
      const key = el0?.querySelector('[data-pexp]')?.dataset.pexp;
      if (key) state.pickOpen.add(key);
      if ((+i >= 5 && !state.picksOpen[s]) || key) { if (+i >= 5) state.picksOpen[s] = true; render(); }
      setTimeout(() => { const el = document.getElementById(`pick-${s}-${i}`); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); } }, 120);
    }
    else if ('arch' in b.dataset) openArchive(!!b.closest('.mast'));
    else if (b.dataset.day) { state.day = b.dataset.day; state.dayMiss = ''; state.pickDay = 0; state.shown = PAGE; render(); }
    else if (b.dataset.w) { state.day = ''; state.dayMiss = ''; state.w = +b.dataset.w; state.pickDay = 0; state.shown = PAGE; render(); }
    else if (b.dataset.tab) {
      state.tab = b.dataset.tab; state.sub = ''; state.chip = ''; state.sort = ''; state.shown = PAGE;
      // 换菜单时回到内容开头（菜单固定在顶上，内容从它下面开始）
      render().then(toContentTop);
    }
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
  if (TABS[h.get('tab')] || h.get('tab') === 'picks') state.tab = h.get('tab');
  if (h.get('sub')) state.sub = h.get('sub');
  // ---------- 外观：跟随系统 / 深色 / 浅色，记在浏览器里（页面一开始的小脚本会先套上，避免闪一下）----------
  const THEMES = [['', '跟随系统'], ['dark', '深色'], ['light', '浅色']];
  const currentTheme = () => document.documentElement.dataset.theme || '';
  function setTheme(v) {
    if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme;
    try { if (v) localStorage.setItem('aigc-radar-theme', v); else localStorage.removeItem('aigc-radar-theme'); } catch { /* 存不了就只在这次打开期间有效 */ }
    const label = THEMES.find(([t]) => t === v)[1];
    const btn = $('#theme-btn');
    btn.textContent = `外观：${label}`;
    btn.title = '点一下切换：跟随系统 → 深色 → 浅色';
  }
  setTheme(currentTheme());

  const wantGuide = location.hash === '#guide';
  render().then(() => { if (wantGuide) openGuide(); }).catch((e) => { $('#list').innerHTML = `<div class="none">数据加载失败：${esc(e.message)}，刷新一下试试。</div>`; });
  renderStatus();
  todoCount();
  // 周报入口：有周报才显示
  load('weeks').then((w) => { if (w?.length) { const a = $('#week-link'); a.href = `archive/week-${w[0]}.html`; a.hidden = false; } }).catch(() => {});
})();
