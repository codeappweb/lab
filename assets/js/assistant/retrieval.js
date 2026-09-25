/* Content retrieval over the build-time content index (assets/data/).
   Core index (content-index.json): title/url/desc/category/headings/parent/child.
   Full-text shards (content-index-cNN.json) are lazy-loaded per cluster —
   the scale strategy for thousands of articles. */
window.XDC = window.XDC || {};
(function (X) {
  'use strict';
  var BASE = document.documentElement.dataset.base || '';
  var cache = {};

  function norm(s) {
    return (s || '').toLowerCase()
      .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
      .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
      .replace(/[ìíịỉĩ]/g, 'i')
      .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
      .replace(/[ùúụủũưừứựửữ]/g, 'u')
      .replace(/[ỳýỵỷỹ]/g, 'y')
      .replace(/đ/g, 'd');
  }
  X.norm = norm;

  function terms(q) {
    return norm(q).split(/[^a-z0-9]+/).filter(function (t) { return t.length > 1; });
  }
  X.terms = terms;

  function fetchJSON(url) { return fetch(url).then(function (r) { return r.json(); }); }
  X.getCore = function () {
    if (!cache.core) cache.core = fetchJSON(BASE + '/assets/data/content-index.json');
    return cache.core;
  };
  X.getShard = function (cluster) {
    var key = 'shard:' + cluster;
    if (!cache[key]) cache[key] = fetchJSON(BASE + '/assets/data/content-index-' + String(cluster || '').toLowerCase() + '.json');
    return cache[key];
  };

  /* Rank core items against the query. Signals: exact/normalized title match,
     heading match, description match, child/parent category match, cluster match. */
  X.rank = function (query) {
    return X.getCore().then(function (core) {
      var ts = terms(query);
      if (!ts.length) return [];
      var scored = [];
      core.forEach(function (it) {
        var nTitle = norm(it.title), nDesc = norm(it.description || ''),
            nHead = norm((it.headings || []).join(' . ')), nCat = norm(it.category || ''),
            nPar = norm(it.parent || ''), nChi = norm(it.child || '');
        var s = 0;
        ts.forEach(function (t) {
          if (nTitle === t) s += 14;
          else if (nTitle.indexOf(t) !== -1) s += 8;
          if (nHead.indexOf(t) !== -1) s += 4;
          if (nDesc.indexOf(t) !== -1) s += 3;
          if (nChi.indexOf(t) !== -1) s += 3;
          if (nCat.indexOf(t) !== -1) s += 2;
          if (nPar.indexOf(t) !== -1) s += 2;
        });
        if (s > 0) scored.push({ item: it, score: s });
      });
      scored.sort(function (a, b) { return b.score - a.score; });
      return scored.slice(0, 5);
    });
  };

  /* Find the most query-relevant paragraph of an article via its cluster shard. */
  X.excerpt = function (item, query) {
    var ts = terms(query);
    return X.getShard(item.category).then(function (shard) {
      var doc = (shard.items || []).filter(function (d) { return d.url === item.url; })[0];
      if (!doc || !doc.text) return '';
      var paras = String(doc.text).split('. ');
      var best = '', bs = 0;
      paras.forEach(function (p) {
        if (!p || p.length < 25) return;
        var np = norm(p), c = 0;
        ts.forEach(function (t) { if (np.indexOf(t) !== -1) c++; });
        if (c > bs) { bs = c; best = p; }
      });
      if (!best && paras[0]) best = paras[0];
      if (best.length > 260) best = best.slice(0, 260).replace(/\s\S*$/, '') + '…';
      return best;
    }).catch(function () { return ''; });
  };
})(window.XDC);
