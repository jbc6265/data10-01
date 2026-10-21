// 실행: node test/logic.test.mjs   (의존성 없음 — vendor 의 SheetJS 만 씀)
// 실제 프레스 로그는 아직 받지 않았습니다. 여기서는 손으로 만든 작은 표와 가상 샘플 90일로 검사합니다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../js/logic.js');
const Sample = require('../js/sample-data.js');
const XLSX = require('../vendor/xlsx.full.min.js');
const AI = require('../js/ai-endpoint.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, a + ' ≠ ' + b);

/* 날짜 d 부터 n 일(쉬는 날 없이) 하루 한 행, 값은 fn(i) */
function series(press, from, n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Object.assign({ press, date: L.addDays(from, i), s: 100 }, fn(i)));
  return out;
}
// 결정적 잡음 — ±1 사이를 고르게 도는 값(시험이 늘 같게)
const wiggle = i => [0.3, -0.5, 0.8, -0.2, 0.1, -0.9, 0.6, -0.4, 0.2, -0.7, 0.5, 0][i % 12];

console.log('열 찾기 · 값 읽기');
test('제목 줄 아래 머리행을 찾고, 단위 괄호를 떼고 이름으로 연결 (금형 타수 → 타수)', () => {
  const aoa = [['■ 프레스 로그'], ['일자', '프레스', '프레스 종류', '금형명', '프레스 누적 타수', '금형 타수', '가동 시간(h)', '전류(A)', '전압(V)', '온도(℃)', '진동(mm/s)'], ['2026-10-01', 'P1', '유압', 'M-01', 1000, 50, 8, 80, 380, 44, 2.1]];
  const d = L.detectColumns(aoa);
  assert.equal(d.headerRow, 1);
  assert.deepEqual(d.missing, []);
  assert.equal(d.map.strokes, 5); assert.equal(d.map.pressCum, 4); assert.equal(d.map.current, 7); assert.equal(d.map.temp, 9); assert.equal(d.map.vib, 10);
  assert.equal(d.warnings.length, 0);
});
test('열 순서·표기가 달라도 찾음 (설비명·톤수·유온·운전시간(분)) — 분은 시간으로 바꿈', () => {
  const aoa = [['운전시간(분)', '설비명', '측정일시', '유온', '톤수', '총타수'], [90, 'A-1', '2026-10-01 08:30', 45.5, '600톤', 12000]];
  const p = L.parseSheet(aoa);
  assert.deepEqual(p.det.missing, []);
  const r = p.records[0];
  assert.equal(r.press, 'A-1'); assert.equal(r.date, '2026-10-01'); assert.equal(r.time, '08:30');
  assert.equal(r.runHr, 1.5); assert.equal(r.temp, 45.5); assert.equal(r.pressType, '600톤'); assert.equal(r.pressCum, 12000);
  assert.ok(p.det.warnings.some(w => w.includes('금형명')), '금형명 열 없음 경고');
});
test('필수 열(일자·프레스)이 없으면 읽지 않음 · 사용자가 열을 고르면 다시 읽음', () => {
  const aoa = [['날짜', '기계', '타수'], ['2026-10-01', 'P9', 30]];
  const d = L.detectColumns(aoa);
  assert.deepEqual(d.missing, ['press']);
  assert.equal(L.parseRows(aoa, d).records.length, 0);
  const p = L.parseSheet(aoa, { overrides: { press: 1 } });
  assert.equal(p.records.length, 1); assert.equal(p.records[0].press, 'P9'); assert.equal(p.records[0].strokes, 30);
});
test('타수·센서 열이 모두 없으면 경고 두 개', () => {
  const d = L.detectColumns([['일자', '프레스', '금형명'], ['2026-10-01', 'P1', 'M']]);
  assert.ok(d.warnings.some(w => w.includes('타수 열')));
  assert.ok(d.warnings.some(w => w.includes('이상 감지')));
});
test('날짜 — 엑셀 일련번호(시각 포함)·글자·8자리·잘못된 날', () => {
  assert.deepEqual(L.toDateTime(46296), { date: '2026-10-01', time: '' });
  assert.deepEqual(L.toDateTime(46296.75), { date: '2026-10-01', time: '18:00' });
  assert.deepEqual(L.toDateTime('2026.10.1 7:05'), { date: '2026-10-01', time: '07:05' });
  assert.equal(L.toISO('20261001'), '2026-10-01');
  assert.equal(L.toISO('2026-02-30'), '');
  assert.equal(L.toTime(0.5), '12:00'); assert.equal(L.toTime('9:15'), '09:15');
});
test('숫자 — 쉼표·단위 붙은 값, 못 읽는 값은 행 알림, 음수 타수는 비움', () => {
  assert.equal(L.toNum('1,234'), 1234); assert.equal(L.toNum('85.2A'), 85.2); assert.equal(L.toNum(''), null); assert.ok(Number.isNaN(L.toNum('측정불가')));
  const p = L.parseSheet([['일자', '프레스', '타수', '전류'], ['2026-10-01', 'P1', -5, '측정불가'], ['', '', null, null], ['날짜아님', 'P1', 1, 1]]);
  assert.equal(p.records.length, 1);
  assert.equal(p.records[0].strokes, null); assert.equal(p.records[0].current, null);
  assert.equal(p.warnings.length, 3);
  assert.equal(p.skipped, 2);
});
test('CSV — UTF-8(BOM) 과 CP949(EUC-KR) 를 가려 읽음', () => {
  const u = L.decodeCsv(new TextEncoder().encode('﻿일자,프레스'));
  assert.equal(u.text, '일자,프레스'); assert.equal(u.encoding, 'UTF-8');
  const k = L.decodeCsv(Uint8Array.from([0xC0, 0xCF, 0xC0, 0xDA, 0x2C, 0xC7, 0xC1, 0xB7, 0xB9, 0xBD, 0xBA]));
  assert.equal(k.text, '일자,프레스'); assert.equal(k.encoding, 'EUC-KR(CP949)');
});
test('여러 시트 중 로그 시트를 고름', () => {
  const pick = L.pickSheet([{ name: '안내', aoa: [['이 파일은 …']] }, { name: '로그', aoa: [['일자', '프레스', '전류'], ['2026-10-01', 'P1', 80]] }]);
  assert.equal(pick.name, '로그');
});

