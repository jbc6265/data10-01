// 가상 샘플 파일 만들기: node scripts/make-samples.js
// js/sample-data.js 의 90일치를 달마다 한 파일로 씁니다(7·8·9월 .xlsx, 10월 .csv — 전부 지어낸 값).
// 쓴 파일을 앱과 같은 방식으로 다시 읽어(엑셀은 cellDates:false, CSV 는 UTF-8/EUC-KR 판별 후 raw) 원본 행과 같은지 확인합니다.
const fs = require('fs');
const path = require('path');
const XLSX = require('../vendor/xlsx.full.min.js');
const L = require('../js/logic.js');
const Sample = require('../js/sample-data.js');

const out = path.join(__dirname, '..', 'samples');
fs.mkdirSync(out, { recursive: true });
const b = Sample.build();
let recs = [];
for (const f of b.files) {
  const file = path.join(out, f.fileName);
  if (f.kind === 'xlsx') {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, Sample.toSheet(XLSX, f.aoa), '프레스 로그');
    fs.writeFileSync(file, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
  } else {
    fs.writeFileSync(file, '﻿' + f.csv, 'utf8'); // 엑셀에서 한글이 깨지지 않게 BOM
  }
  // 다시 읽기 — 앱(js/app.js readFile)과 같은 길
  const bytes = fs.readFileSync(file);
  const wb2 = f.kind === 'csv'
    ? XLSX.read(L.decodeCsv(bytes).text, { type: 'string', raw: true })
    : XLSX.read(bytes, { type: 'buffer', cellDates: false });
  const aoa = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { header: 1, raw: true, defval: null });
  const p = L.parseSheet(aoa, { fileName: f.fileName });
  if (p.det.missing.length || p.warnings.length || p.det.warnings.length) throw new Error(f.fileName + ' 다시 읽기 문제: ' + JSON.stringify(p.det.warnings.concat(p.warnings).slice(0, 3)));
  const want = f.aoa.length - 2 + (f.kind === 'csv' ? 0 : 0);
  if (p.records.length !== want) throw new Error(f.fileName + ' 행 수가 다름: ' + p.records.length + ' / ' + want);
  const first = p.records[0], src = b.rows.find(r => r.date === first.date && r.press === first.press);
  if (!src || src.strokes !== first.strokes || src.current !== first.current || src.pressCum !== first.pressCum) throw new Error(f.fileName + ' 첫 행 값이 원본과 다름');
  recs = L.mergeRecords(recs, p.records).records;
  console.log(f.fileName, '행', p.records.length);
}
const r = L.dataRange(recs);
console.log('누적 행', recs.length, '기간', r.first, '~', r.last);
