// 헤드리스 브라우저로 주요 흐름 점검 (선택 — playwright-core 가 있는 PC 에서만)
//   PLAYWRIGHT_CORE=/경로/node_modules/playwright-core STUDENT_CSV=/경로/log.csv BIG_CSV=/경로/big.csv node scripts/check-browser.mjs
// file:// 로 index.html 을 열어
//   ① 샘플 90일 → 대시보드 상태 → 화면별 가로 넘침
//   ② 수강생 형식 2초 로그 CSV 가져오기 → 실시간 관리도(관리도 4장·마지막 값·타수 719·이탈 목록·엑셀)
//   ③ 2초 로그 샘플(4대 × 3일) → P2 이탈·P4 금형 리셋·P3 정지 · 1분 평균 · 기준 바꾸기
//   ④ 큰 CSV(BIG_CSV, 하루 43,200행 × 4대)를 나눠 읽는 동안 화면이 멈추지 않는지(가장 긴 멈춤) · 다시 열어도 남는지(IndexedDB)
// 순서로 누르고 JS 오류와 폭별 가로 넘침을 잽니다. BREAK=1 이면 일부러 넓은 상자를 넣어 넘침 검사가 잡는지 봅니다.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const url = 'file://' + path.join(root, 'index.html');
const STUDENT = process.env.STUDENT_CSV || path.join(root, 'samples', '센서로그_샘플_2026-10-21.csv');
const BIG = process.env.BIG_CSV || '';

const errors = [], problems = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', d => d.accept());
function ok(cond, msg) { if (!cond) { problems.push(msg); console.log('  FAIL ' + msg); } else console.log('  ok  ' + msg); }
async function go(hash) { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForTimeout(200); }
async function overflow() {
  return page.evaluate(() => {
    const W = document.documentElement.clientWidth, bad = [];
    document.querySelectorAll('main *').forEach(el => {
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
      let p = el.parentElement, inScroll = false;
      while (p) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') { inScroll = true; break; } p = p.parentElement; }
      if (!inScroll && r.right > W + 1) bad.push(el.tagName + '.' + el.className);
    });
    return bad.slice(0, 3);
  });
}
async function widths(ids, ws) {
  for (const id of ids) for (const w of ws) {
    await page.setViewportSize({ width: w, height: 900 });
    await go('#/' + id);
    const bad = await overflow();
    ok(!bad.length, id + ' ' + w + 'px 가로 넘침 없음' + (bad.length ? ' — ' + bad.join(', ') : ''));
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
/* 2초 로그 반영이 끝날 때까지 — 버튼이 「읽는 중…」인 동안 기다림. 그동안 화면 멈춤(가장 긴 틈)을 잽니다 */
async function importFiles(files) {
  await go('#/import');
  await page.setInputFiles('input[type=file][accept=".xlsx,.xlsm,.xls,.csv,.txt"]', files);
  await page.waitForSelector('button:has-text("개 파일 반영")', { timeout: 30000 });
  await page.evaluate(() => { window.__gap = 0; let last = performance.now(); window.__iv = setInterval(() => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - last); last = n; }, 20); });
  const t0 = Date.now();
  await page.locator('button', { hasText: '개 파일 반영' }).click();
  await page.waitForFunction(() => !document.querySelector('button.btn-primary[disabled]') && !/읽는 중|합치는 중|일 집계/.test((document.getElementById('importProgress') || {}).textContent || '') , null, { timeout: 180000 });
  await page.waitForTimeout(300);
  const gap = await page.evaluate(() => { clearInterval(window.__iv); return window.__gap; });
  return { ms: Date.now() - t0, gap };
}

await page.goto(url);
if (process.env.BREAK) await page.addStyleTag({ content: '.page-head { min-width: 900px; } .lastcards { min-width: 900px; }' });

console.log('① 샘플 90일');
await page.locator('button', { hasText: '샘플 90일로 시작' }).first().click();
await page.waitForTimeout(500);
ok(await page.locator('#sampleBanner').isVisible(), '샘플 띠 보임');
const pcs = await page.locator('.press-grid .pcard').evaluateAll(a => a.map(x => x.querySelector('h3').textContent + ':' + x.className.replace(/.*lv-/, '')));
ok(pcs.join(' ') === 'P1:ok P2:bad P3:warn P4:bad', '대시보드 프레스 상태 그대로 (' + pcs.join(' ') + ')');
ok((await page.textContent('#main')).includes('아직 2초 센서 로그가 없습니다') === false, '대시보드에 빈 2초 로그 문구 없음');
await go('#/spc');
ok((await page.textContent('#main')).includes('아직 2초 센서 로그가 없습니다'), '실시간 관리도 — 2초 로그 없을 때 안내');
await widths(['dash', 'import', 'die', 'overhaul', 'anomaly', 'report', 'ai', 'settings', 'spc'], [1280, 390]);