console.log('누적 · 타수 계산');
test('2초 간격 CSV — 3,600행 보존, 금형 누적 자동 연결, 실제 타수 719타', () => {
  const bytes = readFileSync(new URL('../samples/프레스로그_2초간격_2시간.csv', import.meta.url));
  const wb = XLSX.read(L.decodeCsv(bytes).text, { type: 'string', raw: true });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const p = L.parseSheet(aoa);
  assert.equal(p.records.length, 3600);
  assert.equal(p.det.map.strokes, undefined);
  assert.equal(p.det.map.dieCum, 5);
  assert.equal(p.records[0].runHr, null);
  assert.equal(p.records[1].time, '09:00:02');
  const merged = L.mergeRecords([], p.records);
  assert.equal(merged.records.length, 3600);
  assert.equal(L.mergeRecords(merged.records, p.records).records.length, 3600);
  const d = L.deriveStrokes(merged.records);
  assert.equal(d.rows.reduce((sum, r) => sum + (r.s || 0), 0), 719);
  assert.equal(d.stat.noPrev, 1);
  assert.equal(d.stat.mismatch, 0);
  assert.equal(d.rows[4].s, 0); assert.equal(d.rows[5].s, 1);
  assert.equal(d.rows.at(-1).dieCum, 719);
  const manual = L.parseSheet(aoa, { overrides: { strokes: 5, dieCum: -1 } });
  assert.equal(manual.records[5].strokes, 1);
  assert.equal(manual.records[5].dieCum, null);
});
test('초 단위 — 문자열·엑셀 일련번호·Date·별도 시각 및 분 단위와 중복 키 호환', () => {
  assert.equal(L.toDateTime('2026-10-01 09:00:02').time, '09:00:02');
  assert.equal(L.toDateTime(46296 + 32402 / 86400).time, '09:00:02');
  assert.equal(L.toDateTime(new Date(2026, 9, 1, 9, 0, 2)).time, '09:00:02');
  assert.equal(L.toTime('09:00:02'), '09:00:02');
  assert.equal(L.toTime(32402 / 86400), '09:00:02');
  assert.equal(L.recKey({ date: '2026-10-01', time: '09:00', press: 'P1' }), L.recKey({ date: '2026-10-01', time: '09:00:00', press: 'P1' }));
});
test('같은 행(일자+시각+프레스+금형)은 다시 가져오면 새 값으로 — 두 번 세지 않음', () => {
  const a = [{ date: '2026-10-01', time: '', press: 'P1', die: 'M', strokes: 10 }];
  const m = L.mergeRecords(a, [{ date: '2026-10-01', time: '', press: 'P1', die: 'M', strokes: 12 }, { date: '2026-10-02', time: '', press: 'P1', die: 'M', strokes: 5 }]);
  assert.equal(m.records.length, 2); assert.deepEqual(m.stat, { added: 1, updated: 1 });
  assert.equal(m.records[0].strokes, 12);
});
test('타수 열이 없으면 프레스 누적 타수 차이 — 첫 행은 못 셈, 카운터가 줄면 비움', () => {
  const recs = [
    { date: '2026-10-01', press: 'P1', die: 'A', pressCum: 1000 },
    { date: '2026-10-02', press: 'P1', die: 'A', pressCum: 1300 },
    { date: '2026-10-03', press: 'P1', die: 'B', pressCum: 1250 }, // 초기화
    { date: '2026-10-04', press: 'P1', die: 'B', pressCum: 1400 }
  ];
  const d = L.deriveStrokes(recs);
  assert.deepEqual(d.rows.map(r => r.s), [null, 300, null, 150]);
  assert.equal(d.stat.noPrev, 1); assert.equal(d.stat.reset, 1); assert.equal(d.stat.fromPressCum, 2);
});
test('프레스 누적도 없으면 같은 금형의 금형 누적 타수 차이 (프레스를 옮겨 다녀도 금형 순서로)', () => {
  const recs = [
    { date: '2026-10-01', press: 'P1', die: 'M', dieCum: 500 },
    { date: '2026-10-02', press: 'P2', die: 'M', dieCum: 640 },
    { date: '2026-10-03', press: 'P1', die: 'M', dieCum: 700 }
  ];
  const d = L.deriveStrokes(recs);
  const byDate = Object.fromEntries(d.rows.map(r => [r.date, r.s]));
  assert.deepEqual(byDate, { '2026-10-01': null, '2026-10-02': 140, '2026-10-03': 60 });
  assert.equal(d.stat.fromDieCum, 2);
});
test('타수 열과 프레스 누적이 함께 있으면 맞는지 봄 (시각별 여러 행 합 = 누적 차이)', () => {
  const ok = [
    { date: '2026-10-01', time: '08:00', press: 'P1', strokes: 0, pressCum: 100 },
    { date: '2026-10-01', time: '12:00', press: 'P1', strokes: 40, pressCum: 140 },
    { date: '2026-10-01', time: '16:00', press: 'P1', strokes: 60, pressCum: 200 }
  ];
  assert.equal(L.deriveStrokes(ok).stat.mismatch, 0);
  const bad = ok.map(r => Object.assign({}, r)); bad[2].strokes = 90;
  const st = L.deriveStrokes(bad).stat;
  assert.equal(st.mismatch, 1); assert.ok(st.mismatchRows[0].includes('누적 차이 60'));
});
test('하루 묶음 — 타수·가동시간 합, 센서는 있는 값의 평균', () => {
  const d = L.daily([
    { press: 'P1', date: '2026-10-01', s: 10, runHr: 4, current: 80, temp: null, die: 'A' },
    { press: 'P1', date: '2026-10-01', s: 20, runHr: 4, current: 90, temp: 50, die: 'B' }]);
  assert.equal(d.length, 1);
  assert.equal(d[0].strokes, 30); assert.equal(d[0].runHr, 8); assert.equal(d[0].current, 85); assert.equal(d[0].temp, 50); assert.deepEqual(d[0].dies, ['A', 'B']);
});

