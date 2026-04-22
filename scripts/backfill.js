/**
 * 과거 기준가 일괄 수집 스크립트
 * 사용법: node scripts/backfill.js [상품ID]
 * 예: node scripts/backfill.js samsung-1277
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/products.json'), 'utf8'));

const targetId = process.argv[2] || config.products[0].id;
const product = config.products.find(p => p.id === targetId);
if (!product) {
  console.error(`상품 ID "${targetId}" 없음`);
  process.exit(1);
}

function toKSTDateStr(date) {
  const d = new Date(new Date(date).toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayKST() { return toKSTDateStr(new Date()); }

function isWeekday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00+09:00');
  const dow = d.getDay();
  return dow !== 0 && dow !== 6;
}

async function run() {
  const startDate = product.purchaseDate;
  const endDate = todayKST();
  console.log(`[${product.id}] 기준가 수집: ${startDate} ~ ${endDate}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    locale: 'ko-KR',
  });

  const collected = {}; // date -> price

  // ── 전략 1: 네트워크 응답 가로채기 ──────────────────────────────
  const page = await context.newPage();

  page.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try {
      const body = await response.json();
      extractPricesFromJson(body, collected);
    } catch {}
  });

  console.log('페이지 로드 중...');
  await page.goto(product.url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  // ── 날짜 범위 설정 시도 ──────────────────────────────────────────
  const filled = await trySetDateRange(page, startDate, endDate);
  if (filled) {
    console.log('날짜 범위 설정 성공, 조회 버튼 클릭');
    await page.waitForTimeout(3000);
  }

  // ── 전략 2: 현재 페이지 테이블 DOM 파싱 ─────────────────────────
  const domPrices = await extractTableFromDOM(page);
  Object.assign(collected, domPrices);

  // ── 전략 3: 페이지 텍스트에서 날짜+가격 패턴 추출 ───────────────
  const textPrices = await extractFromPageText(page);
  Object.assign(collected, textPrices);

  await page.close();
  await browser.close();

  const entries = Object.entries(collected)
    .filter(([date]) => date >= startDate && date <= endDate && isWeekday(date))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, price]) => ({ date, price }));

  if (!entries.length) {
    console.error('수집된 데이터 없음. 아래 사항을 확인하세요:');
    console.error('  - 페이지 구조가 변경됐을 수 있습니다');
    console.error('  - 수동으로 data/ 폴더에 JSON을 추가하거나 다음을 시도하세요:');
    console.error('    PWDEBUG=1 node scripts/backfill.js');
    process.exit(1);
  }

  // 기존 데이터와 병합
  const dataPath = path.join(ROOT, product.dataFile);
  const existing = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const merged = mergeHistories(existing, entries);
  fs.writeFileSync(dataPath, JSON.stringify(merged, null, 2));

  console.log(`완료: ${entries.length}건 수집, 총 ${merged.length}건 저장`);
  entries.forEach(e => console.log(`  ${e.date}: ${e.price}`));
}

// ────────────────────────────────────────────────────────────────────
// 날짜 범위 입력 시도 (삼성생명 SPA 기준)
async function trySetDateRange(page, startDate, endDate) {
  try {
    // 날짜 입력 필드 후보 선택자
    const startSelectors = [
      'input[id*="start"][type="date"]',
      'input[id*="from"][type="date"]',
      'input[placeholder*="시작"]',
      'input[placeholder*="조회시작"]',
      '.date-start input',
      '.start-date input',
    ];
    const endSelectors = [
      'input[id*="end"][type="date"]',
      'input[id*="to"][type="date"]',
      'input[placeholder*="종료"]',
      '.date-end input',
      '.end-date input',
    ];
    const submitSelectors = [
      'button:has-text("조회")',
      'button:has-text("검색")',
      'input[type="submit"]',
      '.btn-search',
    ];

    let startFilled = false;
    for (const sel of startSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.fill(startDate.replace(/-/g, ''));
        startFilled = true;
        break;
      }
    }
    if (!startFilled) return false;

    for (const sel of endSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.fill(endDate.replace(/-/g, ''));
        break;
      }
    }

    for (const sel of submitSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click();
        return true;
      }
    }
  } catch {}
  return false;
}

// ────────────────────────────────────────────────────────────────────
// DOM 테이블에서 날짜+가격 추출
async function extractTableFromDOM(page) {
  return page.evaluate(() => {
    const result = {};
    const rows = Array.from(document.querySelectorAll('table tr'));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.textContent.trim());
      let date = null, price = null;
      for (const cell of cells) {
        // 날짜 패턴: 2026.03.05 / 2026-03-05 / 20260305
        const dm = cell.match(/(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})/);
        if (dm) date = `${dm[1]}-${dm[2]}-${dm[3]}`;
        // 기준가 패턴: 4자리.2자리
        const pm = cell.match(/\b([1-9]\d{3}(?:,\d{3})*\.\d{2})\b/);
        if (pm) price = parseFloat(pm[1].replace(/,/g, ''));
      }
      if (date && price) result[date] = price;
    }
    return result;
  });
}

// ────────────────────────────────────────────────────────────────────
// 페이지 전체 텍스트에서 날짜+가격 패턴 추출
async function extractFromPageText(page) {
  return page.evaluate(() => {
    const result = {};
    const text = document.body.innerText;
    // "2026.03.05 ... 2707.97" 같은 패턴
    const lines = text.split('\n');
    for (const line of lines) {
      const dm = line.match(/(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})/);
      const pm = line.match(/\b([1-9]\d{3}(?:,\d{3})*\.\d{2})\b/);
      if (dm && pm) {
        const date = `${dm[1]}-${dm[2]}-${dm[3]}`;
        result[date] = parseFloat(pm[1].replace(/,/g, ''));
      }
    }
    return result;
  });
}

// ────────────────────────────────────────────────────────────────────
// JSON 응답에서 재귀적으로 날짜+가격 추출
function extractPricesFromJson(obj, result, depth = 0) {
  if (depth > 8 || !obj) return;
  if (Array.isArray(obj)) {
    for (const item of obj) extractPricesFromJson(item, result, depth + 1);
    return;
  }
  if (typeof obj === 'object') {
    // 날짜+가격 쌍이 있는 객체 탐색
    const keys = Object.keys(obj);
    let date = null, price = null;
    for (const k of keys) {
      const v = String(obj[k]);
      const dm = v.match(/^(\d{4})[.\-\/]?(\d{2})[.\-\/]?(\d{2})$/);
      if (dm) date = `${dm[1]}-${dm[2]}-${dm[3]}`;
      const pm = v.match(/^([1-9]\d{3}(?:\.\d+)?)$/);
      if (pm && parseFloat(pm[1]) > 100) price = parseFloat(pm[1]);
    }
    if (date && price) result[date] = price;
    for (const k of keys) extractPricesFromJson(obj[k], result, depth + 1);
  }
}

function mergeHistories(existing, incoming) {
  const map = {};
  for (const e of existing) map[e.date] = e.price;
  for (const e of incoming) map[e.date] = e.price;
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, price]) => ({ date, price }));
}

run().catch(err => { console.error(err); process.exit(1); });
