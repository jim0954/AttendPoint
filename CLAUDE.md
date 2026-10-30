# AttendPoint 開發說明（給 Claude）

佛堂點名加分系統。使用者以繁體中文溝通，commit 訊息、介面文字、文件都用繁體中文。

## 工作規則

- **每個階段獨立 commit**，階段太大就拆成多次 commit；訊息開頭標註「階段 N-x：」，完成後 push 到 `main`。
- 修改資料規則一定要補測試，`npm test` 全部通過才 commit。
- 介面改完要跑 `npm run e2e`（瀏覽器自動化測試，單機版＋模擬雲端版），新功能要補對應的 e2e 步驟；必要時再用瀏覽器實際操作驗證（`npm run gas-sim` 可模擬雲端版）。
- 不要把真實學員資料、PIN、`.clasp.json`，以及佛堂 LOGO 等組織圖檔放進 repo（repo 是公開的）；範例名字一律用假資料。LOGO 由擁有者從網頁上傳，存在後台 `_logo` 工作表。
- 網頁推到 `main` 會自動發布；改到後台檔案（`store.js`、`auth.js`、`migrate-v2.js`、`Code.js`）時，回報中要提醒使用者更新 Apps Script（`npm run build` → `clasp push` → 發布新版本），網頁也會自動顯示「後台程式需要更新」。

## 架構

| 路徑 | 說明 |
|---|---|
| `src/store.js` | 資料層：所有修改經 `apply(state, op)`，積分由流水帳計算，刪除為軟刪除（前後端共用） |
| `src/auth.js` | 三級權限：訪客／壇務（不能刪除）／擁有者（前後端共用） |
| `src/migrate-v2.js` | v2 資料移轉、`loadAny()` |
| `src/Code.js` | Google Apps Script 後台：`doPost` 接收網頁 fetch 的 API 呼叫 |
| `src/config.js` | 雲端版設定（後台網址 `GAS_URL`） |
| `.github/workflows/pages.yml` | 推送到 `main` 時測試、建置並發布網頁到 GitHub Pages |
| `src/ui/` | 網頁介面（原生 JS，`App.html` 樣板自動跳脫） |
| `scripts/build.js` | 產生 `dist/AttendPoint.html`（單機版）、`dist/web/`（GitHub Pages）與 `dist/gas/`（後台，含版本指紋） |
| `docs/` | 資料結構、權限、部署說明 |

需要 Node.js 18 以上（`npm test` 需要 22 以上），不需安裝套件。

## 目前進度

- 階段 0–3 完成（資料層、權限、GAS 後端、網頁介面），另含調整 3-7 小隊選填、3-8 彈性常態上課時間。
- 階段 4-1 壓力測試（`npm run stress`，見 `docs/stress-test.md`）、4-2 雲端只傳變動（`meta.syncId`、`AttendAuth.syncView`）、4-3 寫入安全（`_data`／`_data_2` 輪流寫入，`DATA_SHEET` 屬性切換）、4-4 備份清理（保留最新 `BACKUP_KEEP` 份，跨年度結算備份不刪）、4-5 瀏覽器自動化測試（`tests/e2e/`，`npm run e2e`）完成。
- 階段 5-1 部署文件補充：部署帳號的選擇、先用個人帳號試行一個班再轉移到公用帳號（`docs/deploy-gas.md` 第 0、6 節）。
- 階段 6 試行中（擁有者個人帳號、一個班）。6-1：點名／加分改送上課日期，課次在同一個操作中建立，第一次點名不必等後端。
- 6-2：改成與 CarTracker 相同的架構——網頁放 GitHub Pages（Actions 自動發布），Apps Script 只當後台（`doPost`），網頁比對後台版本指紋。
- 6-3：服務人員在點名頁直接點名（`session.duty`，記入課次執勤 `dutyStaffIds`）。
- 6-4：LOGO 由擁有者在「系統與備份」上傳，存在後台（`apiGetLogo`／`apiSetLogo`），不放進 repo。
- 6-5：服務人員職務固定為點傳師、主壇務、副主壇務、護持壇務（`AttendStore.STAFF_ROLES`，後台也檢查）。6-6～6-8：外部審查（`REQUEST.md`，結果 `FINDINGS.md` 不進 repo）與修正，處理結果記在 `REQUEST.md` 的「已知問題」。
- 尚未部署到真正的 Google Apps Script 實測（階段 4 其餘測試、階段 5 GitHub 門面與部署、階段 6 佛堂試行）。
- 根目錄 `AttendPoint.html` 是 v2 舊版，`tests/migrate-v2.test.js` 用它當移轉測試資料。