console.log('금형 수명 · 오버홀');
const R0 = L.cleanRules({});
test('금형 — 사용 타수 = 시작 시점 사용 + 시작일부터 로그, 일평균은 달력 일수로, 예정일 추정', () => {
  // 10일 동안 하루 100타(10/01~10/10), 시작일 10/03 → 로그에서 센 타수 800
  const rows = series('P1', '2026-10-01', 10, () => ({ die: 'M' }));
  const [d] = L.dieStatus(rows, { M: { life: 10000, startDate: '2026-10-03', baseStrokes: 8000 } }, { rules: R0, asOf: '2026-10-10' });
  assert.equal(d.logged, 800); assert.equal(d.used, 8800); near(d.ratio, 0.88);
  near(d.avgPerDay, 1000 / 14, 0.1); // 최근 14일 안의 타수 1,000 ÷ 14
  assert.equal(d.daysLeft, Math.ceil(1200 / (1000 / 14))); assert.equal(d.dueDate, L.addDays('2026-10-10', d.daysLeft));
  assert.equal(d.level, 'ok'); // 88% · 17일 뒤 → 정상
});
test('금형 — 90% 이상 또는 예정일 14일 안 = 주의, 100% = 점검 필요, 수명 기준 없음 = 기준 없음', () => {
  const rows = series('P1', '2026-10-01', 14, () => ({ die: 'M', s: 140 }));
  const st = life => L.dieStatus(rows, { M: { life, baseStrokes: 0 } }, { rules: R0, asOf: '2026-10-14' })[0];
  assert.equal(st(1960 / 0.91).level, 'warn');          // 91%
  assert.equal(st(1960 + 140 * 10).level, 'warn');      // 58% 지만 10일 뒤 도달
  assert.equal(st(1960 + 140 * 30).level, 'ok');
  const over = st(1900);
  assert.equal(over.level, 'bad'); assert.equal(over.dueDate, '2026-10-14'); assert.equal(over.daysLeft, 0);
  const none = L.dieStatus(rows, {}, { rules: R0, asOf: '2026-10-14' })[0];
  assert.equal(none.level, 'none'); assert.equal(none.used, 1960);
});
test('오버홀 — 일수·타수 중 먼저 닿는 쪽, 지나면 점검 필요와 지난 날수', () => {
  const rows = series('P4', '2026-10-01', 10, () => ({}));
  const presses = { P4: { ohDays: 180, lastOH: '2026-04-01', ohStrokes: 100000, ohBase: 5000 } };
  const [o] = L.overhaulStatus(rows, presses, { rules: R0, asOf: '2026-10-10' });
  assert.equal(o.strokesSince, 6000); assert.equal(o.daysSince, 192);
  assert.equal(o.basis, '일수'); assert.equal(o.level, 'bad');
  assert.equal(o.dueByDays, '2026-09-28'); assert.equal(o.dueDate, '2026-09-28'); assert.equal(o.overdueDays, 12);
});
test('오버홀 — 마지막 오버홀 다음 날부터 셈 · 주기 없음 = 기준 없음 · 일수만 있고 날짜 없음', () => {
  const rows = series('P1', '2026-10-01', 10, () => ({}));
  const [o] = L.overhaulStatus(rows, { P1: { ohStrokes: 2000, lastOH: '2026-10-05' } }, { rules: R0, asOf: '2026-10-10' });
  assert.equal(o.strokesSince, 500); // 10/06~10/10 의 5일 × 100
  assert.equal(o.daysLeft, 21); assert.equal(o.level, 'ok'); // 남은 1,500타 ÷ 일평균(1,000 ÷ 14) = 21일 → 14일 밖이라 정상
  const [n] = L.overhaulStatus(rows, { P1: {} }, { rules: R0, asOf: '2026-10-10' });
  assert.equal(n.level, 'none');
  const [m] = L.overhaulStatus(rows, { P1: { ohDays: 90 } }, { rules: R0, asOf: '2026-10-10' });
  assert.equal(m.level, 'none'); assert.ok(m.reason.includes('일자'));
});

