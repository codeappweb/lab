/* Article reading enhancements — table scroll regions + heading permalinks.
   Loaded AFTER main.js so main.js builds the TOC from pristine heading text.
   This module is deliberately dependency-free and runs against an injectable
   (doc, win) pair: scripts/tests/article-runtime.test.mjs exercises it against
   a minimal DOM implementation (a DOM/browser environment, not just syntax
   checks) and asserts the contracts below.

   Contracts (all asserted by the runtime test):
   - enhanceArticle is IDEMPOTENT: repeated initialization never wraps a
     table twice and never creates duplicate heading links.
   - tables: 0, 1 or many — each wrapped exactly once in a labelled scroll
     region (role=region, tabindex=0, aria-label).
   - headings: 0, 1 or many eligible h2[id]/h3[id] — each gets exactly one
     .h-link; headings without ids are skipped.
   - clipboard feedback is HONEST: the "copied" state is applied only when a
     real copy succeeded (clipboard API resolves, or the execCommand fallback
     returns true). A failed copy never announces success.
   - no uncaught exceptions on any path.
*/
(function (global) {
  'use strict';

  function enhanceArticle(doc, win, opts) {
    opts = opts || {};
    var prose = (typeof opts.prose !== 'undefined') ? opts.prose
      : doc.querySelector('.article .prose, .prose');
    if (!prose) return { tablesWrapped: 0, headingsLinked: 0 };

    var tablesWrapped = 0;
    var headingsLinked = 0;

    // Wrap tables in a labelled scroll region (keeps wide tables usable at
    // 360px without widening the page). Idempotent: an already-wrapped table
    // (parent is .table-wrap) is skipped.
    var tables = prose.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      if (t.parentElement && t.parentElement.classList &&
          t.parentElement.classList.contains('table-wrap')) continue;
      var wrap = doc.createElement('div');
      wrap.className = 'table-wrap';
      wrap.setAttribute('role', 'region');
      wrap.setAttribute('tabindex', '0');
      wrap.setAttribute('aria-label', 'Bảng dữ liệu — có thể cuộn ngang');
      t.parentElement.insertBefore(wrap, t);
      wrap.appendChild(t);
      tablesWrapped++;
    }

    // Quiet heading permalinks (progressive enhancement; the Kramdown ids
    // keep anchors working without JS). Idempotent: a heading that already
    // contains .h-link is skipped.
    var reduce = !!(win.matchMedia && win.matchMedia &&
      win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var heads = prose.querySelectorAll('h2[id], h3[id]');
    for (var j = 0; j < heads.length; j++) {
      var h = heads[j];
      if (h.querySelector('.h-link')) continue;
      var a = doc.createElement('a');
      var headingText = (h.textContent || '').trim();
      a.className = 'h-link';
      a.setAttribute('href', '#' + h.id);
      a.textContent = '#';
      a.setAttribute('aria-label', 'Liên kết đến mục "' + headingText + '"');
      a.addEventListener('click', (function (anchor, heading) {
        return function (e) {
          e.preventDefault();
          try { win.history.replaceState(null, '', '#' + heading.id); } catch (err) { /* non-fatal */ }
          var url = win.location.href;
          var copied = function () {
            anchor.classList.add('is-copied');
            setTimeout(function () { anchor.classList.remove('is-copied'); }, 1600);
          };
          // HONEST feedback: only mark copied on an actual successful copy.
          // A failed clipboard call must never announce success.
          if (win.navigator.clipboard && win.navigator.clipboard.writeText) {
            win.navigator.clipboard.writeText(url).then(copied, function () { /* no announcement on failure */ });
          } else if (doc.queryCommandSupported && doc.queryCommandSupported('copy')) {
            // legacy fallback path — real copy attempt, feedback only on true
            try {
              var ta = doc.createElement('textarea');
              ta.value = url;
              ta.setAttribute('readonly', '');
              ta.style.position = 'absolute';
              ta.style.left = '-9999px';
              doc.body.appendChild(ta);
              ta.select();
              var ok = doc.execCommand('copy');
              doc.body.removeChild(ta);
              if (ok) copied();
            } catch (err2) { /* no announcement on failure */ }
          }
          heading.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        };
      })(a, h));
      h.appendChild(a);
      headingsLinked++;
    }

    return { tablesWrapped: tablesWrapped, headingsLinked: headingsLinked };
  }

  // Browser auto-run (deferred scripts execute in order after main.js).
  if (typeof document === 'object' && document &&
      typeof document.querySelector === 'function') {
    enhanceArticle(document, (typeof window === 'object' && window) || global);
  }

  // Test hook: the runtime regression test imports this file in Node and
  // calls the factory with its DOM implementation.
  global.XDCArticleEnhance = enhanceArticle;
})(typeof window === 'object' && window ? window : globalThis);
