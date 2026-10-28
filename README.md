# AttendPoint 佛堂點名加分系統

佛堂班程使用的報到、加減分、換禮系統。網頁放在 GitHub Pages，資料存在 Google 試算表（由 Google Apps Script 後台讀寫），多位服務人員可以用手機一起點名；也可以單機離線使用。

## 功能

- **點名加分**：一鍵報到、依班別規則加扣分、自訂事由、小隊／全體加減分、撤銷紀錄
- **榮譽榜**：個人榮譽榜、小隊競賽；榮譽總分不因兌換減少
- **好禮兌換**：禮品目錄管理、以可用點數兌換
- **學員名冊**：新增、編輯、換隊升班、CSV／Excel／LINE 貼上批次匯入、匯出報表
- **班務管理**：動態班別、小隊、加扣分項目、常態上課時間、課次與執勤、服務人員護持統計
- **三級權限**：訪客（唯讀、名字遮蔽）／壇務（不能刪除）／擁有者（全部），由後端檢查
- **兩種用法**：雲端版（GitHub Pages 網頁 + Google Apps Script 後台，多人共用）或單機版（一個 HTML 檔，資料存在瀏覽器）

## 使用方式

需要 Node.js 18 以上（執行 `npm test` 需要 22 以上），不需安裝任何套件：

```bash
npm run build
```

- 雲端版：依照 [docs/deploy-gas.md](docs/deploy-gas.md) 部署後台（`dist/gas/`）並開啟 GitHub Pages；網頁在推送到 `main` 時自動發布
- 單機版：用瀏覽器開啟 `dist/AttendPoint.html`

## 文件

- [資料結構](docs/data-model.md)
- [權限與帳號](docs/permissions.md)
- [部署（GitHub Pages + Google Apps Script）](docs/deploy-gas.md)
- [壓力測試](docs/stress-test.md)

## 開發

```bash
npm test
```

```bash
npm run gas-sim
```

```bash
npm run stress
```

壓力測試結果見 [docs/stress-test.md](docs/stress-test.md)。

瀏覽器自動化測試（用真的瀏覽器操作單機版與模擬雲端版的畫面）需要 Playwright，只有這項要另外安裝：

```bash
npm install --no-save playwright
```

```bash
npx playwright install chromium
```

```bash
npm run e2e
```

沒有安裝 Playwright 時，`npm run e2e` 會略過並提示安裝方式；`npm test` 不需要安裝任何東西。

| 路徑 | 說明 |
|---|---|
| `src/store.js` | 資料層（前後端共用） |
| `src/auth.js` | 權限規則（前後端共用） |
| `src/migrate-v2.js` | v2 資料移轉 |
| `src/Code.js` | Google Apps Script 後台（`doPost` 提供網頁呼叫的 API） |
| `src/config.js` | 雲端版設定：後台網址 `GAS_URL` |
| `src/ui/` | 網頁介面 |
| `scripts/build.js` | 產生 `dist/`（單機版、`dist/web/` GitHub Pages 網頁、`dist/gas/` 後台） |
| `.github/workflows/pages.yml` | 推送到 `main` 時測試、建置並發布網頁 |
| `tests/` | 單元測試（`npm test`）；`tests/e2e/` 瀏覽器自動化測試（`npm run e2e`） |
| `AttendPoint.html` | v2 舊版（保留作為移轉測試資料） |

## 隱私說明

學員名冊與積分資料只存在瀏覽器或 Google 試算表中，**不會**放進這個 repo。程式碼內的名字都是範例假資料。
