const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/products.json'), 'utf8'));

function today() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 날짜 패턴(YYYY.MM.DD)과 구분되는 기준가 추출
// (?!\.\d) : 뒤에 .숫자가 오면 날짜이므로 제외
const PRICE_RE = /\b([1-9]\d{3}(?:,\d{3})*\.\d{2})(?!\.\d)/g;

function parsePrice(text) {
  const cleaned = text.replace(/\s/g, '');
  const matches = [...cleaned.matchAll(PRICE_RE)].map(m => parseFloat(m[1].replace(/,/g, '')));
  // 합리적인 기준가 범위 (500 ~ 50000) 내 첫 번째 값
  return matches.find(v => v >= 500 && v <= 50000) ?? null;
}

// JSON 응답에서 stndPrc 또는 기준가 패턴 재귀 탐색
function extractFromJson(obj, result, depth = 0) {
  if (depth > 8 || !obj) return;
  if (Array.isArray(obj)) { obj.forEach(i => extractFromJson(i, result, depth + 1)); return; }
  if (typeof obj !== 'object') return;
  // stndPrc 키 직접 매칭 (삼성생명 API)
  if (obj.stndYmd && obj.stndPrc) {
    const ymd = String(obj.stndYmd);
    const date = `${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`;
    const price = parseFloat(String(obj.stndPrc).trim());
    if (date && price > 0) result[date] = price;
  }
  Object.values(obj).forEach(v => extractFromJson(v, result, depth + 1));
}

async function fetchSamsungPrice(page, url) {
  const intercepted = {};

  // 전략 1: API 응답 인터셉트
  page.on('response', async resp => {
    const ct = resp.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try { extractFromJson(await resp.json(), intercepted); } catch {}
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  // 인터셉트에서 오늘 날짜 혹은 가장 최근 날짜 찾기
  if (Object.keys(intercepted).length) {
    const sorted = Object.keys(intercepted).sort();
    const latest = sorted[sorted.length - 1];
    console.log(`  API 인터셉트 성공: ${latest} = ${intercepted[latest]}`);
    return intercepted[latest];
  }

  // 전략 2: DOM에서 기준가 라벨 인근 값 탐색
  const price = await page.evaluate((priceReStr) => {
    const PRICE_RE = new RegExp(priceReStr, 'g');

    function parsePrice(text) {
      const matches = [...text.replace(/\s/g,'').matchAll(PRICE_RE)].map(m => parseFloat(m[1].replace(/,/g,'')));
      return matches.find(v => v >= 500 && v <= 50000) ?? null;
    }

    // 기준가 라벨 주변 탐색
    const els = [...document.querySelectorAll('th, td, dt, dd, span, p, div')];
    for (const el of els) {
      if (!/기준가/.test(el.textContent)) continue;
      // 인접 sibling/child에서 가격 추출
      const candidates = [
        el.nextElementSibling,
        el.closest('tr')?.querySelector('td:last-child'),
        el.closest('dl')?.querySelector('dd'),
      ];
      for (const c of candidates) {
        if (!c) continue;
        const v = parsePrice(c.textContent);
        if (v) return v;
      }
      // 같은 요소 내 가격
      const v = parsePrice(el.textContent);
      if (v) return v;
    }

    // 전체 텍스트 노드 스캔
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const v = parsePrice(node.textContent);
      if (v) return v;
    }
    return null;
  }, PRICE_RE.source);

  return price;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    locale: 'ko-KR',
  });

  let anyUpdated = false;
  const date = today();

  for (const product of config.products) {
    console.log(`[${product.id}] 크롤링: ${product.url}`);
    const page = await context.newPage();
    let price = null;

    try {
      if (product.company === 'samsung') {
        price = await fetchSamsungPrice(page, product.url);
      }
    } catch (err) {
      console.error(`[${product.id}] 오류:`, err.message);
    } finally {
      await page.close();
    }

    if (!price) {
      console.warn(`[${product.id}] 기준가 추출 실패`);
      continue;
    }

    console.log(`[${product.id}] 기준가: ${price} (${date})`);

    const dataPath = path.join(ROOT, product.dataFile);
    const history = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const idx = history.findIndex(h => h.date === date);
    if (idx >= 0) history[idx].price = price;
    else { history.push({ date, price }); history.sort((a, b) => a.date.localeCompare(b.date)); }

    fs.writeFileSync(dataPath, JSON.stringify(history, null, 2));
    anyUpdated = true;
  }

  await browser.close();
  if (!anyUpdated) { console.log('업데이트된 데이터 없음'); process.exit(1); }
  console.log('완료');
}

run().catch(err => { console.error(err); process.exit(1); });
