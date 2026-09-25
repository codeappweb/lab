/* Blog AI Assistant UI — chat panel, focus trap, grounded answers only. */
(function () {
  'use strict';
  var panel = document.getElementById('assistantPanel');
  var backdrop = document.getElementById('assistantBackdrop');
  var body = document.getElementById('assistantBody');
  var input = document.getElementById('assistantInput');
  if (!panel) return;
  var context = null; // {url,title} when opened article-scoped

  function open(ctx) {
    context = ctx || null;
    panel.hidden = false; if (backdrop) { backdrop.hidden = false; }
    requestAnimationFrame(function () {
      panel.classList.add('is-open'); if (backdrop) backdrop.classList.add('is-open');
    });
    if (!body.children.length) welcome();
    setTimeout(function () { input && input.focus(); }, 60);
  }
  function close() {
    panel.classList.remove('is-open'); if (backdrop) backdrop.classList.remove('is-open');
    setTimeout(function () { panel.hidden = true; if (backdrop) backdrop.hidden = true; }, 240);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function bubble(kind, text) {
    var b = el('div', 'msg msg--' + kind, text);
    body.appendChild(b); body.scrollTop = body.scrollHeight;
    return b;
  }

  function welcome() {
    var b = bubble('bot', context
      ? 'Trợ lý nội dung. Bạn đang đọc «' + context.title + '» — hỏi thêm về bài này hoặc về bất kỳ chủ đề xe & di chuyển nào trong thư viện.'
      : 'Xin chào. Mình là trợ lý nội dung của thư viện — trả lời dựa trên các bài viết thực tế của site, kèm nguồn tham khảo.');
    var ex = el('div', 'chat-examples');
    ['Xe không nổ máy kiểm tra gì trước?', 'Lốp bị thủng nên vá hay thay?',
     'Xe máy bị nóng máy vì sao?', 'Tiếng hú khi chạy xe do đâu?'].forEach(function (q) {
      var btn = el('button', null, q);
      btn.type = 'button';
      btn.addEventListener('click', function () { input.value = q; send(); });
      ex.appendChild(btn);
    });
    b.appendChild(ex);
  }

  function typing() {
    var t = el('div', 'typing');
    t.innerHTML = '<i></i><i></i><i></i>';
    body.appendChild(t); body.scrollTop = body.scrollHeight;
    return t;
  }

  function resultCard(res) {
    var c = el('div', 'msg-card');
    var a = el('a', null, res.item.title);
    a.href = res.item.url;
    c.appendChild(a);
    if (res.item.category) {
      var badge = el('span', 'badge', res.item.category.toUpperCase());
      badge.style.marginLeft = '8px';
      c.appendChild(badge);
    }
    if (res.excerpt) {
      var p = el('p', null, res.excerpt);
      c.appendChild(p);
    }
    var more = el('a', 'card__more', 'Đọc bài đầy đủ');
    more.href = res.item.url;
    c.appendChild(more);
    return c;
  }

  function send() {
    var q = (input.value || '').trim();
    if (!q) return;
    input.value = '';
    bubble('user', q);
    var t = typing();
    window.XDC.answer(q, context ? { url: context.url } : null).then(function (ans) {
      body.removeChild(t);
      if (ans.confidence === 'low') {
        var b = bubble('bot', 'Chưa tìm thấy nội dung phù hợp trong thư viện. Bạn có thể thử tìm kiếm nhanh (Ctrl K) hoặc xem các chủ đề:');
        window.XDC.getCore().then(function (core) {
          var hubs = core.filter(function (i) { return i.kind === 'hub'; }).slice(0, 4);
          var ex = el('div', 'chat-examples');
          hubs.forEach(function (h) {
            var a = el('a', 'chip', h.title);
            a.href = h.url;
            ex.appendChild(a);
          });
          b.appendChild(ex);
          body.scrollTop = body.scrollHeight;
        });
        return;
      }
      var b = bubble('bot', ans.results.length > 1
        ? 'Theo thư viện, có ' + ans.results.length + ' bài liên quan:'
        : 'Theo thư viện, bài liên quan nhất:');
      ans.results.forEach(function (r) { b.appendChild(resultCard(r)); });
      var src = el('p', 'msg-src', 'Nguồn tham khảo: ' +
        ans.results.map(function (r, i) { return (i + 1) + '. ' + r.item.title; }).join(' · '));
      b.appendChild(src);
      body.scrollTop = body.scrollHeight;
    }).catch(function () {
      body.removeChild(t);
      bubble('bot', 'Không tải được chỉ mục nội dung. Thử lại sau.');
    });
  }

  window.XDC.assistantOpen = open;
  // Wire triggers (hero button, quick actions, article toolbar).
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-assistant-open]');
    if (!btn) return;
    e.preventDefault();
    open({
      url: btn.getAttribute('data-context-url') || null,
      title: btn.getAttribute('data-context-title') || null
    });
  });
  var sendBtn = document.getElementById('assistantSend');
  if (sendBtn) sendBtn.addEventListener('click', send);
  if (input) input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
  });
  var clearBtn = document.getElementById('assistantClear');
  if (clearBtn) clearBtn.addEventListener('click', function () {
    body.textContent = ''; context = null; welcome();
  });
  document.querySelectorAll('[data-assistant-close]').forEach(function (b) {
    b.addEventListener('click', close);
  });
  if (backdrop) backdrop.addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (panel.hidden) return;
    if (e.key === 'Escape') { close(); return; }
    // Focus trap
    if (e.key === 'Tab') {
      var f = Array.prototype.slice.call(panel.querySelectorAll('a, button, input')).filter(function (n) { return !n.disabled; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
})();
