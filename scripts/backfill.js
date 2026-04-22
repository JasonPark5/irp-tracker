/**
 * 과거 기준가 일괄 수집
 * 전략: 삼성생명 SPA가 내부 API로 기준가를 가져오므로
 *       네트워크 응답을 전수 감청 → 날짜별 API 호출 유도 → DOM 테이블 파싱
 */
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/products.json'), 'utf8'));

const targetId = process.argv[2] || config.products[0].id;
const product  = config.products.find(p => p.id === targetId);
if (!product) { console.error(`상품 ID "${targetId}" 없음`); process.exit(1); }

/* ── 날짜 유틸 ───────────────────────────────────────────── */
function kstToday() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return fmt(d);
}
function fmt(d) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function pad(n) { return String(n).padStart(2,'0'); }

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00+09:00');
  d.setDate(d.getDate() + n);
  return fmt(d);
}

function isWeekday(dateStr) {
  const dow = new Date(dateStr + 'T12:00:00+09:00').getDay();
  return dow !== 0 && dow !== 6;
}

function allWeekdays(start, end) {
  const days = [];
  let cur = start;
  while (cur <= end) {
    if (isWeekday(cur)) days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}

/* ── JSON 재귀 파싱 ──────────────────────────────────────── */
function extractFromJson(obj, result, depth=0) {
  if (depth > 10 || !obj) return;
  if (Array.isArray(obj)) { obj.forEach(i => extractFromJson(i, result, depth+1)); return; }
  if (typeof obj !== 'object') return;

  const vals = Object.values(obj).map(String);
  let date = null, price = null;
  for (const v of vals) {
    const dm = v.match(/^(\d{4})[.\-\/]?(\d{2})[.\-\/]?(\d{2})$/);
    if (dm) date = `${dm[1]}-${dm[2]}-${dm[3]}`;
    const pm = v.match(/^([1-9]\d{3,4})(\.\d+)?$/);
    if (pm && parseFloat(v) > 100 && parseFloat(v) < 100000) price = parseFloat(v);
  }
  if (date && price) result[date] = price;
  Object.values(obj).forEach(v => extractFromJson(v, result, depth+1));
}

/* ── 메인 ────────────────────────────────────────────────── */
async function run() {
  const startDate = product.purchaseDate;
  const endDate   = kstToday();
  const weekdays  = allWeekdays(startDate, endDate);
  console.log(`[${product.id}] ${startDate} ~ ${endDate} (평일 ${weekdays.length}일)`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    locale: 'ko-KR',
  });

  const collected = {};

  /* ── 페이지 열기 + API 감청 ─── */
  const page = await context.newPage();

  page.on('response', async resp => {
    const ct = resp.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try {
      const body = await resp.json();
      extractFromJson(body, collected);
    } catch {}
  });

  console.log('페이지 로드...');
  await page.goto(product.url, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(4000);

  /* ── 날짜 범위 UI 조작 시도 ─── */
  const filled = await setDateRange(page, startDate, endDate);
  if (filled) {
    console.log('날짜 입력 성공, 조회 대기...');
    await page.waitForTimeout(5000);
  }

  /* ── DOM 테이블 파싱 ─── */
  const domData = await parseTable(page);
  Object.assign(collected, domData);

  /* ── 페이지 텍스트 fallback ─── */
  const textData = await parsePageText(page);
  Object.assign(collected, textData);

  /* ── 스크린샷 저장 (디버그용) ─── */
  const ssPath = path.join(ROOT, 'data', `debug-${product.id}.png`);
  await page.screenshot({ path: ssPath, fullPage: false });
  console.log(`스크린샷: ${ssPath}`);

  await page.close();
  await browser.close();

  /* ── 수집 결과 정리 ─── */
  const valid = Object.entries(collected)
    .filter(([d]) => d >= startDate && d <= endDate && isWeekday(d))
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([date, price]) => ({ date, price }));

  console.log(`수집된 날짜: ${valid.length}건`);
  if (!valid.length) {
    console.warn('데이터 없음 — data/debug-*.png 스크린샷을 확인하세요');
    process.exit(1);
  }

  /* ── 기존 데이터와 병합 ─── */
  const dataPath = path.join(ROOT, product.dataFile);
  const existing = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const merged   = merge(existing, valid);
  fs.writeFileSync(dataPath, JSON.stringify(merged, null, 2));

  console.log(`저장 완료: 총 ${merged.length}건`);
  merged.forEach(e => console.log(`  ${e.date}: ${e.price}`));
}

/* ── 날짜 범위 입력 ──────────────────────────────────────── */
async function setDateRange(page, start, end) {
  // 삼성생명 SPA에서 자주 사용되는 패턴들
  const startCandidates = [
    'input[id*="start"]', 'input[name*="start"]', 'input[id*="from"]',
    'input[placeholder*="시작"]', 'input[placeholder*="조회"]',
    '.startDt input', '.from-date input', '.search-start input',
  ];
  const endCandidates = [
    'input[id*="end"]', 'input[name*="end"]', 'input[id*="to"]',
    'input[placeholder*="종료"]', '.endDt input', '.to-date input', '.search-end input',
  ];
  const submitCandidates = [
    'button:has-text("조회")', 'button:has-text("검색")', 'a:has-text("조회")',
    '.btn-search', 'input[type="submit"]',
  ];

  const startStr = start.replace(/-/g, '');
  const endStr   = end.replace(/-/g, '');

  for (const sel of startCandidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 })) {
        await el.fill(startStr);
        break;
      }
    } catch {}
  }

  let endFilled = false;
  for (const sel of endCandidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 })) {
        await el.fill(endStr);
        endFilled = true;
        break;
      }
    } catch {}
  }
  if (!endFilled) return false;

  for (const sel of submitCandidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 })) {
        await el.click();
        return true;
      }
    } catch {}
  }
  return false;
}

/* ── DOM 테이블 파싱 ─────────────────────────────────────── */
async function parseTable(page) {
  return page.evaluate(() => {
    const result = {};
    document.querySelectorAll('table tr').forEach(row => {
      const cells = [...row.querySelectorAll('td,th')].map(c => c.textContent.trim());
      let date=null, price=null;
      cells.forEach(c => {
        const dm = c.match(/(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})/);
        if (dm) date = `${dm[1]}-${dm[2]}-${dm[3]}`;
        const pm = c.replace(/,/g,'').match(/\b([1-9]\d{3,4}\.\d{2})\b/);
        if (pm) price = parseFloat(pm[1]);
      });
      if (date && price) result[date] = price;
    });
    return result;
  });
}

/* ── 페이지 텍스트 파싱 ──────────────────────────────────── */
async function parsePageText(page) {
  return page.evaluate(() => {
    const result = {};
    document.body.innerText.split('\n').forEach(line => {
      const dm = line.match(/(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})/);
      const pm = line.replace(/,/g,'').match(/\b([1-9]\d{3,4}\.\d{2})\b/);
      if (dm && pm) {
        result[`${dm[1]}-${dm[2]}-${dm[3]}`] = parseFloat(pm[1]);
      }
    });
    return result;
  });
}

function merge(a, b) {
  const map = {};
  [...a, ...b].forEach(e => { map[e.date] = e.price; });
  return Object.entries(map).sort(([x],[y])=>x.localeCompare(y)).map(([date,price])=>({date,price}));
}

run().catch(err => { console.error(err); process.exit(1); });
