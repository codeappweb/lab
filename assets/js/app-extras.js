/* App extras: quick actions FAB, saved articles, share/copy, reading progress,
   article toolbar, recently viewed, homepage continue-reading. All localStorage,
   no accounts, no network beyond the lazy content index. */
(function () {
  'use strict';
  var KEY_SAVED = 'xdc-saved', KEY_RECENT = 'xdc-recent';
  var BASE = document.documentElement.dataset.base || '';
  var isArticle = !!document.querySelector('.article-body-wrap');
  var $ = function (s, c) { return (c || document).querySelector(s); };

  function read(k) { try { return JSON.parse(localStorage.getItem(k)) || []; } catch (e) { return []; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function pageMeta() {
    return { title: (document.querySelector('h1') ? document.querySelector('h1').textContent : document.title).trim(), url: location.pathname };
  }

  /* ---- toast ---- */
  var toastT;
  function toast(msg) {
    var t = $('#appToast');
    if (!t) { t = document.createElement('div'); t.id = 'appToast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('is-on');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('is-on'); }, 2200);
  }

  /* ---- saved / recent stores ---- */
  function isSaved(url) { return read(KEY_SAVED).some(function (x) { return x.url === url; }); }
  function toggleSave(meta) {
    var list = read(KEY_SAVED);
    if (list.some(function (x) { return x.url === meta.url; })) {
      list = list.filter(function (x) { return x.url !== meta.url; });
      write(KEY_SAVED, list); toast('Đã bỏ lưu bài viết');
    } else {
      list.unshift(meta); write(KEY_SAVED, list.slice(0, 30)); toast('Đã lưu bài viết');
    }
    syncSaveButtons();
  }
  function syncSaveButtons() {
    document.querySelectorAll('[data-tool="save"]').forEach(function (b) {
      b.classList.toggle('is-active', isSaved(location.pathname));
    });
  }
  if (isArticle) {
    var r = read(KEY_RECENT).filter(function (x) { return x.url !== location.pathname; });
    r.unshift({ title: pageMeta().title, url: location.pathname, ts: Date.now() });
    write(KEY_RECENT, r.slice(0, 8));
  }

  /* ---- sheets (saved list) ---- */
  var savedSheet = $('#savedSheet'), savedBackdrop = $('#savedBackdrop');
  function openSaved() {
    if (!savedSheet) return;
    renderSaved();
    savedSheet.hidden = false; if (savedBackdrop) savedBackdrop.hidden = false;
    requestAnimationFrame(function () { savedSheet.classList.add('is-open'); if (savedBackdrop) savedBackdrop.classList.add('is-open'); });
  }
  function closeSaved() {
    if (!savedSheet) return;
    savedSheet.classList.remove('is-open'); if (savedBackdrop) savedBackdrop.classList.remove('is-open');
    setTimeout(function () { savedSheet.hidden = true; if (savedBackdrop) savedBackdrop.hidden = true; }, 240);
  }
  function renderSaved() {
    var list = $('#savedList'); if (!list) return;
    list.textContent = '';
    var items = read(KEY_SAVED);
    if (!items.length) {
      var p = document.createElement('p'); p.className = 'sheet__empty'; p.textContent = 'Chưa có bài nào được lưu.';
      list.appendChild(p); return;
    }
    items.forEach(function (it) {
      var a = document.createElement('a');
      a.className = 'sheet-link'; a.href = it.url; a.textContent = it.title;
      a.addEventListener('click', closeSaved);
      list.appendChild(a);
    });
  }
  if (savedBackdrop) savedBackdrop.addEventListener('click', closeSaved);
  document.querySelectorAll('[data-saved-close]').forEach(function (b) { b.addEventListener('click', closeSaved); });

  /* ---- share / copy ---- */
  function copyLink() {
    var url = location.href;
    var done = function () { toast('Đã sao chép liên kết'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(fallback);
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Không sao chép được'); }
      document.body.removeChild(ta);
    }
  }
  function share() {
    var meta = pageMeta();
    if (navigator.share) {
      navigator.share({ title: meta.title, url: location.href }).catch(function () {});
    } else copyLink();
  }

  /* ---- quick actions ---- */
  var qaPanel = $('#qaPanel');
  document.querySelectorAll('[data-qa-open]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!qaPanel) return;
      var open = qaPanel.hidden;
      qaPanel.hidden = !open;
      if (open) { requestAnimationFrame(function () { qaPanel.classList.add('is-open'); }); }
      else qaPanel.classList.remove('is-open');
    });
  });
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-qa]');
    if (btn) {
      e.preventDefault();
      var id = btn.getAttribute('data-qa');
      if (qaPanel) { qaPanel.classList.remove('is-open'); qaPanel.hidden = true; }
      if (id === 'search') { var s = $('[data-search-open]'); if (s) s.click(); }
      else if (id === 'topics') { var t = $('[data-sheet-open]'); if (t) t.click(); }
      else if (id === 'assistant') { if (window.XDC && window.XDC.assistantOpen) window.XDC.assistantOpen(); else { var a2 = $('[data-assistant-open]'); if (a2) a2.click(); } }
      else if (id === 'latest') {
        if ($('#moi-nhat')) document.getElementById('moi-nhat').scrollIntoView({ behavior: 'smooth' });
        else location.href = BASE + '/#moi-nhat';
      }
      else if (id === 'saved') openSaved();
      else if (id === 'share') share();
      else if (id === 'copy') copyLink();
      else if (id === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    // close qa panel on outside click
    if (qaPanel && !qaPanel.hidden && !e.target.closest('#qaPanel') && !e.target.closest('[data-qa-open]')) {
      qaPanel.classList.remove('is-open'); qaPanel.hidden = true;
    }
  });

  /* ---- article toolbar ---- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-tool]');
    if (!btn) return;
    var id = btn.getAttribute('data-tool');
    if (id === 'save') toggleSave(pageMeta());
    else if (id === 'share') share();
    else if (id === 'copy') copyLink();
    else if (id === 'toc') {
      var mob = $('#tocMobile');
      if (mob && !mob.hidden) { mob.open = true; mob.scrollIntoView({ behavior: 'smooth' }); }
      else { var aside = $('.toc'); if (aside) aside.scrollIntoView({ behavior: 'smooth' }); }
    }
  });
  syncSaveButtons();

  /* ---- reading progress ---- */
  var bar = $('#readProgress');
  if (bar && isArticle) {
    var onProg = function () {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (h > 0 ? Math.min(100, (window.scrollY / h) * 100) : 0) + '%';
    };
    onProg();
    window.addEventListener('scroll', onProg, { passive: true });
  }

  /* ---- homepage: continue reading ---- */
  var recentSection = $('#doc-tiep'), recentList = $('#continueList');
  if (recentSection && recentList) {
    var items = read(KEY_RECENT);
    if (items.length) {
      recentSection.hidden = false;
      items.slice(0, 4).forEach(function (it) {
        var a = document.createElement('a');
        a.className = 'card card--compact';
        a.href = it.url;
        var t = document.createElement('h3'); t.className = 'card__title'; t.textContent = it.title;
        var m = document.createElement('span'); m.className = 'card__more'; m.textContent = 'Đọc tiếp';
        a.appendChild(t); a.appendChild(m);
        recentList.appendChild(a);
      });
    }
  }
})();
