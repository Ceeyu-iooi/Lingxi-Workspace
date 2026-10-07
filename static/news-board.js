(() => {
  'use strict';
  const paths = {
    all: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    baidu: '<path d="M13 3c1 5-5 5-3 10 2-1 3-3 4-4 4 4 6 7 3 10-3 4-11 2-11-3 0-4 5-6 7-13Z"/>',
    bili: '<rect x="3" y="7" width="18" height="14" rx="4"/><path d="m7 3 4 4m6-4-4 4M8 12v3m8-3v3m-7 3h6"/>',
    tech: '<rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4M10 10h4v4h-4Z"/>',
    world: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    study: '<path d="M12 6c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v15"/>',
    search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
    refresh: '<path d="M20 7a9 9 0 1 0 1 8M20 3v5h-5"/>',
    arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${Object.hasOwn(paths, name) ? paths[name] : paths.world}</svg>`;
  const safeURL = value => {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; }
    catch { return ''; }
  };

  function render(root, { load, esc, fmtTime }) {
    root.innerHTML = `<section class="hot-board" aria-label="近期热点">
      <header class="hot-heading"><div><h2>近期热点</h2><p>各平台榜单与近 7 天资讯</p></div>
        <button type="button" class="hot-refresh" id="btn-news-refresh">${icon('refresh')}<span>刷新热点</span></button></header>
      <div class="hot-toolbar"><nav class="hot-tabs" aria-label="热点来源"></nav>
        <label class="hot-search">${icon('search')}<input type="search" placeholder="搜索热点标题" aria-label="搜索热点标题" maxlength="120"></label></div>
      <p class="hot-notice" role="status" aria-live="polite">正在获取热点…</p>
      <div class="hot-grid" id="news-body" aria-busy="true"></div>
      <p class="hot-empty" hidden>没有匹配的热点，试试其他关键词。</p>
    </section>`;
    const board = root.querySelector('.hot-board'), grid = board.querySelector('.hot-grid');
    const tabs = board.querySelector('.hot-tabs'), search = board.querySelector('input');
    const refresh = board.querySelector('.hot-refresh'), notice = board.querySelector('.hot-notice');
    const cards = new Map(), buttons = new Map();
    let selected = 'all', groups = [], pending = false;
    const all = document.createElement('button');
    all.type = 'button'; all.dataset.source = 'all'; all.innerHTML = `${icon('all')}<span>全部</span>`;
    tabs.append(all); buttons.set('all', all);

    function cardFor(id) {
      if (cards.has(id)) return cards.get(id);
      const el = document.createElement('article');
      el.className = 'hot-card'; el.dataset.source = id;
      el.dataset.tone = ['baidu', 'bili', 'tech', 'world', 'study'].includes(id) ? id : 'world';
      el.innerHTML = `<header class="hot-card-head"><span class="hot-source-icon">${icon(id)}</span>
        <div><h3></h3><p class="hot-source-meta"></p></div><span class="hot-count"></span></header>
        <ol class="hot-list"></ol><p class="hot-source-empty" hidden></p>
        <footer class="hot-card-foot"><div class="hot-links"></div><button type="button" class="hot-more" aria-expanded="false">展开更多</button></footer>`;
      const card = { el, rows: new Map(), expanded: false, group: null, linksSignature: null };
      el.querySelector('.hot-more').onclick = () => { card.expanded = !card.expanded; filter(); };
      cards.set(id, card); grid.append(el);
      return card;
    }

    function update(id, group) {
      const card = cardFor(id), el = card.el;
      card.group = group;
      el.querySelector('h3').textContent = group.name;
      const snapshot = group.items.some(item => item.capturedAt);
      const kind = snapshot ? '榜单快照' : group.ranking ? '近 7 天热门视频' : '近 7 天资讯';
      el.querySelector('.hot-source-meta').textContent = `${kind} · ${group.fetchedAt ? fmtTime(group.fetchedAt) + '获取' : '尚未获取'}`;
      const links = group.links.filter(link => safeURL(link.url));
      const signature = JSON.stringify(links);
      if (card.linksSignature !== signature) {
        el.querySelector('.hot-links').innerHTML = links.map(link => `<a href="${esc(safeURL(link.url))}" target="_blank" rel="noopener noreferrer">${esc(link.name)}${icon('arrow')}</a>`).join('');
        card.linksSignature = signature;
      }
      const list = el.querySelector('.hot-list'), retained = new Set();
      group.items.forEach(item => {
        const url = safeURL(item.link);
        if (!url || !item.title || retained.has(url)) return;
        retained.add(url);
        let row = card.rows.get(url);
        if (!row) {
          row = document.createElement('li');
          row.innerHTML = `<a class="hot-story" target="_blank" rel="noopener noreferrer"><span class="hot-rank" aria-hidden="true"></span><span class="hot-story-body"><span class="hot-story-title"></span><span class="hot-story-meta"></span></span>${icon('arrow')}</a>`;
          card.rows.set(url, row);
        }
        row._item = item;
        const a = row.querySelector('a'); a.href = url;
        row.querySelector('.hot-story-title').textContent = item.title;
        const rank = Number.isInteger(item.rank) && item.rank > 0 ? item.rank : null;
        const isRanking = snapshot || group.ranking;
        row.dataset.leading = String(isRanking && rank !== null && rank <= 3);
        row.querySelector('.hot-rank').textContent = isRanking && rank !== null ? String(rank).padStart(2, '0') : '·';
        a.setAttribute('aria-label', `${isRanking && rank !== null ? '第 ' + rank + ' 名，' : ''}${item.title}`);
        a.title = item.title;
        row.querySelector('.hot-story-meta').textContent = [item.source || group.name, item.capturedAt ? '' : fmtTime(item.publishedAt || item.date)].filter(Boolean).join(' · ');
      });
      for (const [url, row] of card.rows) if (!retained.has(url)) { row.remove(); card.rows.delete(url); }
      let cursor = list.firstElementChild;
      for (const url of retained) {
        const row = card.rows.get(url);
        if (row !== cursor) list.insertBefore(row, cursor);
        cursor = row.nextElementSibling;
      }
    }

    function filter() {
      const keyword = search.value.trim().toLocaleLowerCase();
      for (const [id, button] of buttons) {
        button.classList.toggle('on', selected === id);
        button.setAttribute('aria-pressed', String(selected === id));
      }
      let visible = 0;
      for (const [id, card] of cards) {
        const matches = [...card.rows.values()].filter(row => [row._item.title, row._item.source, card.group.name].join(' ').toLocaleLowerCase().includes(keyword));
        const included = selected === 'all' || selected === id;
        card.el.hidden = !included || Boolean(keyword && !matches.length);
        if (!card.el.hidden) visible++;
        const shown = new Set(card.expanded ? matches : matches.slice(0, 6));
        card.rows.forEach(row => { row.hidden = !shown.has(row); });
        card.el.querySelector('.hot-count').textContent = `${matches.length} 条`;
        const empty = card.el.querySelector('.hot-source-empty');
        empty.hidden = matches.length > 0;
        empty.textContent = card.group.hasFeeds ? '暂无近期内容，可刷新或打开平台。' : '此来源仅提供平台入口。';
        const more = card.el.querySelector('.hot-more');
        more.hidden = matches.length <= 6;
        more.textContent = card.expanded ? '收起' : `展开 ${matches.length - 6} 条`;
        more.setAttribute('aria-expanded', String(card.expanded));
      }
      board.querySelector('.hot-empty').hidden = !keyword || visible > 0;
    }

    tabs.onclick = event => {
      const button = event.target.closest('button[data-source]');
      if (!button || !tabs.contains(button)) return;
      selected = button.dataset.source; filter();
    };
    search.oninput = filter;

    async function reload(force) {
      if (pending) return;
      pending = true; refresh.disabled = true; grid.setAttribute('aria-busy', 'true');
      refresh.querySelector('span').textContent = '正在刷新';
      notice.textContent = groups.length ? '正在更新，保留当前热点…' : '正在获取热点…';
      notice.dataset.error = 'false';
      try {
        const data = await load(force);
        if (!board.isConnected || !root.contains(board)) return;
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid news response');
        groups = Object.entries(data || {}).filter(([id, group]) => id !== 'all' && group && typeof group === 'object').map(([id, group]) => [id, {
          ...group, name: String(group.name || id), items: Array.isArray(group.items) ? group.items.filter(item => item && typeof item === 'object') : [], links: Array.isArray(group.links) ? group.links.filter(link => link && typeof link === 'object') : [],
        }]);
        const ids = new Set(groups.map(([id]) => id));
        for (const [id, card] of cards) if (!ids.has(id)) { card.el.remove(); cards.delete(id); buttons.get(id)?.remove(); buttons.delete(id); }
        if (selected !== 'all' && !ids.has(selected)) selected = 'all';
        groups.forEach(([id, group]) => {
          if (!buttons.has(id)) {
            const button = document.createElement('button'); button.type = 'button'; button.dataset.source = id;
            button.innerHTML = `${icon(id)}<span></span>`; tabs.append(button); buttons.set(id, button);
          }
          buttons.get(id).querySelector('span').textContent = group.name;
          update(id, group);
        });
        filter();window.workbenchDesign?.reveal(root);
        const available = [...cards.values()].filter(card => card.rows.size > 0).length;
        notice.textContent = available ? `${available} / ${groups.length} 个来源有近期内容 · 点击标题阅读原文` : groups.length ? '暂未获取到近期内容，可打开平台或稍后刷新。' : '尚未配置热点来源。';
      } catch {
        if (!board.isConnected || !root.contains(board)) return;
        notice.dataset.error = 'true';
        notice.textContent = groups.length ? '更新失败，仍显示上次内容。请稍后刷新。' : '热点加载失败，请检查连接后刷新。';
      } finally {
        pending = false; refresh.disabled = false; grid.setAttribute('aria-busy', 'false');
        refresh.querySelector('span').textContent = '刷新热点';
      }
    }
    refresh.onclick = () => reload(true);
    filter();
    return reload(false);
  }
  window.newsBoard = { render };
})();
