/* Assistant providers.
   Default: "local" — grounded retrieval over the build-time content index.
   No API keys, no external AI calls.

   FUTURE ADAPTER (documented, intentionally inactive):
   To plug a real LLM later, deploy a serverless endpoint (Cloudflare Worker,
   Vercel function, etc.) that holds the API key server-side, then add:

     remote: {
       id: 'remote',
       endpoint: 'https://your-worker.example.com/assistant',
       async answer(query) {
         const r = await fetch(this.endpoint, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ query, index: 'assets/data/content-index.json' })
         });
         return r.json();
       }
     }

   and switch `active` to 'remote'. NEVER put an API key in this repository:
   GitHub Pages is fully public. The remote endpoint must inject its own secret.
*/
window.XDC = window.XDC || {};
(function (X) {
  'use strict';

  var local = {
    id: 'local',
    label: 'Trợ lý nội dung (local)',
    answer: function (query, scope) {
      return X.rank(query).then(function (scored) {
        // Article-scoped mode: boost the current page first.
        if (scope && scope.url) {
          scored = scored.slice().sort(function (a, b) {
            return (b.item.url === scope.url) - (a.item.url === scope.url);
          });
        }
        var hits = scored.filter(function (s) { return s.score >= 4; }).slice(0, 3);
        if (!hits.length) {
          return { confidence: 'low', results: [], suggestions: scored.slice(0, 2) };
        }
        return Promise.all(hits.map(function (h) {
          return X.excerpt(h.item, query).then(function (ex) {
            return { item: h.item, excerpt: ex, score: h.score };
          });
        })).then(function (results) {
          return { confidence: results[0].score >= 8 ? 'high' : 'medium', results: results, suggestions: [] };
        });
      });
    }
  };

  X.providers = { local: local, active: 'local' };
  X.answer = function (query, scope) {
    var p = X.providers[X.providers.active] || local;
    return p.answer(query, scope);
  };
})(window.XDC);
