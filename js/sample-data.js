/* 가상 샘플 — 프레스 4대 × 90일 일일 로그 (전부 지어낸 값, 고정 씨앗 난수라 늘 같은 값)
   · 프레스 P1~P4, 금형 M-01~M-08(프레스마다 2개를 주마다 번갈아 씀), 일요일은 쉼·토요일은 반나절.
   · 열 이름은 수강생이 「올릴 수 있는 샘플」로 적은 칸 그대로: 일자 · 프레스 · 프레스 종류 · 금형명 · 프레스 누적 타수 · 금형 타수 ·
     가동 시간 · 전류 · 전압 · 온도 (+ 보유 데이터의 진동). 「금형 타수」 = 그 날 그 금형으로 친 횟수.
   · 일부러 심어 둔 것 세 가지 — 대시보드에서 바로 보이게:
       ① 금형 M-05(P3) — 수명 기준 120,000타의 약 95% 사용, 교체 예정일이 2주 안 → 「주의」
       ② 프레스 P2 — 마지막 2주 동안 전류(+약 12%)·온도(+약 7℃)가 함께 서서히 오름 → 「점검 필요」
       ③ 프레스 P4 — 오버홀 주기 180일을 넘김(마지막 오버홀 2026-03-27) → 「점검 필요」
   · 파일은 달마다 하나: 7·8·9월은 엑셀(.xlsx), 10월은 CSV — 여러 파일·두 형식 가져오기를 함께 시험합니다.
   브라우저에서는 window.PressSample, node 에서는 require('./sample-data.js'). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PressSample = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var START = '2026-07-21', DAYS = 90; // 2026-07-21 ~ 2026-10-18
  var HEAD = ['일자', '프레스', '프레스 종류', '금형명', '프레스 누적 타수', '금형 타수', '가동 시간(h)', '전류(A)', '전압(V)', '온도(℃)', '진동(mm/s)'];
  var TITLE = '■ 프레스 일일 로그 (가상 샘플 — 실제 설비 값 아님)';
  var PRESSES = [
    { id: 'P1', type: '유압 프레스 800톤', dies: ['M-01', 'M-02'], strokes: 620, cur: 85, temp: 44, vib: 2.1, cum0: 1854200 },
    { id: 'P2', type: '유압 프레스 800톤', dies: ['M-03', 'M-04'], strokes: 600, cur: 92, temp: 46, vib: 2.3, cum0: 2210450 },
    { id: 'P3', type: '기계식 프레스 400톤', dies: ['M-05', 'M-06'], strokes: 1100, cur: 58, temp: 41, vib: 3.1, cum0: 5120900 },
    { id: 'P4', type: '유압 프레스 1500톤', dies: ['M-07', 'M-08'], strokes: 380, cur: 138, temp: 49, vib: 1.8, cum0: 980300 }
  ];
  // 설비·금형 기준표(가상) — 앱의 「설정」에 들어갑니다
  var MASTER_PRESSES = {
    P1: { id: 'P1', type: '유압 프레스 800톤', ohStrokes: 400000, ohDays: 365, lastOH: '2026-01-12', ohBase: 95000, note: '' },
    P2: { id: 'P2', type: '유압 프레스 800톤', ohStrokes: 400000, ohDays: 365, lastOH: '2026-02-02', ohBase: 80000, note: '' },
    P3: { id: 'P3', type: '기계식 프레스 400톤', ohStrokes: 800000, ohDays: 365, lastOH: '2026-04-06', ohBase: 110000, note: '' },
    P4: { id: 'P4', type: '유압 프레스 1500톤', ohStrokes: 150000, ohDays: 180, lastOH: '2026-03-27', ohBase: 38000, note: '오버홀 주기 지남(샘플)' }
  };
  var DIE_LIFE = { 'M-01': 300000, 'M-02': 300000, 'M-03': 300000, 'M-04': 300000, 'M-05': 120000, 'M-06': 250000, 'M-07': 200000, 'M-08': 200000 };
  var DIE_START = { 'M-01': '2026-05-04', 'M-02': '2026-03-16', 'M-03': '2026-06-01', 'M-04': '2026-04-20', 'M-05': '2026-06-15', 'M-06': '2026-07-21', 'M-07': '2026-02-09', 'M-08': '2026-05-25' };
  var DIE_BASE = { 'M-01': 21000, 'M-02': 64000, 'M-03': 9000, 'M-04': 40000, 'M-05': 'near', 'M-06': 0, 'M-07': 52000, 'M-08': 18000 };
  var NEAR_RATIO = 0.95; // M-05 기준 사용률

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function addDays(iso, n) { var p = iso.split('-'); var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + n * 86400000); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function dow(iso) { var p = iso.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay(); }
  function r1(x, d) { var p = Math.pow(10, d); return Math.round(x * p) / p; }

  /* 일일 행 만들기 — 반환: [{date, press, type, die, pressCum, strokes, runHr, current, voltage, temp, vib}] */
  function makeRows() {
    var rnd = mulberry32(20261020);
    // 정규분포 근사(±2.2σ 로 자름 — 샘플의 정상 프레스에 우연한 경고가 섞이지 않게)
    function gauss() { var u = 0; for (var i = 0; i < 6; i++) u += rnd(); u = (u - 3) / Math.sqrt(0.5); return Math.max(-2.2, Math.min(2.2, u)); }
    var rows = [], end = addDays(START, DAYS - 1), rampFrom = addDays(end, -13);
    PRESSES.forEach(function (p) {
      var cum = p.cum0;
      for (var i = 0; i < DAYS; i++) {
        var date = addDays(START, i), wd = dow(date);
        if (wd === 0) continue; // 일요일 쉼
        var half = wd === 6;
        var week = Math.floor((i + 1) / 7); // 월요일마다 금형을 바꿈(07-21 은 화요일)
        var die = p.dies[week % 2];
        var strokes = Math.round(p.strokes * (half ? 0.5 : 1) * (1 + 0.05 * gauss()));
        var runHr = r1((half ? 8 : 16) * (1 + 0.02 * gauss()), 1);
        cum += strokes;
        var cur = p.cur * (1 + 0.012 * gauss()), temp = p.temp + 0.6 * gauss(), vib = p.vib * (1 + 0.04 * gauss()), volt = 380 * (1 + 0.005 * gauss());
        if (p.id === 'P2' && date >= rampFrom) { // ② 마지막 2주 전류·온도 상승
          var f = (i - (DAYS - 14) + 1) / 14;
          cur *= 1 + 0.12 * f; temp += 7 * f;
        }
        rows.push({ date: date, press: p.id, type: p.type, die: die, pressCum: cum, strokes: strokes, runHr: runHr,
          current: r1(cur, 1), voltage: r1(volt, 1), temp: r1(temp, 1), vib: r1(vib, 2) });
      }
    });
    return rows;
  }

  function master(rows) {
    var dies = {};
    Object.keys(DIE_LIFE).forEach(function (id) {
      var base = DIE_BASE[id];
      if (base === 'near') { // ① 로그 끝에서 사용률이 NEAR_RATIO 가 되도록 시작 시점 사용 타수를 맞춤
        var logged = rows.filter(function (r) { return r.die === id && r.date >= DIE_START[id]; }).reduce(function (s, r) { return s + r.strokes; }, 0);
        base = Math.round(DIE_LIFE[id] * NEAR_RATIO - logged);
      }
      dies[id] = { id: id, life: DIE_LIFE[id], startDate: DIE_START[id], baseStrokes: base, note: '' };
    });
    var presses = JSON.parse(JSON.stringify(MASTER_PRESSES));
    return { presses: presses, dies: dies };
  }

  function toAoa(rows) {
    return [[TITLE], HEAD].concat(rows.map(function (r) {
      return [r.date, r.press, r.type, r.die, r.pressCum, r.strokes, r.runHr, r.current, r.voltage, r.temp, r.vib];
    }));
  }
  function toCsv(aoa) {
    return aoa.slice(1).map(function (row) {
      return row.map(function (v) { var s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',');
    }).join('\r\n') + '\r\n';
  }

  /* 엑셀용 — 일자 칸('YYYY-MM-DD')을 엑셀 날짜 일련번호로 (실제 엑셀처럼 날짜 서식 칸) */
  function excelSerial(iso) { var p = iso.split('-'); return Math.round((Date.UTC(+p[0], +p[1] - 1, +p[2]) - Date.UTC(1899, 11, 30)) / 86400000); }
  function xlsxAoa(aoa) {
    return aoa.map(function (row, i) { return i < 2 ? row : row.map(function (v, c) { return c === 0 && /^\d{4}-\d\d-\d\d$/.test(v) ? excelSerial(v) : v; }); });
  }
  /* SheetJS 시트로 — 날짜 칸에 yyyy-mm-dd 서식 */
  function toSheet(XLSX, aoa) {
    var ws = XLSX.utils.aoa_to_sheet(xlsxAoa(aoa));
    var range = XLSX.utils.decode_range(ws['!ref']);
    for (var r = 2; r <= range.e.r; r++) { var c = ws[XLSX.utils.encode_cell({ r: r, c: 0 })]; if (c && c.t === 'n') c.z = 'yyyy-mm-dd'; }
    ws['!cols'] = [{ wch: 11 }, { wch: 7 }, { wch: 18 }, { wch: 8 }, { wch: 14 }, { wch: 9 }, { wch: 11 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 11 }];
    return ws;
  }

  /* 달마다 파일 하나 — { fileName, kind:'xlsx'|'csv', aoa, csv? } */
  function build() {
    var rows = makeRows(), byMonth = {};
    rows.forEach(function (r) { (byMonth[r.date.slice(0, 7)] = byMonth[r.date.slice(0, 7)] || []).push(r); });
    var files = Object.keys(byMonth).sort().map(function (m, i, all) {
      var list = byMonth[m].slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.press < b.press ? -1 : 1; });
      var aoa = toAoa(list), last = i === all.length - 1;
      return { fileName: '프레스로그_샘플_' + m + (last ? '.csv' : '.xlsx'), kind: last ? 'csv' : 'xlsx', aoa: aoa, csv: last ? toCsv(aoa) : null, month: m };
    });
    return { files: files, master: master(rows), rows: rows, start: START, end: addDays(START, DAYS - 1) };
  }

  return { HEAD: HEAD, TITLE: TITLE, PRESSES: PRESSES, START: START, DAYS: DAYS, build: build, makeRows: makeRows, toCsv: toCsv, xlsxAoa: xlsxAoa, toSheet: toSheet, excelSerial: excelSerial };
});
