/* nav2.js — nav UX cho taxonomy-rebalance-001 + menu-compaction-001.
   - Drawer: 6 nhóm accordion (một nhóm mở tại một thời điểm), mỗi cha là accordion con cấp 2.
   - Tự mở nhóm + chuyên mục chứa trang hiện tại, highlight active.
   - Khóa cuộn body khi drawer mở. Mega menu aria. */
(function () {
  'use strict';
  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(function () {
    var drawer = document.getElementById('navDrawer');
    if (drawer) {
      var mo = new MutationObserver(function () {
        document.body.classList.toggle('nav-lock', !drawer.hidden);
      });
      mo.observe(drawer, { attributes: true, attributeFilter: ['hidden'] });
    }
    var norm = function (u) { return (u || '').replace(/\/index\.html$/, ''); };
    var path = norm(location.pathname);
    var groups = Array.prototype.slice.call(document.querySelectorAll('details.nav-acc'));
    groups.forEach(function (g) {
      g.addEventListener('toggle', function () {
        if (g.open) groups.forEach(function (o) { if (o !== g) o.open = false; });
      });
      // một chuyên mục con mở tại một thời điểm trong cùng nhóm
      var subs = Array.prototype.slice.call(g.querySelectorAll('details.nav-sub'));
      subs.forEach(function (s) {
        s.addEventListener('toggle', function () {
          if (s.open) subs.forEach(function (o) { if (o !== s) o.open = false; });
        });
      });
    });
    // active state: mở nhóm + cha chứa link hiện tại
    var links = document.querySelectorAll('.nav-sub__panel a, .nav-acc__panel > a');
    Array.prototype.forEach.call(links, function (a) {
      if (norm(a.getAttribute('href')) === path) {
        a.classList.add('is-active');
        a.setAttribute('aria-current', 'page');
        var sub = a.closest('details.nav-sub');
        var grp = a.closest('details.nav-acc');
        if (sub) sub.open = true;
        if (grp) grp.open = true;
      }
    });
    var trig = document.querySelector('.mega-trigger');
    var wrap = document.querySelector('.mega-wrap');
    if (trig && wrap) {
      wrap.addEventListener('mouseenter', function () { trig.setAttribute('aria-expanded', 'true'); });
      wrap.addEventListener('mouseleave', function () { trig.setAttribute('aria-expanded', 'false'); });
      trig.addEventListener('focus', function () { trig.setAttribute('aria-expanded', 'true'); });
      trig.addEventListener('blur', function () { trig.setAttribute('aria-expanded', 'false'); });
    }
  });
})();