console.log('이상 감지');
test('기준선 — 중앙값·MAD 는 튀는 값에 흔들리지 않고, 값이 같으면 0.5% 바닥값', () => {
  const b = L.baseline([10, 10.2, 9.8, 10.1, 9.9, 100], 'mad');
  near(b.center, 10.05, 1e-9); assert.ok(b.sigma < 0.5);
  const s = L.baseline([10, 10.2, 9.8, 10.1, 9.9, 100], 'sigma');
  assert.ok(s.sigma > 30);
  const f = L.baseline([50, 50, 50, 50], 'mad');
  assert.equal(f.floored, true); near(f.sigma, 0.25);
});
const BASE_FROM = '2026-08-01'; // 기준선 42일 + 최근 14일 = 56일
function sensorDays(fnRecent, n = 56) {
  return L.daily(series('PX', BASE_FROM, n, i => ({ current: i < 42 ? 100 + wiggle(i) : fnRecent(i - 42) })));
}
test('최근 구간에서 ±3σ 를 3일 연속 넘으면 점검 필요 — 근거 숫자와 연속 날짜', () => {
  const a = L.detectSensor(sensorDays(j => j >= 8 ? 110 : 100 + wiggle(j)), 'current', { rules: R0 });
  assert.equal(a.level, 'bad'); assert.equal(a.direction, 'up'); assert.equal(a.runK, 6);
  assert.equal(a.base.n, 42); assert.ok(a.evidence.includes('가동일 6일 연속'));
  assert.ok(a.points.length === 56 && a.points.filter(p => p.zone === 'recent').length === 14);
});
test('하루 튄 값 하나는 정상(판정 기준 미달), 연속 아닌 두 날은 주의, 낮아지는 것도 잡음', () => {
  assert.equal(L.detectSensor(sensorDays(j => j === 5 ? 120 : 100 + wiggle(j)), 'current', { rules: R0 }).level, 'ok');
  assert.equal(L.detectSensor(sensorDays(j => (j === 3 || j === 9) ? 120 : 100 + wiggle(j)), 'current', { rules: R0 }).level, 'warn');
  const down = L.detectSensor(sensorDays(j => j >= 10 ? 90 : 100 + wiggle(j)), 'current', { rules: R0 });
  assert.equal(down.level, 'bad'); assert.equal(down.direction, 'down');
});
test('평소 범위 안이면 정상 · 기준선이 짧으면 비교 못 함 · 최근 값이 없으면 자료 없음', () => {
  assert.equal(L.detectSensor(sensorDays(j => 100 + wiggle(j + 3)), 'current', { rules: R0 }).level, 'ok');
  const short = L.daily(series('PX', '2026-09-20', 20, i => ({ current: 100 + wiggle(i) })));
  assert.equal(L.detectSensor(short, 'current', { rules: R0 }).level, 'nobase');
  assert.equal(L.detectSensor(sensorDays(() => 100), 'temp', { rules: R0 }).level, 'nodata');
});
test('지속 조건을 바꾸면 판정이 바뀜 (persist 3 → 8)', () => {
  const d = sensorDays(j => j >= 8 ? 110 : 100 + wiggle(j));
  assert.equal(L.detectSensor(d, 'current', { rules: L.cleanRules({ persist: 8 }) }).level, 'warn');
});
test('판정 기준 정리 — 범위 밖 값은 기본값, 주의 한계는 관리한계보다 클 수 없음', () => {
  const r = L.cleanRules({ k: 2, kWarn: 3, recentDays: 1, method: 'x', channels: { vib: false } });
  assert.equal(r.kWarn, 2); assert.equal(r.recentDays, 14); assert.equal(r.method, 'mad'); assert.equal(r.channels.vib, false); assert.equal(r.channels.current, true);
});

