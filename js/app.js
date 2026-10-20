/* 프레스·금형 예지보전 — 화면
   계산은 js/logic.js(PressLogic), 그래프는 js/charts.js, 저장은 js/store.js, AI 연결은 js/ai-endpoint.js·ai-panel.js. */
(function () {
  'use strict';
  var L = window.PressLogic, S = window.PressStore, C = window.PressCharts, AIP = window.AIPanel;
  var db = S.loadDb();
  var ui = { press: '', month: '', pending: [], errors: [], progress: '' };
  var main = document.getElementById('main');
  var A = null; // 지금 데이터의 분석 결과(render 마다 다시 계산)

  /* ── 작은 도구 ───────────────────────────── */
  function h(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function add(e, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(e, x); }); return; }
    e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function fld(label, control, hint) {
    return h('label', { class: 'field' }, h('span', null, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
  }
  var toastTimer = null;
  function toast(msg, err) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (err ? ' error' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3800);
  }
  function save() {
    var ok = S.saveDb(db);
    document.getElementById('storeNote').textContent = ok ? '이 브라우저에 저장됨 · ' + S.sizeKb() + 'KB' : '저장 안 됨(브라우저 저장소가 막혔거나 가득 참) — JSON 백업을 받아 두세요';
    return ok;
  }
  function download(name, blob) {
    var a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function copyText(t) {
    function fallback() { var ta = h('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('복사했습니다.'); } catch (e) { toast('복사하지 못했습니다. 직접 선택해 복사해 주세요.', true); } ta.remove(); }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(function () { toast('복사했습니다.'); }, fallback); else fallback();
  }
  var N = function (v, d) { return L.fmtN(v, d); };
  function pill(level) { return h('span', { class: 'pill lv-' + level }, L.LEVELS[level] || level); }
  function pageHead(stage, title, lead, right) {
    return h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('div', { class: 'stage' }, stage), h('h1', null, title), lead ? h('p', { class: 'lead' }, lead) : null), right || null);
  }
  function tile(k, v, sub) { return h('div', { class: 'tile' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), sub ? h('div', { class: 'note' }, sub) : null); }
  function table(head, rows, opts) {
    opts = opts || {};
    var t = h('table', { class: 'list' + (opts.cls ? ' ' + opts.cls : '') });
    var tr = h('tr');
    head.forEach(function (x, i) { tr.appendChild(h('th', { class: opts.num && opts.num[i] ? 'num' : null, scope: 'col' }, x)); });
    t.appendChild(h('thead', null, tr));
    var tb = h('tbody');
    rows.forEach(function (r) {
      var row = h('tr', { class: r.cls || null });
      (r.cells || r).forEach(function (x, i) { row.appendChild(h('td', { class: (opts.num && opts.num[i] ? 'num' : '') || null }, x)); });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    return h('div', { class: 'table-wrap' }, t);
  }
  function emptyNotice() {
    return h('section', { class: 'card empty' },
      h('p', null, '아직 가져온 프레스 로그가 없습니다.'),
      h('p', null, '로그 엑셀·CSV 를 가져오거나, 가상 샘플(프레스 4대 × 90일)로 먼저 둘러봐 주세요.'),
      h('div', { class: 'btn-row', style: 'justify-content:center' },
        h('a', { class: 'btn btn-primary', href: '#/import' }, '데이터 가져오기로'),
        h('button', { type: 'button', class: 'btn', onclick: askSample }, '샘플 90일로 시작')));
  }
  function lifeBar(ratio, warnPct, level) {
    var w = ratio == null ? 0 : Math.max(0, Math.min(1, ratio)) * 100;
    return h('div', { class: 'life', role: 'img', 'aria-label': '사용률 ' + L.pctText(ratio) },
      h('div', { class: 'life-fill lv-' + level, style: 'width:' + w.toFixed(1) + '%' }),
      warnPct ? h('div', { class: 'life-mark', style: 'left:' + (warnPct * 100) + '%', title: '주의 기준 ' + Math.round(warnPct * 100) + '%' }) : null);
  }
  function goPress(id) { ui.press = id; location.hash = '#/anomaly'; }

  /* ── 가져오기 ───────────────────────────── */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var bytes = new Uint8Array(fr.result), wb, enc = '';
          if (/\.(csv|txt)$/i.test(file.name)) {
            var dec = L.decodeCsv(bytes); enc = dec.encoding;
            wb = XLSX.read(dec.text, { type: 'string', raw: true });
          } else wb = XLSX.read(bytes, { type: 'array', cellDates: false });
          var it = prepare(file.name, wb); it.encoding = enc; resolve(it);
        } catch (e) { reject(new Error(file.name + ': 읽지 못했습니다(' + e.message + ')')); }
      };
      fr.onerror = function () { reject(new Error(file.name + ': 파일을 읽지 못했습니다.')); };
      fr.readAsArrayBuffer(file);
    });
  }
  function prepare(name, wb) {
    var sheets = wb.SheetNames.map(function (n) { return { name: n, aoa: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }) }; });
    var pick = L.pickSheet(sheets) || sheets[0];
    var item = { fileName: name, sheets: sheets, sheet: pick ? pick.name : '', overrides: {} };
    reparse(item);
    return item;
  }
  function reparse(item) {
    var sh = item.sheets.filter(function (s) { return s.name === item.sheet; })[0];
    item.aoa = sh ? sh.aoa : [];
    item.result = L.parseSheet(item.aoa, { fileName: item.fileName, overrides: item.overrides });
  }
  function fileId(f) { return f.name + '|' + f.size + '|' + (f.lastModified || 0); }
  function handleFiles(list) {
    var all = Array.prototype.slice.call(list || []), skipped = [];
    var files = all.filter(function (f) {
      if (/^~\$/.test(f.name)) { skipped.push(f.name + ' (엑셀 잠금 파일)'); return false; }
      if (!/\.(xlsx|xlsm|xls|csv|txt)$/i.test(f.name)) { if (!/^\./.test(f.name)) skipped.push(f.name + ' (엑셀·CSV 아님)'); return false; }
      if (ui.pending.some(function (p) { return p.fid === fileId(f); })) { skipped.push(f.name + ' (이미 올려 둠)'); return false; }
      return true;
    });
    if (!files.length) { toast(skipped.length ? '가져올 파일이 없습니다(' + skipped.length + '개 건너뜀).' : '엑셀·CSV 파일을 골라 주세요.', true); return; }
    files.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    ui.errors = skipped.map(function (x) { return '건너뜀: ' + x; });
    var i = 0;
    (function next() {
      if (i >= files.length) { ui.progress = ''; render(); toast(files.length + '개 파일을 읽었습니다. 아래에서 열 연결을 확인한 뒤 반영해 주세요.'); return; }
      var f = files[i++];
      ui.progress = '읽는 중 ' + i + ' / ' + files.length + ' — ' + f.name;
      var pr = document.getElementById('importProgress'); if (pr) pr.textContent = ui.progress;
      readFile(f).then(function (it) {
        it.fid = fileId(f);
        it.already = db.files.some(function (x) { return x.name === f.name; });
        ui.pending.push(it);
        applySameHeader(it);
      }, function (e) { ui.errors.push(e.message); }).then(function () { setTimeout(next, 0); });
    })();
  }
  /* 머리행이 같은 파일에 이미 고친 열 연결이 있으면 그대로 씁니다(첫 파일만 고치면 나머지도 따라감) */
  function applySameHeader(it) {
    var sig = L.headerSignature(it.result.det);
    var src = ui.pending.filter(function (p) { return p !== it && Object.keys(p.overrides).length && L.headerSignature(p.result.det) === sig; })[0];
    if (src) { it.overrides = JSON.parse(JSON.stringify(src.overrides)); reparse(it); }
  }
  function commit(items) {
    var total = { added: 0, updated: 0 }, ok = 0;
    items.forEach(function (it) {
      var r = it.result;
      if (r.det.missing.length) return;
      var m = L.mergeRecords(db.records, r.records);
      db.records = m.records;
      total.added += m.stat.added; total.updated += m.stat.updated;
      db.files.push({ name: it.fileName, sheet: it.sheet, rows: r.records.length, at: new Date().toISOString().slice(0, 16).replace('T', ' ') });
      ok++;
    });
    var sm = L.syncMaster(db.presses, db.dies, db.records);
    db.presses = sm.presses; db.dies = sm.dies;
    db.sample = db.sample && items.every(function (it) { return it.sample; });
    ui.pending = ui.pending.filter(function (p) { return items.indexOf(p) < 0; });
    ui.errors = [];
    save();
    toast(ok + '개 파일 반영 — 새 행 ' + total.added + ' · 바뀐 행 ' + total.updated +
      (sm.added.presses || sm.added.dies ? ' · 기준표에 프레스 ' + sm.added.presses + '대·금형 ' + sm.added.dies + '개 추가(설정에서 수명·주기를 넣어 주세요)' : ''));
    render();
  }
  function sampleItems() {
    var b = window.PressSample.build();
    var items = b.files.map(function (f) {
      // 앱이 실제 파일을 읽을 때와 같은 길로 — 엑셀은 통합문서로 만들었다가 다시 읽고, CSV 는 글자로 읽습니다
      var wb;
      if (f.kind === 'csv') wb = XLSX.read(f.csv, { type: 'string', raw: true });
      else {
        var w = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(w, window.PressSample.toSheet(XLSX, f.aoa), '프레스 로그');
        wb = XLSX.read(XLSX.write(w, { bookType: 'xlsx', type: 'array' }), { type: 'array', cellDates: false });
      }
      var it = prepare(f.fileName, wb); it.sample = true; return it;
    });
    return { items: items, master: b.master };
  }
  function loadSample() {
    var s = sampleItems();
    db = L.emptyDb(); db.sample = true;
    db.presses = s.master.presses; db.dies = s.master.dies;
    ui.pending = []; ui.press = ''; ui.month = '';
    commit(s.items);
    location.hash = '#/dash';
  }
  function askSample() { if (!db.records.length || confirm('지금 데이터를 지우고 가상 샘플(프레스 4대 × 90일)을 불러올까요?')) loadSample(); }

  function pageImport() {
    var input = h('input', { type: 'file', multiple: true, accept: '.xlsx,.xlsm,.xls,.csv,.txt' });
    input.addEventListener('change', function () { handleFiles(input.files); input.value = ''; });
    var folder = h('input', { type: 'file', multiple: true, webkitdirectory: true });
    folder.addEventListener('change', function () { handleFiles(folder.files); folder.value = ''; });
    var drop = h('div', { class: 'drop' },
      h('label', { class: 'btn btn-primary' }, input, '로그 파일 고르기(여러 개 가능)'),
      h('label', { class: 'btn' }, folder, '폴더째 고르기'),
      h('span', { class: 'note' }, '또는 파일을 여기로 끌어다 놓아 주세요. 엑셀(.xlsx·.xls)과 CSV 를 함께 넣어도 됩니다.'));
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); handleFiles(e.dataTransfer.files); });

    var out = [pageHead('데이터', '프레스 로그 가져오기', '설비 화면·PLC·수기 엑셀에서 꺼낸 로그를 넣어 주세요. 열 이름이 달라도 열 연결에서 맞출 수 있습니다.'),
      h('section', { class: 'card' }, h('h2', null, '1. 파일 넣기'), drop,
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn', onclick: askSample }, '샘플 90일로 시작'),
          h('a', { class: 'btn', href: 'samples/' + encodeURIComponent('프레스로그_샘플_2026-09.xlsx'), download: '' }, '샘플 엑셀 내려받기(9월)'),
          h('a', { class: 'btn', href: 'samples/' + encodeURIComponent('프레스로그_샘플_2026-10.csv'), download: '' }, '샘플 CSV 내려받기(10월)')),
        h('ul', { class: 'note' },
          h('li', null, '한 행 = 한 프레스의 한 기록(하루 또는 시각별)입니다. 꼭 필요한 열은 일자와 프레스이고, 나머지(프레스 종류·금형명·타수·누적 타수·가동 시간·전류·전압·온도·진동)는 있는 만큼 씁니다.'),
          h('li', null, '타수는 「타수」 열이 있으면 그 값을, 없으면 같은 프레스의 「프레스 누적 타수」 차이를, 그것도 없으면 「금형 누적 타수」 차이를 씁니다. 「금형 타수」 열은 그 행에서 친 횟수로 읽습니다.'),
          h('li', null, '같은 행(일자 + 시각 + 프레스 + 금형)을 다시 가져오면 새 값으로 바뀝니다. 같은 파일을 두 번 넣어도 두 번 세지 않습니다.'),
          h('li', null, 'CSV 는 UTF-8 과 한글 엑셀이 저장한 CP949(EUC-KR) 를 알아서 가려 읽습니다.'),
          h('li', null, '파일은 서버로 보내지 않고 이 브라우저 안에서만 읽습니다.')),
        h('p', { class: 'note', id: 'importProgress', 'aria-live': 'polite' }, ui.progress || ''),
        ui.errors.length ? h('details', { class: 'warn-list', open: true }, h('summary', null, '읽지 못했거나 건너뛴 파일 ' + ui.errors.length + '개'),
          h('ul', null, ui.errors.map(function (e) { return h('li', null, e); }))) : null)];

    if (ui.pending.length) {
      var box = h('section', { class: 'card' }, h('h2', null, '2. 열 연결 확인 후 반영 (' + ui.pending.length + '개 파일)'));
      var ready = ui.pending.filter(function (it) { return !it.result.det.missing.length; });
      box.appendChild(table(['파일', '기간', '행', '프레스', '알림', '상태'], ui.pending.map(function (it) {
        var r = it.result, rg = L.dataRange(r.records);
        var presses = []; r.records.forEach(function (x) { if (presses.indexOf(x.press) < 0) presses.push(x.press); });
        return { cls: r.det.missing.length ? 'excluded' : null, cells: [it.fileName + (it.encoding ? ' (' + it.encoding + ')' : ''),
          rg.first ? rg.first + ' ~ ' + rg.last : '-', r.records.length, presses.sort(L.natCmp).join(', ') || '-', r.warnings.length + r.det.warnings.length,
          r.det.missing.length ? '열 연결 필요' : it.already ? '이전에 가져온 파일(새 값으로 바뀜)' : '반영 준비됨'] };
      }), { num: [0, 0, 1, 0, 1, 0] }));
      box.appendChild(h('h3', null, '파일별 자세히'));
      ui.pending.forEach(function (it) { box.appendChild(pendingCard(it)); });
      box.appendChild(h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary', disabled: !ready.length, onclick: function () { commit(ready); } }, '확인한 ' + ready.length + '개 파일 반영'),
        h('button', { type: 'button', class: 'btn', onclick: function () { ui.pending = []; render(); } }, '취소')));
      out.push(box);
    }

    var presses = Object.keys(db.presses), st = A.strokeStat;
    out.push(h('section', { class: 'card' }, h('h2', null, '쌓인 데이터'),
      db.records.length ? h('div', null,
        h('div', { class: 'tiles' },
          tile('기간', A.range.first.slice(5).replace('-', '/') + ' ~ ' + A.range.last.slice(5).replace('-', '/'), (L.daysBetween(A.range.first, A.range.last) + 1) + '일'),
          tile('프레스', presses.length + '대'),
          tile('금형', Object.keys(db.dies).length + '개'),
          tile('로그 행', N(db.records.length))),
        h('p', { class: 'note' }, '타수 계산: 타수 열 ' + N(st.fromRow) + '행 · 프레스 누적 타수 차이 ' + N(st.fromPressCum) + '행 · 금형 누적 타수 차이 ' + N(st.fromDieCum) + '행' +
          (st.noPrev ? ' · 앞 누적값이 없어 못 센 첫 행 ' + st.noPrev + '행' : '') + (st.reset ? ' · 누적값이 줄어(카운터 초기화) 못 센 행 ' + st.reset + '행' : '') + (st.none ? ' · 타수 정보가 없는 행 ' + N(st.none) + '행' : '')),
        st.mismatch ? h('details', { class: 'warn-list' }, h('summary', null, '타수 합과 프레스 누적 타수 차이가 맞지 않는 곳 ' + st.mismatch + '곳 (확인해 주세요)'),
          h('ul', null, st.mismatchRows.map(function (x) { return h('li', null, x); }))) : null,
        h('details', null, h('summary', null, '가져온 파일 ' + db.files.length + '개 보기'),
          table(['가져온 파일', '시트', '행', '가져온 때'], db.files.slice().reverse().map(function (f) { return [f.name, f.sheet, f.rows, f.at]; }), { num: [0, 0, 1, 0] })),
        h('div', { class: 'btn-row', style: 'margin-top:12px' },
          h('button', { type: 'button', class: 'btn btn-danger', onclick: function () {
            if (!confirm('이 브라우저에 쌓인 로그·기준표·설정을 모두 지울까요? (되돌릴 수 없습니다. 먼저 설정 화면에서 JSON 백업을 받아 두면 안전합니다)')) return;
            db = L.emptyDb(); S.clearDb(); ui.press = ''; ui.month = ''; save(); render();
          } }, '모든 데이터 지우기'),
          h('button', { type: 'button', class: 'btn', onclick: function () {
            if (!confirm('로그만 지우고 설비·금형 기준표와 설정은 남길까요?')) return;
            db.records = []; db.files = []; db.sample = false; save(); render();
          } }, '로그만 지우기')))
        : h('p', { class: 'note' }, '아직 없습니다.')));
    return out;
  }
  function pendingCard(it) {
    var r = it.result, det = r.det;
    var sheetSel = h('select', { 'aria-label': '시트' });
    it.sheets.forEach(function (s) { var o = h('option', { value: s.name }, s.name); if (s.name === it.sheet) o.selected = true; sheetSel.appendChild(o); });
    sheetSel.addEventListener('change', function () { it.sheet = sheetSel.value; it.overrides = {}; reparse(it); render(); });
    var hdr = det.headers || [], ex = it.aoa[det.headerRow + 1] || [];
    var mapGrid = h('div', { class: 'map-grid' });
    L.FIELDS.forEach(function (f) {
      var sel = h('select', { 'aria-label': f.label + ' 열' });
      sel.appendChild(h('option', { value: '-1' }, '(이 파일에는 없음)'));
      hdr.forEach(function (t, i) {
        var o = h('option', { value: String(i) }, L.colName(i) + ' · ' + (t || '(빈 머리)'));
        if (det.map[f.id] === i) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        var sig = L.headerSignature(it.result.det), n = 0;
        ui.pending.forEach(function (p) {
          if (p !== it && L.headerSignature(p.result.det) !== sig) return;
          p.overrides[f.id] = Number(sel.value); reparse(p); if (p !== it) n++;
        });
        if (n) toast('머리행이 같은 파일 ' + n + '개에도 같은 연결을 적용했습니다.');
        render();
      });
      var col = det.map[f.id], exv = col == null ? '' : ex[col];
      if (f.id === 'date' && typeof exv === 'number') { var dt = L.toDateTime(exv); exv = dt.date + (dt.time ? ' ' + dt.time : '') + ' (엑셀 날짜 ' + exv + ')'; }
      mapGrid.appendChild(h('div', { class: 'map-row' + (f.req && col == null ? ' missing' : '') },
        h('span', { class: 'col' }, f.label, f.req ? h('span', { class: 'req' }, ' 필수') : null), sel,
        h('span', { class: 'ex' }, col == null ? '연결 안 됨' : '예: ' + (exv == null || exv === '' ? '(빈칸)' : String(exv)) + (f.id === 'runHr' && det.units.runHr && /분|min/.test(det.units.runHr) ? ' — 분 단위로 보고 시간으로 바꿈' : ''))));
    });
    var needs = det.missing.length > 0;
    return h('details', { class: 'block', open: needs || ui.pending.length === 1 ? true : null }, h('summary', null, it.fileName + (det.missing.length ? ' — 열 연결 필요' : '')),
      h('div', { class: 'form-grid' },
        fld('시트', sheetSel, it.sheets.length > 1 ? '로그 시트를 자동으로 골랐습니다.' : null),
        h('div', { class: 'field' }, h('span', null, '읽은 결과'),
          h('div', null, det.headerRow < 0 ? '머리행을 못 찾음' : '머리행 ' + (det.headerRow + 1) + '행 · 로그 행 ' + r.records.length + (r.skipped ? ' · 건너뛴 행 ' + r.skipped : '')))),
      det.warnings.map(function (w) { return h('p', { class: 'alert warn' }, w); }),
      r.warnings.length ? h('details', { class: 'warn-list' }, h('summary', null, '행 점검 알림 ' + r.warnings.length + '건'),
        h('ul', null, r.warnings.slice(0, 50).map(function (w) { return h('li', null, w.row + '행: ' + w.msg); }))) : null,
      h('details', { open: needs ? true : null }, h('summary', null, '열 연결 보기·고치기 (' + Object.keys(det.map).length + '개 연결됨)'), mapGrid));
  }

  /* ── 대시보드 ───────────────────────────── */
  function pageDash() {
    if (!db.records.length) return [pageHead('대시보드', '프레스·금형 예지보전'), emptyNotice()];
    var st = A.statuses, R = A.rules;
    var cnt = { bad: 0, warn: 0, ok: 0, none: 0 };
    st.forEach(function (s) { cnt[s.level] = (cnt[s.level] || 0) + 1; });
    var week = st.reduce(function (s, x) { return s + x.strokes7; }, 0);
    var hero = h('div', { class: 'hero' },
      h('div', { class: 'hero-text' }, h('h1', null, '프레스·금형 예지보전 대시보드'),
        h('p', null, '기준일 ' + A.asOf + ' (로그 마지막 날) · 로그 ' + A.range.first + ' ~ ' + A.range.last + ' · 프레스 ' + st.length + '대 · 금형 ' + A.dies.length + '개')));
    var kpis = h('div', { class: 'dkpis' },
      dk('점검 필요', cnt.bad, '대', 'lv-bad', '이상 감지 연속·오버홀 지남·금형 수명 초과'),
      dk('주의', cnt.warn, '대', 'lv-warn', '한계 근접·예정일 ' + R.alertDays + '일 안'),
      dk('정상', cnt.ok, '대', 'lv-ok', cnt.none ? '판정 기준 없음 ' + cnt.none + '대' : '기준 안쪽'),
      dk('최근 7일 타수', N(week), '타', 'lv-info', A.asOf.slice(5).replace('-', '/') + '까지 7일'));
    var cards = h('div', { class: 'press-grid' }, st.map(pressCard));
    var dies = A.dies.slice().sort(function (a, b) { return (b.ratio == null ? -1 : b.ratio) - (a.ratio == null ? -1 : a.ratio); });
    var dieBox = h('section', { class: 'dp' }, h('div', { class: 'dp-head' }, h('h2', null, '금형 수명 사용률'), h('a', { class: 'dp-more', href: '#/die' }, '금형 화면')),
      h('p', { class: 'dp-sub' }, '사용 타수 ÷ 수명 기준 타수. 세로 눈금 = 주의 기준 ' + Math.round(R.warnPct * 100) + '%'),
      h('ul', { class: 'lifelist' }, dies.slice(0, 10).map(function (d) {
        return h('li', null,
          h('div', { class: 'life-top' }, h('strong', null, d.id), h('span', { class: 'note' }, d.presses.join('·')), pill(d.level),
            h('span', { class: 'life-pct' }, d.ratio == null ? '기준 없음' : L.pctText(d.ratio))),
          lifeBar(d.ratio, R.warnPct, d.level),
          h('div', { class: 'note' }, d.life ? N(d.used) + ' / ' + N(d.life) + '타' + (d.dueDate ? ' · 교체 예정 ' + d.dueDate : '') : '수명 기준 타수를 설정에서 넣어 주세요'));
      })), dies.length > 10 ? h('p', { class: 'note' }, '사용률 상위 10개만 보입니다. 전체는 금형 화면에서.') : null);
    var sched = schedule(45);
    var schedBox = h('section', { class: 'dp' }, h('div', { class: 'dp-head' }, h('h2', null, '다가오는 정비 일정'), h('a', { class: 'dp-more', href: '#/overhaul' }, '오버홀 화면')),
      h('p', { class: 'dp-sub' }, '지난 것과 기준일부터 45일 안 · 예정일은 최근 ' + R.avgDays + '일 일평균 타수로 추정'),
      sched.length ? table(['예정일', '구분', '대상', '상태'], sched.map(function (x) {
        return { cells: [x.date + (x.date < A.asOf ? ' (지남)' : x.date === A.asOf ? ' (오늘)' : ' (' + L.daysBetween(A.asOf, x.date) + '일 뒤)'), x.kind, x.target, pill(x.level)] };
      }), { cls: 'dash-table' }) : h('p', { class: 'note' }, '45일 안에 예정된 금형 교체·오버홀이 없습니다.'));
    return [hero, kpis, h('h2', { class: 'sec' }, '프레스별 상태'), cards, h('div', { class: 'grid-2' }, dieBox, schedBox)];
  }
  function dk(t, v, unit, cls, note) {
    return h('div', { class: 'dk ' + cls }, h('div', { class: 'dk-body' }, h('div', { class: 'dk-t' }, t), h('div', { class: 'dk-v' }, String(v), h('small', null, unit)), h('div', { class: 'dk-note' }, note)));
  }
  function pressCard(s) {
    var last = s.lastDay || {};
    var sensors = s.sensors.filter(function (a) { return a.base; }).map(function (a) {
      return h('li', null, h('span', { class: 'k' }, a.label), h('span', { class: 'v' }, a.recent.median == null ? '-' : N(a.recent.median, 1) + a.unit),
        h('span', { class: 'note' }, '평소 ' + N(a.base.center, 1) + a.unit), a.level === 'ok' ? null : pill(a.level));
    });
    return h('article', { class: 'pcard lv-' + s.level },
      h('div', { class: 'pcard-top' }, h('div', null, h('h3', null, s.id), h('div', { class: 'note' }, s.type || '종류 미입력')), pill(s.level)),
      s.reasons.length ? h('ul', { class: 'reasons' }, s.reasons.slice(0, 3).map(function (r) { return h('li', { class: 'lv-' + r.level, title: r.text }, r.short || r.text); }))
        : h('p', { class: 'note' }, s.level === 'none' ? '판정 기준이 없습니다(설정에서 오버홀 주기·금형 수명을 넣어 주세요).' : '기준 안쪽입니다.'),
      s.reasons.length > 3 ? h('p', { class: 'note' }, '외 ' + (s.reasons.length - 3) + '건') : null,
      h('dl', { class: 'pstats' },
        h('dt', null, '최근 7일 타수'), h('dd', null, N(s.strokes7)),
        h('dt', null, '마지막 기록'), h('dd', null, s.lastDate + (last.strokes != null ? ' · ' + N(last.strokes) + '타' : '')),
        h('dt', null, '최근 금형'), h('dd', null, s.dies.join(', ') || '-'),
        h('dt', null, '오버홀 예정'), h('dd', null, s.overhaul && s.overhaul.dueDate ? s.overhaul.dueDate : '-')),
      sensors.length ? h('ul', { class: 'sens' }, sensors) : null,
      h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn btn-sm', onclick: function () { goPress(s.id); } }, '이상 감지 그래프')));
  }
  /* 정비 일정 — 금형 교체·오버홀 예정일, 지난 것 포함 */
  function schedule(days) {
    var until = L.addDays(A.asOf, days), out = [];
    A.dies.forEach(function (d) { if (d.dueDate && d.dueDate <= until) out.push({ date: d.dueDate, kind: '금형 교체', target: d.id + (d.presses.length ? ' (' + d.presses.join('·') + ')' : ''), level: d.level }); });
    A.overhauls.forEach(function (o) { if (o.dueDate && o.dueDate <= until) out.push({ date: o.dueDate, kind: '오버홀', target: o.id + (o.type ? ' · ' + o.type : ''), level: o.level }); });
    return out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }

  /* ── ① 금형 타수·교체 ───────────────────── */
  function pageDie() {
    if (!db.records.length) return [pageHead('①', '금형 타수 · 교체 주기'), emptyNotice()];
    var R = A.rules;
    var months = L.monthsOf(A.rows);
    var dieMonth = {};
    A.rows.forEach(function (r) { if (!r.die || r.s == null) return; var m = L.monthOf(r.date); (dieMonth[r.die] = dieMonth[r.die] || {})[m] = (dieMonth[r.die][m] || 0) + r.s; });
    var lifeRows = A.dies.map(function (d) {
      return { cls: d.level === 'bad' ? 'row-bad' : d.level === 'warn' ? 'row-warn' : null, cells: [h('strong', null, d.id), d.presses.join(', ') || '-', d.life ? N(d.life) : '-', d.startDate || '-',
        d.baseStrokes ? N(d.baseStrokes) : '0', N(d.logged), N(d.used),
        h('div', { class: 'cellbar' }, lifeBar(d.ratio, R.warnPct, d.level), h('span', null, d.ratio == null ? '-' : L.pctText(d.ratio))),
        N(d.avgPerDay), d.remain == null ? '-' : N(d.remain), d.dueDate ? d.dueDate + (d.daysLeft != null ? ' (' + d.daysLeft + '일)' : '') : '-', pill(d.level), replaceBtn(d.id)] };
    });
    var monthRows = A.dies.map(function (d) {
      var m = dieMonth[d.id] || {}, tot = 0;
      return [d.id].concat(months.map(function (x) { tot += m[x] || 0; return m[x] ? N(m[x]) : '-'; })).concat([N(tot)]);
    });
    return [
      pageHead('①', '금형 타수 · 교체 주기', '금형마다 사용 타수를 세고, 최근 ' + R.avgDays + '일 일평균 타수로 수명 기준 타수에 닿는 날을 추정합니다.',
        h('button', { type: 'button', class: 'btn', onclick: exportDies }, '엑셀로 내려받기')),
      h('div', { class: 'tiles' },
        tile('금형', A.dies.length + '개'),
        tile('점검 필요', A.dies.filter(function (d) { return d.level === 'bad'; }).length + '개', '수명 기준 도달'),
        tile('주의', A.dies.filter(function (d) { return d.level === 'warn'; }).length + '개', Math.round(R.warnPct * 100) + '% 이상 또는 ' + R.alertDays + '일 안'),
        tile('수명 기준 없음', A.dies.filter(function (d) { return !d.life; }).length + '개', '설정에서 입력')),
      h('section', { class: 'card' }, h('h2', null, '금형 수명 · 교체 예정 (기준일 ' + A.asOf + ')'),
        table(['금형', '쓴 프레스', '수명 기준 타수', '사용 시작일', '시작 시점 사용', '로그에서 센 타수', '사용 타수', '사용률', '일평균(최근 ' + R.avgDays + '일)', '남은 타수', '교체 예정일', '상태', '교체 기록'],
          lifeRows, { num: [0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0, 0], cls: 'dies' }),
        h('ul', { class: 'note' },
          h('li', null, '사용 타수 = 시작 시점 사용 타수 + 사용 시작일(교체일)부터 로그에서 센 타수. 수명 기준·시작일은 설정의 금형 기준표에서 고칩니다.'),
          h('li', null, '일평균은 쉬는 날을 포함한 달력 일수로 나눕니다(실제 쓰는 빈도 그대로 반영). 최근에 쓰지 않은 금형은 예정일을 내지 않습니다.'),
          h('li', null, '「교체 기록」은 교체·재연마한 날을 사용 시작일로 하고 시작 시점 사용 타수를 0 으로 되돌립니다.'))),
      h('section', { class: 'card' }, h('h2', null, '금형별 월 타수 집계'),
        table(['금형'].concat(months.map(L.monthLabel)).concat(['합계']), monthRows, { num: [0].concat(months.map(function () { return 1; })).concat([1]) }),
        h('p', { class: 'note' }, '로그 기간의 타수만 셉니다(시작 시점 사용 타수는 들어가지 않음).'))
    ];
  }
  function replaceBtn(id) {
    var inp = h('input', { type: 'date', value: A.asOf, 'aria-label': id + ' 교체일' });
    return h('span', { class: 'inline-act' }, inp, h('button', { type: 'button', class: 'btn btn-sm', onclick: function () {
      if (!inp.value) return;
      if (!confirm(id + ' 을(를) ' + inp.value + ' 에 교체·재연마한 것으로 기록할까요? 사용 시작일이 이 날로 바뀌고 시작 시점 사용 타수는 0 이 됩니다.')) return;
      var d = L.cleanDie(db.dies[id], id); d.startDate = inp.value; d.baseStrokes = 0; db.dies[id] = d; save(); toast(id + ' 교체를 기록했습니다.'); render();
    } }, '기록'));
  }
  function exportDies() {
    var wb = XLSX.utils.book_new();
    var a = [['금형', '쓴 프레스', '수명 기준 타수', '사용 시작일', '시작 시점 사용 타수', '로그에서 센 타수', '사용 타수', '사용률(%)', '일평균 타수', '남은 타수', '교체 예정일', '상태', '설명']];
    A.dies.forEach(function (d) { a.push([d.id, d.presses.join(', '), d.life, d.startDate, d.baseStrokes || 0, d.logged, d.used, d.ratio == null ? null : L.round(d.ratio * 100, 1), d.avgPerDay, d.remain, d.dueDate, L.LEVELS[d.level], d.reason]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(a), '금형 수명');
    var months = L.monthsOf(A.rows), b = [['금형'].concat(months.map(L.monthLabel)).concat(['합계'])];
    A.dies.forEach(function (d) {
      var tot = 0, row = [d.id];
      months.forEach(function (m) { var s = 0; A.rows.forEach(function (r) { if (r.die === d.id && r.s != null && L.monthOf(r.date) === m) s += r.s; }); tot += s; row.push(s); });
      row.push(tot); b.push(row);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(b), '금형별 월 타수');
    XLSX.writeFile(wb, '금형_타수_' + A.asOf + '.xlsx');
  }

  /* ── ② 오버홀 ───────────────────────────── */
  function pageOverhaul() {
    if (!db.records.length) return [pageHead('②', '오버홀 알림'), emptyNotice()];
    var R = A.rules;
    var rows = A.overhauls.map(function (o) {
      return { cls: o.level === 'bad' ? 'row-bad' : o.level === 'warn' ? 'row-warn' : null, cells: [h('strong', null, o.id), o.type || '-', o.lastOH || '-',
        o.ohStrokes ? N(o.ohStrokes) : '-', o.ohDays ? o.ohDays + '일' : '-', N(o.strokesSince), o.daysSince == null ? '-' : o.daysSince + '일',
        h('div', { class: 'cellbar' }, lifeBar(o.ratio, R.warnPct, o.level), h('span', null, o.ratio == null ? '-' : L.pctText(o.ratio) + (o.basis ? '(' + o.basis + ')' : ''))),
        o.dueDate ? o.dueDate + (o.overdueDays ? ' (' + o.overdueDays + '일 지남)' : o.daysLeft != null ? ' (' + o.daysLeft + '일)' : '') : '-', pill(o.level), ohBtn(o.id)] };
    });
    return [
      pageHead('②', '오버홀 알림', '프레스마다 마지막 오버홀부터 친 타수와 지난 날수를 오버홀 주기(타수·일수)와 견줍니다. 둘 다 있으면 먼저 닿는 쪽을 따릅니다.'),
      h('div', { class: 'tiles' },
        tile('프레스', A.overhauls.length + '대'),
        tile('점검 필요', A.overhauls.filter(function (o) { return o.level === 'bad'; }).length + '대', '주기 지남'),
        tile('주의', A.overhauls.filter(function (o) { return o.level === 'warn'; }).length + '대', Math.round(R.warnPct * 100) + '% 이상 또는 ' + R.alertDays + '일 안'),
        tile('주기 없음', A.overhauls.filter(function (o) { return o.level === 'none'; }).length + '대', '설정에서 입력')),
      h('section', { class: 'card' }, h('h2', null, '오버홀 현황 (기준일 ' + A.asOf + ')'),
        table(['프레스', '종류', '마지막 오버홀', '주기(타수)', '주기(일수)', '그 뒤 타수', '그 뒤 날수', '사용률', '예정일', '상태', '완료 기록'], rows, { num: [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0] }),
        h('ul', { class: 'note' },
          h('li', null, '그 뒤 타수 = 「마지막 오버홀 뒤 로그 이전 타수」(로그가 시작되기 전에 친 타수, 설정) + 마지막 오버홀 다음 날부터 로그에서 센 타수.'),
          h('li', null, '타수 기준 예정일은 최근 ' + R.avgDays + '일 일평균 타수로 추정합니다. 일수 기준은 마지막 오버홀 일자 + 주기입니다.'),
          h('li', null, '「완료 기록」은 마지막 오버홀 일자를 그 날로 바꾸고 로그 이전 타수를 0 으로 되돌립니다.')))
    ];
  }
  function ohBtn(id) {
    var inp = h('input', { type: 'date', value: A.asOf, 'aria-label': id + ' 오버홀 완료일' });
    return h('span', { class: 'inline-act' }, inp, h('button', { type: 'button', class: 'btn btn-sm', onclick: function () {
      if (!inp.value) return;
      if (!confirm(id + ' 오버홀을 ' + inp.value + ' 에 마친 것으로 기록할까요?')) return;
      var p = L.cleanPress(db.presses[id], id); p.lastOH = inp.value; p.ohBase = 0; db.presses[id] = p; save(); toast(id + ' 오버홀 완료를 기록했습니다.'); render();
    } }, '기록'));
  }

  /* ── ③ 이상 감지 ─────────────────────────── */
  var CH_COLOR = { current: 'var(--series-1)', temp: 'var(--series-2)', vib: 'var(--series-3)', voltage: 'var(--series-4)' };
  function pageAnomaly() {
    if (!db.records.length) return [pageHead('③', '이상 감지'), emptyNotice()];
    var R = A.rules;
    var presses = A.statuses.map(function (s) { return s.id; });
    if (!ui.press || presses.indexOf(ui.press) < 0) {
      var worstP = A.statuses.slice().sort(function (a, b) { return L.RANK[b.level] - L.RANK[a.level]; })[0];
      ui.press = worstP ? worstP.id : presses[0];
    }
    var sel = h('select', { 'aria-label': '프레스' });
    presses.forEach(function (p) { var o = h('option', { value: p }, p); if (p === ui.press) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', function () { ui.press = sel.value; render(); });
    var chans = L.CHANNELS.filter(function (c) { return R.channels[c.id]; });
    // 전체 한눈 표 — 프레스 × 채널
    var matrix = table(['프레스'].concat(chans.map(function (c) { return c.label; })), presses.map(function (p) {
      return [h('button', { type: 'button', class: 'linkbtn', onclick: function () { ui.press = p; render(); } }, p)].concat(chans.map(function (c) {
        var a = A.anomalies.filter(function (x) { return x.press === p && x.channel === c.id; })[0];
        return a ? pill(a.level) : h('span', { class: 'note' }, '열 없음');
      }));
    }), { cls: 'matrix' });
    var mine = A.anomalies.filter(function (a) { return a.press === ui.press; });
    var figs = mine.map(function (a) {
      return h('section', { class: 'card an lv-' + a.level },
        h('div', { class: 'an-top' }, pill(a.level), h('strong', null, ui.press + ' · ' + a.label + (a.unit ? '(' + a.unit + ')' : ''))),
        h('p', { class: 'an-ev' }, a.evidence),
        a.base ? h('p', { class: 'note' }, '기준선 구간 ' + a.base.from + ' ~ ' + a.base.to + ' (가동일 ' + a.base.n + '일) · 최근 구간 ' + a.recent.from + ' ~ ' + a.recent.to + ' (가동일 ' + a.recent.n + '일) · σ ' + N(a.base.sigma, 3) + a.unit +
          (a.base.floored ? ' (값이 거의 같아 기준선의 0.5% 를 바닥값으로 씀)' : '')) : null,
        C.sensorFigure(a.label + ' 하루 평균 — ' + ui.press, { points: a.points, base: a.base, recentFrom: a.recent.from, unit: a.unit, k: R.k, kWarn: R.kWarn, color: CH_COLOR[a.channel] }));
    });
    return [
      pageHead('③', '이상 감지 (통계 기준)', '평소(기준선)보다 벗어난 날이 이어지는지를 봅니다. 고장 기록으로 배운 예측이 아니라 「평소와 다름」을 알리는 1단계입니다.'),
      h('section', { class: 'card filters' }, fld('프레스', sel),
        h('p', { class: 'note span-all' }, ruleText(R) + ' · ', h('a', { href: '#/settings' }, '기준 바꾸기'))),
      h('section', { class: 'card' }, h('h2', null, '전체 한눈 보기 (기준일 ' + A.asOf + ')'), matrix),
      figs.length ? figs : h('section', { class: 'card' }, h('p', { class: 'note' }, ui.press + ' 에는 전류·전압·온도·진동 값이 없습니다.')),
      h('details', { class: 'card rules' }, h('summary', null, '이 판정을 읽는 법'),
        h('ul', null,
          h('li', null, '하루에 여러 행이 있으면 하루 평균으로 묶습니다. 쉬는 날(값 없음)은 건너뜁니다.'),
          h('li', null, '기준선 = 최근 구간 바로 앞 ' + R.baseDays + '일의 ' + (R.method === 'mad' ? '중앙값, 흩어짐 = 1.4826 × MAD(중앙값과의 차이의 중앙값). 튀는 값 몇 개에 흔들리지 않습니다.' : '평균, 흩어짐 = 표준편차.')),
          h('li', null, '관리한계 = 기준선 ± ' + R.k + 'σ, 주의 한계 = ± ' + R.kWarn + 'σ. 그래프의 빨간 점은 관리한계 밖, 주황 점은 주의 한계 밖입니다.'),
          h('li', null, '하루 튄 값만으로는 판정하지 않습니다(지속 조건). 전류와 온도가 함께 오르는 것처럼 여러 채널이 같이 움직이면 더 눈여겨봅니다.'),
          h('li', null, '2단계에서 고장·교체 이력을 받으면 「어떤 모양이 고장 전에 나왔는가」를 배워 기준을 맞춥니다.')))
    ];
  }
  function ruleText(R) { return L.ruleText(R); }

  /* ── ④ 월별 타수 보고서 ──────────────────── */
  function pageReport() {
    if (!db.records.length) return [pageHead('④', '월별 프레스 종류별 타수 보고서'), emptyNotice()];
    var mb = L.monthlyByType(A.rows, db.presses);
    if (!ui.month || mb.months.indexOf(ui.month) < 0) ui.month = mb.months[mb.months.length - 1];
    var sel = h('select', { 'aria-label': '월' });
    mb.months.slice().reverse().forEach(function (m) { var o = h('option', { value: m }, L.monthLabel(m)); if (m === ui.month) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', function () { ui.month = sel.value; render(); });
    var det = L.monthDetail(A.rows, db.presses, ui.month);
    var partial = ui.month === L.monthOf(A.range.first) && A.range.first.slice(8) !== '01' || ui.month === L.monthOf(A.range.last);
    var colors = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
    var fig = C.figure('월별 프레스 종류별 타수', { labels: mb.months.map(function (m) { return (+m.slice(5)) + '월'; }), type: 'bar',
      series: mb.types.map(function (t, i) { return { name: t.type, color: colors[i % colors.length], values: t.months.map(function (c) { return c.strokes; }) }; }) });
    var ai = (db.aiNotes || {})[A.asOf];
    var alerts = A.statuses.filter(function (s) { return s.level === 'bad' || s.level === 'warn'; });
    var paper = h('section', { class: 'card paper rp', id: 'reportPaper' },
      h('h1', null, '프레스 타수 월간 보고 — ' + L.monthLabel(ui.month)),
      h('p', { class: 'note' }, '로그 기간 ' + A.range.first + ' ~ ' + A.range.last + ' · 작성 기준일 ' + A.asOf + (partial ? ' · 이 달은 로그가 한 달 전부가 아닙니다' : '')),
      h('h2', null, '1. 프레스 종류별 타수'),
      table(['프레스 종류', '타수', '가동 시간(h)', '프레스·가동일', '프레스'], det.byType.map(function (g) { return [g.key, N(g.strokes), N(g.runHr, 1), g.days, g.presses.join(', ')]; })
        .concat([{ cls: 'sum', cells: ['합계', N(det.total), N(det.byType.reduce(function (s, g) { return s + g.runHr; }, 0), 1), '', ''] }]), { num: [0, 1, 1, 1, 0] }),
      h('h2', null, '2. 프레스별'),
      table(['프레스', '종류', '타수', '가동일', '일평균 타수', '가동 시간(h)', '시간당 타수'], det.byPress.map(function (g) {
        return [g.key, g.extra, N(g.strokes), g.days, N(g.perDay), N(g.runHr, 1), g.perHr == null ? '-' : N(g.perHr, 1)];
      }), { num: [0, 0, 1, 1, 1, 1, 1] }),
      h('h2', null, '3. 금형별'),
      table(['금형', '쓴 프레스', '타수', '사용일', '일평균 타수'], det.byDie.map(function (g) { return [g.key, g.presses.join(', '), N(g.strokes), g.days, N(g.perDay)]; }), { num: [0, 0, 1, 1, 1] }),
      h('h2', null, '4. 월별 추이 (프레스 종류별 타수)'),
      fig,
      table(L.monthlyToAoa(mb)[0], L.monthlyToAoa(mb).slice(1).map(function (r, i, all) { return { cls: i === all.length - 1 ? 'sum' : null, cells: r.map(function (v, j) { return j ? N(v) : v; }) }; }),
        { num: [0].concat(mb.months.map(function () { return 1; })).concat([1]) }),
      h('h2', null, '5. 현재 알림 (기준일 ' + A.asOf + ')'),
      alerts.length ? h('ul', null, alerts.map(function (s) {
        return h('li', null, h('strong', null, s.id + ' [' + L.LEVELS[s.level] + '] '), s.reasons.map(function (r) { return r.short || r.text; }).join(' / '));
      })) : h('p', null, '점검 필요·주의 프레스가 없습니다.'),
      ai ? [h('h2', null, '6. AI 분석 의견 (검토 후 사용)'), h('div', { class: 'pre' }, ai)] : null);
    return [
      pageHead('④', '월별 프레스 종류별 타수 보고서', '달을 고르면 종류별·프레스별·금형별 타수를 모읍니다. 엑셀로 받거나 인쇄(PDF 저장)할 수 있습니다.'),
      h('section', { class: 'card filters no-print' }, fld('보고 월', sel),
        h('div', { class: 'btn-row span-all' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { exportReport(mb, det); } }, '엑셀 내려받기'),
          h('button', { type: 'button', class: 'btn', onclick: function () { window.print(); } }, '인쇄 · PDF'))),
      h('div', { class: 'tiles no-print' },
        tile(L.monthLabel(ui.month) + ' 타수', N(det.total)),
        tile('가동 프레스', det.byPress.length + '대'),
        tile('쓴 금형', det.byDie.length + '개'),
        tile('프레스 종류', det.byType.length + '가지')),
      paper
    ];
  }
  function exportReport(mb, det) {
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(L.monthlyToAoa(mb)), '월별 종류별 타수');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(L.monthDetailToAoa(det)), L.monthLabel(det.month).replace(/\s/g, ''));
    var al = [['프레스', '종류', '상태', '근거']];
    A.statuses.forEach(function (s) { al.push([s.id, s.type, L.LEVELS[s.level], s.reasons.map(function (r) { return '[' + L.LEVELS[r.level] + '] ' + r.text; }).join(' / ')]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(al), '현재 알림');
    XLSX.writeFile(wb, '프레스_월간타수_' + det.month + '.xlsx');
  }

  /* ── ⑤ AI 분석 ──────────────────────────── */
  function pageAi() {
    if (!db.records.length) return [pageHead('⑤', 'AI 분석'), emptyNotice()];
    var mask = db.maskNames !== false;
    if (mask) {
      db.aliases.press = L.assignAliases(db.aliases.press, Object.keys(db.presses).concat(A.statuses.map(function (s) { return s.id; })), L.ALIAS.press);
      db.aliases.die = L.assignAliases(db.aliases.die, A.dies.map(function (d) { return d.id; }), L.ALIAS.die);
    }
    var months = L.monthsOf(A.rows);
    var info = L.buildAiPromptInfo({ asOf: A.asOf, range: A.range, rules: A.rules, statuses: A.statuses, anomalies: A.anomalies, dies: A.dies, overhauls: A.overhauls,
      month: months.length ? L.monthDetail(A.rows, db.presses, months[months.length - 1]) : null, aliases: mask ? db.aliases : null });
    var prompt = info.prompt;
    function back(t) { return mask ? L.unmaskText(t, db.aliases) : t; }
    var answer = h('textarea', { rows: 10, placeholder: 'AI 답을 여기에 붙여 넣어 주세요. 별칭(설비1·금형1)은 실제 이름으로 되돌려 월별 보고서의 「AI 분석 의견」에 넣습니다.' });
    answer.value = (db.aiNotes || {})[A.asOf] || '';
    answer.addEventListener('input', function () { db.aiNotes[A.asOf] = back(answer.value); save(); });
    answer.addEventListener('change', function () { var b = back(answer.value); if (b !== answer.value) { answer.value = b; toast('답의 별칭을 실제 이름으로 되돌렸습니다.'); } });
    var promptBox = h('textarea', { rows: 14, readonly: true, class: 'mono' }); promptBox.value = prompt;
    var maskBox = h('input', { type: 'checkbox' }); maskBox.checked = mask;
    maskBox.addEventListener('change', function () { db.maskNames = maskBox.checked; save(); render(); });
    var mapRows = [];
    ['press', 'die'].forEach(function (k) { Object.keys(info.map[k]).sort(L.natCmp).forEach(function (n) { mapRows.push([info.map[k][n], n, k === 'press' ? '프레스' : '금형']); }); });
    mapRows.sort(function (a, b) { return L.natCmp(a[0], b[0]); });
    var maskCard = h('div', { class: 'mask-box' },
      h('label', { class: 'opt' }, maskBox, h('span', null, h('span', { class: 't' }, '이름 가리기(외부 AI 에 프레스·금형 이름을 보내지 않음)'),
        h('span', { class: 's' }, '프롬프트의 프레스 이름을 「설비1」, 금형명을 「금형1」 같은 별칭으로 바꿉니다. 대응표는 이 브라우저에만 있고, AI 답의 별칭은 붙여 넣을 때 실제 이름으로 되돌립니다.'))),
      mask && info.leaks.length ? h('p', { class: 'alert warn' }, '가리지 못한 이름이 프롬프트에 남아 있습니다: ' + info.leaks.join(', ') + ' — 보내기 전에 지워 주세요.') : null,
      mask ? (info.leaks.length ? null : h('p', { class: 'note' }, '확인: 프롬프트에 실제 프레스·금형 이름이 없습니다(' + (Object.keys(db.aliases.press).length + Object.keys(db.aliases.die).length) + '개 대조). 프레스 종류(톤수)와 숫자는 그대로 들어갑니다.'))
        : h('p', { class: 'alert info' }, '지금은 실제 이름이 그대로 들어갑니다. 회사·협력사 보안 기준을 확인해 주세요.'),
      mask && mapRows.length ? h('details', null, h('summary', null, '별칭 대응표 — 이 프롬프트에 쓴 ' + mapRows.length + '개 (이 PC 에만 있음)'),
        table(['별칭', '실제 이름', '구분'], mapRows, { cls: 'alias' })) : null);
    return [
      pageHead('⑤', 'AI 분석 (반자동)', '도구가 계산한 사실(상태·근거 숫자·예정일)만 담은 프롬프트를 만듭니다. 로그 원본은 넣지 않습니다.'),
      h('section', { class: 'card', id: 'ai' },
        h('ol', { class: 'steps' },
          h('li', null, '아래 프롬프트를 복사해 회사가 허용한 AI(ChatGPT 등)에 붙여 넣어 주세요.'),
          h('li', null, '받은 답을 「AI 답」 칸에 붙여 넣으면 별칭이 실제 이름으로 돌아가 월별 보고서에 들어갑니다. 답은 꼭 검토해 주세요 — 원인은 추정입니다.')),
        maskCard, promptBox,
        h('div', { class: 'btn-row', style: 'margin:10px 0' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { copyText(prompt); } }, '프롬프트 복사'),
          AIP.sendButton('설정한 AI 서버로 보내기(선택)', function () { return prompt; }, function (text) { text = back(text); answer.value = text; db.aiNotes[A.asOf] = text; save(); toast('AI 답을 받았습니다(별칭은 실제 이름으로 되돌림). 검토 후 보고서에 씁니다.'); },
            { toast: toast, settingsHref: '#/settings', system: '너는 프레스 설비 보전 담당자를 돕는 보조야. 주어진 사실 밖의 숫자를 만들지 마.' })),
        fld('AI 답 (기준일 ' + A.asOf + ')', answer, '붙여 넣은 답은 이 브라우저에 저장됩니다.'))
    ];
  }

  /* ── 설정 ───────────────────────────────── */
  function pageSettings() {
    var pIds = Object.keys(db.presses).sort(L.natCmp), dIds = Object.keys(db.dies).sort(L.natCmp);
    var pInputs = pIds.map(function (id) {
      var p = L.cleanPress(db.presses[id], id);
      var x = { id: id, type: h('input', { value: p.type, 'aria-label': id + ' 종류' }), ohStrokes: numIn(p.ohStrokes, id + ' 오버홀 주기 타수'), ohDays: numIn(p.ohDays, id + ' 오버홀 주기 일수'),
        lastOH: h('input', { type: 'date', value: p.lastOH, 'aria-label': id + ' 마지막 오버홀' }), ohBase: numIn(p.ohBase, id + ' 로그 이전 타수'), note: h('input', { value: p.note, 'aria-label': id + ' 메모' }) };
      x.cells = [h('strong', null, id), x.type, x.ohStrokes, x.ohDays, x.lastOH, x.ohBase, x.note, delBtn('presses', id)];
      return x;
    });
    var dInputs = dIds.map(function (id) {
      var d = L.cleanDie(db.dies[id], id);
      var x = { id: id, life: numIn(d.life, id + ' 수명 기준 타수'), startDate: h('input', { type: 'date', value: d.startDate, 'aria-label': id + ' 사용 시작일' }),
        baseStrokes: numIn(d.baseStrokes, id + ' 시작 시점 사용 타수'), note: h('input', { value: d.note, 'aria-label': id + ' 메모' }) };
      x.cells = [h('strong', null, id), x.life, x.startDate, x.baseStrokes, x.note, delBtn('dies', id)];
      return x;
    });
    function saveMaster() {
      pInputs.forEach(function (x) { db.presses[x.id] = L.cleanPress({ type: x.type.value, ohStrokes: x.ohStrokes.value, ohDays: x.ohDays.value, lastOH: x.lastOH.value, ohBase: x.ohBase.value, note: x.note.value }, x.id); });
      dInputs.forEach(function (x) { db.dies[x.id] = L.cleanDie({ life: x.life.value, startDate: x.startDate.value, baseStrokes: x.baseStrokes.value, note: x.note.value }, x.id); });
      save(); toast('기준표를 저장했습니다.'); render();
    }
    var newP = h('input', { placeholder: '예: P5', 'aria-label': '새 프레스 이름' }), newD = h('input', { placeholder: '예: M-09', 'aria-label': '새 금형 이름' });
    var masterFile = h('input', { type: 'file', accept: '.xlsx,.xls' });
    masterFile.addEventListener('change', function () {
      var f = masterFile.files[0]; if (!f) return;
      f.arrayBuffer().then(function (buf) {
        var wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: false });
        var n = { p: 0, d: 0 };
        wb.SheetNames.forEach(function (sn) {
          var aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
          var r = L.masterFromAoa(aoa);
          Object.keys(r.presses).forEach(function (k) { db.presses[k] = r.presses[k]; n.p++; });
          Object.keys(r.dies).forEach(function (k) { db.dies[k] = r.dies[k]; n.d++; });
        });
        save(); toast('기준표를 불러왔습니다 — 프레스 ' + n.p + '대 · 금형 ' + n.d + '개'); render();
      }).catch(function (e) { toast('불러오지 못했습니다: ' + e.message, true); });
      masterFile.value = '';
    });
    var backup = h('input', { type: 'file', accept: '.json' });
    backup.addEventListener('change', function () {
      var f = backup.files[0]; if (!f) return;
      f.text().then(function (t) {
        var o = JSON.parse(t); if (!o || !Array.isArray(o.records)) throw new Error('이 도구의 백업 파일이 아닙니다.');
        db = L.restoreDb(o); save(); toast('백업을 불러왔습니다(' + db.records.length + '행).'); render();
      }).catch(function (e) { toast('불러오지 못했습니다: ' + e.message, true); });
    });
    return [
      pageHead('설정', '설비·금형 기준표 · 판정 기준 · AI 연결 · 백업'),
      h('section', { class: 'card' }, h('h2', null, '설비(프레스) 기준표 — 오버홀 주기'),
        h('p', { class: 'note' }, '로그를 가져오면 처음 보는 프레스가 자동으로 더해집니다. 오버홀 주기는 타수·일수 가운데 아는 것만 넣어도 됩니다. 「프레스 종류」는 월별 보고서의 묶음 기준입니다(비우면 로그의 값을 씀).'),
        pIds.length ? table(['프레스', '프레스 종류', '오버홀 주기(타수)', '오버홀 주기(일)', '마지막 오버홀 일자', '마지막 오버홀 뒤 로그 이전 타수', '메모', ''], pInputs.map(function (x) { return x.cells; }), { cls: 'items' }) : h('p', { class: 'note' }, '아직 없습니다.'),
        h('div', { class: 'btn-row', style: 'margin-top:10px' }, newP, h('button', { type: 'button', class: 'btn', onclick: function () {
          var id = newP.value.trim(); if (!id) return; if (db.presses[id]) { toast('이미 있는 프레스입니다.', true); return; }
          db.presses[id] = L.emptyPress(id); save(); render();
        } }, '프레스 추가'))),
      h('section', { class: 'card' }, h('h2', null, '금형 기준표 — 수명 기준 타수'),
        h('p', { class: 'note' }, '사용 타수 = 시작 시점 사용 타수 + 사용 시작일(교체·재연마한 날)부터 로그에서 센 타수. 시작일을 비우면 로그 전체를 셉니다.'),
        dIds.length ? table(['금형', '수명 기준 타수', '사용 시작일(교체일)', '시작 시점 사용 타수', '메모', ''], dInputs.map(function (x) { return x.cells; }), { cls: 'items' }) : h('p', { class: 'note' }, '아직 없습니다.'),
        h('div', { class: 'btn-row', style: 'margin-top:10px' }, newD, h('button', { type: 'button', class: 'btn', onclick: function () {
          var id = newD.value.trim(); if (!id) return; if (db.dies[id]) { toast('이미 있는 금형입니다.', true); return; }
          db.dies[id] = L.emptyDie(id); save(); render();
        } }, '금형 추가'))),
      h('div', { class: 'submit-bar' },
        h('button', { type: 'button', class: 'btn', onclick: function () { exportMaster(); } }, '기준표 엑셀로 내려받기'),
        h('label', { class: 'btn' }, masterFile, '기준표 엑셀 불러오기'),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: saveMaster }, '기준표 저장')),
      rulesCard(),
      AIP.settingsCard({ toast: toast, onChange: render }),
      h('section', { class: 'card' }, h('h2', null, '백업'),
        h('p', { class: 'note' }, '쌓인 로그와 기준표는 이 브라우저에만 있습니다. 다른 PC 로 옮기거나 브라우저 정리 전에 JSON 으로 받아 두세요.'),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn', onclick: function () { download('프레스예지보전_백업_' + new Date().toISOString().slice(0, 10) + '.json', new Blob([JSON.stringify(db)], { type: 'application/json' })); } }, 'JSON 백업 내려받기'),
          h('label', { class: 'btn' }, backup, 'JSON 백업 불러오기')))
    ];
  }
  function numIn(v, label) { return h('input', { type: 'number', min: 0, step: 'any', inputmode: 'numeric', value: v == null ? '' : v, 'aria-label': label }); }
  function delBtn(kind, id) {
    return h('button', { type: 'button', class: 'btn btn-sm btn-danger', 'aria-label': id + ' 기준표에서 빼기', onclick: function () {
      var used = db.records.some(function (r) { return kind === 'presses' ? r.press === id : r.die === id; });
      if (!confirm(id + ' 을(를) 기준표에서 뺄까요?' + (used ? ' 로그에 남아 있어 다음에 가져오기를 하면 빈 칸으로 다시 생깁니다.' : ''))) return;
      delete db[kind][id]; save(); render();
    } }, '빼기');
  }
  function exportMaster() {
    var wb = XLSX.utils.book_new(), m = L.masterToAoa(db.presses, db.dies);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(m.presses), '설비 기준표');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(m.dies), '금형 기준표');
    XLSX.writeFile(wb, '설비_금형_기준표.xlsx');
  }
  function rulesCard() {
    var r = L.cleanRules(db.rules);
    var defs = [
      ['avgDays', '예정일 추정에 쓸 최근 일수', 1, 1], ['warnPct', '수명·주기 「주의」 기준 (%)', 100, 1], ['alertDays', '예정일이 며칠 안이면 「주의」', 1, 1],
      ['recentDays', '이상 감지 — 최근 구간(일)', 1, 1], ['baseDays', '이상 감지 — 기준선 구간(일)', 1, 1], ['minBase', '기준선에 필요한 최소 가동일', 1, 1],
      ['k', '관리한계 k (σ 배수)', 1, 0.5], ['kWarn', '주의 한계 (σ 배수)', 1, 0.5], ['persist', '연속 가동일 수(지속 조건)', 1, 1], ['spikes', '연속 아니어도 관리한계 밖 며칠이면 「주의」', 1, 1]];
    var inputs = {};
    var grid = h('div', { class: 'form-grid' }, defs.map(function (d) {
      var i = h('input', { type: 'number', min: 0, step: d[3], value: L.round(r[d[0]] * d[2], 2), inputmode: 'decimal' });
      inputs[d[0]] = { el: i, mul: d[2] };
      return fld(d[1], i);
    }));
    var method = h('select', { 'aria-label': '기준선 계산' }, h('option', { value: 'mad' }, '중앙값 · MAD (튀는 값에 강함, 권장)'), h('option', { value: 'sigma' }, '평균 · 표준편차'));
    method.value = r.method;
    var chBoxes = L.CHANNELS.map(function (c) { var b = h('input', { type: 'checkbox' }); b.checked = !!r.channels[c.id]; return { id: c.id, el: b, label: h('label', { class: 'opt' }, b, h('span', { class: 't' }, c.label)) }; });
    return h('section', { class: 'card', id: 'rules' }, h('h2', null, '판정 기준'),
      h('p', { class: 'note' }, '지금: ' + L.ruleText(r)),
      grid,
      h('div', { class: 'form-grid', style: 'margin-top:12px' }, fld('기준선 계산', method), h('div', { class: 'field span-all' }, h('span', null, '살펴볼 채널'), h('div', { class: 'opt-grid' }, chBoxes.map(function (c) { return c.label; })))),
      h('div', { class: 'btn-row', style: 'margin-top:10px' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: function () {
          var p = { method: method.value, channels: {} };
          Object.keys(inputs).forEach(function (k) { p[k] = Number(inputs[k].el.value) / inputs[k].mul; });
          chBoxes.forEach(function (c) { p.channels[c.id] = c.el.checked; });
          db.rules = L.cleanRules(p); save(); toast('판정 기준을 바꿨습니다.'); render();
        } }, '기준 적용'),
        h('button', { type: 'button', class: 'btn', onclick: function () { db.rules = L.cleanRules({}); save(); toast('기본값으로 되돌렸습니다.'); render(); } }, '기본값으로')));
  }

  /* ── 라우터 ─────────────────────────────── */
  var PAGES = [
    { id: 'dash', no: '홈', t: '대시보드', s: '프레스 상태·금형 수명', fn: pageDash },
    { id: 'import', no: '0', t: '데이터 가져오기', s: '로그 엑셀·CSV 여러 개', fn: pageImport },
    { id: 'die', no: '①', t: '금형 타수·교체', s: '수명 사용률·교체 예정일', fn: pageDie },
    { id: 'overhaul', no: '②', t: '오버홀 알림', s: '타수·일수 주기', fn: pageOverhaul },
    { id: 'anomaly', no: '③', t: '이상 감지', s: '전류·온도·진동·전압', fn: pageAnomaly },
    { id: 'report', no: '④', t: '월별 타수 보고서', s: '프레스 종류별·엑셀·인쇄', fn: pageReport },
    { id: 'ai', no: '⑤', t: 'AI 분석', s: '사실만 담은 프롬프트', fn: pageAi },
    { id: 'settings', no: '설', t: '설정', s: '기준표·판정 기준·백업', fn: pageSettings }
  ];
  function route() { var id = (location.hash || '').replace(/^#\//, '').split('?')[0]; return PAGES.filter(function (p) { return p.id === id; })[0] || (db.records.length ? PAGES[0] : PAGES[1]); }
  function render() {
    var p = route();
    A = L.analyze(db);
    document.body.setAttribute('data-route', p.id);
    var nav = document.getElementById('nav'); nav.innerHTML = '';
    PAGES.forEach(function (x) {
      var badge = null;
      if (x.id === 'dash' && db.records.length) { var nb = A.statuses.filter(function (s) { return s.level === 'bad'; }).length; if (nb) badge = h('span', { class: 'nav-badge', title: '점검 필요 ' + nb + '대' }, String(nb)); }
      nav.appendChild(h('a', { href: '#/' + x.id, 'aria-current': x === p ? 'page' : null }, h('span', { class: 'no' }, x.no), h('span', { class: 't' }, x.t, badge), h('span', { class: 's' }, x.s)));
    });
    document.getElementById('dataChip').textContent = db.records.length
      ? '기준일 ' + A.asOf + ' · 프레스 ' + A.statuses.length + '대 · 금형 ' + A.dies.length + '개 · 로그 ' + L.fmtN(db.records.length) + '행'
      : '데이터 없음';
    var b = document.getElementById('sampleBanner');
    b.hidden = !db.sample;
    b.textContent = '지금 보시는 것은 가상 샘플입니다(프레스 P1~P4 × 90일, 금형 M-01~M-08). 금형 M-05 수명 임박, P2 전류·온도 상승(마지막 2주), P4 오버홀 주기 지남을 일부러 심어 두었습니다. 실제 로그를 넣기 전에 「데이터 가져오기 → 모든 데이터 지우기」를 해 주세요.';
    main.innerHTML = '';
    add(main, p.fn());
    document.title = p.t + ' — 프레스·금형 예지보전';
    save();
  }
  window.addEventListener('hashchange', function () { render(); main.focus(); window.scrollTo(0, 0); });
  render();
})();
