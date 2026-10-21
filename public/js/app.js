// Progressive enhancement only: every feature also works without JavaScript.
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  // Mobile navigation
  var toggle = $('.nav-toggle'), nav = $('#main-nav');
  if (toggle && nav) toggle.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // Confirm dangerous actions
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // Search suggestions (public API, privacy-filtered on the server)
  $$('[data-suggest]').forEach(function (form) {
    var input = $('input[type=search]', form), box = $('.suggest', form);
    if (!input || !box) return;
    var timer, ctrl, idx = -1;
    var branch = form.getAttribute('data-branch') || '';
    function close() { box.classList.add('hidden'); box.innerHTML = ''; idx = -1; }
    function render(data) {
      var html = '';
      data.boys.forEach(function (b) {
        html += '<a role="option" href="' + esc(b.url) + '">' + (b.thumb ? '<img class="avatar" src="' + esc(b.thumb) + '" alt="">' : '<span class="avatar">' + esc(b.name.charAt(0)) + '</span>') +
          '<span><strong>' + esc(b.name) + '</strong><br><span class="small muted">' + esc(b.branch.name) + '</span></span><span class="tag">בחור</span></a>';
      });
      data.occasions.slice(0, 6).forEach(function (o) {
        html += '<a role="option" href="' + esc(o.url) + '"><span><strong>' + esc(o.boy.name) + '</strong><br><span class="small muted">' + esc(o.date.hebrew) + ' · ' + esc(o.branch.name) + '</span></span><span class="tag cat-' + esc(o.category.kind) + '">' + esc(o.category.name) + '</span></a>';
      });
      if (!html) html = '<div class="empty small">קיין רעזולטאטן</div>';
      else html += '<a role="option" href="/search?q=' + encodeURIComponent(input.value) + (branch ? '&branch=' + branch : '') + '"><span>ווייזן אלע ' + data.total + ' רעזולטאטן ›</span></a>';
      box.innerHTML = html;
      box.classList.remove('hidden');
    }
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) return close();
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        ctrl = window.AbortController ? new AbortController() : null;
        fetch('/api/search?q=' + encodeURIComponent(q) + (branch ? '&branch=' + branch : ''), ctrl ? { signal: ctrl.signal } : {})
          .then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) render(d); }).catch(function () {});
      }, 200);
    });
    input.addEventListener('keydown', function (e) {
      var items = $$('a', box);
      if (!items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach(function (a, i) { a.classList.toggle('active', i === idx); });
      } else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); location.href = items[idx].href; }
      else if (e.key === 'Escape') close();
    });
    document.addEventListener('click', function (e) { if (!form.contains(e.target)) close(); });
  });

  // Calendar navigation without full page reloads
  function bindCalendar(root) {
    root.addEventListener('click', function (e) {
      var a = e.target.closest('a[data-frag]');
      if (!a) return;
      e.preventDefault();
      load(a.getAttribute('data-frag'), a.getAttribute('href'), a.classList.contains('day'));
    });
    root.addEventListener('submit', function (e) {
      var f = e.target.closest('[data-cal-jump]');
      if (!f) return;
      e.preventDefault();
      var a = $('a[data-frag]', f);
      var base = (a.getAttribute('data-frag') || '').replace(/y=[^&]*&m=[^&]*/, 'y=' + f.y.value + '&m=' + f.m.value);
      var href = f.getAttribute('action').split('#')[0] + '?y=' + f.y.value + '&m=' + f.m.value + (f.branch ? '&branch=' + f.branch.value : '') + '#calendar';
      load(base, href, false);
    });
    function load(url, href, focusDay) {
      root.setAttribute('aria-busy', 'true');
      fetch(url).then(function (r) { if (!r.ok) throw new Error(); return r.text(); }).then(function (html) {
        root.innerHTML = html;
        root.removeAttribute('aria-busy');
        if (history.replaceState) history.replaceState(null, '', href);
        if (focusDay) { var p = $('#day-panel', root); if (p) { p.focus(); p.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } }
      }).catch(function () { location.href = href; });
    }
  }
  $$('[data-cal-root]').forEach(bindCalendar);

  // ---------- admin: boy picker ----------
  var picker = $('[data-boy-picker]');
  if (picker) {
    var pInput = $('[data-picker-input]', picker), pResults = $('[data-picker-results]', picker), pId = $('input[name=boyId]', picker),
      pChosen = $('[data-picker-chosen]', picker), pNew = $('[data-new-boy]'), pBranch = $('select[name=branch]');
    var pTimer;
    var show = function (name, branchName) {
      pChosen.innerHTML = '<span>נאכגעקליבן: <strong>' + esc(name) + '</strong> · ' + esc(branchName || '') + '</span> <button type="button" class="btn ghost sm" data-clear>טוישן</button>';
      pChosen.classList.remove('hidden');
      if (pNew) pNew.classList.add('hidden');
    };
    picker.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-id]');
      if (b) {
        pId.value = b.getAttribute('data-id');
        show(b.getAttribute('data-name'), b.getAttribute('data-branch-name'));
        if (pBranch && !pBranch.getAttribute('data-touched')) pBranch.value = b.getAttribute('data-branch');
        pResults.innerHTML = ''; pInput.value = '';
      }
      if (e.target.closest('[data-clear]')) { pId.value = ''; pChosen.classList.add('hidden'); if (pNew) pNew.classList.remove('hidden'); pInput.focus(); }
    });
    if (pBranch) pBranch.addEventListener('change', function () { pBranch.setAttribute('data-touched', '1'); });
    pInput.addEventListener('input', function () {
      clearTimeout(pTimer);
      var q = pInput.value.trim();
      if (q.length < 2) { pResults.innerHTML = ''; return; }
      pTimer = setTimeout(function () {
        fetch('/admin/api/boys?q=' + encodeURIComponent(q), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
          var labels = { exact: 'גענוי', spelling: 'ענליכער אויסלייג', similar: 'ענליך', search: '' };
          pResults.innerHTML = d.items.length ? d.items.map(function (i) {
            return '<button type="button" data-id="' + i.id + '" data-name="' + esc(i.name) + '" data-branch="' + esc(i.branch) + '" data-branch-name="' + esc(i.branchName) + '"><strong>' + esc(i.name) + '</strong><span class="small muted">' + esc(i.branchName) + (i.aliases ? ' · ' + esc(i.aliases) : '') + '</span>' + (labels[i.via] ? '<span class="tag">' + labels[i.via] + '</span>' : '') + '</button>';
          }).join('') : '<div class="empty small">נישט געפונען – שרייבט א נייעם נאמען אונטן</div>';
        }).catch(function () {});
      }, 200);
    });
  }

  // admin: Jewish vs civil date input
  $$('input[name=dateMode]').forEach(function (r) {
    var sync = function () {
      var heb = $('input[name=dateMode][value=heb]').checked;
      $$('[data-date-greg]').forEach(function (el) { el.classList.toggle('hidden', heb); });
      $$('[data-date-heb]').forEach(function (el) { el.classList.toggle('hidden', !heb); });
    };
    r.addEventListener('change', sync);
    sync();
  });
})();
