/* 프레스·금형 예지보전 — 화면
   계산은 js/logic.js(PressLogic), 그래프는 js/charts.js, 저장은 js/store.js, AI 연결은 js/ai-endpoint.js·ai-panel.js. */
(function () {
  'use strict';
  var L = window.PressLogic, S = window.PressStore, C = window.PressCharts, AIP = window.AIPanel, P = window.PressSPC, RS = window.PressRaw;
  var db = S.loadDb();
  var ui = { press: '', month: '', pending: [], errors: [], progress: '', busy: false, spc: { press: '', die: -1, view: 'all', from: '', to: '', group: 0 } };
  var raw = {};       // 2초 센서 로그 — 프레스마다 시계열(IndexedDB 에 저장, js/rawstore.js)
  var rawInfo = {};   // 프레스마다 타수·정지 계산 캐시
  var rawSaved = null; // true 저장됨 · false 저장 안 됨(메모리만)
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
  /* CSV 는 앞부분(512KB)만 먼저 읽어 2초 로그인지 봅니다. 2초 로그면 반영할 때 조각으로 끝까지 읽고(큰 파일도 화면이 멈추지 않게),
     아니면 지금처럼 통째로 읽습니다. */
  var HEAD_BYTES = 512 * 1024, CHUNK_BYTES = 4 * 1024 * 1024;
  function readFile(file) {
    if (!/\.(csv|txt)$/i.test(file.name)) return readWhole(file);
    return file.slice(0, HEAD_BYTES).arrayBuffer().then(function (buf) {
      var u8 = new Uint8Array(buf), enc = P.sniffEncoding(u8);
      var text = new TextDecoder(enc).decode(u8);
      var aoa = P.parseCsvText(text);
      if (file.size > HEAD_BYTES && aoa.length > 1) aoa.pop(); // 잘린 마지막 행
      var det = L.detectColumns(aoa), hf = P.isHighFreq(aoa, det);
      if (!hf.high) return readWhole(file);
      var it = { fileName: file.name, sheets: [{ name: 'CSV', aoa: aoa }], sheet: 'CSV', overrides: {}, file: file, previewOnly: true, encoding: enc === 'utf-8' ? 'UTF-8' : 'EUC-KR(CP949)', size: file.size };
      reparse(it);
      return it;
    });
  }
  function readWhole(file) {
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
    item.hf = P.isHighFreq(item.aoa, item.result.det);
    item.raw = item.previewOnly ? true : item.hf.high;
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
        if (!it.fileName) throw new Error(f.name + ': 읽지 못했습니다.');
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
    var rawItems = items.filter(function (it) { return it.raw && !it.result.det.missing.length; });
    items.forEach(function (it) {
      var r = it.result;
      if (r.det.missing.length || it.raw) return;
      var m = L.mergeRecords(db.records, r.records);
      db.records = m.records;
      total.added += m.stat.added; total.updated += m.stat.updated;
      db.files.push({ name: it.fileName, sheet: it.sheet, rows: r.records.length, at: new Date().toISOString().slice(0, 16).replace('T', ' ') });
      ok++;
    });
    function finish(rawMsg) {
      var sm = L.syncMaster(db.presses, db.dies, db.records);
      db.presses = sm.presses; db.dies = sm.dies;
      db.sample = db.sample && items.every(function (it) { return it.sample; });
      ui.pending = ui.pending.filter(function (p) { return items.indexOf(p) < 0; });
      ui.errors = [];
      save();
      toast((ok ? ok + '개 파일 반영 — 새 행 ' + total.added + ' · 바뀐 행 ' + total.updated : '') + (rawMsg ? (ok ? ' · ' : '') + rawMsg : '') +
        (sm.added.presses || sm.added.dies ? ' · 기준표에 프레스 ' + sm.added.presses + '대·금형 ' + sm.added.dies + '개 추가(설정에서 수명·주기를 넣어 주세요)' : ''));
      render();
    }
    if (!rawItems.length) { finish(''); return Promise.resolve(); }
    ui.busy = true; render();
    return readRawItems(rawItems).then(function (st) {
      ui.busy = false; ui.progress = '';
      finish('2초 로그 ' + rawItems.length + '개 파일 ' + L.fmtN(st.rows) + '행 → 프레스 ' + st.presses.join(', ') + (st.replaced ? ' (같은 시각 ' + L.fmtN(st.replaced) + '행은 새 값으로)' : '') + (st.warnCount ? ' · 행 점검 알림 ' + L.fmtN(st.warnCount) + '건' : ''));
      if (location.hash !== '#/spc' && !items.some(function (it) { return it.sample; })) location.hash = '#/spc';
    }, function (e) {
      ui.busy = false; ui.progress = '';
      ui.errors.push(e.message || String(e)); toast('2초 로그를 반영하지 못했습니다: ' + (e.message || e), true); render();
    });
  }

  /* ── 2초 로그 반영 ─────────────────────── */
  function setProgress(t) { ui.progress = t; var pr = document.getElementById('importProgress'); if (pr) pr.textContent = t; }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  /* 파일마다 조각으로 읽어 행 → 프레스별 시계열 → 이미 있는 것과 합치기 → 일 집계를 기존 판정으로 */
  function readRawItems(items) {
    var stat = { rows: 0, replaced: 0, warnCount: 0, presses: [] }, touched = {};
    var chain = Promise.resolve();
    items.forEach(function (it, idx) {
      chain = chain.then(function () {
        var b = P.createRawBuilder(it.result.det), det = it.result.det, label = '(' + (idx + 1) + '/' + items.length + ') ' + it.fileName;
        var work;
        if (it.previewOnly && it.file) {
          var pos = 0, rowNo = 0, dec = new TextDecoder(it.encoding === 'UTF-8' ? 'utf-8' : 'euc-kr'), started = Date.now();
          var parser = P.createCsvParser(function (row) { rowNo++; if (rowNo - 1 > det.headerRow) b.add(row, rowNo); });
          work = (function next() {
            if (pos >= it.file.size) { parser.push(dec.decode()); parser.end(); return Promise.resolve(); }
            return it.file.slice(pos, pos + CHUNK_BYTES).arrayBuffer().then(function (buf) {
              pos += buf.byteLength;
              parser.push(dec.decode(new Uint8Array(buf), { stream: true }));
              setProgress('읽는 중 ' + label + ' — ' + Math.round(pos / it.file.size * 100) + '% · ' + L.fmtN(b.result.rows) + '행' + (Date.now() - started > 1500 ? ' · ' + Math.round((Date.now() - started) / 1000) + '초' : ''));
              return tick().then(next);
            });
          })();
        } else {
          var aoa = it.aoa, r = det.headerRow + 1;
          work = (function next() {
            var end = Math.min(aoa.length, r + 20000);
            for (; r < end; r++) b.add(aoa[r], r + 1);
            setProgress('읽는 중 ' + label + ' — ' + Math.round(r / aoa.length * 100) + '%');
            return r < aoa.length ? tick().then(next) : Promise.resolve();
          })();
        }
        return work.then(function () {
          setProgress('합치는 중 ' + label);
          var res = b.finish();
          stat.rows += res.rows; stat.warnCount += res.warnCount;
          if (res.warnings.length) ui.rawWarnings = res.warnings;
          Object.keys(res.series).forEach(function (p) {
            var m = P.mergeSeries(raw[p], res.series[p]);
            stat.replaced += m.replaced || 0; raw[p] = m; touched[p] = 1; delete rawInfo[p];
          });
          db.rawFiles = (db.rawFiles || []).concat([{ name: it.fileName, rows: res.rows, skipped: res.skipped, presses: Object.keys(res.series).sort(L.natCmp).join(', '),
            from: P.stampText(res.first), to: P.stampText(res.last), at: new Date().toISOString().slice(0, 16).replace('T', ' ') }]);
          return tick();
        });
      });
    });
    return chain.then(function () {
      stat.presses = Object.keys(touched).sort(L.natCmp);
      setProgress('일 집계 만드는 중');
      rebuildDaily(stat.presses);
      return saveRaw(stat.presses).then(function () { return stat; });
    });
  }
  function infoOf(p) {
    var O = P.cleanOpts(db.spc), key = raw[p].n + '|' + O.cycleSec + '|' + O.stopSec + '|' + O.gapSec;
    if (!rawInfo[p] || rawInfo[p].key !== key) { rawInfo[p] = P.strokeInfo(raw[p], O); rawInfo[p].key = key; }
    return rawInfo[p];
  }
  /* 원 로그 → 하루 묶음(프레스·날짜·금형) — 기존 금형·오버홀·「최근 14일 vs 앞 42일」 판정이 이어서 씁니다 */
  function rebuildDaily(presses) {
    presses.forEach(function (p) {
      db.records = db.records.filter(function (r) { return !(r.src === 'raw' && r.press === p); });
      if (!raw[p]) return;
      db.records = L.mergeRecords(db.records, P.dailyFromSeries(raw[p], infoOf(p))).records;
    });
  }
  function saveRaw(presses) {
    var m = {}; presses.forEach(function (p) { if (raw[p]) m[p] = raw[p]; });
    return RS.save(m).then(function (ok) { rawSaved = ok; });
  }
  function rawRows() { return Object.keys(raw).reduce(function (s, p) { return s + raw[p].n; }, 0); }
  function clearRaw() { raw = {}; rawInfo = {}; db.rawFiles = []; return RS.clear(); }
  function loadRawSample() {
    toast('2초 로그 샘플을 만드는 중입니다(4대 × 3일, 172,350행)…');
    ui.busy = true; render();
    setTimeout(function () {
      var det = L.detectColumns([window.PressSample.RAW_HEAD]);
      var it = { fileName: '센서로그_샘플_2026-10-19~21 (2초)', result: { det: det, records: [], warnings: [] }, raw: true, sample: true, aoa: [window.PressSample.RAW_HEAD] };
      window.PressSample.buildRaw(function (row) { it.aoa.push(row); });
      clearRaw().then(function () {
        db = L.emptyDb(); db.sample = true; db.sampleKind = 'raw';
        ui.pending = []; ui.press = ''; ui.month = ''; ui.spc = { press: '', die: -1, view: 'all', from: '', to: '', group: 0 };
        return commit([it]);
      }).then(function () { location.hash = '#/spc'; });
    }, 30);
  }
  function askRawSample() { if ((!db.records.length && !rawRows()) || confirm('지금 데이터를 지우고 2초 로그 샘플(프레스 4대 × 3일)을 불러올까요?')) loadRawSample(); }
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
    clearRaw();
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
          h('button', { type: 'button', class: 'btn', onclick: askRawSample }, '2초 로그 샘플(4대 × 3일)'),
          h('a', { class: 'btn', href: 'samples/' + encodeURIComponent('센서로그_샘플_2026-10-21.csv'), download: '' }, '2초 로그 샘플 CSV 내려받기'),
          h('a', { class: 'btn', href: 'samples/' + encodeURIComponent('프레스로그_샘플_2026-09.xlsx'), download: '' }, '샘플 엑셀 내려받기(9월)'),
          h('a', { class: 'btn', href: 'samples/' + encodeURIComponent('프레스로그_샘플_2026-10.csv'), download: '' }, '샘플 CSV 내려받기(10월)')),
        h('ul', { class: 'note' },
          h('li', null, '한 행 = 한 프레스의 한 기록(하루 또는 시각별)입니다. 꼭 필요한 열은 일자와 프레스이고, 나머지(프레스 종류·금형명·타수·누적 타수·가동 시간·전류·전압·온도·진동)는 있는 만큼 씁니다.'),
          h('li', null, '2초 간격 센서 로그(일자에 초까지, 예: 2026-10-01 09:00:02)는 알아서 가려 「실시간 관리도」로 보냅니다. 큰 CSV(하루 43,200행 × 프레스 여러 대)도 조각으로 나눠 읽어 화면이 멈추지 않습니다. 같은 프레스·같은 시각은 한 번만 셉니다.'),
          h('li', null, '타수는 「타수」 열이 있으면 그 값을, 없으면 같은 프레스의 「프레스 누적 타수」 차이를, 그것도 없으면 「금형 (누적) 타수」 차이를 씁니다. 「금형 타수」 열은 금형 교체 때 0 으로 돌아가는 누적 카운터로 읽습니다(받은 로그 확인).'),
          h('li', null, '같은 행(일자 + 시각 + 프레스 + 금형)을 다시 가져오면 새 값으로 바뀝니다. 같은 파일을 두 번 넣어도 두 번 세지 않습니다.'),
          h('li', null, 'CSV 는 UTF-8 과 한글 엑셀이 저장한 CP949(EUC-KR) 를 알아서 가려 읽습니다.'),
          h('li', null, '파일은 서버로 보내지 않고 이 브라우저 안에서만 읽습니다.')),
        h('p', { class: 'note progress', id: 'importProgress', 'aria-live': 'polite' }, ui.progress || ''),
        ui.errors.length ? h('details', { class: 'warn-list', open: true }, h('summary', null, '읽지 못했거나 건너뛴 파일 ' + ui.errors.length + '개'),
          h('ul', null, ui.errors.map(function (e) { return h('li', null, e); }))) : null)];

    if (ui.pending.length) {
      var box = h('section', { class: 'card' }, h('h2', null, '2. 열 연결 확인 후 반영 (' + ui.pending.length + '개 파일)'));
      var ready = ui.pending.filter(function (it) { return !it.result.det.missing.length; });
      box.appendChild(table(['파일', '기간', '행', '프레스', '알림', '상태'], ui.pending.map(function (it) {
        var r = it.result, rg = L.dataRange(r.records);
        var presses = []; r.records.forEach(function (x) { if (presses.indexOf(x.press) < 0) presses.push(x.press); });
        var rows = it.previewOnly ? '앞부분 ' + r.records.length + '행 미리 봄 · 전체 ' + (it.size / 1048576).toFixed(1) + 'MB' : r.records.length;
        return { cls: r.det.missing.length ? 'excluded' : null, cells: [it.fileName + (it.encoding ? ' (' + it.encoding + ')' : ''),
          rg.first ? rg.first + ' ~ ' + rg.last + (it.previewOnly ? ' …' : '') : '-', rows, presses.sort(L.natCmp).join(', ') || '-', r.warnings.length + r.det.warnings.length,
          r.det.missing.length ? '열 연결 필요' : it.raw ? '2초 센서 로그(' + (it.hf.reason || '고빈도') + ') → 실시간 관리도' : it.already ? '이전에 가져온 파일(새 값으로 바뀜)' : '반영 준비됨'] };
      }), { num: [0, 0, 0, 0, 1, 0] }));
      box.appendChild(h('h3', null, '파일별 자세히'));
      ui.pending.forEach(function (it) { box.appendChild(pendingCard(it)); });
      box.appendChild(h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary', disabled: !ready.length || ui.busy, onclick: function () { commit(ready); } }, ui.busy ? '읽는 중…' : '확인한 ' + ready.length + '개 파일 반영'),
        h('button', { type: 'button', class: 'btn', onclick: function () { ui.pending = []; render(); } }, '취소')));
      out.push(box);
    }

    var presses = Object.keys(db.presses), st = A.strokeStat;
    var rawPs = Object.keys(raw).sort(L.natCmp);
    if (rawPs.length) out.push(h('section', { class: 'card' }, h('h2', null, '쌓인 2초 센서 로그'),
      table(['프레스', '종류', '기간', '행', '날 수', '금형'], rawPs.map(function (p) { var m = P.summary(raw[p]); return [p, m.type || '-', P.stampText(m.from) + ' ~ ' + P.stampText(m.to), N(m.n), m.days, m.dies.join(', ') || '-']; }), { num: [0, 0, 0, 1, 1, 0] }),
      h('p', { class: 'note' }, rawSaved === false ? '이 브라우저 저장소(IndexedDB)가 막혀 이번 창에만 있습니다. 창을 닫으면 사라집니다.' : '이 브라우저(IndexedDB)에 저장됩니다. 하루 묶음(타수·가동 시간·센서 평균)은 아래 「쌓인 데이터」로 이어져 금형·오버홀·일 단위 이상 감지에 쓰입니다.'),
      ui.rawWarnings && ui.rawWarnings.length ? h('details', { class: 'warn-list' }, h('summary', null, '마지막으로 읽은 파일의 행 점검 알림(앞 50건)'),
        h('ul', null, ui.rawWarnings.map(function (w) { return h('li', null, (w.row ? w.row + '행: ' : '') + w.msg); }))) : null,
      (db.rawFiles || []).length ? h('details', null, h('summary', null, '가져온 2초 로그 파일 ' + db.rawFiles.length + '개'),
        table(['파일', '프레스', '처음', '끝', '행', '가져온 때'], db.rawFiles.slice().reverse().map(function (f) { return [f.name, f.presses, f.from, f.to, N(f.rows), f.at]; }), { num: [0, 0, 0, 0, 1, 0] })) : null,
      h('div', { class: 'btn-row', style: 'margin-top:12px' },
        h('a', { class: 'btn btn-primary', href: '#/spc' }, '실시간 관리도 보기'),
        h('button', { type: 'button', class: 'btn', onclick: function () {
          if (!confirm('2초 센서 로그와 거기서 만든 하루 묶음만 지울까요?')) return;
          clearRaw().then(function () { db.records = db.records.filter(function (r) { return r.src !== 'raw'; }); save(); render(); });
        } }, '2초 로그만 지우기'))));
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
            db = L.emptyDb(); S.clearDb(); ui.press = ''; ui.month = ''; clearRaw(); save(); render();
          } }, '모든 데이터 지우기'),
          h('button', { type: 'button', class: 'btn', onclick: function () {
            if (!confirm('로그만 지우고 설비·금형 기준표와 설정은 남길까요?')) return;
            db.records = []; db.files = []; db.sample = false; clearRaw(); save(); render();
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
    return [hero, kpis, rawDash(), h('h2', { class: 'sec' }, '프레스별 상태 (하루 묶음 기준)'), cards, h('div', { class: 'grid-2' }, dieBox, schedBox)];
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


  /* ── 실시간 관리도 (2초 센서 로그) ─────────── */
  var CH_META = { current: { label: '전류', unit: 'A', color: 'var(--series-1)' }, voltage: { label: '전압', unit: 'V', color: 'var(--series-4)' },
    temp: { label: '온도', unit: '℃', color: 'var(--series-2)' }, vib: { label: '진동', unit: 'mm/s', color: 'var(--series-3)' } };
  var VIEWS = [['all', '전체'], [10, '최근 10분'], [30, '최근 30분'], [60, '최근 1시간'], [240, '최근 4시간'], [1440, '최근 하루'], ['custom', '기간 지정']];
  function spcWindow(s) {
    var last = s.t[s.n - 1], first = s.t[0], v = ui.spc.view;
    if (v === 'custom') {
      var a = P.fromLocalInput(ui.spc.from), b = P.fromLocalInput(ui.spc.to);
      return { from: isFinite(a) ? a : first, to: isFinite(b) ? b : last };
    }
    if (typeof v === 'number') return { from: Math.max(first, last - v * 60), to: last };
    return { from: first, to: last };
  }
  function chansOf(s) { return P.CH.filter(function (c) { var v = s[c]; for (var i = 0; i < v.length; i += Math.max(1, Math.floor(v.length / 200))) if (!isNaN(v[i])) return true; return false; }); }
  function emptyRaw(title) {
    return [pageHead('실시간', title || '실시간 관리도'), h('section', { class: 'card empty' },
      h('p', null, '아직 2초 센서 로그가 없습니다.'),
      h('p', null, '「데이터 가져오기」에서 설비가 2초마다 보낸 로그 CSV 를 넣거나, 2초 로그 샘플(프레스 4대 × 3일)로 둘러봐 주세요.'),
      h('div', { class: 'btn-row', style: 'justify-content:center' },
        h('a', { class: 'btn btn-primary', href: '#/import' }, '데이터 가져오기로'),
        h('button', { type: 'button', class: 'btn', onclick: askRawSample }, '2초 로그 샘플로 시작')))];
  }
  function pageSpc() {
    var presses = Object.keys(raw).sort(L.natCmp);
    if (!presses.length) return emptyRaw();
    if (presses.indexOf(ui.spc.press) < 0) { ui.spc.press = presses[0]; ui.spc.die = -1; }
    var s = raw[ui.spc.press], info = infoOf(ui.spc.press), O = P.cleanOpts(db.spc), win = spcWindow(s);
    var view = { from: win.from, to: win.to, dieIdx: ui.spc.die, groupSec: ui.spc.group };
    var chans = chansOf(s);
    var charts = chans.map(function (c) { return P.chartData(s, info, c, O, view); });

    // 고르기
    var pSel = h('select', { 'aria-label': '프레스' }, presses.map(function (p) { return h('option', { value: p, selected: p === ui.spc.press }, p + (raw[p].type ? ' · ' + raw[p].type : '')); }));
    pSel.addEventListener('change', function () { ui.spc.press = pSel.value; ui.spc.die = -1; render(); });
    var dSel = h('select', { 'aria-label': '금형' }, h('option', { value: '-1' }, '전체 금형'), s.dies.map(function (d, i) { return d ? h('option', { value: String(i), selected: i === ui.spc.die }, d) : null; }));
    dSel.addEventListener('change', function () { ui.spc.die = Number(dSel.value); render(); });
    var gSel = h('select', { 'aria-label': '묶어 보기' }, [[0, '2초 원값(받은 그대로)'], [60, '1분 평균'], [300, '5분 평균']].map(function (x) { return h('option', { value: String(x[0]), selected: x[0] === ui.spc.group }, x[1]); }));
    gSel.addEventListener('change', function () { ui.spc.group = Number(gSel.value); render(); });
    var seg = h('div', { class: 'seg seg-sm' }, VIEWS.map(function (v) {
      return h('button', { type: 'button', class: 'btn btn-sm' + (ui.spc.view === v[0] ? ' on' : ''), 'aria-pressed': ui.spc.view === v[0] ? 'true' : 'false', onclick: function () {
        ui.spc.view = v[0];
        if (v[0] === 'custom' && !ui.spc.from) { ui.spc.from = P.toLocalInput(win.from); ui.spc.to = P.toLocalInput(win.to); }
        render();
      } }, v[1]);
    }));
    var custom = null;
    if (ui.spc.view === 'custom') {
      var fIn = h('input', { type: 'datetime-local', step: 1, value: ui.spc.from, 'aria-label': '시작' }), tIn = h('input', { type: 'datetime-local', step: 1, value: ui.spc.to, 'aria-label': '끝' });
      custom = h('div', { class: 'btn-row' }, fIn, h('span', { class: 'note' }, '~'), tIn, h('button', { type: 'button', class: 'btn btn-sm', onclick: function () { ui.spc.from = fIn.value; ui.spc.to = tIn.value; render(); } }, '보기'));
    }
    var controls = h('section', { class: 'card spc-controls' },
      h('div', { class: 'form-grid' }, fld('프레스', pSel), fld('금형', dSel, s.dies.filter(Boolean).length > 1 ? '금형을 고르면 그 금형으로 친 때의 값만 보고, 관리 한계도 그 값으로 잡습니다.' : null),
        fld('묶어 보기', gSel, '2초 값은 정상이어도 370개에 1개꼴(약 12분에 한 번) 우연히 ±3σ 를 넘습니다. 1분 평균으로 묶으면 우연한 이탈이 줄고 서서히 바뀌는 것이 잘 보입니다.')),
      h('div', { class: 'field' }, h('span', null, '보는 구간'), seg), custom,
      h('p', { class: 'note' }, '로그 ' + P.stampText(s.t[0]) + ' ~ ' + P.stampText(s.t[s.n - 1]) + ' · ' + N(s.n) + '행 · 지금 보는 구간 ' + P.stampText(win.from) + ' ~ ' + P.stampText(win.to) +
        ' · 「최근 N분」은 로그 마지막 시각 기준입니다(새 파일을 넣으면 따라갑니다).'));

    // 마지막 값 카드
    var lastCards = h('div', { class: 'lastcards' }, charts.map(function (d) {
      var m = CH_META[d.channel], lv = 'none', st = '기준 없음';
      if (d.lim && d.last) {
        var v = d.last.v;
        if (v > d.lim.ucl || v < d.lim.lcl) { lv = 'bad'; st = '관리선 밖'; }
        else if (v > d.lim.uwl || v < d.lim.lwl) { lv = 'warn'; st = '경고선 밖'; }
        else { lv = 'ok'; st = '관리선 안'; }
      }
      var ev = d.events.length;
      return h('div', { class: 'lastcard lv-' + lv },
        h('div', { class: 'lc-top' }, h('span', { class: 'k' }, m.label), h('span', { class: 'pill lv-' + lv }, st)),
        h('div', { class: 'v' }, d.last ? fmt(d.last.v) : '-', h('small', null, ' ' + m.unit)),
        h('div', { class: 'note' }, d.last ? P.stampText(d.last.t, 'md') + ':' + P.stampText(d.last.t, 'time').slice(6) : ''),
        d.lim ? h('div', { class: 'note' }, '중심선 ' + fmt(d.lim.center) + ' · 관리선 ' + fmt(d.lim.lcl) + ' ~ ' + fmt(d.lim.ucl)) : null,
        h('div', { class: 'note' }, '이 구간 이탈 ' + (ev ? ev + '번(' + N(d.count.r1 + d.count.run9 + d.count.trend6 + d.count.two3) + '점)' : '없음')));
    }));

    // 관리도
    var figs = h('div', { class: 'spc-charts' }, charts.map(function (d) {
      var m = CH_META[d.channel];
      var ds = P.downsample(d.cs.t, d.values, d.flags, d.i0, 600, 2000);
      var cap = m.label + ' (' + m.unit + ')' + (ui.spc.group ? ' — ' + (ui.spc.group / 60) + '분 평균' : '') + (d.lim ? ' · σ ' + fmt(d.lim.sigma, 4) + (d.lim.method === 'mr' ? ' (MR̄/1.128)' : ' (표본 표준편차)') : ' · 기준 구간 값이 모자라 관리선을 못 그림');
      var f = C.spcFigure(cap, { ds: ds, lim: d.lim, base: d.base, from: win.from, to: win.to, warn: O.warnLines, unit: m.unit, color: m.color, gapSec: Math.max(O.gapSec, ui.spc.group * 3) });
      if (ds.violCount > ds.viol.length) f.appendChild(h('p', { class: 'note' }, '이탈점이 ' + N(ds.violCount) + '개라 그래프에는 칸마다 가장 먼 점만 그렸습니다. 전부는 아래 목록·엑셀에 있습니다.'));
      if (!ds.raw) f.appendChild(h('p', { class: 'note' }, N(d.values.length) + '점을 ' + ds.buckets.length + '칸으로 줄여 그림(칸마다 평균·최소·최대) — 이탈점은 줄이지 않고 모두 빨간 점으로 표시. 구간을 좁히면 원값이 그대로 보입니다.'));
      return f;
    }));

    // 타수
    var r = P.rangeIdx(s, win.from, win.to), w = P.strokeWindow(s, info, r[0], r[1]);
    var stroke = h('section', { class: 'card' }, h('h2', null, '타수 · 가동률 · 정지'),
      info.counted ? [
        h('div', { class: 'tiles' },
          tile('타수', N(w.strokes) + '타', '시간당 ' + N(w.perHour, 0) + '타 (' + info.source + ' 차이)'),
          tile('기준 대비', L.pctText(w.perf), O.cycleSec + '초에 1타 = 시간당 ' + N(3600 / O.cycleSec) + '타 기준'),
          tile('시간 가동률', L.pctText(w.availability), '기록된 ' + P.durText(w.coveredSec) + ' 중 가동 ' + P.durText(w.runSec)),
          tile('정지', w.stops.length + '번', w.stops.length ? '합 ' + P.durText(w.stops.reduce(function (a, x) { return a + x.sec; }, 0)) : O.stopSec + '초 넘게 타수가 안 오른 때'),
          tile('마지막 타수 뒤', isFinite(w.sinceStroke) ? P.durText(w.sinceStroke) : '-', isFinite(w.sinceStroke) && w.sinceStroke > O.stopSec ? '정지 중으로 보임' : '가동 중'),
          tile('금형 리셋(교체)', w.resets.length + '번', w.resets.length ? w.resets.map(function (x) { return x.fromDie + '→' + x.toDie; }).join(', ') : '금형 타수가 0 으로 돌아간 때')),
        hourFig(w, O),
        w.stops.length ? h('details', { open: w.stops.length <= 8 ? true : null }, h('summary', null, '정지 구간 ' + w.stops.length + '번'),
          table(['시작', '끝', '길이', ''], w.stops.slice(-200).reverse().map(function (x) { return [P.stampText(x.from), P.stampText(x.to), P.durText(x.sec), x.open ? '진행 중' : '']; }))) : null,
        w.resets.length ? h('details', { open: true }, h('summary', null, '금형 리셋(교체) 감지 ' + w.resets.length + '번'),
          table(['시각', '바뀌기 전', '바뀐 뒤', '바뀌기 전 금형 타수', '알아낸 방법'], w.resets.map(function (x) { return [P.stampText(x.t), x.fromDie || '-', x.toDie || '-', isFinite(x.before) ? N(x.before) : '-', x.kind]; }))) : null,
        w.gaps.length ? h('details', null, h('summary', null, '기록 끊김 ' + w.gaps.length + '번 (' + O.gapSec + '초 넘게 기록이 없던 때 — 쉬는 시간·근무 외 포함)'),
          table(['끊긴 때', '다시 들어온 때', '길이'], w.gaps.slice(-200).reverse().map(function (x) { return [P.stampText(x.from), P.stampText(x.to), P.durText(x.sec)]; }))) : null
      ] : h('p', { class: 'note' }, '이 로그에는 프레스 누적 타수·금형 타수가 없어 타수를 셀 수 없습니다.'));

    // 이탈 목록
    var evs = [];
    charts.forEach(function (d) { d.events.forEach(function (e) { evs.push({ ch: d.channel, e: e, lim: d.lim }); }); });
    evs.sort(function (a, b) { return b.e.from - a.e.from; });
    var evBox = h('section', { class: 'card' }, h('h2', null, '이탈 목록 (' + N(evs.length) + '번)'),
      h('p', { class: 'note' }, '바로 이어진 이탈점은 한 번으로 묶었습니다. 최근 것부터 · 화면에는 300번까지, 엑셀에는 전부.'),
      evs.length ? table(['채널', '시작', '끝', '점 수', '규칙', '가장 먼 값', '중심선에서', '방향'], evs.slice(0, 300).map(function (x) {
        var m = CH_META[x.ch];
        return { cls: 'lv-row', cells: [m.label, P.stampText(x.e.from), x.e.to > x.e.from ? P.stampText(x.e.to, 'time') : '', N(x.e.n), x.e.rules.join(', '), fmt(x.e.peak) + ' ' + m.unit, (x.e.z > 0 ? '+' : '') + fmt(x.e.z, 1) + 'σ', x.e.side === 'up' ? '높음' : '낮음'] };
      }), { num: [0, 0, 0, 1, 0, 1, 1, 0] }) : h('p', { class: 'note' }, '이 구간에는 켜 둔 규칙에 걸린 점이 없습니다.'),
      h('div', { class: 'btn-row', style: 'margin-top:10px' }, h('button', { type: 'button', class: 'btn', onclick: function () { exportSpc(s, charts, evs, w, win); } }, '엑셀로 내려받기(이탈 목록·관리 한계·정지·리셋)')));

    return [pageHead('실시간', '실시간 관리도 — ' + ui.spc.press, '전류·전압·온도·진동을 2초 값 그대로 시간순으로 그리고, 기준 구간의 평균(중심선)과 ±3σ 관리선(UCL/LCL)으로 벗어남을 봅니다.',
      h('a', { class: 'btn', href: '#/import' }, '로그 더 넣기')),
      controls, h('h2', { class: 'sec' }, '마지막 값'), lastCards, figs, spcRulesCard(O, s, info), stroke, evBox];
  }
  function fmt(v, d) {
    if (v == null || !isFinite(v)) return '-';
    if (d == null) { var a = Math.abs(v); d = a >= 100 ? 1 : a >= 10 ? 2 : 3; }
    return Number(v).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function hourFig(w, O) {
    var hs = w.hours.filter(function (x) { return x.covered > 0; }).slice(-24);
    if (!hs.length) return null;
    var every = Math.ceil(hs.length / 12);
    var labels = hs.map(function (x, i) { return i % every ? '' : P.stampText(x.t, hs.length > 1 && P.dateOf(hs[0].t) !== P.dateOf(hs[hs.length - 1].t) ? 'md' : 'time').replace(/:00(:00)?$/, '시').replace(/ (\d\d):\d\d$/, ' $1시'); });
    return C.figure('시간별 타수' + (w.hours.length > 24 ? ' (마지막 24칸)' : '') + ' — 기준 = 기록된 시간 ÷ ' + O.cycleSec + '초', { labels: labels, type: 'bar', unit: '타',
      series: [{ name: '친 타수', values: hs.map(function (x) { return x.strokes; }), color: 'var(--series-1)' }, { name: '기준(' + O.cycleSec + '초 1타)', values: hs.map(function (x) { return Math.round(x.expected); }), color: 'var(--series-5)' }] });
  }
  function spcRulesCard(O, s, info) {
    var method = h('select', { 'aria-label': 'σ 계산' }, h('option', { value: 'sd', selected: O.method === 'sd' }, '표본 표준편차 (기본)'), h('option', { value: 'mr', selected: O.method === 'mr' }, '이동범위 MR̄ ÷ 1.128 (I-MR)'));
    var mode = h('select', { 'aria-label': '기준 구간' }, h('option', { value: 'firstN', selected: O.baseMode === 'firstN' }, '처음 N개'), h('option', { value: 'range', selected: O.baseMode === 'range' }, '기준 기간 지정'));
    var nIn = h('input', { type: 'number', min: 10, step: 1, value: O.baseN, inputmode: 'numeric', 'aria-label': '처음 몇 개' });
    var bf = h('input', { type: 'datetime-local', step: 1, value: O.baseFrom || P.toLocalInput(s.t[0]), 'aria-label': '기준 시작' });
    var bt = h('input', { type: 'datetime-local', step: 1, value: O.baseTo || P.toLocalInput(Math.min(s.t[s.n - 1], s.t[0] + 3600)), 'aria-label': '기준 끝' });
    function box(checked, t, sub) { var b = h('input', { type: 'checkbox' }); b.checked = !!checked; return { el: b, label: h('label', { class: 'opt' }, b, h('span', null, h('span', { class: 't' }, t), sub ? h('span', { class: 's' }, sub) : null)) }; }
    var warn = box(O.warnLines, '±2σ 경고선 그리기'), stops = box(O.excludeStops, '정지 구간 값은 빼기', '정지하면 전류·진동이 떨어져 늘 이탈로 나옵니다');
    var rb = { r1: box(true, '1점이 ±3σ 밖', '늘 봄'), run9: box(O.rules.run9, '연속 9점이 중심선 한쪽', '평균이 옮겨 간 것'), trend6: box(O.rules.trend6, '연속 6점 계속 증가·감소', '추세'), two3: box(O.rules.two3, '3점 중 2점이 ±2σ 밖', '같은 쪽') };
    rb.r1.el.disabled = true;
    var cyc = h('input', { type: 'number', min: 1, step: 1, value: O.cycleSec, 'aria-label': '기준 사이클(초)' });
    var stp = h('input', { type: 'number', min: 2, step: 1, value: O.stopSec, 'aria-label': '정지로 볼 시간(초)' });
    var gap = h('input', { type: 'number', min: 2, step: 1, value: O.gapSec, 'aria-label': '기록 끊김으로 볼 시간(초)' });
    var br = P.baseRange(s, info, O, ui.spc.die);
    return h('section', { class: 'card', id: 'spcRules' }, h('h2', null, '관리도 기준'),
      h('ul', { class: 'note explain' },
        h('li', null, h('strong', null, '중심선·관리선'), ' — 기준 구간 값의 평균이 중심선, 평균 ± 3σ 가 관리선(UCL·LCL)입니다. 지금 기준 구간: ' + (isFinite(br.from) ? P.stampText(br.from) + ' ~ ' + P.stampText(br.to) + ' (' + N(br.n) + '개)' : '없음') + (br.short ? ' — 값이 N개보다 적어 있는 만큼 썼습니다' : '') + '. 그래프의 옅은 띠입니다.'),
        h('li', null, h('strong', null, '기준 구간 = 처음 1,800개(2초 간격 1시간)가 기본'), ' — 설비가 정상이던 때로 골라 주세요(예열이 끝난 뒤, 금형 교체 직후 등). 다른 구간을 기준으로 삼고 싶으면 「기준 기간 지정」.'),
        h('li', null, h('strong', null, 'σ 는 표본 표준편차가 기본'), ' — 이동범위(MR̄/1.128)는 하나씩 재는 값의 표준 관리도(I-MR) 방식이지만, 2초 값은 앞뒤 값이 거의 같아(자기상관) σ 가 매우 작게 잡힙니다. 받은 로그(3,600행)로 재 보니 이동범위 방식은 온도 3,425점·전류 2,520점이 관리선 밖으로 나왔고, 표본 표준편차는 0점이었습니다. 1분·5분 평균으로 묶어 볼 때는 이동범위도 쓸 만합니다.'),
        h('li', null, h('strong', null, '규칙'), ' — 1점 ±3σ 는 늘 봅니다. 「연속 9점 한쪽」 「연속 6점 증가·감소」는 2초 값에서는 정상이어도 아주 자주 걸려(받은 로그 전류 3,600점 중 3,086점이 연속 9점 한쪽) 기본은 꺼 두었습니다. 1분 평균으로 묶어 볼 때 켜 보세요.')),
      h('div', { class: 'form-grid' }, fld('σ 계산', method), fld('기준 구간', mode), fld('처음 몇 개', nIn, '2초 간격이면 1,800개 = 1시간'),
        fld('기준 기간 — 시작', bf), fld('기준 기간 — 끝', bt), h('div', { class: 'field span-all' }, h('span', null, '그리기'), h('div', { class: 'opt-grid' }, warn.label, stops.label))),
      h('div', { class: 'field', style: 'margin-top:12px' }, h('span', null, '이상 판정 규칙'), h('div', { class: 'opt-grid' }, rb.r1.label, rb.run9.label, rb.trend6.label, rb.two3.label)),
      h('div', { class: 'form-grid', style: 'margin-top:12px' }, fld('기준 사이클(초) — 몇 초에 1타', cyc, '받은 설명: 10초에 1타'), fld('정지로 볼 시간(초)', stp, '이만큼 타수가 안 오르면 정지(기본 60초 = 6사이클)'), fld('기록 끊김으로 볼 시간(초)', gap, '2초 로그 기준 30초')),
      h('div', { class: 'btn-row', style: 'margin-top:12px' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: function () {
          var before = P.cleanOpts(db.spc);
          db.spc = P.cleanOpts({ method: method.value, baseMode: mode.value, baseN: nIn.value, baseFrom: bf.value, baseTo: bt.value, warnLines: warn.el.checked, excludeStops: stops.el.checked,
            rules: { r1: true, run9: rb.run9.el.checked, trend6: rb.trend6.el.checked, two3: rb.two3.el.checked }, cycleSec: cyc.value, stopSec: stp.value, gapSec: gap.value });
          if (before.stopSec !== db.spc.stopSec || before.gapSec !== db.spc.gapSec || before.cycleSec !== db.spc.cycleSec || before.excludeStops !== db.spc.excludeStops) { rawInfo = {}; rebuildDaily(Object.keys(raw)); }
          save(); toast('관리도 기준을 바꿨습니다.'); render();
        } }, '기준 적용'),
        h('button', { type: 'button', class: 'btn', onclick: function () { db.spc = {}; rawInfo = {}; rebuildDaily(Object.keys(raw)); save(); toast('기본값으로 되돌렸습니다.'); render(); } }, '기본값으로')));
  }
  function exportSpc(s, charts, evs, w, win) {
    var wb = XLSX.utils.book_new(), O = P.cleanOpts(db.spc);
    var a = [['프레스', '채널', '시작', '끝', '점 수', '규칙', '가장 먼 값', '단위', '중심선에서(σ)', '방향', '중심선', 'UCL', 'LCL']];
    evs.slice().reverse().forEach(function (x) { var m = CH_META[x.ch]; a.push([s.press, m.label, P.stampText(x.e.from), P.stampText(x.e.to), x.e.n, x.e.rules.join(', '), L.round(x.e.peak, 4), m.unit, L.round(x.e.z, 2), x.e.side === 'up' ? '높음' : '낮음', L.round(x.lim.center, 4), L.round(x.lim.ucl, 4), L.round(x.lim.lcl, 4)]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(a), '이탈 목록');
    var b = [['프레스', '채널', '단위', '묶어 보기', 'σ 계산', '기준 구간 시작', '기준 구간 끝', '기준 값 수', '중심선', 'σ', 'UCL(+3σ)', 'LCL(−3σ)', '+2σ', '−2σ', '보는 구간 시작', '보는 구간 끝', '±3σ 밖 점', '연속 9점', '연속 6점', '3점 중 2점']];
    charts.forEach(function (d) { var m = CH_META[d.channel], l = d.lim || {}; b.push([s.press, m.label, m.unit, ui.spc.group ? ui.spc.group / 60 + '분 평균' : '2초 원값', O.method === 'mr' ? 'MR̄/1.128' : '표본 표준편차',
      P.stampText(d.base.from), P.stampText(d.base.to), d.lim ? d.lim.n : 0, L.round(l.center, 4), L.round(l.sigma, 5), L.round(l.ucl, 4), L.round(l.lcl, 4), L.round(l.uwl, 4), L.round(l.lwl, 4), P.stampText(win.from), P.stampText(win.to), d.count.r1, d.count.run9, d.count.trend6, d.count.two3]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(b), '관리 한계');
    var c = [['시작', '끝', '길이(초)']]; w.stops.forEach(function (x) { c.push([P.stampText(x.from), P.stampText(x.to), Math.round(x.sec)]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(c), '정지 구간');
    var r = [['시각', '바뀌기 전 금형', '바뀐 뒤 금형', '바뀌기 전 금형 타수', '알아낸 방법']]; w.resets.forEach(function (x) { r.push([P.stampText(x.t), x.fromDie, x.toDie, isFinite(x.before) ? x.before : null, x.kind]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(r), '금형 리셋');
    var hr = [['시각(시간 칸)', '친 타수', '기준 타수', '기준 대비', '기록된 시간(분)', '가동 시간(분)']]; w.hours.forEach(function (x) { hr.push([P.stampText(x.t), x.strokes, Math.round(x.expected), x.perf == null ? null : L.round(x.perf * 100, 1), L.round(x.covered / 60, 1), L.round(x.run / 60, 1)]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hr), '시간별 타수');
    XLSX.writeFile(wb, '관리도_' + s.press + '_' + P.stampText(win.from).slice(0, 10) + '.xlsx');
  }
  /* 대시보드 — 2초 로그 마지막 값(프레스마다, 최근 1시간 기준) */
  function rawDash() {
    var presses = Object.keys(raw).sort(L.natCmp);
    if (!presses.length) return null;
    var O = P.cleanOpts(db.spc);
    return [h('h2', { class: 'sec' }, '2초 센서 — 마지막 값', h('a', { class: 'dp-more', href: '#/spc' }, '실시간 관리도')),
      h('div', { class: 'press-grid' }, presses.map(function (p) {
        var s = raw[p], info = infoOf(p), last = s.t[s.n - 1], view = { from: last - 3600, to: last };
        var ds = chansOf(s).map(function (c) { return P.chartData(s, info, c, O, view); });
        var r = P.rangeIdx(s, view.from, view.to), w = P.strokeWindow(s, info, r[0], r[1]);
        var outs = ds.reduce(function (a, d) { return a + d.events.length; }, 0);
        var lastOut = ds.some(function (d) { return d.lim && d.last && (d.last.v > d.lim.ucl || d.last.v < d.lim.lcl); });
        var lv = lastOut ? 'bad' : outs ? 'warn' : 'ok';
        var stopNow = info.counted && isFinite(w.sinceStroke) && w.sinceStroke > O.stopSec;
        return h('article', { class: 'pcard lv-' + lv },
          h('div', { class: 'pcard-top' }, h('div', null, h('h3', null, p), h('div', { class: 'note' }, (s.type || '종류 미입력') + ' · ' + P.stampText(last))),
            h('span', { class: 'pill lv-' + lv }, lastOut ? '관리선 밖' : outs ? '최근 1시간 이탈 ' + outs + '번' : '관리선 안')),
          h('ul', { class: 'sens' }, ds.map(function (d) {
            var m = CH_META[d.channel], bad = d.lim && d.last && (d.last.v > d.lim.ucl || d.last.v < d.lim.lcl);
            return h('li', null, h('span', { class: 'k' }, m.label), h('span', { class: 'v' }, d.last ? fmt(d.last.v) + m.unit : '-'),
              h('span', { class: 'note' }, d.lim ? fmt(d.lim.lcl) + ' ~ ' + fmt(d.lim.ucl) : '기준 없음'), bad ? pill('bad') : null);
          })),
          info.counted ? h('dl', { class: 'pstats' },
            h('dt', null, '최근 1시간 타수'), h('dd', null, N(w.strokes) + '타 · 기준 대비 ' + L.pctText(w.perf)),
            h('dt', null, '지금'), h('dd', null, stopNow ? '정지 ' + P.durText(w.sinceStroke) + ' 째' : '가동 중'),
            h('dt', null, '정지'), h('dd', null, w.stops.length ? w.stops.length + '번 · ' + P.durText(w.stops.reduce(function (a, x) { return a + x.sec; }, 0)) : '없음')) : null,
          h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn btn-sm', onclick: function () { ui.spc.press = p; ui.spc.die = -1; ui.spc.view = 60; location.hash = '#/spc'; } }, '관리도 보기')));
      }))];
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
        h('p', { class: 'note' }, '쌓인 로그와 기준표는 이 브라우저에만 있습니다. 다른 PC 로 옮기거나 브라우저 정리 전에 JSON 으로 받아 두세요. 2초 센서 로그 원본은 너무 커서 JSON 에 넣지 않습니다(하루 묶음과 관리도 기준은 들어감) — 원본 CSV 를 따로 보관해 주세요.'),
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
    { id: 'spc', no: '실', t: '실시간 관리도', s: '2초 센서 ±3σ·타수·정지', fn: pageSpc },
    { id: 'import', no: '0', t: '데이터 가져오기', s: '로그 엑셀·CSV 여러 개', fn: pageImport },
    { id: 'die', no: '①', t: '금형 타수·교체', s: '수명 사용률·교체 예정일', fn: pageDie },
    { id: 'overhaul', no: '②', t: '오버홀 알림', s: '타수·일수 주기', fn: pageOverhaul },
    { id: 'anomaly', no: '③', t: '이상 감지', s: '전류·온도·진동·전압', fn: pageAnomaly },
    { id: 'report', no: '④', t: '월별 타수 보고서', s: '프레스 종류별·엑셀·인쇄', fn: pageReport },
    { id: 'ai', no: '⑤', t: 'AI 분석', s: '사실만 담은 프롬프트', fn: pageAi },
    { id: 'settings', no: '설', t: '설정', s: '기준표·판정 기준·백업', fn: pageSettings }
  ];
  function route() { var id = (location.hash || '').replace(/^#\//, '').split('?')[0]; return PAGES.filter(function (p) { return p.id === id; })[0] || (db.records.length ? PAGES[0] : PAGES.filter(function (p) { return p.id === 'import'; })[0]); }
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
    if (rawRows()) document.getElementById('dataChip').textContent += ' · 2초 로그 ' + L.fmtN(rawRows()) + '행';
    var b = document.getElementById('sampleBanner');
    b.hidden = !db.sample;
    if (db.sampleKind === 'raw') b.textContent = '지금 보시는 것은 2초 로그 가상 샘플입니다(프레스 P1~P4 × 10/19~10/21, 08~12시·13~17시). P2 10/21 오후 전류·온도 상승, P3 10/20 10:00 20분 정지와 10/21 14시대 진동 튐, P4 10/20 13:00 금형 M-07→M-08 교체, P4 10/21 오후 전압 조금 내려앉음(연속 9점 규칙으로 보임), P1 10/20 15:10 기록 끊김을 심어 두었습니다. 3일치라 일 단위 이상 감지는 「비교 못 함」으로 나옵니다.';
    else b.textContent = '지금 보시는 것은 가상 샘플입니다(프레스 P1~P4 × 90일, 금형 M-01~M-08). 금형 M-05 수명 임박, P2 전류·온도 상승(마지막 2주), P4 오버홀 주기 지남을 일부러 심어 두었습니다. 실제 로그를 넣기 전에 「데이터 가져오기 → 모든 데이터 지우기」를 해 주세요.';
    main.innerHTML = '';
    add(main, p.fn());
    document.title = p.t + ' — 프레스·금형 예지보전';
    save();
  }
  window.addEventListener('hashchange', function () { render(); main.focus(); window.scrollTo(0, 0); });
  render();
  RS.loadAll().then(function (m) {
    rawSaved = RS.available() !== false;
    var ks = Object.keys(m).filter(function (k) { return m[k] && m[k].n && m[k].t; });
    if (!ks.length) return;
    ks.forEach(function (k) { raw[k] = m[k]; });
    render();
  });
})();
