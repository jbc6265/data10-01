/* 2초 센서 로그(원 로그) — 큰 파일 나눠 읽기 · 프레스별 시계열 · 관리도(Shewhart) · 이상 판정 규칙 · 타수/가동률/정지/금형 리셋 · 일 집계
   브라우저에서는 window.PressSPC, node 에서는 require('./spc.js') 로 씁니다(logic.js 를 함께 씀).
   기준 문서: docs/01_프로젝트_기획서.md 11장(2차 반영)

   수강생 로그 형식(2026-10-21 접수): 일자(yyyy-mm-dd hh:mm:ss, 2초 간격) · 프레스 · 프레스 종류 · 금형명 · 프레스 누적 타수 · 금형 타수(교체 때 0 으로 돌아가는 누적) ·
   전류(A) · 전압(V) · 온도(℃) · 진동(mm/s) · 데이터 구분. 센서 값은 2초마다, 타수는 10초에 1타씩 오릅니다.

   흐름: 파일 앞부분 → isHighFreq(2초 로그인가) → createCsvParser(조각마다 행) → createRawBuilder(행 → 프레스별 시계열)
        → mergeSeries(이미 있는 것과 합치기·같은 시각 중복 제거) → strokeInfo(타수·정지·리셋) → limits·evalRules(관리도) → dailyFromSeries(기존 일 단위 판정으로) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./logic.js'));
  else root.PressSPC = factory(root.PressLogic);
})(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';

  var CH = ['current', 'voltage', 'temp', 'vib'];
  var CH_LABEL = { current: '전류', voltage: '전압', temp: '온도', vib: '진동' };
  var D2 = 1.128; // 이동범위(n=2) 관리도 상수 d2

  /* ── 1. 시각 ──────────────────────────────────────────────
     시각은 「벽시계 그대로」 초 단위 숫자로 둡니다(시간대 바꿈 없음). 2026-10-01 09:00:02 → Date.UTC(...)/1000 */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  var RE_STAMP = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?/;
  /* 글자·엑셀 일련번호 → 초. 못 읽으면 NaN. 엑셀 일련번호는 초까지 반올림 */
  function parseStamp(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') {
      if (v < 20000 || v > 80000) return NaN;
      return Math.round((v - 25569) * 86400);
    }
    var s = String(v).trim();
    var m = RE_STAMP.exec(s);
    if (!m) { if (/^\d{5}(\.\d+)?$/.test(s)) return parseStamp(Number(s)); return NaN; }
    var y = +m[1], mo = +m[2], d = +m[3], h = m[4] == null ? 0 : +m[4], mi = m[5] == null ? 0 : +m[5], se = m[6] == null ? 0 : +m[6];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return NaN;
    var t = Date.UTC(y, mo - 1, d, h, mi, se);
    if (new Date(t).getUTCDate() !== d) return NaN;
    return t / 1000;
  }
  /* 따로 있는 시각 칸 → 하루 안의 초 (「09:00:02」 · 엑셀 시각 0~1) */
  function parseClock(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return v >= 0 && v < 1 ? Math.round(v * 86400) : NaN;
    var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(v).trim());
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (m[3] ? +m[3] : 0) : NaN;
  }
  function stampText(sec, short) {
    if (sec == null || !isFinite(sec)) return '-';
    var d = new Date(sec * 1000);
    var day = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    var tm = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
    return short === 'time' ? tm : short === 'md' ? (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + tm.slice(0, 5) : day + ' ' + tm;
  }
  function dateOf(sec) { var d = new Date(sec * 1000); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  /* <input type="datetime-local"> 값 ↔ 초 */
  function toLocalInput(sec) { return isFinite(sec) ? stampText(sec).replace(' ', 'T') : ''; }
  function fromLocalInput(s) { return parseStamp(String(s || '').replace('T', ' ')); }
  function durText(sec) {
    if (!isFinite(sec)) return '-';
    sec = Math.round(sec);
    if (sec < 60) return sec + '초';
    if (sec < 3600) return Math.floor(sec / 60) + '분' + (sec % 60 ? ' ' + (sec % 60) + '초' : '');
    var h = Math.floor(sec / 3600), mi = Math.round((sec % 3600) / 60);
    return h + '시간' + (mi ? ' ' + mi + '분' : '');
  }

  /* ── 2. CSV 나눠 읽기 ─────────────────────────────────────
     파일을 조각(예: 4MB)으로 읽어 push 하면 다 읽은 행마다 onRow(cells) 를 부릅니다. 조각 경계에 걸린 행·따옴표도 이어 붙입니다.
     따옴표 안의 쉼표·줄바꿈·「""」 를 지원하고, 맨 앞 BOM 은 뗍니다. */
  function createCsvParser(onRow, opts) {
    opts = opts || {};
    var delim = opts.delimiter || ',';
    var field = '', row = [], inQ = false, quoted = false, started = false, pendingQuote = false, rows = 0;
    function endField() { row.push(quoted ? field : field.trim() === '' ? null : field); field = ''; quoted = false; }
    function endRow() {
      endField();
      if (!(row.length === 1 && row[0] == null)) { rows++; onRow(row); }
      row = [];
    }
    function push(text) {
      var s = text, i = 0, n = s.length;
      if (!started) { started = true; if (s.charCodeAt(0) === 0xfeff) i = 1; }
      while (i < n) {
        var c = s.charAt(i);
        if (pendingQuote) { // 따옴표 안에서 「"」 다음 글자를 보고 판단
          pendingQuote = false;
          if (c === '"') { field += '"'; i++; continue; }
          inQ = false; // 닫는 따옴표였음 — 이 글자는 아래에서 다시 처리
        }
        if (inQ) {
          var q = s.indexOf('"', i);
          if (q < 0) { field += s.slice(i); i = n; break; }
          field += s.slice(i, q); i = q + 1; pendingQuote = true; continue;
        }
        if (c === '"' && field === '' && !quoted) { inQ = true; quoted = true; i++; continue; }
        if (c === delim) { endField(); i++; continue; }
        if (c === '\n') { endRow(); i++; continue; }
        if (c === '\r') { i++; continue; }
        // 보통 글자 — 다음 구분 글자까지 한 번에
        var j = i + 1;
        while (j < n) { var cj = s.charAt(j); if (cj === delim || cj === '\n' || cj === '\r' || cj === '"') break; j++; }
        field += s.slice(i, j); i = j;
      }
    }
    function end() {
      if (pendingQuote) { pendingQuote = false; inQ = false; }
      if (field !== '' || row.length || quoted) endRow();
      return rows;
    }
    return { push: push, end: end, rows: function () { return rows; } };
  }
  /* 글자 전체 → 행 배열 (작은 파일·시험용) */
  function parseCsvText(text, opts) {
    var out = [], p = createCsvParser(function (r) { out.push(r); }, opts);
    p.push(text); p.end();
    return out;
  }
  /* 첫 조각 바이트의 글자 판별 — UTF-8 로 읽어 보고 깨지면 EUC-KR(CP949). 조각 끝이 글자 중간에서 잘렸을 수 있어 끝 3바이트는 봐 줍니다 */
  function sniffEncoding(u8) {
    var cut = u8.length;
    for (var k = 0; k < 3 && cut > 0; k++) { var b = u8[cut - 1]; if (b >= 0x80) cut--; else break; }
    try { new TextDecoder('utf-8', { fatal: true }).decode(u8.subarray(0, cut)); return 'utf-8'; }
    catch (e) { return 'euc-kr'; }
  }

  /* ── 3. 2초 로그인가 ──────────────────────────────────────
     앞쪽 행(최대 300행)의 시각을 읽어, 초가 붙어 있거나 같은 프레스의 시각 간격 중앙값이 60초 이하면 「원 로그(고빈도)」로 봅니다.
     하루 한 행·시간마다 한 행 로그는 기존 길(일 단위)로 갑니다. */
  function stampOf(row, det) {
    var m = det.map, t = parseStamp(row[m.date]);
    if (m.time != null && isFinite(t)) {
      var c = parseClock(row[m.time]);
      if (isFinite(c)) t = Math.floor(t / 86400) * 86400 + c;
    }
    return t;
  }
  function isHighFreq(aoa, det) {
    if (!det || det.headerRow < 0 || det.missing.length) return { high: false, reason: '' };
    var last = {}, gaps = [], secs = 0, n = 0;
    for (var r = det.headerRow + 1; r < aoa.length && n < 300; r++) {
      var row = aoa[r]; if (!row) continue;
      var t = stampOf(row, det); if (!isFinite(t)) continue;
      n++;
      if (t % 60) secs++;
      var p = String(row[det.map.press] == null ? '' : row[det.map.press]).trim();
      if (last[p] != null && t > last[p]) gaps.push(t - last[p]);
      last[p] = t;
    }
    gaps.sort(function (a, b) { return a - b; });
    var med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
    var high = secs > 0 || (med != null && med <= 60);
    return { high: high, interval: med, rows: n, reason: high ? (med != null ? '시각 간격 약 ' + med + '초' : '초 단위 시각') : '' };
  }

  /* ── 4. 행 → 프레스별 시계열 ─────────────────────────────
     프레스마다 { press, type, dies:[이름], n, t(초), current·voltage·temp·vib(Float32, 빈칸 NaN), pc(프레스 누적 타수), dc(금형 타수), die(금형 번호) } */
  var RE_NUM = /^-?\d+(\.\d+)?$/;
  function num(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    var s = String(v).trim();
    if (s === '') return NaN;
    if (RE_NUM.test(s)) return +s;
    var x = L.toNum(s);
    return x == null || isNaN(x) ? NaN : x;
  }
  function createRawBuilder(det, opts) {
    opts = opts || {};
    var m = det.map, buf = {}, out = { rows: 0, skipped: 0, warnings: [], warnCount: 0, first: Infinity, last: -Infinity };
    function warn(rowNo, msg) { out.warnCount++; if (out.warnings.length < 50) out.warnings.push({ row: rowNo, msg: msg }); }
    function add(row, rowNo) {
      if (!row) return;
      var t = stampOf(row, det), rawP = row[m.press];
      var press = rawP == null ? '' : String(rawP).trim();
      if (!isFinite(t)) { if (press || row[m.date] != null) { warn(rowNo, '일시를 읽지 못해 건너뜀 (' + row[m.date] + ')'); } out.skipped++; return; }
      if (!press) { warn(rowNo, '프레스 칸이 비어 건너뜀'); out.skipped++; return; }
      var b = buf[press];
      if (!b) b = buf[press] = { press: press, type: '', dies: [], dieIdx: {}, t: [], current: [], voltage: [], temp: [], vib: [], pc: [], dc: [], die: [] };
      if (!b.type && m.pressType != null && row[m.pressType] != null) b.type = String(row[m.pressType]).trim();
      var dn = m.die != null && row[m.die] != null ? String(row[m.die]).trim() : '';
      var di = b.dieIdx[dn];
      if (di == null) { di = b.dieIdx[dn] = b.dies.length; b.dies.push(dn); }
      b.t.push(t); b.die.push(di);
      for (var k = 0; k < CH.length; k++) {
        var c = CH[k];
        var v = m[c] == null ? NaN : num(row[m[c]]);
        if (m[c] != null && row[m[c]] != null && row[m[c]] !== '' && isNaN(v)) warn(rowNo, CH_LABEL[c] + ' 값을 숫자로 읽지 못함 (' + row[m[c]] + ')');
        b[c].push(v);
      }
      var pc = m.pressCum == null ? NaN : num(row[m.pressCum]);
      var dc = m.dieCum == null ? NaN : num(row[m.dieCum]);
      if (pc < 0) pc = NaN; if (dc < 0) dc = NaN;
      b.pc.push(pc); b.dc.push(dc);
      if (t < out.first) out.first = t; if (t > out.last) out.last = t;
      out.rows++;
    }
    function finish() {
      var series = {};
      Object.keys(buf).forEach(function (p) { series[p] = finalize(buf[p]); });
      out.series = series;
      return out;
    }
    return { add: add, finish: finish, result: out };
  }
  /* 배열 묶음 → 시각순 정렬·같은 시각은 나중 행 · 타입 배열 */
  function finalize(b) {
    var n = b.t.length, idx = new Array(n), sorted = true;
    for (var i = 0; i < n; i++) { idx[i] = i; if (i && b.t[i] < b.t[i - 1]) sorted = false; }
    if (!sorted) idx.sort(function (x, y) { return b.t[x] - b.t[y] || x - y; });
    var keep = [];
    for (var j = 0; j < n; j++) {
      if (keep.length && b.t[idx[j]] === b.t[keep[keep.length - 1]]) keep[keep.length - 1] = idx[j];
      else keep.push(idx[j]);
    }
    var s = alloc(b.press, b.type, b.dies.slice(), keep.length);
    keep.forEach(function (k, o) {
      s.t[o] = b.t[k]; s.pc[o] = b.pc[k]; s.dc[o] = b.dc[k]; s.die[o] = b.die[k];
      for (var c = 0; c < CH.length; c++) s[CH[c]][o] = b[CH[c]][k];
    });
    return s;
  }
  function alloc(press, type, dies, n) {
    var s = { press: press, type: type || '', dies: dies || [], n: n, t: new Float64Array(n), pc: new Float64Array(n), dc: new Float64Array(n), die: new Uint16Array(n) };
    CH.forEach(function (c) { s[c] = new Float32Array(n); });
    return s;
  }
  /* 두 시계열 합치기 — 같은 시각이면 새 것(b)이 이깁니다 */
  function mergeSeries(a, b) {
    if (!a || !a.n) return b;
    if (!b || !b.n) return a;
    var dies = a.dies.slice(), map = {};
    dies.forEach(function (d, i) { map[d] = i; });
    var remap = b.dies.map(function (d) { if (map[d] == null) { map[d] = dies.length; dies.push(d); } return map[d]; });
    var out = alloc(a.press, b.type || a.type, dies, a.n + b.n), i = 0, j = 0, o = 0, dup = 0;
    function copy(src, k, fromB) {
      out.t[o] = src.t[k]; out.pc[o] = src.pc[k]; out.dc[o] = src.dc[k]; out.die[o] = fromB ? remap[src.die[k]] : src.die[k];
      for (var c = 0; c < CH.length; c++) out[CH[c]][o] = src[CH[c]][k];
      o++;
    }
    while (i < a.n || j < b.n) {
      if (j >= b.n || (i < a.n && a.t[i] < b.t[j])) copy(a, i++, false);
      else if (i >= a.n || b.t[j] < a.t[i]) copy(b, j++, true);
      else { copy(b, j++, true); i++; dup++; }
    }
    var res = shrink(out, o);
    res.replaced = dup;
    return res;
  }
  function shrink(s, n) {
    if (n === s.n) return s;
    var r = { press: s.press, type: s.type, dies: s.dies, n: n, t: s.t.slice(0, n), pc: s.pc.slice(0, n), dc: s.dc.slice(0, n), die: s.die.slice(0, n) };
    CH.forEach(function (c) { r[c] = s[c].slice(0, n); });
    return r;
  }
  /* 시각 범위 → [i0, i1) (이분 탐색) */
  function lowerBound(t, x, n) { var lo = 0, hi = n; while (lo < hi) { var mid = (lo + hi) >> 1; if (t[mid] < x) lo = mid + 1; else hi = mid; } return lo; }
  function rangeIdx(s, from, to) {
    var i0 = isFinite(from) ? lowerBound(s.t, from, s.n) : 0;
    var i1 = isFinite(to) ? lowerBound(s.t, to + 0.5, s.n) : s.n;
    return [i0, Math.max(i0, i1)];
  }

  /* ── 5. 타수 · 정지 · 금형 리셋 ─────────────────────────
     행마다 「이 행에서 오른 타수」 inc 를 프레스 누적 타수 차이로(없으면 금형 타수 차이로) 셉니다.
     · 누적값이 줄면 카운터 초기화 — 세지 않음 · 금형 타수가 줄거나 금형명이 바뀌면 「금형 리셋(교체)」
     · 타수가 오른 시각 사이가 stopSec 를 넘으면 그 사이는 「정지」 · 기록 간격이 gapSec 를 넘으면 「기록 끊김」 */
  var DEFAULT_OPTS = {
    cycleSec: 10,      // 기준 사이클 — 10초에 1타(수강생 설명)
    stopSec: 60,       // 타수가 이만큼 안 오르면 정지(기준 사이클의 6배)
    gapSec: 30,        // 기록 간격이 이보다 길면 기록 끊김(2초 로그 기준)
    method: 'sd',      // 'sd' 표본 표준편차 · 'mr' 이동범위 MR̄/1.128
    baseMode: 'firstN',// 'firstN' 처음 N개 · 'range' 기준 기간
    baseN: 1800,       // 처음 1,800개 = 2초 간격 1시간
    baseFrom: '', baseTo: '',
    warnLines: true,   // ±2σ 경고선
    excludeStops: true,// 정지 구간 값은 관리도·판정에서 뺌(정지하면 전류가 떨어져 늘 이탈로 나오므로)
    rules: { r1: true, run9: false, trend6: false, two3: false },
    k: 3, kWarn: 2
  };
  function cleanOpts(p) {
    var o = JSON.parse(JSON.stringify(DEFAULT_OPTS));
    if (!p || typeof p !== 'object') return o;
    function n(k, min, max) { var v = Number(p[k]); if (p[k] != null && p[k] !== '' && isFinite(v) && v >= min && v <= max) o[k] = v; }
    n('cycleSec', 1, 3600); n('stopSec', 2, 86400); n('gapSec', 2, 86400); n('baseN', 10, 10000000); n('k', 1, 6); n('kWarn', 0.5, 6);
    if (o.kWarn > o.k) o.kWarn = o.k;
    if (p.method === 'sd' || p.method === 'mr') o.method = p.method;
    if (p.baseMode === 'firstN' || p.baseMode === 'range') o.baseMode = p.baseMode;
    if (typeof p.baseFrom === 'string') o.baseFrom = p.baseFrom;
    if (typeof p.baseTo === 'string') o.baseTo = p.baseTo;
    if (p.warnLines === false) o.warnLines = false;
    if (p.excludeStops === false) o.excludeStops = false;
    if (p.rules && typeof p.rules === 'object') Object.keys(o.rules).forEach(function (k) { if (p.rules[k] != null) o.rules[k] = !!p.rules[k]; });
    o.rules.r1 = true; // 1점 3σ 이탈은 늘 봅니다
    return o;
  }
  function strokeInfo(s, opts) {
    var O = cleanOpts(opts), n = s.n;
    var inc = new Float64Array(n), stroke = new Uint8Array(n), resets = [];
    var hasPc = false, hasDc = false;
    for (var i = 0; i < n; i++) { if (!isNaN(s.pc[i])) hasPc = true; if (!isNaN(s.dc[i])) hasDc = true; }
    var lastPc = NaN, lastDc = NaN, lastDie = -1, uncounted = 0, pcResets = 0;
    for (var k = 0; k < n; k++) {
      inc[k] = NaN;
      var pc = s.pc[k], dc = s.dc[k], dd = s.die[k];
      var dieChanged = lastDie >= 0 && dd !== lastDie;
      var dcDown = !isNaN(dc) && !isNaN(lastDc) && dc < lastDc;
      if ((dieChanged || dcDown) && k > 0) {
        resets.push({ i: k, t: s.t[k], fromDie: s.dies[lastDie] || '', toDie: s.dies[dd] || '', before: lastDc, after: dc, kind: dieChanged ? '금형 바뀜' : '금형 타수 0 으로' });
      }
      if (hasPc) {
        if (!isNaN(pc)) {
          if (!isNaN(lastPc)) { var d = pc - lastPc; if (d >= 0) inc[k] = d; else { pcResets++; uncounted++; } }
          lastPc = pc;
        }
      } else if (hasDc && !isNaN(dc)) {
        if (!isNaN(lastDc) && !dieChanged && !dcDown) inc[k] = dc - lastDc;
        else if (k > 0 && (dieChanged || dcDown)) inc[k] = dc; // 0 에서 다시 센 만큼
      }
      if (!isNaN(dc)) lastDc = dc;
      lastDie = dd;
      if (inc[k] > 0) stroke[k] = 1;
    }
    // 정지 판정 — 앞뒤 타수 시각
    var counted = hasPc || hasDc, stopped = new Uint8Array(n);
    if (counted) {
      var prev = new Float64Array(n), next = new Float64Array(n), p = NaN, q = NaN;
      for (var a = 0; a < n; a++) { if (stroke[a]) p = s.t[a]; prev[a] = p; }
      for (var b = n - 1; b >= 0; b--) { if (stroke[b]) q = s.t[b]; next[b] = q; }
      for (var c = 0; c < n; c++) {
        var t = s.t[c], pv = prev[c], nx = next[c], st;
        if (stroke[c]) st = false;
        else if (!isNaN(pv) && !isNaN(nx)) st = nx - pv > O.stopSec;
        else if (!isNaN(nx)) st = nx - t > O.stopSec;
        else if (!isNaN(pv)) st = t - pv > O.stopSec;
        else st = true;
        stopped[c] = st ? 1 : 0;
      }
    }
    return { inc: inc, stroke: stroke, stopped: stopped, resets: resets, counted: counted, source: hasPc ? '프레스 누적 타수' : hasDc ? '금형 타수' : '', pcResets: pcResets, opts: O };
  }
  /* 구간 [i0,i1) 의 타수·가동률·정지·기록 끊김·시간별 타수 */
  function strokeWindow(s, info, i0, i1) {
    var O = info.opts, out = { strokes: 0, coveredSec: 0, runSec: 0, stops: [], gaps: [], hours: [], resets: [], from: s.t[i0], to: s.t[i1 - 1] };
    if (!(i1 > i0)) return out;
    var hours = {}, stopFrom = null, lastStrokeT = NaN;
    for (var i = i0; i < i1; i++) {
      var t = s.t[i];
      if (info.inc[i] > 0) out.strokes += info.inc[i];
      var hk = Math.floor(t / 3600) * 3600;
      var hb = hours[hk] || (hours[hk] = { t: hk, strokes: 0, covered: 0, run: 0 });
      if (info.inc[i] > 0) hb.strokes += info.inc[i];
      if (i > i0) {
        var dt = t - s.t[i - 1];
        if (dt > O.gapSec) { out.gaps.push({ from: s.t[i - 1], to: t, sec: dt }); }
        else {
          out.coveredSec += dt; hb.covered += dt;
          if (!(info.stopped[i] && info.stopped[i - 1])) { out.runSec += dt; hb.run += dt; }
        }
      }
      // 정지 구간 — 연속된 정지 행을 하나로(기록 끊김에서 끊음)
      var st = info.counted && info.stopped[i];
      if (st && stopFrom == null) stopFrom = i;
      var gapNext = i + 1 < i1 && s.t[i + 1] - t > O.gapSec;
      if (stopFrom != null && (!st || i === i1 - 1 || gapNext)) {
        var endI = st ? i : i - 1;
        var sec = s.t[endI] - s.t[stopFrom];
        if (endI >= stopFrom && sec >= O.stopSec / 2) out.stops.push({ from: s.t[stopFrom], to: s.t[endI], sec: sec, open: st && i === i1 - 1 });
        stopFrom = null;
      }
      if (info.stroke[i]) lastStrokeT = t;
    }
    out.lastStroke = lastStrokeT;
    out.sinceStroke = isFinite(lastStrokeT) ? s.t[i1 - 1] - lastStrokeT : NaN;
    out.expected = out.coveredSec / O.cycleSec;
    out.perf = out.expected > 0 ? out.strokes / out.expected : null;          // 기준(10초 1타) 대비 타수
    out.availability = out.coveredSec > 0 ? out.runSec / out.coveredSec : null; // 시간 가동률
    out.perHour = out.coveredSec > 0 ? out.strokes / (out.coveredSec / 3600) : null;
    out.hours = Object.keys(hours).map(function (k) { var h = hours[k]; h.expected = h.covered / O.cycleSec; h.perf = h.expected > 0 ? h.strokes / h.expected : null; return h; }).sort(function (a, b) { return a.t - b.t; });
    out.resets = info.resets.filter(function (r) { return r.i >= i0 && r.i < i1; });
    return out;
  }

  /* ── 6. 관리 한계 ─────────────────────────────────────────
     중심선 = 기준 구간 평균. σ = 표본 표준편차(n−1) 또는 이동범위 평균 MR̄ ÷ 1.128 (I-MR 관리도).
     UCL/LCL = 중심선 ± k·σ (기본 3), 경고선 ± kWarn·σ (기본 2). values 의 NaN 은 뺍니다. */
  function limits(values, method, k, kWarn) {
    k = k || 3; kWarn = kWarn || 2;
    var n = 0, sum = 0, mrSum = 0, mrN = 0, prev = NaN;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (isNaN(v)) { prev = NaN; continue; }
      n++; sum += v;
      if (!isNaN(prev)) { mrSum += Math.abs(v - prev); mrN++; }
      prev = v;
    }
    if (n < 2) return null;
    var mean = sum / n, ss = 0;
    for (var j = 0; j < values.length; j++) { var x = values[j]; if (!isNaN(x)) ss += (x - mean) * (x - mean); }
    var sd = Math.sqrt(ss / (n - 1)), mrBar = mrN ? mrSum / mrN : NaN;
    var sigma = method === 'mr' ? mrBar / D2 : sd;
    if (!(sigma > 0)) sigma = Math.max(Math.abs(mean) * 1e-4, 1e-6); // 값이 모두 같을 때 0 으로 나누지 않게
    return { center: mean, sigma: sigma, sd: sd, mrBar: mrBar, sigmaMr: mrBar / D2, method: method === 'mr' ? 'mr' : 'sd', n: n, k: k, kWarn: kWarn,
      ucl: mean + k * sigma, lcl: mean - k * sigma, uwl: mean + kWarn * sigma, lwl: mean - kWarn * sigma };
  }
  /* 채널 하나의 그릴 값 — 정지 구간(선택)·다른 금형은 NaN 으로 뺍니다.
     groupSec > 0 이면 그 초 단위 시간 칸마다 평균(예: 60 = 1분 평균)으로 묶습니다 — 2초 값은 앞뒤가 비슷해 우연한 이탈이 잦으므로 함께 볼 수 있게. */
  function channelSeries(s, info, channel, opts, dieIdx, groupSec) {
    var O = cleanOpts(opts), src = s[channel], n = s.n, v = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = src[i];
      if ((dieIdx != null && dieIdx >= 0 && s.die[i] !== dieIdx) || (O.excludeStops && info && info.counted && info.stopped[i])) x = NaN;
      v[i] = x;
    }
    if (!(groupSec > 0)) return { t: s.t, v: v, n: n, groupSec: 0 };
    var ts = [], vs = [], key = NaN, sum = 0, cnt = 0;
    function flush() { if (cnt) { ts.push(key * groupSec); vs.push(sum / cnt); } sum = 0; cnt = 0; }
    for (var j = 0; j < n; j++) {
      var kk = Math.floor(s.t[j] / groupSec);
      if (kk !== key) { flush(); key = kk; }
      if (!isNaN(v[j])) { sum += v[j]; cnt++; }
    }
    flush();
    return { t: Float64Array.from(ts), v: Float32Array.from(vs), n: ts.length, groupSec: groupSec };
  }
  /* 기준 구간(시각 범위) — 처음 N개(정지 제외를 켰으면 정지 아닌 2초 값만 셈) 또는 기준 기간 */
  function baseRange(s, info, opts, dieIdx) {
    var O = cleanOpts(opts);
    if (O.baseMode === 'range') {
      var a = fromLocalInput(O.baseFrom), b = fromLocalInput(O.baseTo);
      if (isFinite(a) && isFinite(b) && b > a) {
        var r = rangeIdx(s, a, b), cnt = 0;
        for (var k = r[0]; k < r[1]; k++) if (!(dieIdx != null && dieIdx >= 0 && s.die[k] !== dieIdx) && !(O.excludeStops && info && info.counted && info.stopped[k])) cnt++;
        return { from: a, to: b, n: cnt, mode: 'range' };
      }
    }
    var got = 0, from = NaN, to = NaN;
    for (var i = 0; i < s.n && got < O.baseN; i++) {
      if (dieIdx != null && dieIdx >= 0 && s.die[i] !== dieIdx) continue;
      if (O.excludeStops && info && info.counted && info.stopped[i]) continue;
      if (!got) from = s.t[i];
      to = s.t[i]; got++;
    }
    return { from: from, to: to, n: got, mode: 'firstN', short: got < O.baseN };
  }
  function valuesIn(cs, from, to) {
    var out = [];
    for (var i = 0; i < cs.n; i++) { var t = cs.t[i]; if (t < from) continue; if (t > to) break; if (!isNaN(cs.v[i])) out.push(cs.v[i]); }
    return out;
  }
  /* 채널 하나의 관리도 — 기준 구간으로 한계를 잡고, 보는 구간 [from,to] 에 규칙을 적용 */
  function chartData(s, info, channel, opts, view) {
    var O = cleanOpts(opts); view = view || {};
    var cs = channelSeries(s, info, channel, O, view.dieIdx, view.groupSec || 0);
    var br = baseRange(s, info, O, view.dieIdx);
    var lim = isFinite(br.from) ? limits(valuesIn(cs, br.from, br.to), O.method, O.k, O.kWarn) : null;
    var from = isFinite(view.from) ? view.from : -Infinity, to = isFinite(view.to) ? view.to : Infinity;
    var i0 = lowerBound(cs.t, from, cs.n), i1 = lowerBound(cs.t, to + 0.5, cs.n);
    var vals = cs.v.subarray(i0, i1);
    var ev = evalRules(vals, lim, O.rules);
    var last = -1; for (var j = vals.length - 1; j >= 0; j--) if (!isNaN(vals[j])) { last = j; break; }
    return { channel: channel, cs: cs, i0: i0, i1: i1, values: vals, base: br, lim: lim, flags: ev.flags, count: ev.count,
      events: lim ? toEvents(cs.t, vals, ev.flags, lim, Math.max(10, (view.groupSec || 2) * 5), i0) : [],
      last: last >= 0 ? { t: cs.t[i0 + last], v: vals[last], flag: ev.flags[last] } : null };
  }

  /* ── 7. 이상 판정 규칙 (Western Electric 일부) ──────────
     flags 비트: 1 = 1점이 ±3σ 밖 · 2 = 연속 9점이 중심선 한쪽 · 4 = 연속 6점 계속 증가·감소 · 8 = 3점 중 2점이 같은 쪽 ±2σ 밖
     values 의 NaN(빈칸·정지 구간으로 뺀 값)은 연속을 끊습니다. */
  var RULES = [
    { bit: 1, id: 'r1', label: '1점 ±3σ 밖' },
    { bit: 2, id: 'run9', label: '연속 9점 한쪽' },
    { bit: 4, id: 'trend6', label: '연속 6점 증가·감소' },
    { bit: 8, id: 'two3', label: '3점 중 2점 ±2σ 밖' }
  ];
  function evalRules(values, lim, rules) {
    rules = rules || { r1: true };
    var n = values.length, flags = new Uint8Array(n), count = { r1: 0, run9: 0, trend6: 0, two3: 0 };
    if (!lim) return { flags: flags, count: count };
    var side = 0, run = 0, dir = 0, trend = 1, prev = NaN, recent = [];
    for (var i = 0; i < n; i++) {
      var x = values[i];
      if (isNaN(x)) { side = 0; run = 0; dir = 0; trend = 1; prev = NaN; recent = []; continue; }
      var f = 0;
      if (rules.r1 !== false && (x > lim.ucl || x < lim.lcl)) f |= 1;
      // 한쪽 연속
      var sd = x > lim.center ? 1 : x < lim.center ? -1 : 0;
      if (sd !== 0 && sd === side) run++; else { side = sd; run = sd ? 1 : 0; }
      if (rules.run9 && run >= 9) f |= 2;
      // 증가·감소 연속(같은 값이면 끊김)
      if (!isNaN(prev)) {
        var dd = x > prev ? 1 : x < prev ? -1 : 0;
        if (dd !== 0 && dd === dir) trend++; else { dir = dd; trend = dd ? 2 : 1; }
      } else { dir = 0; trend = 1; }
      if (rules.trend6 && trend >= 6) f |= 4;
      // 3점 중 2점 ±2σ 밖(같은 쪽)
      recent.push(x > lim.uwl ? 1 : x < lim.lwl ? -1 : 0); if (recent.length > 3) recent.shift();
      if (rules.two3 && recent.length === 3) {
        var up = 0, dn = 0; recent.forEach(function (z) { if (z > 0) up++; else if (z < 0) dn++; });
        if ((up >= 2 && recent[2] > 0) || (dn >= 2 && recent[2] < 0)) f |= 8;
      }
      prev = x;
      flags[i] = f;
      if (f & 1) count.r1++; if (f & 2) count.run9++; if (f & 4) count.trend6++; if (f & 8) count.two3++;
    }
    return { flags: flags, count: count };
  }
  function ruleLabels(mask) { return RULES.filter(function (r) { return mask & r.bit; }).map(function (r) { return r.label; }); }
  /* 걸린 점을 「사건」으로 묶기 — 바로 이어진 점(사이 maxGap 초 이하)은 하나로 */
  function toEvents(t, values, flags, lim, maxGap, base) {
    var ev = [], cur = null;
    maxGap = maxGap || 10;
    for (var i = 0; i < flags.length; i++) {
      if (!flags[i]) continue;
      var tt = t[base + i], x = values[i];
      if (cur && tt - cur.to <= maxGap) {
        cur.to = tt; cur.n++; cur.mask |= flags[i];
        if (Math.abs(x - lim.center) > Math.abs(cur.peak - lim.center)) cur.peak = x;
      } else {
        cur = { from: tt, to: tt, n: 1, mask: flags[i], peak: x };
        ev.push(cur);
      }
    }
    ev.forEach(function (e) { e.side = e.peak > lim.center ? 'up' : 'down'; e.z = (e.peak - lim.center) / lim.sigma; e.rules = ruleLabels(e.mask); });
    return ev;
  }

  /* ── 8. 그래프용 줄이기 ───────────────────────────────────
     점이 많으면 시간 칸(buckets 개)마다 평균·최소·최대를 남기고, 규칙에 걸린 점은 줄이지 않고 따로 돌려줍니다(빠지지 않게).
     걸린 점이 maxViol 보다 많으면 칸마다 가장 멀리 벗어난 점 하나만 남깁니다(모두 몇 개인지는 count 로). */
  function downsample(t, values, flags, base, buckets, maxViol) {
    var n = values.length; buckets = buckets || 600; maxViol = maxViol || 2000;
    var out = { raw: n <= buckets * 2, points: [], buckets: [], viol: [], violCount: 0, t0: NaN, t1: NaN };
    var first = -1, last = -1;
    for (var i = 0; i < n; i++) if (!isNaN(values[i])) { if (first < 0) first = i; last = i; }
    if (first < 0) return out;
    out.t0 = t[base + first]; out.t1 = t[base + last];
    var span = Math.max(1, out.t1 - out.t0), w = span / buckets;
    for (var a = 0; a < n; a++) if (flags && flags[a] && !isNaN(values[a])) out.violCount++;
    var thin = out.violCount > maxViol, perBucket = {};
    for (var j = 0; j < n; j++) {
      var v = values[j]; if (isNaN(v)) continue;
      var tt = t[base + j];
      if (flags && flags[j]) {
        if (!thin) out.viol.push({ t: tt, v: v, f: flags[j] });
        else { var kb = Math.min(buckets - 1, Math.floor((tt - out.t0) / w)), cur = perBucket[kb]; if (!cur || Math.abs(v) > Math.abs(cur.v)) perBucket[kb] = { t: tt, v: v, f: flags[j], far: true }; }
      }
      if (out.raw) { out.points.push({ t: tt, v: v }); continue; }
      var b = Math.min(buckets - 1, Math.floor((tt - out.t0) / w)), bk = out.buckets[b];
      if (!bk) bk = out.buckets[b] = { t: out.t0 + (b + 0.5) * w, min: v, max: v, sum: 0, n: 0 };
      if (v < bk.min) bk.min = v; if (v > bk.max) bk.max = v; bk.sum += v; bk.n++;
    }
    if (thin) out.viol = Object.keys(perBucket).map(function (k) { return perBucket[k]; });
    if (!out.raw) out.buckets = out.buckets.filter(Boolean).map(function (bk) { bk.mean = bk.sum / bk.n; return bk; });
    return out;
  }

  /* ── 9. 원 로그 → 일 집계(기존 「최근 14일 vs 앞 42일」 판정으로) ──
     프레스·날짜·금형마다 한 행: 타수 = 그날 오른 타수 합, 가동 시간 = 정지·기록 끊김을 뺀 시간(h), 센서 = 정지 아닌 값의 평균.
     time 은 비워 둡니다(같은 날을 다시 가져오면 같은 행으로 바뀌게). src:'raw' 로 표시합니다. */
  function dailyFromSeries(s, info) {
    info = info || strokeInfo(s);
    var O = info.opts, m = {};
    for (var i = 0; i < s.n; i++) {
      var date = dateOf(s.t[i]), die = s.dies[s.die[i]] || '', key = date + '|' + die;
      var d = m[key] || (m[key] = { date: date, time: '', press: s.press, pressType: s.type, die: die, strokes: info.counted ? 0 : null, runSec: 0, sum: {}, cnt: {}, rows: 0, src: 'raw' });
      d.rows++;
      if (info.inc[i] > 0) d.strokes += info.inc[i];
      if (i > 0 && dateOf(s.t[i - 1]) === date) {
        var dt = s.t[i] - s.t[i - 1];
        if (dt <= O.gapSec && !(info.stopped[i] && info.stopped[i - 1])) d.runSec += dt;
      }
      if (info.counted && info.stopped[i]) continue;
      for (var c = 0; c < CH.length; c++) { var v = s[CH[c]][i]; if (!isNaN(v)) { d.sum[CH[c]] = (d.sum[CH[c]] || 0) + v; d.cnt[CH[c]] = (d.cnt[CH[c]] || 0) + 1; } }
    }
    return Object.keys(m).sort().map(function (k) {
      var d = m[k], r = { date: d.date, time: '', press: d.press, pressType: d.pressType, die: d.die, strokes: d.strokes, pressCum: null, dieCum: null,
        runHr: L.round(d.runSec / 3600, 3), src: 'raw', rawRows: d.rows };
      CH.forEach(function (c) { r[c] = d.cnt[c] ? L.round(d.sum[c] / d.cnt[c], 3) : null; });
      return r;
    });
  }

  /* 프레스 시계열 요약(가져오기 화면·대시보드용) */
  function summary(s) {
    if (!s || !s.n) return null;
    var days = {}; for (var i = 0; i < s.n; i++) days[dateOf(s.t[i])] = 1;
    return { press: s.press, type: s.type, n: s.n, from: s.t[0], to: s.t[s.n - 1], days: Object.keys(days).length, dies: s.dies.filter(Boolean) };
  }

  return {
    CH: CH, D2: D2, DEFAULT_OPTS: DEFAULT_OPTS, RULES: RULES,
    parseStamp: parseStamp, parseClock: parseClock, stampText: stampText, dateOf: dateOf, toLocalInput: toLocalInput, fromLocalInput: fromLocalInput, durText: durText,
    createCsvParser: createCsvParser, parseCsvText: parseCsvText, sniffEncoding: sniffEncoding,
    isHighFreq: isHighFreq, stampOf: stampOf, createRawBuilder: createRawBuilder, mergeSeries: mergeSeries, rangeIdx: rangeIdx,
    cleanOpts: cleanOpts, strokeInfo: strokeInfo, strokeWindow: strokeWindow,
    limits: limits, channelSeries: channelSeries, baseRange: baseRange, valuesIn: valuesIn, chartData: chartData, evalRules: evalRules, ruleLabels: ruleLabels, toEvents: toEvents, downsample: downsample,
    dailyFromSeries: dailyFromSeries, summary: summary
  };
});
