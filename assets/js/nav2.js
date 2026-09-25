/* nav2.js — bổ sung cho taxonomy-rebalance-001.
   Accordion drawer (mở một cha tại một thời điểm, tự mở mục hiện tại), khóa cuộn body, aria mega menu. */
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
    var accs = Array.prototype.slice.call(document.querySelectorAll('details.nav-acc'));
    accs.forEach(function (d) {
      d.addEventListener('toggle', function () {
        if (d.open) accs.forEach(function (o) { if (o !== d) o.open = false; });
      });
    });
    var path = location.pathname.replace(/\/index\.html$/, '');
    accs.forEach(function (d) {
      var hit = false;
      Array.prototype.forEach.call(d.querySelectorAll('.nav-acc__panel a'), function (a) {
        var href = (a.getAttribute('href') || '').replace(/\/index\.html$/, '');
        if (href && path === href) { a.classList.add('is-active'); a.setAttribute('aria-current', 'page'); hit = true; }
      });
      if (hit) d.open = true;
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
