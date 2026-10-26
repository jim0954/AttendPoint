# AttendPoint 開發說明（給 Claude）

佛堂點名加分系統。使用者以繁體中文溝通，commit 訊息、介面文字、文件都用繁體中文。

## 工作規則

- **每個階段獨立 commit**，階段太大就拆成多次 commit；訊息開頭標註「階段 N-x：」，完成後 push 到 `main`。
- 修改資料規則一定要補測試，`npm test` 全部通過才 commit。
- 介面改完要跑 `npm run e2e`（瀏覽器自動化測試，單機版＋模擬雲端版），新功能要補對應的 e2e 步驟；必要時再用瀏覽器實際操作驗證（`npm run gas-sim` 可模擬雲端版）。
- 不要把真實學員資料、PIN 或 `.clasp.json` 放進 repo；範例名字一律用假資料。

## 架構

| 路徑 | 說明 |
|---|---|
| `src/store.js` | 資料層：所有修改經 `apply(state, op)`，積分由流水帳計算，刪除為軟刪除（前後端共用） |
| `src/auth.js` | 三級權限：訪客／壇務（不能刪除）／擁有者（前後端共用） |
| `src/migrate-v2.js` | v2 資料移轉、`loadAny()` |
| `src/Code.js` | Google Apps Script 後端 |
| `src/ui/` | 網頁介面（原生 JS，`App.html` 樣板自動跳脫） |
| `scripts/build.js` | 產生 `dist/AttendPoint.html`（單機版）與 `dist/gas/` |
| `docs/` | 資料結構、權限、部署說明 |

需要 Node.js 18 以上，不需安裝套件。

## 目前進度

- 階段 0–3 完成（資料層、權限、GAS 後端、網頁介面），另含調整 3-7 小隊選填、3-8 彈性常態上課時間。
- 階段 4-1 壓力測試（`npm run stress`，見 `docs/stress-test.md`）、4-2 雲端只傳變動（`meta.syncId`、`AttendAuth.syncView`）、4-3 寫入安全（`_data`／`_data_2` 輪流寫入，`DATA_SHEET` 屬性切換）、4-4 備份清理（保留最新 `BACKUP_KEEP` 份，跨年度結算備份不刪）、4-5 瀏覽器自動化測試（`tests/e2e/`，`npm run e2e`）完成。
- 尚未部署到真正的 Google Apps Script 實測（階段 4 其餘測試、階段 5 GitHub 門面與部署、階段 6 佛堂試行）。
- 根目錄 `AttendPoint.html` 是 v2 舊版，`tests/migrate-v2.test.js` 用它當移轉測試資料。
