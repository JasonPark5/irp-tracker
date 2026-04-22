const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/products.json'), 'utf8'));

function today() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchSamsungPrice(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  // 기준가 로드 대기 — 삼성생명 SPA는 숫자 데이터를 동적으로 렌더링
  await page.waitForTimeout(3000);

  const price = await page.evaluate(() => {
    // 방법 1: 기준가 라벨 옆 값
    const labels = Array.from(document.querySelectorAll('th, td, dt, dd, span, p'));
    for (const el of labels) {
      const text = el.textContent.trim();
      if (/기준가/.test(text)) {
        const next = el.nextElementSibling || el.closest('tr')?.querySelector('td:last-child');
        if (next) {
          const val = next.textContent.replace(/[^0-9.]/g, '');
          if (val && parseFloat(val) > 100) return parseFloat(val);
        }
        // 같은 요소 안에 숫자 패턴 탐색
        const m = text.match(/[\d,]+\.\d{2}/);
        if (m) return parseFloat(m[0].replace(/,/g, ''));
      }
    }

    // 방법 2: 4자리 숫자 + 소수점 2자리 패턴 (기준가 범위: 1000~9999)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const candidates = [];
    let node;
    while ((node = walker.nextNode())) {
      const m = node.textContent.match(/\b([1-9]\d{3})\.\d{2}\b/);
      if (m) candidates.push(parseFloat(m[0]));
    }
    if (candidates.length) return candidates[0];

    return null;
  });

  return price;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    locale: 'ko-KR',
  });

  let anyUpdated = false;
  const date = today();

  for (const product of config.products) {
    console.log(`[${product.id}] 크롤링 시작: ${product.url}`);
    const page = await context.newPage();

    let price = null;
    try {
      if (product.company === 'samsung') {
        price = await fetchSamsungPrice(page, product.url);
      }
      // 추가 회사는 여기에 분기 추가
    } catch (err) {
      console.error(`[${product.id}] 오류:`, err.message);
    } finally {
      await page.close();
    }

    if (!price) {
      console.warn(`[${product.id}] 기준가 추출 실패, 건너뜀`);
      continue;
    }

    console.log(`[${product.id}] 기준가: ${price} (${date})`);

    const dataPath = path.join(ROOT, product.dataFile);
    const history = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    if (history.some(h => h.date === date)) {
      console.log(`[${product.id}] 이미 오늘 데이터 존재, 업데이트`);
      const idx = history.findIndex(h => h.date === date);
      history[idx].price = price;
    } else {
      history.push({ date, price });
      history.sort((a, b) => a.date.localeCompare(b.date));
    }

    fs.writeFileSync(dataPath, JSON.stringify(history, null, 2));
    anyUpdated = true;
  }

  await browser.close();

  if (!anyUpdated) {
    console.log('업데이트된 데이터 없음');
    process.exit(1);
  }
  console.log('완료');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
