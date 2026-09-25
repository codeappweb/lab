/* nav2.js — hybrid app menu: two-screen drawer, active states, footer accordion */
(function () {
  'use strict';
  var drawer = document.getElementById('navDrawer');
  var home = document.getElementById('navScrHome');
  var moreToggle = document.getElementById('navMoreToggle');

  function scr(slug) { return document.getElementById('navScr-' + slug); }
  function hideAllScreens() {
    if (!drawer) return;
    drawer.querySelectorAll('.nav-scr').forEach(function (s) { s.hidden = true; });
  }

  /* Reset to home screen each time the drawer opens */
  function resetToHome() {
    hideAllScreens();
    if (home) home.hidden = false;
  }
  if (drawer) {
    resetToHome();
    new MutationObserver(function () {
      if (!drawer.hidden) resetToHome();
    }).observe(drawer, { attributes: true, attributeFilter: ['hidden'] });
  }

  /* Level 1 → Level 2 */
  drawer && drawer.addEventListener('click', function (e) {
    var cat = e.target.closest('[data-nav-cat]');
    if (cat) {
      var s = scr(cat.getAttribute('data-nav-cat'));
      if (s) {
        hideAllScreens();
        s.hidden = false;
        var body = drawer.querySelector('.nav-drawer__body');
        if (body) body.scrollTop = 0;
        var back = s.querySelector('.nav-back');
        if (back) back.focus({ preventScroll: true });
      }
      return;
    }

    if (e.target.closest('[data-nav-back]')) {
      hideAllScreens();
      if (home) {
        home.hidden = false;
        var t = home.querySelector('[data-nav-cat]');
        if (t) t.focus({ preventScroll: true });
      }
      return;
    }

    /* Close drawer after choosing an action/link inside it */
    var act = e.target.closest('a, [data-qa]');
    if (act && drawer.contains(act) && !act.hasAttribute('data-nav-cat') && !act.closest('[data-nav-back]')) {
      var closer = drawer.querySelector('[data-nav-close]');
      if (closer) setTimeout(function () { closer.click(); }, 0);
    }
  });

  /* Xem thêm toggle */
  if (moreToggle) {
    moreToggle.addEventListener('click', function () {
      var expanded = moreToggle.getAttribute('aria-expanded') === 'true';
      moreToggle.setAttribute('aria-expanded', String(!expanded));
      moreToggle.querySelector('span').textContent = expanded ? 'Xem thêm' : 'Thu gọn';
      drawer.querySelectorAll('.nav-cat--more').forEach(function (b) {
        b.hidden = expanded;
      });
    });
  }

  /* Active states */
  function siteBase() {
    var b = document.documentElement.getAttribute('data-base') || '';
    return b.replace(/\/index\.html$/, '');
  }
  function markActive() {
    var here = location.pathname.replace(/\/index\.html$/, '');
    drawer && drawer.querySelectorAll('a[href]').forEach(function (a) {
      var u;
      try { u = new URL(a.href, location.origin); } catch (err) { return; }
      var p = u.pathname.replace(/\/index\.html$/, '');
      var isRoot = p === '/' || p === siteBase();
      a.classList.toggle('is-active', !isRoot && here === p);
    });
  }
  markActive();

  /* Footer: <details> open on desktop, closed on mobile */
  function syncFooter() {
    var desktop = window.matchMedia('(min-width: 900px)').matches;
    document.querySelectorAll('details.foot-sec').forEach(function (d) {
      d.open = desktop;
    });
  }
  if (document.querySelector('.site-footer')) {
    syncFooter();
    var rq;
    window.addEventListener('resize', function () {
      clearTimeout(rq);
      rq = setTimeout(syncFooter, 150);
    });
  }
})();