console.log('가상 샘플 90일 (심어 둔 세 가지)');
const S = Sample.build();
let recs = [];
for (const f of S.files) recs = L.mergeRecords(recs, L.parseSheet(f.aoa, { fileName: f.fileName }).records).records;
const db = L.emptyDb(); db.records = recs; db.presses = S.master.presses; db.dies = S.master.dies;
const A = L.analyze(db);
test('파일 4개(7~10월) → 4대 × 90일 중 일요일 뺀 308행, 기준일 10-17', () => {
  assert.equal(S.files.length, 4); assert.equal(S.files[3].kind, 'csv');
  assert.equal(recs.length, 308); assert.equal(A.asOf, '2026-10-17');
  assert.equal(A.strokeStat.fromRow, 308); assert.equal(A.strokeStat.mismatch, 0); // 금형 타수 합 = 프레스 누적 차이
});
test('① 금형 M-05 — 수명 약 95%, 교체 예정 14일 안 → 주의 (다른 금형은 정상)', () => {
  const m5 = A.dies.find(d => d.id === 'M-05');
  assert.equal(m5.level, 'warn'); near(m5.ratio, 0.95, 0.002); assert.ok(m5.daysLeft <= 14);
  assert.deepEqual(A.dies.filter(d => d.level !== 'ok').map(d => d.id), ['M-05']);
});
test('② P2 — 전류·온도가 함께 점검 필요(오름), 다른 프레스·채널은 정상', () => {
  const bad = A.anomalies.filter(a => a.level !== 'ok').map(a => a.press + ':' + a.channel + ':' + a.level + ':' + a.direction).sort();
  assert.deepEqual(bad, ['P2:current:bad:up', 'P2:temp:bad:up']);
});
test('③ P4 — 오버홀 일수 주기(180일) 지남 → 점검 필요', () => {
  const o = A.overhauls.find(x => x.id === 'P4');
  assert.equal(o.level, 'bad'); assert.equal(o.basis, '일수'); assert.equal(o.dueDate, '2026-09-23');
  assert.deepEqual(A.overhauls.filter(x => x.level !== 'ok').map(x => x.id), ['P4']);
});
test('프레스 종합 — P1 정상 · P2 점검 필요 · P3 주의(금형) · P4 점검 필요(오버홀)', () => {
  assert.deepEqual(A.statuses.map(s => s.id + ':' + s.level), ['P1:ok', 'P2:bad', 'P3:warn', 'P4:bad']);
  assert.equal(A.statuses[2].reasons[0].kind, 'die');
  assert.ok(A.statuses[1].reasons[0].short.includes('평소'));
});

