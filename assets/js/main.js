(function () {
  'use strict';
  var doc = document.documentElement;
  var BASE = doc.dataset.base || '';
  var KEY = 'xdc-theme';
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  /* ---------- Theme ---------- */
  function applyTheme(t) { doc.dataset.theme = t; }
  function storedTheme() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  var toggleBtn = $('[data-theme-toggle]');
  var current = doc.dataset.theme || storedTheme() ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(current);
  if (toggleBtn) {
    toggleBtn.setAttribute('aria-pressed', current === 'dark' ? 'true' : 'false');
    toggleBtn.addEventListener('click', function () {
      var next = doc.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
      toggleBtn.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
    });
  }
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onScheme = function (e) {
      if (!storedTheme()) applyTheme(e.matches ? 'dark' : 'light');
    };
    if (mq.addEventListener) mq.addEventListener('change', onScheme);
    else if (mq.addListener) mq.addListener(onScheme);
  }

  /* ---------- App bar scroll state ---------- */
  var bar = $('#appBar');
  if (bar) {
    var onScroll = function () { bar.classList.toggle('is-scrolled', window.scrollY > 8); };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ---------- Search overlay ---------- */
  var overlay = $('#searchOverlay');
  var input = $('#searchInput');
  var resultsEl = $('#searchResults');
  var searchIndex = null;
  var activeIdx = -1;

  function openSearch(prefill) {
    if (!overlay) return;
    overlay.hidden = false;
    requestAnimationFrame(function () { overlay.classList.add('is-open'); });
    document.body.style.overflow = 'hidden';
    if (input) { input.value = prefill || ''; doSearch(); input.focus(); input.select(); }
  }
  function closeSearch() {
    if (!overlay || overlay.hidden) return;
    overlay.classList.remove('is-open');
    document.body.style.overflow = '';
    setTimeout(function () { overlay.hidden = true; }, 180);
    activeIdx = -1;
  }
  function fetchIndex() {
    if (searchIndex) return Promise.resolve(searchIndex);
    return fetch(BASE + '/assets/search.json').then(function (r) { return r.json(); })
      .then(function (d) { searchIndex = d; return d; });
  }
  function normalize(s) {
    return (s || '').toLowerCase()
      .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
      .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
      .replace(/[ìíịỉĩ]/g, 'i')
      .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
      .replace(/[ùúụủũưừứựửữ]/g, 'u')
      .replace(/[ỳýỵỷỹ]/g, 'y')
      .replace(/đ/g, 'd');
  }
  function doSearch() {
    if (!resultsEl) return;
    var q = normalize((input && input.value) || '').trim();
    fetchIndex().then(function (data) {
      var items = data;
      if (q) {
        var terms = q.split(/\s+/);
        items = data.filter(function (it) {
          var hay = normalize(it.title + ' ' + (it.desc || '') + ' ' + (it.cluster || ''));
          return terms.every(function (t) { return hay.indexOf(t) !== -1; });
        });
      }
      items = items.slice(0, 12);
      renderResults(items, q);
    }).catch(function () {
      resultsEl.textContent = '';
      var p = document.createElement('p');
      p.className = 'palette__empty';
      p.textContent = 'Không tải được chỉ mục tìm kiếm.';
      resultsEl.appendChild(p);
    });
  }
  function renderResults(items, q) {
    resultsEl.textContent = '';
    activeIdx = -1;
    if (!items.length) {
      var p = document.createElement('p');
      p.className = 'palette__empty';
      p.textContent = q ? 'Không tìm thấy kết quả.' : 'Nhập từ khóa để tìm kiếm.';
      resultsEl.appendChild(p);
      return;
    }
    items.forEach(function (it, i) {
      var a = document.createElement('a');
      a.className = 'search-result';
      a.href = it.url;
      var t = document.createElement('span');
      t.className = 'search-result__title';
      t.innerHTML = highlight(it.title, q);
      var m = document.createElement('span');
      m.className = 'search-result__meta';
      m.textContent = (it.kind === 'hub' ? 'Chủ đề' : 'Bài viết') + (it.cluster ? ' · ' + it.cluster.toUpperCase() : '');
      a.appendChild(t); a.appendChild(m);
      a.addEventListener('mouseenter', function () { setActive(i); });
      a.addEventListener('click', closeSearch);
      resultsEl.appendChild(a);
    });
    setActive(0);
  }
  function highlight(text, q) {
    var out = '';
    var src = text || '';
    if (!q) return escapeHtml(src);
    var nSrc = normalize(src); var nQ = normalize(q);
    var pos = 0; var idx;
    while ((idx = nSrc.indexOf(nQ, pos)) !== -1 && q.length) {
      out += escapeHtml(src.slice(pos, idx)) + '<mark>' + escapeHtml(src.substr(idx, q.length)) + '</mark>';
      pos = idx + q.length;
      if (nQ.length === 0) break;
    }
    out += escapeHtml(src.slice(pos));
    return out || escapeHtml(src);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setActive(i) {
    var nodes = $$('.search-result', resultsEl);
    if (i < 0 || i >= nodes.length) return;
    nodes.forEach(function (n, j) { n.classList.toggle('is-active', i === j); });
    nodes[i].scrollIntoView({ block: 'nearest' });
    activeIdx = i;
  }
  function moveActive(dir) {
    var nodes = $$('.search-result', resultsEl);
    if (!nodes.length) return;
    var next = activeIdx + dir;
    if (next < 0) next = nodes.length - 1;
    if (next >= nodes.length) next = 0;
    setActive(next);
  }

  if (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.hasAttribute('data-search-close')) closeSearch();
    });
    $$('[data-search-open]').forEach(function (btn) {
      btn.addEventListener('click', function () { openSearch(btn.dataset.search || ''); });
    });
    if (input) {
      var t = null;
      input.addEventListener('input', function () {
        clearTimeout(t); t = setTimeout(doSearch, 120);
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
        else if (e.key === 'Enter') {
          var nodes = $$('.search-result', resultsEl);
          if (nodes[activeIdx]) { e.preventDefault(); nodes[activeIdx].click(); }
        }
      });
    }
    document.addEventListener('keydown', function (e) {
      if (overlay.hidden) {
        if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
          e.preventDefault(); openSearch();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault(); openSearch();
        }
      } else if (e.key === 'Escape') {
        closeSearch();
      }
    });
  }
  var heroForm = $('#heroSearch');
  if (heroForm) {
    heroForm.addEventListener('submit', function (e) {
      e.preventDefault();
      openSearch((heroForm.querySelector('input') || {}).value || '');
    });
  }

  /* ---------- Topic sheet (mobile) ---------- */
  var sheet = $('#topicSheet');
  var backdrop = $('#sheetBackdrop');
  function openSheet() {
    if (!sheet) return;
    sheet.hidden = false; if (backdrop) backdrop.hidden = false;
    requestAnimationFrame(function () { sheet.classList.add('is-open'); if (backdrop) backdrop.classList.add('is-open'); });
    document.body.style.overflow = 'hidden';
    var first = sheet.querySelector('a'); if (first) first.focus();
  }
  function closeSheet() {
    if (!sheet) return;
    sheet.classList.remove('is-open'); if (backdrop) backdrop.classList.remove('is-open');
    document.body.style.overflow = '';
    setTimeout(function () { sheet.hidden = true; if (backdrop) backdrop.hidden = true; }, 200);
  }
  if (sheet) {
    $$('[data-sheet-open]').forEach(function (b) { b.addEventListener('click', openSheet); });
    if (backdrop) backdrop.addEventListener('click', closeSheet);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !sheet.hidden) closeSheet();
    });
  }

  /* ---------- Bottom nav active state ---------- */
  $$('.bottom-nav a').forEach(function (a) {
    var href = a.getAttribute('href');
    if (href && (href === location.pathname || (href !== BASE + '/' && location.pathname.indexOf(href) === 0))) {
      a.classList.add('is-active');
      a.setAttribute('aria-current', 'page');
    }
  });

  /* ---------- Table of contents ---------- */
  var prose = $('.prose');
  var tocNav = $('#tocNav');
  if (prose && tocNav) {
    var heads = $$('h2', prose).filter(function (h) { return h.id; });
    if (heads.length >= 3) {
      var ul = document.createElement('ul');
      heads.forEach(function (h) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = '#' + h.id;
        a.textContent = h.textContent;
        li.appendChild(a); ul.appendChild(li);
      });
      tocNav.appendChild(ul);
      var links = $$('a', tocNav);
      if ('IntersectionObserver' in window) {
        var obs = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (en.isIntersecting) {
              links.forEach(function (l) { l.classList.toggle('is-active', l.hash === '#' + en.target.id); });
            }
          });
        }, { rootMargin: '-80px 0px -70% 0px' });
        heads.forEach(function (h) { obs.observe(h); });
      }
      var tocAside = tocNav.closest('.toc');
      if (tocAside) tocAside.hidden = false;
      var mob = $('#tocMobileNav');
      if (mob) {
        var mclone = ul.cloneNode(true);
        mob.appendChild(mclone);
        var det = $('#tocMobile');
        if (det) det.hidden = false;
      }
    } else {
      var aside = tocNav.closest('.toc');
      if (aside) aside.remove();
      var det2 = $('#tocMobile');
      if (det2) det2.remove();
    }
  }

  /* ---------- Reading time ---------- */
  var rt = $('#readingTime');
  if (rt && prose) {
    var words = (prose.textContent || '').trim().split(/\s+/).length;
    rt.textContent = Math.max(1, Math.round(words / 200)) + ' phút đọc';
  }
})();
