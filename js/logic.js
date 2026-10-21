/* 프레스·금형 예지보전 — 순수 로직 (화면·저장소와 무관)
   브라우저에서는 window.PressLogic, node 에서는 require('./logic.js') 로 씁니다.
   기준 문서: docs/01_프로젝트_기획서.md (3장 데이터, 5장 기능, 8장 1단계)

   흐름: 로그 엑셀·CSV → detectColumns(열 찾기) → parseRows(행 → 로그 기록) → mergeRecords(여러 파일 누적·중복 제거)
        → deriveStrokes(행마다 타수: 타수 열 · 프레스 누적 타수 차이 · 금형 누적 타수 차이)
        → dieStatus(금형 수명·교체 예정일) · overhaulStatus(오버홀) · detectSensor(전류·전압·온도·진동 이상)
        → pressStatus(프레스별 정상/주의/점검 필요) · monthlyByType(월별 프레스 종류별 타수) · buildAiPromptInfo */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PressLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = 1;

  /* ── 1. 열 이름 ────────────────────────────────────────────────
     머리행 글자에서 괄호 속(단위)을 떼고, 공백·가운데점 등을 빼고 소문자로 맞춘 뒤 아래 별칭과 비교합니다.
     수강생이 올릴 수 있다고 한 칸: 프레스 종류 · 금형명 · 프레스 누적 타수 · 금형 타수 · 가동 시간 · 전류 · 전압 · 온도 (+ 보유 데이터의 진동)
     「금형 타수」는 금형 교체 때 0 으로 돌아가는 누적 카운터로 읽습니다(2026-10-21 수강생 로그 실측: 0 → 719 로 오름).
     그 행에서 친 횟수라면 열 이름을 「타수」로 하거나 열 연결에서 「타수」로 바꿉니다. */
  var FIELDS = [
    { id: 'date', label: '일자(일시)', req: true, aliases: ['일자', '날짜', '일시', '생산일자', '작업일자', '측정일시', '측정일자', '기록일시', '수집일시', 'date', 'datetime', 'timestamp'] },
    { id: 'time', label: '시각', req: false, aliases: ['시각', '측정시각', '기록시각', '수집시각', 'time'] },
    { id: 'press', label: '프레스(설비)', req: true, aliases: ['프레스', '프레스명', '프레스번호', '프레스no', '설비', '설비명', '설비번호', '설비코드', '호기', 'press'] },
    { id: 'pressType', label: '프레스 종류', req: false, aliases: ['프레스종류', '종류', '설비종류', '기종', '프레스기종', '프레스유형', '톤수', 'type'] },
    { id: 'die', label: '금형명', req: false, aliases: ['금형', '금형명', '금형번호', '금형코드', '금형no', 'die', 'mold'] },
    { id: 'strokes', label: '타수(이 행에서 친 횟수)', req: false, aliases: ['타수', '일타수', '생산타수', '작업타수', 'stroke', 'strokes'] },
    { id: 'pressCum', label: '프레스 누적 타수', req: false, aliases: ['프레스누적타수', '누적타수', '총타수', '설비누적타수', '프레스총타수'] },
    { id: 'dieCum', label: '금형 (누적) 타수', req: false, aliases: ['금형누적타수', '금형누적', '금형총타수', '금형타수'] },
    { id: 'runHr', label: '가동 시간', req: false, aliases: ['가동시간', '가동', '운전시간', '가동hr', '가동시간hr'] },
    { id: 'current', label: '전류(A)', req: false, aliases: ['전류', '부하전류', '모터전류', '메인모터전류', '전류값', 'current'] },
    { id: 'voltage', label: '전압(V)', req: false, aliases: ['전압', '전압값', 'voltage'] },
    { id: 'temp', label: '온도(℃)', req: false, aliases: ['온도', '유온', '작동유온도', '오일온도', '모터온도', '온도값', 'temp', 'temperature'] },
    { id: 'vib', label: '진동', req: false, aliases: ['진동', '진동값', '진동rms', 'vib', 'vibration', 'rms'] }
  ];
  var FIELD_BY_ID = {};
  FIELDS.forEach(function (f) { FIELD_BY_ID[f.id] = f; });
  /* 이상 감지 채널 — 단위는 화면 표시용 */
  var CHANNELS = [
    { id: 'current', label: '전류', unit: 'A' },
    { id: 'temp', label: '온도', unit: '℃' },
    { id: 'vib', label: '진동', unit: '' },
    { id: 'voltage', label: '전압', unit: 'V' }
  ];
  var CHANNEL_BY_ID = {};
  CHANNELS.forEach(function (c) { CHANNEL_BY_ID[c.id] = c; });
  var LEVELS = { ok: '정상', warn: '주의', bad: '점검 필요', none: '기준 없음', nobase: '비교 못 함', nodata: '자료 없음' };
  var RANK = { bad: 3, warn: 2, ok: 1, none: 0, nobase: 0, nodata: 0 };

  function str(v) { return v == null ? '' : String(v).trim(); }
  function norm(s) {
    return String(s == null ? '' : s).replace(/[\s()（）\[\]·.:_\-\/]/g, '').toLowerCase();
  }
  /* 머리 글자 → { key, unit }. 「전류(A)」 → key 전류, unit a · 「가동 시간(분)」 → key 가동시간, unit 분 */
  function splitHeader(text) {
    var s = str(text), unit = '';
    var m = /[(（\[]([^)）\]]*)[)）\]]/.exec(s);
    if (m) { unit = m[1].trim().toLowerCase(); s = s.replace(m[0], ''); }
    var key = norm(s).replace(/(℃|°c)$/i, '');
    return { key: key, unit: unit };
  }
  function matchField(text) {
    var k = splitHeader(text).key;
    if (!k) return null;
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].aliases.indexOf(k) >= 0) return FIELDS[i].id;
    return null;
  }

  /* ── 2. 숫자·날짜 ─────────────────────────────────────────── */
  /* 빈칸은 null, 숫자로 못 읽으면 NaN(경고용). 「1,234」 「12.5A」 처럼 뒤에 단위가 붙은 것도 읽습니다 */
  function toNum(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (typeof v === 'boolean') return NaN;
    var s = String(v).trim();
    if (!s || s === '-') return null;
    if (s.charAt(0) === '=') return null;
    s = s.replace(/,/g, '').replace(/\s*(a|v|℃|°c|mm\/s|hr|h|타|회|시간)$/i, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }
  function round(n, d) { if (n == null || !isFinite(n)) return n; var p = Math.pow(10, d == null ? 2 : d); return Math.round(n * p) / p; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoFromUTC(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function isoOk(y, m, d) {
    if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    var t = Date.UTC(y, m - 1, d); var x = new Date(t);
    return x.getUTCMonth() === m - 1 ? isoFromUTC(t) : '';
  }
  function hm(h, m) { return (h >= 0 && h < 24 && m >= 0 && m < 60) ? pad(h) + ':' + pad(m) : ''; }
  /* 일(fraction) → 'HH:MM' */
  function timeFromFraction(f) {
    var mins = Math.round(f * 1440);
    if (mins >= 1440) mins = 1439;
    return mins > 0 ? hm(Math.floor(mins / 60), mins % 60) : '';
  }
  /* 엑셀 날짜(일련번호 · Date · 글자) → { date:'YYYY-MM-DD', time:'HH:MM'|'' }. 못 읽으면 date ''.
     앱은 엑셀을 cellDates:false 로 읽어 날짜 칸이 일련번호로 옵니다(시간대 영향 없이 정확). */
  function toDateTime(v) {
    var out = { date: '', time: '' };
    if (v == null || v === '') return out;
    if (v instanceof Date || Object.prototype.toString.call(v) === '[object Date]') {
      if (isNaN(v.getTime())) return out;
      var d = new Date(Math.round(v.getTime() / 60000) * 60000);
      out.date = isoOk(d.getFullYear(), d.getMonth() + 1, d.getDate());
      out.time = (d.getHours() || d.getMinutes()) ? hm(d.getHours(), d.getMinutes()) : '';
      return out;
    }
    if (typeof v === 'number') {
      if (v < 20000 || v > 80000) return out;
      var day = Math.floor(v);
      out.date = isoFromUTC(Date.UTC(1899, 11, 30) + day * 86400000);
      out.time = timeFromFraction(v - day);
      return out;
    }
    var s = String(v).trim();
    var m = /^(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})일?(?:[T\s]+(\d{1,2}):(\d{2})(?::\d{2})?)?/.exec(s);
    if (m) { out.date = isoOk(+m[1], +m[2], +m[3]); if (out.date && m[4] != null) out.time = hm(+m[4], +m[5]); return out; }
    m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (m) { out.date = isoOk(+m[1], +m[2], +m[3]); return out; }
    if (/^\d{5}(\.\d+)?$/.test(s)) return toDateTime(Number(s));
    return out;
  }
  function toISO(v) { return toDateTime(v).date; }
  /* 따로 있는 시각 칸 — 0~1 사이 숫자(엑셀 시각) 또는 「8:30」 */
  function toTime(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') return v >= 0 && v < 1 ? timeFromFraction(v) : '';
    var m = /^(\d{1,2}):(\d{2})/.exec(String(v).trim());
    return m ? hm(+m[1], +m[2]) : '';
  }
  function isoToUTC(iso) { var p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function addDays(iso, n) { return isoFromUTC(isoToUTC(iso) + n * 86400000); }
  function daysBetween(a, b) { return Math.round((isoToUTC(b) - isoToUTC(a)) / 86400000); }
  function monthOf(iso) { return iso ? iso.slice(0, 7) : ''; }
  function monthLabel(ym) { return ym ? ym.slice(0, 4) + '년 ' + (+ym.slice(5, 7)) + '월' : ''; }
  function md(iso) { return iso ? (+iso.slice(5, 7)) + '/' + (+iso.slice(8, 10)) : ''; }
  function colName(i) {
    var s = ''; i = Number(i);
    do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
    return s;
  }
  function cmp(a, b) { a = a == null ? '' : String(a); b = b == null ? '' : String(b); return a < b ? -1 : a > b ? 1 : 0; }
  /* P2 < P10 처럼 숫자를 숫자로 비교 */
  function natCmp(a, b) { return String(a).localeCompare(String(b), 'ko', { numeric: true }); }
  function uniq(a) { var s = {}, o = []; a.forEach(function (x) { if (x != null && x !== '' && !s[x]) { s[x] = 1; o.push(x); } }); return o; }
  function fmtN(v, d) {
    if (v == null || !isFinite(v)) return '-';
    return Number(round(v, d == null ? 0 : d)).toLocaleString('ko-KR');
  }
  function signed(v, d) { if (v == null || !isFinite(v)) return '-'; return (v > 0 ? '+' : v < 0 ? '−' : '±') + fmtN(Math.abs(v), d); }
  function pctText(r, d) { return r == null || !isFinite(r) ? '-' : fmtN(r * 100, d == null ? 1 : d) + '%'; }

  /* CSV 바이트 → 글자. 한글 엑셀이 저장한 CSV 는 대개 CP949(EUC-KR)라 UTF-8 로 먼저 읽고 깨지면 EUC-KR 로 다시 읽습니다 */
  function decodeCsv(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try {
      var t = new TextDecoder('utf-8', { fatal: true }).decode(u8);
      return { text: t.charCodeAt(0) === 0xfeff ? t.slice(1) : t, encoding: 'UTF-8' };
    } catch (e) {
      return { text: new TextDecoder('euc-kr').decode(u8), encoding: 'EUC-KR(CP949)' };
    }
  }

  /* ── 3. 머리행 찾기 ────────────────────────────────────────── */
  /* aoa: 시트를 행 배열로 읽은 것(SheetJS sheet_to_json header:1).
     반환: { headerRow, map:{field:col}, units:{field:unit}, headers:[글자], missing:[field], warnings:[] } */
  function detectColumns(aoa, overrides) {
    var best = -1, bestScore = 0, limit = Math.min(aoa.length, 20);
    for (var r = 0; r < limit; r++) {
      var row = aoa[r] || [], seen = {}, score = 0;
      for (var c = 0; c < row.length; c++) {
        var f = matchField(row[c]);
        if (f && !seen[f]) { seen[f] = 1; score++; }
      }
      if (score > bestScore && (seen.date || seen.press)) { best = r; bestScore = score; }
    }
    var out = { headerRow: best, map: {}, units: {}, headers: [], missing: [], warnings: [] };
    if (best < 0 || bestScore < 2) {
      out.headerRow = -1;
      out.warnings.push('머리행(일자·프레스·타수·전류 …)을 찾지 못했습니다. 프레스 로그 시트인지 확인해 주세요.');
      FIELDS.forEach(function (f) { if (f.req) out.missing.push(f.id); });
      return out;
    }
    var hdr = aoa[best] || [], width = hdr.length;
    for (var k = best + 1; k < Math.min(aoa.length, best + 4); k++) width = Math.max(width, (aoa[k] || []).length);
    for (var c3 = 0; c3 < width; c3++) {
      var text = str(hdr[c3]);
      out.headers.push(text);
      var fid = matchField(text);
      if (fid && out.map[fid] == null) { out.map[fid] = c3; out.units[fid] = splitHeader(text).unit; }
      else if (fid) out.warnings.push('「' + text + '」 열이 두 번 나옵니다. 앞의 것(' + colName(out.map[fid]) + ')을 씁니다.');
    }
    // 사용자가 고른 연결이 있으면 덮어씁니다 (값 -1 = 이 파일에는 없음)
    if (overrides) Object.keys(overrides).forEach(function (fid) {
      if (!FIELD_BY_ID[fid]) return;
      var v = overrides[fid];
      if (v === -1 || v === '' || v == null) { delete out.map[fid]; delete out.units[fid]; }
      else { out.map[fid] = Number(v); out.units[fid] = splitHeader(out.headers[Number(v)]).unit; }
    });
    FIELDS.forEach(function (f) { if (f.req && out.map[f.id] == null) out.missing.push(f.id); });
    if (out.missing.length) out.warnings.push('꼭 필요한 열이 없습니다: ' + out.missing.map(function (id) { return FIELD_BY_ID[id].label; }).join(', ') + ' — 열 연결에서 골라 주세요.');
    if (out.map.strokes == null && out.map.pressCum == null && out.map.dieCum == null)
      out.warnings.push('타수 열(타수·프레스 누적 타수·금형 누적 타수)이 없어 타수 집계·교체 예측을 할 수 없습니다.');
    if (!CHANNELS.some(function (ch) { return out.map[ch.id] != null; }))
      out.warnings.push('전류·전압·온도·진동 열이 없어 이 파일로는 이상 감지를 할 수 없습니다.');
    if (out.map.die == null) out.warnings.push('금형명 열이 없어 금형별 타수를 셀 수 없습니다(프레스별 집계는 됩니다).');
    return out;
  }
  function headerSignature(det) { return (det.headers || []).map(norm).join('|'); }

  /* ── 4. 행 → 로그 기록 ─────────────────────────────────────── */
  function hourFactor(unit) {
    var u = str(unit).toLowerCase();
    if (/^(분|min|mins|minute|minutes|m)$/.test(u)) return 1 / 60;
    if (/^(초|s|sec|secs|second|seconds)$/.test(u)) return 1 / 3600;
    return 1;
  }
  /* opts: { fileName } → { records, warnings:[{row, msg}], skipped } */
  function parseRows(aoa, det, opts) {
    opts = opts || {};
    var out = { records: [], warnings: [], skipped: 0 };
    if (det.headerRow < 0 || det.missing.length) return out;
    var m = det.map;
    function cell(row, fid) { return m[fid] == null ? null : row[m[fid]]; }
    for (var r = det.headerRow + 1; r < aoa.length; r++) {
      var row = aoa[r] || [], rowNo = r + 1;
      var rawDate = cell(row, 'date'), rawPress = cell(row, 'press');
      if ((rawDate == null || rawDate === '') && !str(rawPress)) { out.skipped++; continue; }
      var dt = toDateTime(rawDate);
      if (!dt.date) { out.warnings.push({ row: rowNo, msg: '일자를 읽지 못해 건너뜀 (' + str(rawDate) + ')' }); out.skipped++; continue; }
      var press = str(rawPress);
      if (!press) { out.warnings.push({ row: rowNo, msg: '프레스 칸이 비어 건너뜀' }); out.skipped++; continue; }
      if (typeof rawPress === 'number') press = String(rawPress);
      var rec = { date: dt.date, time: dt.time, press: press, pressType: str(cell(row, 'pressType')), die: str(cell(row, 'die')) };
      if (m.time != null) { var tm = toTime(cell(row, 'time')); if (tm) rec.time = tm; }
      ['strokes', 'pressCum', 'dieCum', 'runHr', 'current', 'voltage', 'temp', 'vib'].forEach(function (fid) {
        var v = toNum(cell(row, fid));
        if (v != null && isNaN(v)) { out.warnings.push({ row: rowNo, msg: FIELD_BY_ID[fid].label + ' 값을 숫자로 읽지 못함 (' + str(cell(row, fid)) + ')' }); v = null; }
        if (v != null && v < 0 && fid !== 'temp') { out.warnings.push({ row: rowNo, msg: FIELD_BY_ID[fid].label + ' 값이 음수라 비움 (' + v + ')' }); v = null; }
        if (v != null && fid === 'runHr') v = round(v * hourFactor(det.units.runHr), 4);
        rec[fid] = v;
      });
      if (rec.runHr != null && rec.runHr > 24 && !rec.time) out.warnings.push({ row: rowNo, msg: '가동 시간이 24시간을 넘습니다(' + rec.runHr + ') — 단위가 분이면 열 이름을 「가동 시간(분)」으로 해 주세요' });
      if (opts.fileName) rec.file = opts.fileName;
      out.records.push(rec);
    }
    return out;
  }
  function parseSheet(aoa, opts) {
    opts = opts || {};
    var det = detectColumns(aoa, opts.overrides);
    var p = parseRows(aoa, det, opts);
    return { det: det, records: p.records, warnings: p.warnings, skipped: p.skipped };
  }
  /* 여러 시트 중 로그 시트 고르기 — 머리행 점수가 가장 높은 시트 */
  function pickSheet(sheets) {
    var best = null, bestN = -1;
    sheets.forEach(function (s) {
      var d = detectColumns(s.aoa);
      var n = d.headerRow < 0 ? -1 : Object.keys(d.map).length - d.missing.length * 3;
      if (n > bestN) { best = s; bestN = n; }
    });
    return best;
  }

  /* ── 5. 누적 · 중복 제거 ─────────────────────────────────────
     같은 행 = 일자 + 시각 + 프레스 + 금형. 다시 가져오면 새 값으로 바뀝니다. */
  function recKey(r) { return [r.date, r.time || '', r.press, r.die || ''].join('|'); }
  function mergeRecords(existing, incoming) {
    var byKey = {}, stat = { added: 0, updated: 0 };
    (existing || []).forEach(function (r) { byKey[recKey(r)] = r; });
    (incoming || []).forEach(function (r) {
      var k = recKey(r);
      if (byKey[k]) stat.updated++; else stat.added++;
      byKey[k] = r;
    });
    var records = Object.keys(byKey).map(function (k) { return byKey[k]; });
    return { records: sortRecords(records), stat: stat };
  }
  function sortRecords(list) {
    return list.slice().sort(function (a, b) {
      return natCmp(a.press, b.press) || cmp(a.date, b.date) || cmp(a.time || '', b.time || '') || cmp(a.die, b.die);
    });
  }
  function dataRange(records) {
    var first = '', last = '';
    (records || []).forEach(function (r) { if (!first || r.date < first) first = r.date; if (!last || r.date > last) last = r.date; });
    return { first: first, last: last };
  }

  /* ── 6. 타수 계산 ─────────────────────────────────────────────
     행마다 「이 행에서 친 타수」 s 를 정합니다.
       1) 타수 열이 있으면 그 값
       2) 없으면 같은 프레스 바로 앞 행의 프레스 누적 타수와의 차이
       3) 그것도 없으면 같은 금형 바로 앞 행의 금형 누적 타수와의 차이
     누적값이 줄었으면(카운터 초기화) 그 행은 셀 수 없어 비웁니다. 첫 행은 앞 값이 없어 셀 수 없습니다.
     타수 열과 프레스 누적 타수가 함께 있으면 둘이 맞는지도 봅니다(누적 차이 = 그 사이 타수 합). */
  function deriveStrokes(records) {
    var rows = sortRecords(records || []).map(function (r) { var c = {}; for (var k in r) c[k] = r[k]; c.s = null; c.sSrc = ''; return c; });
    var stat = { fromRow: 0, fromPressCum: 0, fromDieCum: 0, noPrev: 0, reset: 0, mismatch: 0, none: 0, mismatchRows: [] };
    var prevPress = {}, prevDie = {}, sinceStrokes = {};
    var dieOrder = rows.slice().sort(function (a, b) { return cmp(a.die, b.die) || cmp(a.date, b.date) || cmp(a.time || '', b.time || '') || natCmp(a.press, b.press); });
    // 금형 누적 차이는 금형 순서로 따로 구합니다
    var dieDelta = new Map();
    dieOrder.forEach(function (r) {
      if (!r.die || r.dieCum == null) return;
      var p = prevDie[r.die];
      if (p != null) dieDelta.set(r, r.dieCum - p);
      prevDie[r.die] = r.dieCum;
    });
    rows.forEach(function (r) {
      var pc = prevPress[r.press];
      if (r.strokes != null) {
        r.s = r.strokes; r.sSrc = 'row'; stat.fromRow++;
        sinceStrokes[r.press] = (sinceStrokes[r.press] || 0) + r.strokes;
        if (r.pressCum != null && pc != null) {
          var d = r.pressCum - pc, sum = sinceStrokes[r.press];
          if (d >= 0 && Math.abs(d - sum) > Math.max(5, sum * 0.01)) { stat.mismatch++; if (stat.mismatchRows.length < 20) stat.mismatchRows.push(r.press + ' ' + r.date + (r.time ? ' ' + r.time : '') + ' — 누적 차이 ' + d + ' · 타수 합 ' + sum); }
        }
      } else if (r.pressCum != null) {
        if (pc == null) { stat.noPrev++; }
        else if (r.pressCum - pc < 0) { stat.reset++; }
        else { r.s = r.pressCum - pc; r.sSrc = 'pressCum'; stat.fromPressCum++; }
      } else if (r.dieCum != null && r.die) {
        if (!dieDelta.has(r)) stat.noPrev++;
        else if (dieDelta.get(r) < 0) stat.reset++;
        else { r.s = dieDelta.get(r); r.sSrc = 'dieCum'; stat.fromDieCum++; }
      } else stat.none++;
      if (r.pressCum != null) { prevPress[r.press] = r.pressCum; sinceStrokes[r.press] = 0; }
    });
    return { rows: rows, stat: stat };
  }

  /* 프레스·날짜별 하루 묶음 — 타수·가동시간은 합, 센서는 평균(있는 값만) */
  function daily(rows) {
    var m = {};
    (rows || []).forEach(function (r) {
      var k = r.press + '|' + r.date;
      var d = m[k] || (m[k] = { press: r.press, date: r.date, strokes: null, runHr: null, dies: [], n: 0, sum: {}, cnt: {} });
      d.n++;
      if (r.s != null) d.strokes = (d.strokes || 0) + r.s;
      if (r.runHr != null) d.runHr = round((d.runHr || 0) + r.runHr, 4);
      if (r.die && d.dies.indexOf(r.die) < 0) d.dies.push(r.die);
      CHANNELS.forEach(function (ch) { var v = r[ch.id]; if (v != null && isFinite(v)) { d.sum[ch.id] = (d.sum[ch.id] || 0) + v; d.cnt[ch.id] = (d.cnt[ch.id] || 0) + 1; } });
    });
    return Object.keys(m).map(function (k) {
      var d = m[k];
      CHANNELS.forEach(function (ch) { d[ch.id] = d.cnt[ch.id] ? round(d.sum[ch.id] / d.cnt[ch.id], 3) : null; });
      delete d.sum; delete d.cnt;
      return d;
    }).sort(function (a, b) { return natCmp(a.press, b.press) || cmp(a.date, b.date); });
  }

  /* ── 7. 설비·금형 기준표(마스터) ────────────────────────────── */
  function emptyPress(id, type) { return { id: id, type: type || '', ohStrokes: null, ohDays: null, lastOH: '', ohBase: null, note: '' }; }
  function emptyDie(id) { return { id: id, life: null, startDate: '', baseStrokes: null, note: '' }; }
  /* 로그에 나온 프레스·금형을 기준표에 더합니다(이미 있는 칸은 그대로). 프레스 종류가 비어 있으면 로그 값으로 채웁니다 */
  function syncMaster(presses, dies, records) {
    var P = presses || {}, D = dies || {}, added = { presses: 0, dies: 0 };
    (records || []).forEach(function (r) {
      if (!P[r.press]) { P[r.press] = emptyPress(r.press, r.pressType); added.presses++; }
      else if (!P[r.press].type && r.pressType) P[r.press].type = r.pressType;
      if (r.die && !D[r.die]) { D[r.die] = emptyDie(r.die); added.dies++; }
    });
    return { presses: P, dies: D, added: added };
  }
  function posNum(v) { var n = toNum(v); return n != null && !isNaN(n) && n > 0 ? n : null; }
  function nonNeg(v) { var n = toNum(v); return n != null && !isNaN(n) && n >= 0 ? n : null; }
  function cleanPress(p, id) {
    var c = emptyPress(id || str(p && p.id));
    if (!p) return c;
    c.type = str(p.type); c.ohStrokes = posNum(p.ohStrokes); c.ohDays = posNum(p.ohDays);
    c.lastOH = toISO(p.lastOH); c.ohBase = nonNeg(p.ohBase); c.note = str(p.note);
    return c;
  }
  function cleanDie(d, id) {
    var c = emptyDie(id || str(d && d.id));
    if (!d) return c;
    c.life = posNum(d.life); c.startDate = toISO(d.startDate); c.baseStrokes = nonNeg(d.baseStrokes); c.note = str(d.note);
    return c;
  }
  function pressTypeOf(presses, press, fallback) {
    var p = presses && presses[press];
    return (p && p.type) || fallback || '(종류 없음)';
  }

  /* 기준표 ↔ 엑셀 — 협력사가 금형이 많을 때 엑셀로 채워 한 번에 불러오게 */
  var MASTER_PRESS_HEAD = ['프레스', '프레스 종류', '오버홀 주기(타수)', '오버홀 주기(일)', '마지막 오버홀 일자', '마지막 오버홀 뒤 로그 이전 타수', '메모'];
  var MASTER_DIE_HEAD = ['금형명', '수명 기준 타수', '사용 시작일(교체일)', '시작 시점 사용 타수', '메모'];
  var MP_KEYS = ['id', 'type', 'ohStrokes', 'ohDays', 'lastOH', 'ohBase', 'note'], MD_KEYS = ['id', 'life', 'startDate', 'baseStrokes', 'note'];
  function masterToAoa(presses, dies) {
    var p = [MASTER_PRESS_HEAD], d = [MASTER_DIE_HEAD];
    Object.keys(presses || {}).sort(natCmp).forEach(function (k) { var x = cleanPress(presses[k], k); p.push(MP_KEYS.map(function (f) { return x[f] == null ? '' : x[f]; })); });
    Object.keys(dies || {}).sort(natCmp).forEach(function (k) { var x = cleanDie(dies[k], k); d.push(MD_KEYS.map(function (f) { return x[f] == null ? '' : x[f]; })); });
    return { presses: p, dies: d };
  }
  /* 시트 하나 → 머리행으로 설비/금형 기준표를 가려 읽음 (열 순서가 달라도 이름으로) */
  function masterFromAoa(aoa) {
    var out = { presses: {}, dies: {} };
    var heads = [[MASTER_PRESS_HEAD, MP_KEYS, 'presses'], [MASTER_DIE_HEAD, MD_KEYS, 'dies']];
    for (var r = 0; r < Math.min(aoa.length, 10); r++) {
      var row = (aoa[r] || []).map(norm);
      for (var h = 0; h < heads.length; h++) {
        var cols = heads[h][0].map(function (t) { return row.indexOf(norm(t)); });
        if (cols[0] < 0 || cols.filter(function (c) { return c >= 0; }).length < 2) continue;
        for (var i = r + 1; i < aoa.length; i++) {
          var src = aoa[i] || [], o = {};
          heads[h][1].forEach(function (k, j) { if (cols[j] >= 0) o[k] = src[cols[j]]; });
          var id = str(o.id); if (!id) continue;
          if (typeof o.lastOH === 'number') o.lastOH = toISO(o.lastOH);
          if (typeof o.startDate === 'number') o.startDate = toISO(o.startDate);
          out[heads[h][2]][id] = h === 0 ? cleanPress(o, id) : cleanDie(o, id);
        }
        return out;
      }
    }
    return out;
  }

  /* ── 8. 판정 기준 ─────────────────────────────────────────── */
  var DEFAULT_RULES = {
    avgDays: 14,      // 교체·오버홀 예정일 추정에 쓰는 최근 일수(달력 일수, 쉬는 날 포함 평균)
    warnPct: 0.9,     // 수명·오버홀 주기의 이 비율에 닿으면 「주의」
    alertDays: 14,    // 예정일이 이 날수 안이면 「주의」
    recentDays: 14,   // 이상 감지 — 살펴볼 최근 구간(달력 일수)
    baseDays: 42,     // 이상 감지 — 기준선 구간(최근 구간 바로 앞, 달력 일수)
    minBase: 10,      // 기준선에 필요한 최소 가동일 수
    k: 3,             // 관리한계 = 기준선 ± k × 표준편차(로버스트)
    kWarn: 2,         // 주의 한계
    persist: 3,       // 연속 가동일 수 — 이만큼 이어서 넘어야 판정
    spikes: 2,        // 연속이 아니어도 최근 구간에서 ±k 를 이만큼 넘으면 「주의」(하루 튄 값 하나로는 판정하지 않음)
    method: 'mad',    // 'mad' = 중앙값 ± k × 1.4826 × MAD (튀는 값에 강함) · 'sigma' = 평균 ± k × 표준편차
    channels: { current: true, temp: true, vib: true, voltage: true }
  };
  function cleanRules(p) {
    var r = JSON.parse(JSON.stringify(DEFAULT_RULES));
    if (!p || typeof p !== 'object') return r;
    function num(k, min, max, int) {
      var v = Number(p[k]);
      if (p[k] != null && p[k] !== '' && isFinite(v) && v >= min && v <= max) r[k] = int ? Math.round(v) : v;
    }
    num('avgDays', 1, 365, true); num('warnPct', 0.5, 1, false); num('alertDays', 0, 365, true);
    num('recentDays', 3, 180, true); num('baseDays', 7, 365, true); num('minBase', 3, 365, true);
    num('k', 0.5, 10, false); num('kWarn', 0.5, 10, false); num('persist', 1, 30, true); num('spikes', 1, 30, true);
    if (r.kWarn > r.k) r.kWarn = r.k;
    if (p.method === 'sigma' || p.method === 'mad') r.method = p.method;
    if (p.channels && typeof p.channels === 'object') CHANNELS.forEach(function (ch) { if (p.channels[ch.id] != null) r.channels[ch.id] = !!p.channels[ch.id]; });
    return r;
  }
  function ruleText(r) {
    r = cleanRules(r);
    return '최근 ' + r.recentDays + '일을 직전 ' + r.baseDays + '일 기준선(' + (r.method === 'mad' ? '중앙값·MAD' : '평균·표준편차') + ')과 비교, ' +
      '±' + r.k + 'σ 를 가동일 ' + r.persist + '일 연속 넘으면 점검 필요 · ±' + r.kWarn + 'σ 를 ' + r.persist + '일 연속 또는 ±' + r.k + 'σ 를 ' + r.spikes + '일 넘으면 주의';
  }

  /* ── 9. 금형 수명 · 교체 예정일 ──────────────────────────────
     사용 타수 = 기준표의 「시작 시점 사용 타수」 + 사용 시작일(교체일)부터 로그에서 센 타수
     일평균 = 기준일까지 최근 avgDays 일(쉬는 날 포함) 동안 그 금형 타수 ÷ avgDays */
  function windowSum(rows, filter, asOf, days) {
    var from = addDays(asOf, -days + 1), s = 0;
    rows.forEach(function (r) { if (r.s != null && r.date >= from && r.date <= asOf && filter(r)) s += r.s; });
    return s;
  }
  function levelFrom(ratio, daysLeft, R) {
    if (ratio == null) return 'none';
    if (ratio >= 1) return 'bad';
    if (ratio >= R.warnPct || (daysLeft != null && daysLeft <= R.alertDays)) return 'warn';
    return 'ok';
  }
  function dieStatus(rows, dies, opts) {
    opts = opts || {};
    var R = cleanRules(opts.rules), asOf = opts.asOf || dataRange(rows).last;
    var ids = uniq(Object.keys(dies || {}).concat(rows.map(function (r) { return r.die; }))).sort(natCmp);
    return ids.map(function (id) {
      var d = cleanDie((dies || {})[id], id);
      var mine = rows.filter(function (r) { return r.die === id; });
      var counted = mine.filter(function (r) { return r.s != null && (!d.startDate || r.date >= d.startDate) && r.date <= asOf; });
      var logged = counted.reduce(function (s, r) { return s + r.s; }, 0);
      var used = (d.baseStrokes || 0) + logged;
      var avg = windowSum(mine, function () { return true; }, asOf, R.avgDays) / R.avgDays;
      var lastRow = mine.filter(function (r) { return r.date <= asOf; }).slice(-1)[0];
      var cums = mine.filter(function (r) { return r.dieCum != null; });
      var o = { id: id, presses: uniq(mine.map(function (r) { return r.press; })).sort(natCmp), life: d.life, startDate: d.startDate, baseStrokes: d.baseStrokes,
        logged: logged, used: used, ratio: null, remain: null, avgPerDay: round(avg, 1), daysLeft: null, dueDate: '', level: 'none', reason: '',
        lastDate: lastRow ? lastRow.date : '', lastDieCum: cums.length ? cums[cums.length - 1].dieCum : null };
      if (!d.life) { o.reason = '수명 기준 타수가 없음 — 설정에서 넣어 주세요'; return o; }
      o.ratio = used / d.life; o.remain = d.life - used;
      if (o.remain <= 0) { o.daysLeft = 0; o.dueDate = asOf; }
      else if (avg > 0) { o.daysLeft = Math.ceil(o.remain / avg); o.dueDate = addDays(asOf, o.daysLeft); }
      o.level = levelFrom(o.ratio, o.daysLeft, R);
      o.reason = o.level === 'bad' ? '수명 기준 ' + fmtN(d.life) + '타 도달(사용 ' + fmtN(used) + '타, ' + pctText(o.ratio) + ') — 교체·정비 필요'
        : o.level === 'warn' ? '수명 사용률 ' + pctText(o.ratio) + ', 남은 ' + fmtN(o.remain) + '타' + (o.dueDate ? ' — 교체 예정 ' + o.dueDate + '(약 ' + o.daysLeft + '일 뒤)' : '')
        : '수명 사용률 ' + pctText(o.ratio) + (o.dueDate ? ', 교체 예정 ' + o.dueDate : avg > 0 ? '' : ', 최근 ' + R.avgDays + '일 사용 없음');
      return o;
    });
  }

  /* ── 10. 오버홀 ──────────────────────────────────────────────
     주기는 타수 · 일수 가운데 하나 또는 둘 다. 둘 다 있으면 먼저 닿는 쪽. 기준 = 마지막 오버홀 일자. */
  function overhaulStatus(rows, presses, opts) {
    opts = opts || {};
    var R = cleanRules(opts.rules), asOf = opts.asOf || dataRange(rows).last;
    var ids = uniq(Object.keys(presses || {}).concat(rows.map(function (r) { return r.press; }))).sort(natCmp);
    return ids.map(function (id) {
      var p = cleanPress((presses || {})[id], id);
      var mine = rows.filter(function (r) { return r.press === id; });
      var since = (p.ohBase || 0) + mine.filter(function (r) { return r.s != null && (!p.lastOH || r.date > p.lastOH) && r.date <= asOf; }).reduce(function (s, r) { return s + r.s; }, 0);
      var avg = windowSum(mine, function () { return true; }, asOf, R.avgDays) / R.avgDays;
      var o = { id: id, type: p.type, lastOH: p.lastOH, ohStrokes: p.ohStrokes, ohDays: p.ohDays, strokesSince: since, daysSince: p.lastOH ? daysBetween(p.lastOH, asOf) : null,
        ratioStrokes: null, ratioDays: null, ratio: null, dueByStrokes: '', dueByDays: '', dueDate: '', daysLeft: null, avgPerDay: round(avg, 1), level: 'none', reason: '', basis: '' };
      if (!p.ohStrokes && !p.ohDays) { o.reason = '오버홀 주기가 없음 — 설정에서 타수 또는 일수를 넣어 주세요'; return o; }
      if (p.ohDays && !p.lastOH && !p.ohStrokes) { o.reason = '마지막 오버홀 일자가 없어 일수 주기를 셀 수 없음'; return o; }
      var cands = [];
      if (p.ohStrokes) {
        o.ratioStrokes = since / p.ohStrokes;
        var rem = p.ohStrokes - since;
        o.dueByStrokes = rem <= 0 ? asOf : avg > 0 ? addDays(asOf, Math.ceil(rem / avg)) : '';
        cands.push({ ratio: o.ratioStrokes, due: o.dueByStrokes, basis: '타수' });
      }
      if (p.ohDays && p.lastOH) {
        o.ratioDays = o.daysSince / p.ohDays;
        o.dueByDays = addDays(p.lastOH, p.ohDays);
        cands.push({ ratio: o.ratioDays, due: o.dueByDays, basis: '일수' });
      }
      cands.sort(function (a, b) { return b.ratio - a.ratio; });
      o.ratio = cands[0].ratio; o.basis = cands[0].basis;
      var dues = cands.map(function (c) { return c.due; }).filter(Boolean).sort();
      o.dueDate = dues[0] || '';
      o.daysLeft = o.dueDate ? Math.max(0, daysBetween(asOf, o.dueDate)) : null;
      o.level = levelFrom(o.ratio, o.daysLeft, R);
      var parts = [];
      if (p.ohStrokes) parts.push('타수 ' + fmtN(since) + ' / ' + fmtN(p.ohStrokes) + '(' + pctText(o.ratioStrokes) + ')');
      if (o.ratioDays != null) parts.push('경과 ' + o.daysSince + '일 / ' + p.ohDays + '일(' + pctText(o.ratioDays) + ')');
      o.reason = (o.level === 'bad' ? '오버홀 주기 지남 — ' : o.level === 'warn' ? '오버홀 주기 임박 — ' : '') + parts.join(', ') +
        (o.dueDate ? (o.level === 'bad' ? ' · 예정일 ' + o.dueDate + ' 지남' : ' · 예정 ' + o.dueDate) : '');
      if (o.level === 'bad' && o.dueDate && o.dueDate < asOf) o.overdueDays = daysBetween(o.dueDate, asOf);
      return o;
    });
  }

  /* ── 11. 이상 감지 (통계 기준) ───────────────────────────────
     프레스·채널마다 하루 평균값으로 봅니다.
       기준선 = 최근 구간(recentDays) 바로 앞 baseDays 일의 가동일 값 → 중앙값과 1.4826×MAD (또는 평균·표준편차)
       최근 구간의 날마다 z = (값 − 기준선) ÷ σ
       ±k 를 persist 일 연속(같은 방향) 넘으면 「점검 필요」, ±kWarn 을 persist 일 연속 넘거나 ±k 를 spikes 일 넘으면 「주의」
     σ 가 너무 작으면(값이 거의 같음) 기준선의 0.5% 를 바닥으로 씁니다 — 소수점 반올림만으로 경고가 나지 않게. */
  var SIGMA_FLOOR = 0.005;
  function median(a) {
    var s = a.filter(function (x) { return x != null && isFinite(x); }).sort(function (x, y) { return x - y; });
    if (!s.length) return null;
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
  function stdev(a) {
    if (a.length < 2) return 0;
    var m = mean(a); return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  }
  function baseline(values, method) {
    var v = values.filter(function (x) { return x != null && isFinite(x); });
    if (!v.length) return null;
    var center, sigma;
    if (method === 'sigma') { center = mean(v); sigma = stdev(v); }
    else { center = median(v); sigma = 1.4826 * median(v.map(function (x) { return Math.abs(x - center); })); }
    var floor = Math.max(Math.abs(center) * SIGMA_FLOOR, 1e-6);
    return { center: center, sigma: Math.max(sigma, floor), rawSigma: sigma, floored: sigma < floor, n: v.length };
  }
  function slope(points) {
    if (points.length < 2) return null;
    var xs = points.map(function (p) { return p.x; }), ys = points.map(function (p) { return p.y; });
    var mx = mean(xs), my = mean(ys), num = 0, den = 0;
    for (var i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); }
    return den ? num / den : null;
  }
  /* dailyRows: daily() 결과 가운데 한 프레스 · channel: 'current' 등 */
  function detectSensor(dailyRows, channel, opts) {
    opts = opts || {};
    var R = cleanRules(opts.rules), ch = CHANNEL_BY_ID[channel];
    var asOf = opts.asOf || (dailyRows.length ? dailyRows[dailyRows.length - 1].date : '');
    var press = dailyRows.length ? dailyRows[0].press : opts.press || '';
    var out = { press: press, channel: channel, label: ch.label, unit: ch.unit, level: 'nodata', asOf: asOf, base: null, recent: null, points: [], runK: 0, runWarn: 0, outDays: 0, direction: '', outFrom: '', outTo: '', evidence: '' };
    var recentFrom = addDays(asOf, -R.recentDays + 1), baseTo = addDays(recentFrom, -1), baseFrom = addDays(baseTo, -R.baseDays + 1);
    var pts = dailyRows.filter(function (d) { return d[channel] != null && d.date >= baseFrom && d.date <= asOf; })
      .map(function (d) { return { date: d.date, v: d[channel], zone: d.date >= recentFrom ? 'recent' : 'base' }; });
    var basePts = pts.filter(function (p) { return p.zone === 'base'; }), recPts = pts.filter(function (p) { return p.zone === 'recent'; });
    out.points = pts;
    out.recent = { from: recentFrom, to: asOf, n: recPts.length, median: median(recPts.map(function (p) { return p.v; })) };
    out.baseRange = { from: baseFrom, to: baseTo };
    if (!recPts.length) { out.level = 'nodata'; out.evidence = '최근 ' + R.recentDays + '일 ' + ch.label + ' 값 없음'; return out; }
    if (basePts.length < R.minBase) {
      out.level = 'nobase';
      out.evidence = '기준선 구간(' + baseFrom + ' ~ ' + baseTo + ')의 가동일이 ' + basePts.length + '일뿐이라 비교하지 않음(필요 ' + R.minBase + '일)';
      return out;
    }
    var b = baseline(basePts.map(function (p) { return p.v; }), R.method);
    out.base = { from: baseFrom, to: baseTo, n: b.n, center: round(b.center, 3), sigma: round(b.sigma, 4), floored: b.floored,
      upper: round(b.center + R.k * b.sigma, 3), lower: round(b.center - R.k * b.sigma, 3),
      upperWarn: round(b.center + R.kWarn * b.sigma, 3), lowerWarn: round(b.center - R.kWarn * b.sigma, 3) };
    pts.forEach(function (p) { p.z = round((p.v - b.center) / b.sigma, 2); });
    // 최근 구간 — 같은 방향으로 이어서 넘은 가장 긴 줄
    function longest(th) {
      var best = { n: 0, dir: '', from: '', to: '' }, cur = { n: 0, dir: '' };
      recPts.forEach(function (p) {
        var dir = p.z >= th ? 'up' : p.z <= -th ? 'down' : '';
        if (dir && dir === cur.dir) { cur.n++; cur.to = p.date; }
        else if (dir) cur = { n: 1, dir: dir, from: p.date, to: p.date };
        else cur = { n: 0, dir: '' };
        if (cur.n > best.n) best = { n: cur.n, dir: cur.dir, from: cur.from, to: cur.to };
      });
      return best;
    }
    var lk = longest(R.k), lw = longest(R.kWarn);
    out.runK = lk.n; out.runWarn = lw.n;
    out.outDays = recPts.filter(function (p) { return Math.abs(p.z) >= R.k; }).length;
    var warnDays = recPts.filter(function (p) { return Math.abs(p.z) >= R.kWarn; }).length;
    var sl = slope(recPts.map(function (p) { return { x: daysBetween(recentFrom, p.date), y: p.v }; }));
    out.recent.slopePerDay = sl == null ? null : round(sl, 4);
    out.recent.maxZ = round(recPts.reduce(function (m, p) { return Math.abs(p.z) > Math.abs(m) ? p.z : m; }, 0), 2);
    var pick = lk.n >= R.persist ? lk : lw.n >= R.persist ? lw : lk.n ? lk : lw;
    out.direction = pick.dir; out.outFrom = pick.from || ''; out.outTo = pick.to || '';
    out.level = lk.n >= R.persist ? 'bad' : (lw.n >= R.persist || out.outDays >= R.spikes) ? 'warn' : 'ok';
    var u = ch.unit, md2 = out.recent.median, diff = md2 - b.center;
    out.evidence = '최근 ' + R.recentDays + '일 중앙값 ' + fmtN(md2, 2) + u + ' — 기준선 ' + fmtN(b.center, 2) + u + ' 대비 ' + signed(diff, 2) + u +
      ' (' + signed(b.center ? diff / Math.abs(b.center) * 100 : null, 1) + '%)' +
      ' · 관리한계 ' + fmtN(out.base.lower, 2) + '~' + fmtN(out.base.upper, 2) + u + '(±' + R.k + 'σ)' +
      (out.level === 'ok' ? (out.outDays ? ' · ±' + R.k + 'σ 밖 ' + out.outDays + '일(판정 기준 미달)' : ' · 한계 밖 없음') :
        ' · ' + (pick === lk ? '±' + R.k + 'σ' : '±' + R.kWarn + 'σ') + ' 밖 가동일 ' + pick.n + '일 연속(' + md(pick.from) + '~' + md(pick.to) + ', ' + (pick.dir === 'up' ? '높음' : '낮음') + ')' +
        ' · 최근 구간 ±' + R.k + 'σ 밖 ' + out.outDays + '일, ±' + R.kWarn + 'σ 밖 ' + warnDays + '일') +
      (sl != null && Math.abs(sl) * R.recentDays >= b.sigma ? ' · 추세 하루 ' + signed(sl, 3) + u : '');
    return out;
  }
  /* 모든 프레스 × 켜 둔 채널 */
  function detectAll(rows, opts) {
    opts = opts || {};
    var R = cleanRules(opts.rules), asOf = opts.asOf || dataRange(rows).last;
    var days = daily(rows), byPress = {};
    days.forEach(function (d) { (byPress[d.press] = byPress[d.press] || []).push(d); });
    var out = [];
    Object.keys(byPress).sort(natCmp).forEach(function (p) {
      var list = byPress[p].filter(function (d) { return d.date <= asOf; });
      CHANNELS.forEach(function (ch) {
        if (!R.channels[ch.id]) return;
        if (!list.some(function (d) { return d[ch.id] != null; })) return;
        out.push(detectSensor(list, ch.id, { rules: R, asOf: asOf, press: p }));
      });
    });
    return out;
  }

  /* ── 12. 프레스별 종합 상태 ─────────────────────────────────
     이상 감지 · 오버홀 · 최근 그 프레스에서 쓴 금형의 수명 가운데 가장 나쁜 것을 따릅니다. */
  function worst(levels) {
    var w = 'ok', seen = false;
    levels.forEach(function (l) { if (RANK[l] > 0) { seen = true; if (RANK[l] > RANK[w]) w = l; } });
    return seen ? w : 'none';
  }
  /* 카드용 짧은 근거 — 평소 → 최근, 연속 일수 */
  function sensorShort(a, R) {
    var u = a.unit, c = a.base.center, m = a.recent.median;
    return a.label + ' ' + (a.direction === 'down' ? '낮음' : '높음') + ' — 평소 ' + fmtN(c, 1) + u + ' → 최근 ' + fmtN(m, 1) + u + ' (' + signed(c ? (m - c) / Math.abs(c) * 100 : null, 1) + '%)' +
      (a.level === 'bad' ? ', 관리한계 밖 가동일 ' + a.runK + '일 연속' : a.runWarn >= R.persist ? ', 주의 한계 밖 ' + a.runWarn + '일 연속' : ', 관리한계 밖 ' + a.outDays + '일');
  }
  function pressStatus(ctx) {
    var R = cleanRules(ctx.rules), asOf = ctx.asOf;
    var recentFrom = addDays(asOf, -R.recentDays + 1);
    var dieById = {}; (ctx.dies || []).forEach(function (d) { dieById[d.id] = d; });
    var ids = uniq((ctx.overhauls || []).map(function (o) { return o.id; }).concat((ctx.anomalies || []).map(function (a) { return a.press; }))).sort(natCmp);
    return ids.map(function (id) {
      var reasons = [];
      var oh = (ctx.overhauls || []).filter(function (o) { return o.id === id; })[0];
      var an = (ctx.anomalies || []).filter(function (a) { return a.press === id; });
      var mine = (ctx.rows || []).filter(function (r) { return r.press === id && r.date <= asOf; });
      var recentDies = uniq(mine.filter(function (r) { return r.date >= recentFrom; }).map(function (r) { return r.die; })).sort(natCmp);
      var levels = [];
      an.forEach(function (a) { if (RANK[a.level] > 0) levels.push(a.level); if (a.level === 'bad' || a.level === 'warn') reasons.push({ level: a.level, kind: 'sensor', text: a.label + ' ' + (a.direction === 'down' ? '낮음' : '높음') + ' — ' + a.evidence, short: sensorShort(a, R) }); });
      if (oh) { levels.push(oh.level); if (oh.level === 'bad' || oh.level === 'warn') reasons.push({ level: oh.level, kind: 'overhaul', text: oh.reason, short: oh.reason }); }
      recentDies.forEach(function (d) { var x = dieById[d]; if (x) { levels.push(x.level); if (x.level === 'bad' || x.level === 'warn') reasons.push({ level: x.level, kind: 'die', text: '금형 ' + d + ' — ' + x.reason, short: '금형 ' + d + ' — ' + x.reason }); } });
      reasons.sort(function (a, b) { return RANK[b.level] - RANK[a.level]; });
      var last = mine.slice(-1)[0];
      var lastDays = daily(mine).slice(-1)[0];
      var stroke7 = windowSum(mine, function () { return true; }, asOf, 7);
      return { id: id, type: oh ? oh.type : '', level: worst(levels), reasons: reasons, dies: recentDies, lastDate: last ? last.date : '', lastDay: lastDays || null,
        strokes7: stroke7, sensors: an, overhaul: oh || null };
    });
  }

  /* ── 13. 월별 · 프레스 종류별 타수 ───────────────────────── */
  function monthsOf(rows) { return uniq(rows.map(function (r) { return monthOf(r.date); })).sort(); }
  function monthlyByType(rows, presses) {
    var months = monthsOf(rows), cells = {}, types = [];
    rows.forEach(function (r) {
      var t = pressTypeOf(presses, r.press, r.pressType), m = monthOf(r.date);
      if (types.indexOf(t) < 0) types.push(t);
      var c = (cells[t] = cells[t] || {})[m] || (cells[t][m] = { strokes: 0, runHr: 0, days: {}, presses: {} });
      if (r.s != null) c.strokes += r.s;
      if (r.runHr != null) c.runHr += r.runHr;
      c.days[r.press + '|' + r.date] = 1; c.presses[r.press] = 1;
    });
    types.sort(natCmp);
    var out = types.map(function (t) {
      return { type: t, months: months.map(function (m) {
        var c = cells[t][m]; if (!c) return { month: m, strokes: 0, runHr: 0, pressDays: 0, presses: 0 };
        return { month: m, strokes: c.strokes, runHr: round(c.runHr, 1), pressDays: Object.keys(c.days).length, presses: Object.keys(c.presses).length };
      }) };
    });
    var total = months.map(function (m, i) { return out.reduce(function (s, t) { return s + t.months[i].strokes; }, 0); });
    return { months: months, types: out, total: total };
  }
  function monthDetail(rows, presses, month) {
    var list = rows.filter(function (r) { return monthOf(r.date) === month; });
    function group(keyFn, extra) {
      var m = {};
      list.forEach(function (r) {
        var k = keyFn(r); if (!k) return;
        var g = m[k] || (m[k] = { key: k, strokes: 0, runHr: 0, days: {}, rows: 0, uncounted: 0, extra: extra ? extra(r) : null, presses: {} });
        if (r.s != null) g.strokes += r.s; else g.uncounted++;
        if (r.runHr != null) g.runHr += r.runHr;
        g.days[r.date] = 1; g.rows++; g.presses[r.press] = 1;
      });
      return Object.keys(m).sort(natCmp).map(function (k) {
        var g = m[k], days = Object.keys(g.days).length;
        return { key: k, strokes: g.strokes, runHr: round(g.runHr, 1), days: days, perDay: days ? round(g.strokes / days, 0) : null,
          perHr: g.runHr > 0 ? round(g.strokes / g.runHr, 1) : null, uncounted: g.uncounted, extra: g.extra, presses: Object.keys(g.presses).sort(natCmp) };
      });
    }
    var byType = group(function (r) { return pressTypeOf(presses, r.press, r.pressType); });
    var byPress = group(function (r) { return r.press; }, function (r) { return pressTypeOf(presses, r.press, r.pressType); });
    var byDie = group(function (r) { return r.die; });
    var total = list.reduce(function (s, r) { return s + (r.s || 0); }, 0);
    return { month: month, byType: byType, byPress: byPress, byDie: byDie, total: total, rows: list.length };
  }
  function monthlyToAoa(mb) {
    var aoa = [['프레스 종류'].concat(mb.months.map(monthLabel)).concat(['합계'])];
    mb.types.forEach(function (t) { var s = 0; aoa.push([t.type].concat(t.months.map(function (c) { s += c.strokes; return c.strokes; })).concat([s])); });
    aoa.push(['합계'].concat(mb.total).concat([mb.total.reduce(function (a, b) { return a + b; }, 0)]));
    return aoa;
  }
  function monthDetailToAoa(det) {
    var a = [[monthLabel(det.month) + ' 프레스 종류별 타수'], ['프레스 종류', '타수', '가동 시간(h)', '프레스·가동일', '프레스']];
    det.byType.forEach(function (g) { a.push([g.key, g.strokes, g.runHr, g.days, g.presses.join(', ')]); });
    a.push(['합계', det.total]);
    a.push([]);
    a.push(['프레스별']);
    a.push(['프레스', '프레스 종류', '타수', '가동일', '일평균 타수', '가동 시간(h)', '시간당 타수', '타수를 못 센 행']);
    det.byPress.forEach(function (g) { a.push([g.key, g.extra, g.strokes, g.days, g.perDay, g.runHr, g.perHr, g.uncounted]); });
    a.push([]);
    a.push(['금형별']);
    a.push(['금형', '쓴 프레스', '타수', '사용일', '일평균 타수']);
    det.byDie.forEach(function (g) { a.push([g.key, g.presses.join(', '), g.strokes, g.days, g.perDay]); });
    return a;
  }

  /* ── 14. AI 프롬프트 — 계산된 사실만, 이름은 별칭으로 ────────
     프레스 이름 → 「설비1」, 금형명 → 「금형1」. 대응표는 이 브라우저에만 있고 답을 붙여 넣으면 되돌립니다. */
  var ALIAS = { press: '설비', die: '금형' };
  function assignAliases(map, names, prefix) {
    var out = {}, used = 0, re = new RegExp('^' + prefix + '(\\d+)$');
    Object.keys(map || {}).forEach(function (n) { var m = re.exec(map[n]); if (m) { out[n] = map[n]; used = Math.max(used, +m[1]); } });
    uniq((names || []).map(str)).sort(natCmp).forEach(function (n) { if (!out[n]) out[n] = prefix + (++used); });
    return out;
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'); }
  function nameRegex(names) {
    var list = names.filter(Boolean).slice().sort(function (a, b) { return b.length - a.length; }).map(escRe);
    if (!list.length) return null;
    return new RegExp('(^|[^0-9A-Za-z가-힣])(' + list.join('|') + ')(?![0-9A-Za-z가-힣])', 'g');
  }
  /* 안전망 — 프롬프트에 남은 실제 이름 */
  function findLeaks(text, names) {
    var s = String(text || '');
    return uniq((names || []).filter(function (n) { var re = nameRegex([n]); return re && re.test(s); }));
  }
  /* AI 답 → 실제 이름. 「설비3」만 바꾸고 「설비 3대」「금형2개」처럼 수를 세는 말은 그대로 둡니다 */
  function unmaskText(text, aliases) {
    var back = {};
    ['press', 'die'].forEach(function (k) { var m = (aliases || {})[k] || {}; Object.keys(m).forEach(function (n) { back[m[n]] = n; }); });
    return String(text == null ? '' : text).replace(/(설비|금형)(\d+)(?![0-9개건대종가일회번차월년타])/g, function (all) { return back[all] || all; });
  }
  function buildAiPromptInfo(ctx) {
    var R = cleanRules(ctx.rules), al = ctx.aliases || null, used = { press: {}, die: {} };
    function P(n) { if (!al || !al.press[n]) return n; used.press[n] = al.press[n]; return al.press[n]; }
    function D(n) { if (!al || !al.die[n]) return n; used.die[n] = al.die[n]; return al.die[n]; }
    var L = [];
    L.push('너는 프레스 설비 보전 담당자를 돕는 보조야. 아래 [사실]은 프레스 로그(타수·가동 시간·전류·전압·온도·진동)에서 도구가 계산한 값이야.');
    L.push('[사실]에 있는 숫자만 근거로 삼아 정리해줘. 숫자를 새로 만들거나 바꾸지 말아줘.');
    L.push('이상 감지는 통계 기준(평소 값 대비 벗어남)일 뿐 고장 기록과 맞춰 본 것이 아니야. 원인은 반드시 「추정」이라고 표시하고, 확실하지 않은 것은 「확인 필요」라고 적어줘.');
    if (al) L.push('프레스와 금형 이름은 보안상 「설비1」 「금형1」 같은 별칭으로 바꿔 두었어. 답에서도 별칭을 띄어 쓰지 말고 그대로 써줘.');
    L.push('');
    L.push('[사실]');
    L.push('- 기준일(로그 마지막 날): ' + ctx.asOf + ' · 로그 기간 ' + ctx.range.first + ' ~ ' + ctx.range.last);
    L.push('- 판정 기준: ' + ruleText(R) + ' · 수명·오버홀은 ' + Math.round(R.warnPct * 100) + '% 또는 예정일 ' + R.alertDays + '일 안이면 주의, 100% 면 점검 필요 · 예정일은 최근 ' + R.avgDays + '일 일평균 타수로 추정');
    L.push('- 프레스별 상태:');
    (ctx.statuses || []).forEach(function (s) {
      L.push('  · ' + P(s.id) + (s.type ? '(' + s.type + ')' : '') + ': ' + LEVELS[s.level] + ' — 최근 7일 타수 ' + fmtN(s.strokes7) + (s.dies.length ? ', 최근 쓴 금형 ' + s.dies.map(D).join('·') : ''));
      s.reasons.forEach(function (r) {
        var t = r.text;
        if (al) { t = t.replace(/금형 (\S+) — /, function (all, d) { return '금형 ' + D(d) + ' — '; }); }
        L.push('      [' + LEVELS[r.level] + '] ' + t);
      });
    });
    var bad = (ctx.anomalies || []).filter(function (a) { return a.level === 'bad' || a.level === 'warn'; });
    L.push('- 이상 감지 ' + bad.length + '건 (채널별):');
    bad.forEach(function (a) {
      L.push('  · ' + P(a.press) + ' ' + a.label + ' [' + LEVELS[a.level] + ']: ' + a.evidence +
        (a.recent.slopePerDay != null ? ' · 최근 구간 기울기 하루 ' + signed(a.recent.slopePerDay, 3) + a.unit : ''));
    });
    if (!bad.length) L.push('  (기준을 넘은 채널 없음)');
    var nob = (ctx.anomalies || []).filter(function (a) { return a.level === 'nobase'; });
    if (nob.length) L.push('- 기준선이 짧아 비교 못 한 채널: ' + nob.map(function (a) { return P(a.press) + ' ' + a.label; }).join(', '));
    L.push('- 금형 수명 (사용률 높은 순):');
    (ctx.dies || []).filter(function (d) { return d.life; }).slice().sort(function (a, b) { return b.ratio - a.ratio; }).forEach(function (d) {
      L.push('  · ' + D(d.id) + ' [' + LEVELS[d.level] + ']: 사용 ' + fmtN(d.used) + ' / 기준 ' + fmtN(d.life) + '타(' + pctText(d.ratio) + '), 일평균 ' + fmtN(d.avgPerDay) + '타' +
        (d.dueDate ? ', 교체 예정 ' + d.dueDate : '') + (d.presses.length ? ', 쓴 프레스 ' + d.presses.map(P).join('·') : ''));
    });
    var noLife = (ctx.dies || []).filter(function (d) { return !d.life; });
    if (noLife.length) L.push('  · 수명 기준이 없는 금형 ' + noLife.length + '개: ' + noLife.map(function (d) { return D(d.id); }).join(', '));
    L.push('- 오버홀:');
    (ctx.overhauls || []).forEach(function (o) {
      L.push('  · ' + P(o.id) + ' [' + LEVELS[o.level] + ']: ' + (o.level === 'none' ? o.reason : o.reason + (o.lastOH ? ' (마지막 오버홀 ' + o.lastOH + ')' : '')));
    });
    if (ctx.month) {
      L.push('- ' + monthLabel(ctx.month.month) + ' 타수: 합계 ' + fmtN(ctx.month.total) + ' — ' + ctx.month.byType.map(function (g) { return g.key + ' ' + fmtN(g.strokes); }).join(', '));
    }
    L.push('');
    L.push('[요청] 다음 순서로 한국어로 짧게 정리해줘.');
    L.push('1. 오늘 기준 한 줄 요약');
    L.push('2. 프레스별로 먼저 확인할 것 (점검 필요 → 주의 순서, 근거 숫자를 그대로 인용)');
    L.push('3. 전류·온도가 함께 오르는 경우처럼 채널을 묶어 볼 때 의심할 수 있는 점검 항목 (「추정」 표시, 2~3개씩)');
    L.push('4. 다음 2주 정비 일정 제안 (금형 교체·오버홀 예정일 기준, 생산 영향이 적은 순서)');
    L.push('5. 예지 정확도를 높이려면 더 모아야 할 기록 (고장·교체 이력 등)');
    var text = L.join('\n');
    var names = al ? Object.keys(al.press).concat(Object.keys(al.die)) : [];
    return { prompt: text, map: used, leaks: al ? findLeaks(text, names) : [] };
  }

  /* ── 15. 저장 형식 ─────────────────────────────────────────── */
  function emptyDb() {
    return { schemaVersion: SCHEMA_VERSION, records: [], files: [], presses: {}, dies: {}, rules: cleanRules({}), aiNotes: {}, aliases: { press: {}, die: {} }, maskNames: true, sample: false, spc: {}, rawFiles: [] };
  }
  function restoreDb(o) {
    var db = emptyDb();
    if (!o || typeof o !== 'object') return db;
    if (Array.isArray(o.records)) db.records = sortRecords(o.records.filter(function (r) { return r && r.date && r.press; }));
    if (Array.isArray(o.files)) db.files = o.files;
    if (o.presses && typeof o.presses === 'object') Object.keys(o.presses).forEach(function (k) { db.presses[k] = cleanPress(o.presses[k], k); });
    if (o.dies && typeof o.dies === 'object') Object.keys(o.dies).forEach(function (k) { db.dies[k] = cleanDie(o.dies[k], k); });
    db.rules = cleanRules(o.rules || {});
    if (o.aiNotes && typeof o.aiNotes === 'object') db.aiNotes = o.aiNotes;
    if (o.aliases && typeof o.aliases === 'object') {
      db.aliases.press = assignAliases(o.aliases.press, [], ALIAS.press);
      db.aliases.die = assignAliases(o.aliases.die, [], ALIAS.die);
    }
    if (o.maskNames === false) db.maskNames = false;
    db.sample = !!o.sample;
    if (o.spc && typeof o.spc === 'object') db.spc = o.spc;
    if (Array.isArray(o.rawFiles)) db.rawFiles = o.rawFiles;
    if (o.sampleKind === 'raw') db.sampleKind = 'raw';
    return db;
  }

  /* 화면·보고서가 같은 계산을 쓰도록 한 번에 */
  function analyze(db) {
    var R = cleanRules(db.rules);
    var d = deriveStrokes(db.records);
    var range = dataRange(db.records), asOf = range.last;
    var dies = dieStatus(d.rows, db.dies, { rules: R, asOf: asOf });
    var overhauls = overhaulStatus(d.rows, db.presses, { rules: R, asOf: asOf });
    var anomalies = detectAll(d.rows, { rules: R, asOf: asOf });
    var statuses = pressStatus({ rules: R, asOf: asOf, rows: d.rows, dies: dies, overhauls: overhauls, anomalies: anomalies });
    return { rules: R, rows: d.rows, strokeStat: d.stat, range: range, asOf: asOf, dies: dies, overhauls: overhauls, anomalies: anomalies, statuses: statuses };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION, FIELDS: FIELDS, CHANNELS: CHANNELS, LEVELS: LEVELS, RANK: RANK, DEFAULT_RULES: DEFAULT_RULES, ALIAS: ALIAS, SIGMA_FLOOR: SIGMA_FLOOR,
    norm: norm, splitHeader: splitHeader, matchField: matchField, toNum: toNum, toDateTime: toDateTime, toISO: toISO, toTime: toTime,
    addDays: addDays, daysBetween: daysBetween, monthOf: monthOf, monthLabel: monthLabel, md: md, colName: colName, round: round, natCmp: natCmp,
    fmtN: fmtN, signed: signed, pctText: pctText, decodeCsv: decodeCsv,
    detectColumns: detectColumns, headerSignature: headerSignature, parseRows: parseRows, parseSheet: parseSheet, pickSheet: pickSheet,
    recKey: recKey, mergeRecords: mergeRecords, sortRecords: sortRecords, dataRange: dataRange, deriveStrokes: deriveStrokes, daily: daily,
    emptyPress: emptyPress, emptyDie: emptyDie, syncMaster: syncMaster, masterToAoa: masterToAoa, masterFromAoa: masterFromAoa, MASTER_PRESS_HEAD: MASTER_PRESS_HEAD, MASTER_DIE_HEAD: MASTER_DIE_HEAD, cleanPress: cleanPress, cleanDie: cleanDie, pressTypeOf: pressTypeOf,
    cleanRules: cleanRules, ruleText: ruleText, dieStatus: dieStatus, overhaulStatus: overhaulStatus,
    median: median, baseline: baseline, slope: slope, detectSensor: detectSensor, detectAll: detectAll, worst: worst, pressStatus: pressStatus,
    monthsOf: monthsOf, monthlyByType: monthlyByType, monthDetail: monthDetail, monthlyToAoa: monthlyToAoa, monthDetailToAoa: monthDetailToAoa,
    assignAliases: assignAliases, findLeaks: findLeaks, unmaskText: unmaskText, buildAiPromptInfo: buildAiPromptInfo,
    emptyDb: emptyDb, restoreDb: restoreDb, analyze: analyze
  };
});