console.log('월별 보고서');
test('월별 종류별 타수 합 = 전체 타수 합, 종류 3가지 · 달 4개', () => {
  const mb = L.monthlyByType(A.rows, db.presses);
  assert.deepEqual(mb.months, ['2026-07', '2026-08', '2026-09', '2026-10']);
  assert.equal(mb.types.length, 3);
  const all = A.rows.reduce((s, r) => s + r.s, 0);
  assert.equal(mb.total.reduce((a, b) => a + b, 0), all);
  const aoa = L.monthlyToAoa(mb);
  assert.equal(aoa[aoa.length - 1][5], all);
});
test('한 달 자세히 — 종류·프레스·금형 합이 서로 같음, 기준표의 종류가 로그보다 먼저', () => {
  const det = L.monthDetail(A.rows, db.presses, '2026-09');
  const sum = a => a.reduce((s, g) => s + g.strokes, 0);
  assert.equal(sum(det.byType), det.total); assert.equal(sum(det.byPress), det.total); assert.equal(sum(det.byDie), det.total);
  const renamed = Object.assign({}, db.presses, { P1: Object.assign({}, db.presses.P1, { type: '시험용 종류' }) });
  assert.ok(L.monthDetail(A.rows, renamed, '2026-09').byType.some(g => g.key === '시험용 종류'));
  assert.ok(L.monthDetailToAoa(det).length > 10);
});

console.log('AI 프롬프트 · 이름 가리기');
function promptWith(mask) {
  const aliases = { press: L.assignAliases({}, Object.keys(db.presses), L.ALIAS.press), die: L.assignAliases({}, A.dies.map(d => d.id), L.ALIAS.die) };
  return { aliases, info: L.buildAiPromptInfo({ asOf: A.asOf, range: A.range, rules: A.rules, statuses: A.statuses, anomalies: A.anomalies, dies: A.dies, overhauls: A.overhauls,
    month: L.monthDetail(A.rows, db.presses, '2026-10'), aliases: mask ? aliases : null }) };
}
test('사실만 — 심어 둔 세 가지의 근거 숫자가 프롬프트에 들어감', () => {
  const p = promptWith(false).info.prompt;
  assert.ok(p.includes('P2 전류 [점검 필요]')); assert.ok(p.includes('M-05 [주의]')); assert.ok(p.includes('P4 [점검 필요]: 오버홀 주기 지남'));
  assert.ok(p.includes('「추정」'));
});
test('가리기 — 실제 프레스·금형 이름이 남지 않고, 답의 별칭은 되돌리되 「설비 3대」「금형2개」는 그대로', () => {
  const { aliases, info } = promptWith(true);
  assert.deepEqual(info.leaks, []);
  for (const n of ['P1', 'P2', 'P3', 'P4', 'M-01', 'M-05']) assert.ok(!new RegExp('(^|[^0-9A-Za-z가-힣])' + n + '(?![0-9A-Za-z])').test(info.prompt), n + ' 이 남음');
  assert.equal(aliases.press.P2, '설비2'); assert.equal(aliases.die['M-05'], '금형5');
  assert.equal(L.unmaskText('설비2 전류 확인, 금형5 교체. 설비 3대·금형2개', aliases), 'P2 전류 확인, M-05 교체. 설비 3대·금형2개');
});
test('안전망 — 가린 뒤에도 남은 이름을 찾음 (일부러 넣어 봄)', () => {
  assert.deepEqual(L.findLeaks('설비1 과 P3 를 비교', ['P1', 'P3', 'M-01']), ['P3']);
  assert.deepEqual(L.findLeaks('P30 은 다른 설비', ['P3']), []);
});
test('별칭 대응표는 유지 — 새 이름에만 다음 번호', () => {
  const a = L.assignAliases({ P2: '설비1' }, ['P1', 'P2'], '설비');
  assert.deepEqual(a, { P2: '설비1', P1: '설비2' });
});

