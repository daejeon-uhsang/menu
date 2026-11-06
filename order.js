/* 대전어상 QR 주문 (손님 화면) — docs/contract.md 11/6 약속 기준
   동작 조건: 주소에 t(1~9)·k(8글자)가 있고 menu.json "orderEnabled": true 일 때만.
   조건이 아니면 아무것도 하지 않는다(지금 메뉴판과 완전히 같음).
   손님 이름·전화번호는 받지 않는다. 테이블 번호·메뉴·수량·메모·성인 확인만 보낸다. */
(function () {
  'use strict';
  var P = new URLSearchParams(location.search);
  var tRaw = P.get('t'), K = P.get('k') || '';
  var T = parseInt(tRaw, 10);
  if (!(T >= 1 && T <= 9) || String(T) !== tRaw || !/^[A-Za-z0-9]{8}$/.test(K)) return;

  var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  var TIMEOUT_MS = 8000, BLOCK_MS = 30000, MAX_LINES = 20, MAX_QTY = 10, MEMO_MAX = 40;
  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || /^(10|192\.168)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  var EMU = P.get('emu') === '1' && isLocal;

  // 11/6 사장님: 1=입구 옆 창가석, 2~5=홀 테이블(5=냉장고 옆), 6~9=다찌 1석씩
  var TABLE_NAME = T === 1 ? '1번 창가석' : (T <= 5 ? T + '번 테이블' : '다찌 ' + T + '번');
  var ALC_RE = /전통주|명주|소주|막걸리|탁주|약주|청주|하이볼|와인|위스키|브랜디|맥주|사케|칵테일/;

  var ss = {
    get: function (k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { sessionStorage.removeItem(k); } catch (e) {} }
  };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function ev(name, p) { try { if (window.gtag) window.gtag('event', name, p || {}); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function won(n) { return Number(n || 0).toLocaleString('ko-KR') + '원'; }
  function getMD() { try { return (typeof MD !== 'undefined' && MD && MD.sections) ? MD : null; } catch (e) { return null; } }

  /* menu.json 을 기다렸다가 orderEnabled 확인 */
  var waited = 0;
  (function waitMD() {
    var md = getMD();
    if (md) { if (md.orderEnabled === true) start(md); return; }
    waited += 150;
    if (waited < 30000) setTimeout(waitMD, 150);
  })();

  /* ---------- 가격 글자 → 선택지 ---------- */
  function parseOpts(item) {
    var out = [], both = !!(item.priceBottle && item.priceGlass);
    function parts(str, def) {
      String(str).split('/').forEach(function (seg) {
        seg = seg.trim(); if (!seg) return;
        var m = seg.match(/^(.*?)\+?\s*([\d,]+)\s*원?$/);
        if (!m) return;
        var label = m[1].replace(/\+$/, '').trim() || def;
        out.push({ opt: label.slice(0, 20), price: parseInt(m[2].replace(/,/g, ''), 10) || 0 });
      });
    }
    if (item.priceBottle) parts(item.priceBottle, both ? '병' : '');
    if (item.priceGlass) parts(item.priceGlass, both ? '잔' : '');
    if (!out.length) out.push({ opt: '', price: 0 });
    return out;
  }

  /* ---------- 상태 ---------- */
  var CART_KEY = 'od_cart_' + T, PEND_KEY = 'od_pending_' + T, LAST_KEY = 'od_last_sent';
  var cart = ss.get(CART_KEY) || [];
  var INDEX = {};           // item id → {item, sec}
  var storeOpen = null;     // null=모름, true/false
  var configured = true;
  var fb = null;            // {db, setDoc, doc, getDoc, serverTimestamp}
  var sending = false;

  function saveCart() { ss.set(CART_KEY, cart); }
  /* 미확정 주문(id·내용): 접수 확인 또는 손님이 직접 취소할 때까지 localStorage 에 보관하고 수정·새 주문을 잠근다 */
  function pendGet() { try { return JSON.parse(lsGet(PEND_KEY) || 'null'); } catch (e) { return null; } }
  function pendSet(p) { lsSet(PEND_KEY, JSON.stringify(p)); }
  function pendDel() { lsDel(PEND_KEY); }
  function locked() { var p = pendGet(); return !!(p && p.unsure); }
  function cartCount() { return cart.reduce(function (a, l) { return a + l.qty; }, 0); }
  function cartTotal() { return cart.reduce(function (a, l) { return a + l.qty * l.price; }, 0); }
  function hasAlcohol() { return cart.some(function (l) { return l.alc; }); }

  /* ---------- Firebase 연결 ---------- */
  var backendP = null;
  function backend() {
    if (backendP) return backendP;
    if (window.__ORDER_TEST_BACKEND) { backendP = Promise.resolve(window.__ORDER_TEST_BACKEND); return backendP; } // 시험 도구가 넣을 때만
    var cfg = window.ORDER_FIREBASE || {};
    if (EMU) {
      var em = window.ORDER_EMULATOR || {};
      cfg = { apiKey: 'emulator-key', projectId: em.projectId || 'demo-daejeon-order', appId: 'emulator' };
    } else if (!cfg.apiKey || cfg.apiKey === 'REPLACE_ME' || !cfg.projectId) {
      configured = false;
      backendP = Promise.reject(new Error('not-configured'));
      return backendP;
    }
    backendP = Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-firestore.js')]).then(function (m) {
      var A = m[0], F = m[1];
      var app = A.initializeApp(cfg, 'order');
      var db = F.getFirestore(app);
      if (EMU) F.connectFirestoreEmulator(db, host, (window.ORDER_EMULATOR || {}).firestorePort || 8080);
      return {
        storeOpen: function () {
          return F.getDoc(F.doc(db, 'config', 'store')).then(function (s) { return !!(s.exists() && s.data().open === true); });
        },
        send: function (id, payload) {
          var data = Object.assign({}, payload, { createdAt: F.serverTimestamp() });
          return F.setDoc(F.doc(db, 'orders', id), data);
        }
      };
    });
    return backendP;
  }

  function checkOpen() {
    return backend().then(function (b) { return b.storeOpen(); }).then(function (o) {
      storeOpen = o; paintBanner(); return o;
    }, function (e) {
      if (!configured) { storeOpen = false; paintBanner(); return false; }
      return null; // 읽기 실패(끊김 등) — 보내기에서 다시 판단
    });
  }

  /* ---------- 시작 ---------- */
  var bannerEl, barEl, sheetEl, dimEl, toastEl;
  function start(md) {
    var link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = 'order.css?v=20261106';
    document.head.appendChild(link);
    document.body.classList.add('od-on');
    md.sections.forEach(function (sec) {
      (sec.items || []).forEach(function (it) { INDEX[it.id] = { item: it, sec: sec }; });
    });
    // 메뉴가 바뀌었으면 담은 메뉴 정리(없어진·품절 메뉴 제거)
    cart = cart.filter(function (l) { var r = INDEX[l.id]; return r && !r.item.soldout; });
    saveCart();

    var scon = document.getElementById('scon');
    bannerEl = document.createElement('div');
    bannerEl.className = 'od-banner'; bannerEl.setAttribute('role', 'status');
    document.body.insertBefore(bannerEl, document.body.firstChild); // 첫 화면 맨 위에 보이도록
    paintBanner();
    buildBar(); buildSheet();
    decorateAll();
    if (scon && window.MutationObserver) {
      var tm = 0;
      new MutationObserver(function () { clearTimeout(tm); tm = setTimeout(decorateAll, 60); }).observe(scon, { childList: true, subtree: true });
    }
    checkOpen();
    ev('order_mode', { table: T });
  }

  function paintBanner() {
    if (barEl) paintCounts();
    if (!bannerEl) return;
    if (storeOpen === false) {
      bannerEl.className = 'od-banner od-closed';
      bannerEl.innerHTML = configured
        ? '<b>지금은 주문을 받지 않아요</b><span class="od-sub">직원에게 말씀해 주세요. 메뉴는 그대로 보실 수 있어요.</span>'
        : '<b>주문 연결 준비 중이에요</b><span class="od-sub">직원에게 말씀해 주세요.</span>';
    } else {
      bannerEl.className = 'od-banner';
      bannerEl.innerHTML = '<b>' + esc(TABLE_NAME) + ' 주문</b><span class="od-sub">메뉴 아래 [담기]를 누르고, 화면 아래 [보기]에서 보내 주세요. 계산은 나가실 때 계산대에서 해요.</span>';
    }
  }

  /* ---------- 메뉴 항목마다 담기 줄 ---------- */
  function decorateAll() {
    document.querySelectorAll('#scon [data-item-id]').forEach(function (el) {
      if (el.querySelector(':scope > .od-row')) return;
      var r = INDEX[el.dataset.itemId];
      if (!r || r.item.soldout || el.classList.contains('is-soldout')) return;
      el.appendChild(buildRow(r.item, r.sec));
    });
    paintCounts();
  }

  function buildRow(item, sec) {
    var opts = parseOpts(item);
    var row = document.createElement('div');
    row.className = 'od-row'; row.dataset.odId = item.id;
    var chosen = opts.length === 1 ? 0 : -1;
    var html = '';
    if (opts.length > 1) opts.forEach(function (o, i) {
      html += '<button type="button" class="od-opt" aria-pressed="false" data-i="' + i + '">' + esc(o.opt || '기본') + '<small>' + esc(o.price.toLocaleString('ko-KR')) + '</small></button>';
    });
    html += '<button type="button" class="od-add" aria-label="' + esc(item.name) + ' 담기">담기</button><div class="od-hint" aria-live="polite"></div>';
    row.innerHTML = html;
    row.addEventListener('click', function (e) {
      e.stopPropagation(); // 메뉴 카드의 펼치기·통계 클릭과 겹치지 않게
      var ob = e.target.closest('.od-opt');
      if (ob) {
        chosen = +ob.dataset.i;
        row.querySelectorAll('.od-opt').forEach(function (b) { b.setAttribute('aria-pressed', String(b === ob)); });
        row.classList.remove('od-need'); row.querySelector('.od-hint').textContent = '';
        return;
      }
      if (e.target.closest('.od-add')) {
        if (chosen < 0) {
          row.classList.add('od-need');
          row.querySelector('.od-hint').textContent = opts.map(function (o) { return o.opt; }).join('·') + ' 중 먼저 골라 주세요';
          return;
        }
        addToCart(item, sec, opts[chosen]);
      }
    });
    return row;
  }

  function addToCart(item, sec, o) {
    if (locked()) { toast('확인 안 된 주문이 있어요. 먼저 처리해 주세요'); openSheet('cart'); return; }
    var key = item.id + '|' + o.opt;
    var line = cart.find(function (l) { return l.key === key; });
    if (line) {
      if (line.qty >= MAX_QTY) { toast('한 메뉴는 ' + MAX_QTY + '개까지 담을 수 있어요'); return; }
      line.qty++;
    } else {
      if (cart.length >= MAX_LINES) { toast('한 번에 ' + MAX_LINES + '가지까지 보낼 수 있어요'); return; }
      cart.push({ key: key, id: item.id, name: (String(item.name).replace(/^[\s↳└ㄴ∟·\-]+/, '').trim() || String(item.name)).slice(0, 40), opt: o.opt, price: o.price, qty: 1,
        alc: /^s/.test(sec.id) || ALC_RE.test(item.name) });
    }
    saveCart(); paintCounts();
    toast('담았어요 · ' + String(item.name).replace(/^[\s↳└ㄴ∟·\-]+/, '') + (o.opt ? ' ' + o.opt : ''));
    barEl.classList.remove('od-bump'); void barEl.offsetWidth; barEl.classList.add('od-bump');
    ev('order_add', { item_id: item.id, opt: o.opt, table: T });
  }

  function paintCounts() {
    var per = {};
    cart.forEach(function (l) { per[l.id] = (per[l.id] || 0) + l.qty; });
    document.querySelectorAll('.od-row').forEach(function (row) {
      var b = row.querySelector('.od-add'), n = per[row.dataset.odId] || 0;
      b.innerHTML = '담기' + (n ? '<span class="od-cnt">' + n + '</span>' : '');
    });
    if (!barEl) return;
    var n = cartCount();
    if (locked()) {
      barEl.querySelector('.od-bar-t').innerHTML = '<b>확인 안 된 주문</b><span>' + esc(TABLE_NAME) + ' · [보기]에서 다시 보내 주세요</span>';
      barEl.querySelector('button').disabled = false; return;
    }
    barEl.querySelector('.od-bar-t').innerHTML = n
      ? '<b>담은 메뉴 ' + n + '</b><span>' + esc(TABLE_NAME) + ' · 합계 ' + won(cartTotal()) + '</span>'
      : '<b>' + esc(TABLE_NAME) + '</b><span>' + (storeOpen === false ? '지금은 주문을 받지 않아요' : '담은 메뉴가 없어요') + '</span>';
    barEl.querySelector('button').disabled = !n;
  }

  /* ---------- 아래 고정 바 ---------- */
  function buildBar() {
    barEl = document.createElement('div');
    barEl.className = 'od-bar';
    barEl.innerHTML = '<div class="od-bar-t"></div><button type="button">보기</button>';
    barEl.querySelector('button').addEventListener('click', function () { openSheet('cart'); });
    document.body.appendChild(barEl);
    toastEl = document.createElement('div'); toastEl.className = 'od-toast'; toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
  }
  var toastTm = 0;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('on');
    clearTimeout(toastTm); toastTm = setTimeout(function () { toastEl.classList.remove('on'); }, 1800);
  }

  /* ---------- 장바구니·결과 화면 ---------- */
  var memo = '', adultOk = false, blockTm = 0;
  function buildSheet() {
    dimEl = document.createElement('div'); dimEl.className = 'od-dim'; dimEl.hidden = true;
    dimEl.addEventListener('click', function () { if (!sending) closeSheet(); });
    sheetEl = document.createElement('div');
    sheetEl.className = 'od-sheet'; sheetEl.hidden = true;
    sheetEl.setAttribute('role', 'dialog'); sheetEl.setAttribute('aria-modal', 'true'); sheetEl.setAttribute('aria-label', '담은 메뉴');
    document.body.appendChild(dimEl); document.body.appendChild(sheetEl);
  }
  function openSheet(view) {
    sheetEl.hidden = false; dimEl.hidden = false; document.body.classList.add('od-lock');
    if (view === 'cart') { paintCart(); checkOpen().then(function () { if (!sheetEl.hidden && sheetEl.dataset.view === 'cart') paintFoot(); }); }
  }
  function closeSheet() {
    sheetEl.hidden = true; dimEl.hidden = true; document.body.classList.remove('od-lock');
    clearInterval(blockTm);
  }

  function paintLocked(note) {
    var p = pendGet(); if (!p) { paintCart(); return; }
    sheetEl.dataset.view = 'locked';
    var its = p.payload.items, tot = its.reduce(function (a, it) { return a + it.qty * it.price; }, 0);
    var h = '<div class="od-head"><h2>' + esc(TABLE_NAME) + ' 주문</h2><button type="button" class="od-x" data-act="close">닫기</button></div><div class="od-body">'
      + '<p class="od-note" style="color:#7a1414;font-weight:700">' + esc(note || '보낸 주문이 계산대에 도착했는지 아직 확인되지 않았어요. 같은 주문이 두 번 들어가지 않도록 [다시 보내기]로만 보내 주세요.') + '</p>';
    its.forEach(function (it) {
      h += '<div class="od-line"><div><div class="od-nm">' + esc(it.name) + (it.opt ? '<em>' + esc(it.opt) + '</em>' : '') + '</div><div class="od-up">' + it.qty + '개</div></div><div class="od-lt">' + (it.price ? won(it.price * it.qty) : '') + '</div></div>';
    });
    if (p.payload.memo) h += '<p class="od-note">요청사항: ' + esc(p.payload.memo) + '</p>';
    h += '<div class="od-sum"><span>합계</span><b>' + won(tot) + '</b></div></div>'
      + '<div class="od-foot"><button type="button" class="od-send" data-act="retry">다시 보내기</button>'
      + '<button type="button" class="od-btn2" data-act="cancelpend">이 주문 취소하고 새로 담기</button></div>';
    sheetEl.innerHTML = h;
    sheetEl.onclick = onSheetClick;
  }
  function paintCart() {
    if (locked()) { paintLocked(); return; }
    sheetEl.dataset.view = 'cart';
    var h = '<div class="od-head"><h2>' + esc(TABLE_NAME) + ' 주문</h2><button type="button" class="od-x" data-act="close">닫기</button></div><div class="od-body">';
    if (!cart.length) h += '<div class="od-empty">담은 메뉴가 없어요.<br>메뉴 아래 [담기]를 눌러 주세요.</div>';
    cart.forEach(function (l, i) {
      h += '<div class="od-line"><div><div class="od-nm">' + esc(l.name) + (l.opt ? '<em>' + esc(l.opt) + '</em>' : '') + '</div>'
        + '<div class="od-up">' + (l.price ? won(l.price) : '가격은 직원 확인') + '</div></div>'
        + '<div class="od-lt">' + (l.price ? won(l.price * l.qty) : '') + '</div>'
        + '<div class="od-qty" style="grid-column:1/-1;justify-content:flex-end">'
        + '<button type="button" data-act="minus" data-i="' + i + '" aria-label="' + esc(l.name) + ' 하나 빼기">−</button>'
        + '<output aria-live="polite">' + l.qty + '</output>'
        + '<button type="button" data-act="plus" data-i="' + i + '" aria-label="' + esc(l.name) + ' 하나 더">＋</button></div></div>';
    });
    if (cart.length) {
      h += '<div class="od-field"><label for="od-memo">요청사항 (선택)</label>'
        + '<input id="od-memo" type="text" maxlength="' + MEMO_MAX + '" placeholder="예: 덜 맵게, 간장 양념으로" value="' + esc(memo) + '" autocomplete="off" enterkeyhint="done">'
        + '<span class="od-count"><span id="od-mc">' + memo.length + '</span>/' + MEMO_MAX + '</span></div>';
      if (hasAlcohol()) h += '<label class="od-adult" id="od-adult"><input type="checkbox" id="od-adult-cb"' + (adultOk ? ' checked' : '') + '>만 19세 이상입니다 (술은 성인만 주문할 수 있어요)</label>';
      h += '<div class="od-sum"><span>합계</span><b>' + won(cartTotal()) + '</b></div>'
        + '<p class="od-note">이름·전화번호는 받지 않아요. 계산은 나가실 때 계산대에서 해 주세요.</p>';
    }
    h += '</div><div class="od-foot"><p class="od-msg" id="od-msg"></p><button type="button" class="od-send" data-act="send">주문 보내기</button></div>';
    sheetEl.innerHTML = h;
    var mi = sheetEl.querySelector('#od-memo');
    if (mi) mi.addEventListener('input', function () { memo = mi.value.slice(0, MEMO_MAX); sheetEl.querySelector('#od-mc').textContent = memo.length; });
    var cb = sheetEl.querySelector('#od-adult-cb');
    if (cb) cb.addEventListener('change', function () { adultOk = cb.checked; sheetEl.querySelector('#od-adult').classList.remove('od-need'); paintFoot(); });
    sheetEl.onclick = onSheetClick;
    paintFoot();
  }

  function blockLeft() {
    var last = parseInt(lsGet(LAST_KEY) || '0', 10) || 0;
    return Math.max(0, Math.ceil((last + BLOCK_MS - Date.now()) / 1000));
  }

  function paintFoot() {
    var btn = sheetEl.querySelector('.od-send'), msg = sheetEl.querySelector('#od-msg');
    if (!btn) return;
    clearInterval(blockTm);
    if (!cart.length) { btn.disabled = true; msg.textContent = ''; return; }
    if (storeOpen === false) { btn.disabled = true; msg.textContent = configured ? '지금은 주문을 받지 않아요 — 직원에게 말씀해 주세요' : '주문 연결 준비 중이에요 — 직원에게 말씀해 주세요'; return; }
    var left = blockLeft();
    if (left > 0) {
      btn.disabled = true;
      var tick = function () {
        var l = blockLeft();
        if (l <= 0) { clearInterval(blockTm); paintFoot(); return; }
        msg.textContent = '방금 주문을 보냈어요. ' + l + '초 뒤에 다시 보낼 수 있어요';
      };
      tick(); blockTm = setInterval(tick, 1000);
      return;
    }
    btn.disabled = false; msg.textContent = '';
  }

  function onSheetClick(e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var act = b.dataset.act, i = +b.dataset.i;
    if (act === 'close') { closeSheet(); return; }
    if (act === 'minus' || act === 'plus') {
      if (locked()) { paintLocked(); return; }
      var l = cart[i]; if (!l) return;
      if (act === 'plus') { if (l.qty >= MAX_QTY) { toast('한 메뉴는 ' + MAX_QTY + '개까지예요'); return; } l.qty++; }
      else { l.qty--; if (l.qty <= 0) cart.splice(i, 1); }
      saveCart(); paintCounts(); paintCart(); return;
    }
    if (act === 'send') { trySend(); return; }
    if (act === 'retry') { doSend(pendGet(), true); return; }
    if (act === 'cancelpend') {
      if (!window.confirm('이 주문을 취소하고 새로 담을까요?\n이미 계산대에 들어갔을 수 있으니, 직원에게 먼저 확인해 주세요.')) return;
      pendDel(); paintCounts(); paintCart(); return;
    }
    if (act === 'back') { paintCart(); return; }
    if (act === 'more') { closeSheet(); return; }
  }

  /* ---------- 보내기 ---------- */
  function rid() {
    var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', a = new Uint32Array(20), s = '';
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < 20; i++) s += abc[a[i] % 62];
    return s;
  }
  function buildPayload() {
    return {
      t: T, k: K,
      items: cart.map(function (l) { return { id: String(l.id).slice(0, 40), name: l.name, opt: l.opt, qty: l.qty, price: l.price }; }),
      memo: memo.slice(0, MEMO_MAX), adult: hasAlcohol() ? adultOk : false, status: 'new'
    };
  }

  function trySend() {
    if (sending || !cart.length) return;
    if (locked()) { paintLocked(); return; }
    if (blockLeft() > 0) { paintFoot(); return; }
    if (hasAlcohol() && !adultOk) {
      var a = sheetEl.querySelector('#od-adult');
      if (a) { a.classList.remove('od-need'); void a.offsetWidth; a.classList.add('od-need'); a.scrollIntoView({ block: 'center' }); }
      sheetEl.querySelector('#od-msg').textContent = '술이 담겨 있어요. 만 19세 이상 확인에 체크해 주세요';
      return;
    }
    // 보내기 시작부터 '미확정'으로 저장(도중에 화면이 닫혀도 같은 id 로만 다시 보냄)
    var pend = { id: rid(), payload: buildPayload(), unsure: true, timedOut: false };
    pendSet(pend);
    doSend(pend, false);
  }

  function showResult(kind, title, lines, acts) {
    sheetEl.dataset.view = 'result';
    var ic = { ok: '✓', bad: '!', wait: '<div class="od-spin"></div>', wait2: '?' }[kind];
    var h = '<div class="od-result' + (kind === 'bad' ? ' od-bad' : (kind === 'wait' || kind === 'wait2') ? ' od-wait' : '') + '" role="status" aria-live="assertive">'
      + '<div class="od-ic" aria-hidden="true">' + ic + '</div><h3>' + esc(title) + '</h3>';
    lines.forEach(function (ln, i) { h += '<p' + (i ? ' class="od-small"' : '') + '>' + esc(ln) + '</p>'; });
    h += '<div class="od-acts">' + (acts || '') + '</div></div>';
    sheetEl.innerHTML = h;
    sheetEl.onclick = onSheetClick;
  }

  function doSend(pend, isRetry) {
    if (!pend || sending) return;
    sending = true;
    showResult('wait', '보내는 중…', [TABLE_NAME + ' 주문을 계산대로 보내고 있어요']);
    ev('order_send', { table: T, lines: pend.payload.items.length, retry: isRetry ? 1 : 0 });
    var timer, settled = false;
    // SDK 불러오기까지 포함한 전체를 8초 제한과 경쟁
    var sendP = backend().then(function (b) { return b.send(pend.id, pend.payload); });
    // 시간 초과 뒤 늦게 성공하면: 아직 같은 미확정 주문이면 도착 처리
    sendP.then(function () {
      if (!settled) return;
      var cur = pendGet();
      if (cur && cur.id === pend.id) { arrived(pend, true); if (sheetEl.hidden) toast('앞서 보낸 주문이 계산대에 도착했어요'); }
    }, function () {});
    var timeout = new Promise(function (_, rej) { timer = setTimeout(function () { rej({ code: 'od-timeout' }); }, TIMEOUT_MS); });
    Promise.race([sendP, timeout]).then(function () { settled = true; clearTimeout(timer); arrived(pend, false); },
      function (e) {
        settled = true; clearTimeout(timer);
        var code = (e && e.code) || (e && e.message) || '';
        if (code === 'not-configured') { sending = false; pendDel(); storeOpen = false; paintBanner(); paintCounts(); failClosed(); return; }
        if (code === 'permission-denied' || /permission/i.test(code)) {
          checkOpen().then(function (open) {
            sending = false;
            var uncertain = isRetry || pend.timedOut;   // 앞서 결과를 모르는 전송이 있었음
            if (!uncertain) { pendDel(); paintCounts(); }  // 첫 전송 거절 = 들어가지 않음 → 잠금 풀고 장바구니는 그대로
            if (open === false) { failClosed(uncertain); return; }
            if (uncertain) { maybeArrived(); return; }
            failKey();
          });
          return;
        }
        // 시간 초과·끊김·기타: 결과를 모름 → 잠금 유지, 같은 id 로만 다시 보내기
        pend.timedOut = true; pendSet(pend); sending = false; paintCounts(); failNet();
      });
  }

  function arrived(pend, already) {
    sending = false;
    lsSet(LAST_KEY, String(Date.now()));
    pendDel();
    cart = []; memo = ''; adultOk = false; saveCart(); paintCounts();
    ev('order_ok', { table: T, already: already ? 1 : 0 });
    showResult('ok', '주문 도착', [TABLE_NAME, '계산대 주문판에 도착했어요. 곧 준비해 드릴게요.', '계산은 나가실 때 계산대에서 해 주세요.'],
      '<button type="button" class="od-send" data-act="more">더 주문하기</button>');
  }
  // 다시 보냈는데 거절 = 앞서 보낸 것이 이미 들어갔을 수 있음(손님은 주문을 읽을 수 없어 확인 불가) → 장바구니·잠금 유지
  function maybeArrived() {
    ev('order_fail', { table: T, why: 'maybe_dup' });
    showResult('wait2', '이미 도착했을 수 있어요', ['직원에게 확인해 주세요', TABLE_NAME + ' 주문이 계산대에 먼저 들어갔을 수 있어요. 직원이 못 받았다고 하면 [이 주문 취소하고 새로 담기]를 눌러 주세요.'],
      '<button type="button" class="od-send" data-act="more">닫기</button><button type="button" class="od-btn2" data-act="cancelpend">이 주문 취소하고 새로 담기</button>');
  }
  function failNet() {
    ev('order_fail', { table: T, why: 'net' });
    showResult('bad', '전송 실패', ['직원을 불러 주세요', '인터넷 연결이 약하면 다시 보내 주세요. 같은 주문이 두 번 들어가지 않아요.'],
      '<button type="button" class="od-send" data-act="retry">다시 보내기</button><button type="button" class="od-btn2" data-act="back">담은 메뉴로</button>');
  }
  function failClosed(uncertain) {
    ev('order_fail', { table: T, why: 'closed' });
    showResult('bad', '지금은 주문을 받지 않아요', ['직원에게 말씀해 주세요', uncertain ? '앞서 보낸 주문이 들어갔을 수 있어요. 직원에게 확인해 주세요.' : '담은 메뉴는 그대로 있어요.'],
      '<button type="button" class="od-btn2" data-act="back">담은 메뉴로</button>');
  }
  function failKey() {
    ev('order_fail', { table: T, why: 'denied' });
    showResult('bad', '주문 주소가 맞지 않아요', ['직원을 불러 주세요', '테이블에 붙은 QR을 다시 찍어 주세요. 담은 메뉴는 그대로 있어요.'],
      '<button type="button" class="od-btn2" data-act="back">담은 메뉴로</button>');
  }
})();
