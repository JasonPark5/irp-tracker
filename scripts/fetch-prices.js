/**
 * 삼성생명 IRP 펀드 기준가 자동 수집
 *
 * 핵심 로직:
 *  1. 페이지 로드 시 모든 JSON 응답을 가로채서 stndYmd/stndPrc 키로 가격 추출
 *  2. 추출된 모든 날짜에 대해 history에 없는 날짜만 추가 (누락된 날짜 자동 보충)
 *  3. API 인터셉트 실패 시 DOM에서 기준가 라벨 옆 값 탐색 (today() 기준 저장)
 *  4. 가격 검증: 500~50000 범위, 날짜 패턴(YYYY.MM.DD) 자동 제외
 */
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/products.json'), 'utf8'));

function todayKST() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/* ── 가격 검증 ──────────────────────────────────────────── */
function isValidPrice(v) {
  return typeof v === 'number' && !isNaN(v) && v >= 500 && v <= 50000;
}

/* ── 날짜 변환 ──────────────────────────────────────────── */
// "20260422" → "2026-04-22"
function ymdToDate(ymd) {
  const s = String(ymd).trim();
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

/* ── JSON 응답 재귀 파싱: stndYmd + stndPrc 짝 추출 ───── */
function extractFromJson(obj, result, depth = 0) {
  if (depth > 10 || !obj) return;
  if (Array.isArray(obj)) { obj.forEach(i => extractFromJson(i, result, depth + 1)); return; }
  if (typeof obj !== 'object') return;

  // 삼성생명 표준 응답 형식
  if (obj.stndYmd && obj.stndPrc != null) {
    const date  = ymdToDate(obj.stndYmd);
    const price = parseFloat(String(obj.stndPrc).trim());
    if (date && isValidPrice(price)) result[date] = price;
  }

  // 다른 키 이름 변형 (혹시 API 변경 대비)
  const dateKey  = ['stndYmd','baseDate','date','ymd','dt'].find(k => obj[k]);
  const priceKey = ['stndPrc','basePrc','price','prc','nav'].find(k => obj[k] != null);
  if (dateKey && priceKey) {
    const v = String(obj[dateKey]).trim();
    let date = ymdToDate(v);
    if (!date) {
      const m = v.match(/^(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})$/);
      if (m) date = `${m[1]}-${m[2]}-${m[3]}`;
    }
    const price = parseFloat(String(obj[priceKey]).trim().replace(/,/g,''));
    if (date && isValidPrice(price)) result[date] = price;
  }

  Object.values(obj).forEach(v => extractFromJson(v, result, depth + 1));
}

/* ── DOM 가격 추출 (fallback) ───────────────────────────── */
// (?!\.\d) : 뒤에 .숫자가 오면 날짜이므로 제외
const DOM_PRICE_RE = /\b([1-9]\d{3}(?:,\d{3})*\.\d{2})(?!\.\d)/g;

async function fetchSamsungPrices(page, url) {
  const intercepted = {};

  page.on('response', async resp => {
    const ct = resp.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try {
      const body = await resp.json();
      extractFromJson(body, intercepted);
    } catch {}
  });

  console.log(`  로드: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    console.warn(`  네비게이션 타임아웃: ${e.message}`);
  }
  await page.waitForTimeout(5000); // API 응답 대기

  if (Object.keys(intercepted).length) {
    console.log(`  API 인터셉트: ${Object.keys(intercepted).length}건 (${Object.keys(intercepted).sort().slice(-3).join(', ')})`);
    return { source: 'api', prices: intercepted };
  }

  // ── DOM fallback ──
  console.log(`  API 인터셉트 실패, DOM 탐색 시도`);
  const domPrice = await page.evaluate((reSrc) => {
    const RE = new RegExp(reSrc, 'g');

    function pickPrice(text) {
      const matches = [...text.replace(/\s/g,'').matchAll(RE)].map(m => parseFloat(m[1].replace(/,/g,'')));
      return matches.find(v => v >= 500 && v <= 50000) ?? null;
    }

    // 기준가 라벨 인근 탐색
    const els = [...document.querySelectorAll('th, td, dt, dd, span, p, div')];
    for (const el of els) {
      if (!/기준가/.test(el.textContent)) continue;
      const candidates = [
        el.nextElementSibling,
        el.closest('tr')?.querySelector('td:last-child'),
        el.closest('dl')?.querySelector('dd'),
      ].filter(Boolean);
      for (const c of candidates) {
        const v = pickPrice(c.textContent);
        if (v) return v;
      }
      const v = pickPrice(el.textContent);
      if (v) return v;
    }

    // 마지막 수단: 전체 텍스트 노드 스캔
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const v = pickPrice(node.textContent);
      if (v) return v;
    }
    return null;
  }, DOM_PRICE_RE.source);

  if (domPrice) {
    console.log(`  DOM 추출 성공: ${domPrice} (저장 날짜: today)`);
    return { source: 'dom', prices: { [todayKST()]: domPrice } };
  }
  return { source: 'fail', prices: {} };
}

/* ── 메인 ────────────────────────────────────────────────── */
async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    locale: 'ko-KR',
  });

  let totalAdded = 0;
  console.log(`실행 시각 (KST): ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);

  for (const product of config.products) {
    console.log(`\n[${product.id}] ${product.name}`);
    const page = await context.newPage();

    let result = { source: 'skip', prices: {} };
    try {
      if (product.company === 'samsung') {
        result = await fetchSamsungPrices(page, product.url);
      } else {
        console.warn(`  미지원 회사: ${product.company}`);
      }
    } catch (err) {
      console.error(`  오류: ${err.message}`);
    } finally {
      await page.close();
    }

    if (!Object.keys(result.prices).length) {
      console.warn(`  추출 실패`);
      continue;
    }

    // 기존 history와 머지
    const dataPath = path.join(ROOT, product.dataFile);
    const history  = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const existing = new Map(history.map(h => [h.date, h.price]));

    let added = 0, updated = 0;
    for (const [date, price] of Object.entries(result.prices)) {
      if (!existing.has(date)) {
        history.push({ date, price });
        added++;
      } else if (existing.get(date) !== price) {
        // 임시 가격이 확정 가격으로 갱신된 경우 등
        const idx = history.findIndex(h => h.date === date);
        history[idx].price = price;
        updated++;
      }
    }

    if (added || updated) {
      history.sort((a, b) => a.date.localeCompare(b.date));
      fs.writeFileSync(dataPath, JSON.stringify(history, null, 2));
      console.log(`  저장: 신규 ${added}건, 갱신 ${updated}건`);
      totalAdded += added + updated;
    } else {
      console.log(`  변경 없음`);
    }
  }

  await browser.close();
  console.log(`\n총 ${totalAdded}건 변경`);
  if (!totalAdded) process.exit(1); // 변경 없으면 커밋 스킵
}

run().catch(err => { console.error(err); process.exit(1); });