console.log('기준표 · 저장');
test('기준표 엑셀 왕복 — 열 순서가 바뀌어도 이름으로 읽고, 엑셀 날짜 칸도 읽음', () => {
  const m = L.masterToAoa(db.presses, db.dies);
  const backP = L.masterFromAoa(m.presses).presses, backD = L.masterFromAoa(m.dies).dies;
  assert.deepEqual(backP.P4, L.cleanPress(db.presses.P4, 'P4'));
  assert.deepEqual(backD['M-05'], L.cleanDie(db.dies['M-05'], 'M-05'));
  const swapped = [['수명 기준 타수', '금형명', '사용 시작일(교체일)'], [5000, 'X-1', 46296]];
  assert.deepEqual(L.masterFromAoa(swapped).dies['X-1'], { id: 'X-1', life: 5000, startDate: '2026-10-01', baseStrokes: null, note: '' });
});
test('로그에 나온 프레스·금형을 기준표에 더함(있는 값은 그대로)', () => {
  const r = L.syncMaster({ P1: L.cleanPress({ ohDays: 30 }, 'P1') }, {}, [{ press: 'P1', pressType: '유압', die: 'A' }, { press: 'P2', die: 'B' }]);
  assert.equal(r.presses.P1.ohDays, 30); assert.equal(r.presses.P1.type, '유압'); assert.ok(r.presses.P2); assert.deepEqual(Object.keys(r.dies), ['A', 'B']);
  assert.deepEqual(r.added, { presses: 1, dies: 2 });
});
test('백업 왕복 — restoreDb 는 이상한 값을 걸러 냄', () => {
  const back = L.restoreDb(JSON.parse(JSON.stringify(db)));
  assert.equal(back.records.length, 308); assert.equal(back.dies['M-05'].life, 120000);
  const bad = L.restoreDb({ records: [{ date: '', press: 'x' }, null], presses: { P: { ohDays: -3 } }, maskNames: false });
  assert.equal(bad.records.length, 0); assert.equal(bad.presses.P.ohDays, null); assert.equal(bad.maskNames, false);
});

console.log('샘플 파일 (엑셀로 쓰고 다시 읽기)');
test('엑셀 날짜 칸(일련번호)으로 써도 앱과 같은 길로 읽으면 같은 행', () => {
  const f = S.files[1];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, Sample.toSheet(XLSX, f.aoa), '로그');
  const back = XLSX.read(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }), { type: 'array', cellDates: false });
  const aoa = XLSX.utils.sheet_to_json(back.Sheets['로그'], { header: 1, raw: true, defval: null });
  assert.equal(typeof aoa[2][0], 'number');
  const p = L.parseSheet(aoa);
  assert.equal(p.records.length, f.aoa.length - 2); assert.equal(p.records[0].date, '2026-08-01');
});
test('CSV 샘플을 글자로 읽어도 같은 행', () => {
  const f = S.files[3];
  const wb = XLSX.read(f.csv, { type: 'string', raw: true });
  const p = L.parseSheet(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null }));
  assert.equal(p.records.length, f.aoa.length - 2); assert.deepEqual(p.det.warnings, []);
});

console.log('AI 연결');
test('주소 정리·요청 만들기·키 없으면 머리글 없음', () => {
  assert.equal(AI.normalizeBaseUrl('https://x.com/v1/chat/completions/'), 'https://x.com/v1');
  const r = AI.buildChatRequest({ baseUrl: 'https://x.com/v1', model: 'm' }, [{ role: 'user', content: 'a' }]);
  assert.equal(r.url, 'https://x.com/v1/chat/completions'); assert.ok(!r.init.headers.Authorization);
  assert.ok(AI.validateConfig({ baseUrl: 'http://10.0.0.1/v1', model: 'm' }, 'https:').errors.length > 0);
  assert.equal(AI.toStored({ baseUrl: 'https://x.com/v1', model: 'm', apiKey: 'k', remember: false }).apiKey, '');
});

console.log('\n' + passed + '개 통과' + (process.exitCode ? ' — 실패가 있습니다' : ''));
