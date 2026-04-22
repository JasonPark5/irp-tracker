# IRP 수익률 트래커

GitHub Actions로 매일 자동 크롤링하고 GitHub Pages로 서빙하는 IRP 펀드 수익률 대시보드입니다.

## 기능

- 평일 오후 6시(KST) 자동 기준가 크롤링 (Playwright)
- 누적 수익률, 평가금액, 손익 실시간 표시
- 기준가 추이 / 수익률 차트 (Chart.js)
- N개 상품 추가 가능한 탭 구조
- 완전 무료 (GitHub Actions + GitHub Pages)

## 설정

### GitHub Pages 활성화

1. 레포 → **Settings** → **Pages**
2. Source: **Deploy from a branch** → branch: `main`, folder: `/ (root)`
3. 저장

### 상품 추가

`config/products.json`에 항목을 추가하고 `data/` 폴더에 빈 JSON 파일(`[]`)을 생성합니다.

```json
{
  "products": [
    {
      "id": "samsung-1277",
      "name": "삼성생명 IRP 펀드 (1277)",
      "company": "samsung",
      "dataFile": "data/samsung-1277.json",
      "url": "https://www.samsunglife.com/individual/products/pension/PDP-PRREA990110M/1277/1277",
      "purchasePrice": 2707.97,
      "purchaseDate": "2026-03-05",
      "units": 5665911,
      "currency": "KRW"
    }
  ]
}
```

### 수동 크롤링 실행

```bash
npm install
node scripts/fetch-prices.js
```

### GitHub Actions 수동 실행

레포 → **Actions** → **Fetch IRP Prices** → **Run workflow**

## 파일 구조

```
irp-tracker/
├── index.html                        # 대시보드
├── config/products.json              # 상품 설정
├── data/samsung-1277.json            # 기준가 이력
├── scripts/fetch-prices.js           # Playwright 크롤러
├── .github/workflows/fetch-prices.yml
└── package.json
```