console.log('② 수강생 형식 2초 로그 CSV — ' + path.basename(STUDENT));
const r1 = await importFiles([STUDENT]);
ok(true, '반영 ' + r1.ms + 'ms · 가장 긴 멈춤 ' + Math.round(r1.gap) + 'ms');
await go('#/spc');
const main2 = await page.textContent('#main');
ok(await page.locator('svg.chart.spc').count() === 4, '관리도 4장(전류·전압·온도·진동)');
ok(await page.locator('.lastcard').count() === 4, '마지막 값 카드 4개');
ok(await page.locator('svg.chart.spc line.lim').count() === 8, 'UCL·LCL 8줄');
ok(await page.locator('svg.chart.spc .base-zone').count() === 4, '기준 구간 띠 4개');
if (STUDENT.endsWith('log.csv')) {
  ok(/719타/.test(main2), '타수 719 (누적 1,890,112 → 1,890,831)');
  ok(/99\.9%/.test(main2), '기준(10초 1타) 대비 99.9%');
  ok(/이탈 목록 \(0번\)/.test(main2), '표본 표준편차·처음 1,800개 기준 — 이탈 0번');
}
await widths(['spc'], [1280, 768, 390, 360]);
// 일부러 이동범위 방식으로 바꾸면 이탈이 쏟아짐(설명문과 같은 결과인지)
await page.locator('#spcRules select[aria-label="σ 계산"]').selectOption('mr');
await page.locator('#spcRules button', { hasText: '기준 적용' }).click();
await page.waitForTimeout(300);
const mrText = await page.textContent('#main');
const mrN = +(/이탈 목록 \(([\d,]+)번\)/.exec(mrText) || [0, '0'])[1].replace(/,/g, '');
ok(mrN > 50, '이동범위(MR̄/1.128)로 바꾸면 이탈이 많아짐 — ' + mrN + '번');
await page.locator('#spcRules button', { hasText: '기본값으로' }).click();
await page.waitForTimeout(300);
const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('button', { hasText: '엑셀로 내려받기(이탈 목록' }).click()]);
ok(/^관리도_.*\.xlsx$/.test(dl.suggestedFilename()), '관리도 엑셀 내려받기 ' + dl.suggestedFilename());
await go('#/dash');
ok(await page.locator('.pcard', { hasText: '최근 1시간 타수' }).count() >= 1, '대시보드에 2초 센서 마지막 값 카드');
await widths(['dash', 'import'], [1280, 390]);

console.log('③ 2초 로그 샘플(4대 × 3일)');
await go('#/import');
await page.locator('button', { hasText: '2초 로그 샘플(4대 × 3일)' }).click();
await page.waitForFunction(() => location.hash === '#/spc' && document.querySelectorAll('svg.chart.spc').length === 4, null, { timeout: 60000 });
await page.waitForTimeout(300);
ok((await page.textContent('#dataChip')).includes('172,350'), '2초 로그 172,350행');
ok((await page.textContent('#sampleBanner')).includes('2초 로그 가상 샘플'), '2초 로그 샘플 띠');
await page.locator('select[aria-label="프레스"]').selectOption('P2');
await page.waitForTimeout(300);
let t = await page.textContent('#main');
ok(/2026-10-21 1[3-6]:/.test(t) && /높음/.test(t), 'P2 10/21 오후 전류 이탈(높음)이 목록에');
ok(await page.locator('svg.chart.spc circle.viol').count() > 0, '이탈점 빨간 점');
await page.locator('select[aria-label="묶어 보기"]').selectOption('60');
await page.waitForTimeout(300);
ok((await page.textContent('#main')).includes('1분 평균'), '1분 평균으로 묶어 보기');
await page.locator('select[aria-label="프레스"]').selectOption('P4');
await page.waitForTimeout(300);
t = await page.textContent('#main');
ok(t.includes('M-07→M-08') && t.includes('2026-10-20 13:00:00'), 'P4 금형 리셋(교체) 감지');
await page.locator('select[aria-label="프레스"]').selectOption('P3');
await page.waitForTimeout(300);
ok(/정지 구간 1번/.test(await page.textContent('#main')), 'P3 정지 구간 1번');
await page.locator('.seg-sm button', { hasText: '최근 30분' }).click();
await page.waitForTimeout(300);
ok(/2026-10-21 16:29:5\d ~ 2026-10-21 16:59:58/.test(await page.textContent('#main')), '최근 30분 보기(로그 마지막 시각 기준)');
await widths(['spc', 'dash', 'anomaly'], [1280, 390]);

if (BIG && fs.existsSync(BIG)) {
  console.log('④ 큰 CSV — ' + (fs.statSync(BIG).size / 1048576).toFixed(1) + 'MB');
  const r = await importFiles([BIG]);
  ok(r.gap < 1500, '나눠 읽는 동안 가장 긴 멈춤 ' + Math.round(r.gap) + 'ms (< 1.5초) · 전체 ' + (r.ms / 1000).toFixed(1) + '초');
  await go('#/spc');
  ok((await page.textContent('#dataChip')).includes('345,150'), '샘플 172,350 + 큰 파일 172,800 = 345,150행 (' + (await page.textContent('#dataChip')) + ')');
  const t0 = Date.now(); await page.locator('select[aria-label="프레스"]').selectOption('P1'); await page.waitForTimeout(50);
  ok(Date.now() - t0 < 3000, '프레스 바꿔 다시 그리기 ' + (Date.now() - t0) + 'ms');
  await page.reload(); await page.waitForTimeout(1500);
  ok((await page.textContent('#dataChip')).includes('345,150'), '다시 열어도 2초 로그가 남음(IndexedDB)');
}

ok(!errors.length, 'JS 오류 없음' + (errors.length ? ' — ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
console.log(problems.length ? '\n문제 ' + problems.length + '건' : '\n모두 통과');
process.exitCode = problems.length ? 1 : 0;
