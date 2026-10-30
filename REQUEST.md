# 審查請求：AttendPoint 佛堂點名加分系統（GitHub Pages ＋ Google Apps Script）

## 給審查者的指示

- **只做審查，不修改任何檔案**：程式碼、文件、測試都不要改，也不要 commit、push，或執行會改動 Google 試算表、Apps Script 的動作。唯一要建立的是下面的結果檔。
- 依嚴重度列出發現：**嚴重 / 高 / 中 / 低 / 建議**。每一項寫出：
  - 檔案與行號（以 repo 內的路徑為準，例如 `src/Code.js:149`）
  - 問題是什麼、在什麼情況下會發生、發生後的結果
  - 建議的修正方向（不用寫出完整程式碼）。如果修正會動到後台檔案（`src/store.js`、`src/auth.js`、`src/migrate-v2.js`、`src/Code.js`），請註明「需更新後台」，因為後台要另外部署到 Apps Script。
  - 標示 **「確定」** 或 **「推測」**：確定 = 有程式碼依據，或可以用測試、模擬環境重現；推測 = 需要真實 Google Apps Script 環境、Google 文件或更多資訊才能確認，請寫出需要確認什麼。
- 結果寫到 repo 根目錄的新檔案：`FINDINGS.md`（不要 commit）。
- 下面的「已驗證事項」僅供參考，請仍然獨立判斷，不要因為列為已驗證就略過。
- 回覆與結果檔請用**繁體中文**。
- repo 是公開的，結果中不要寫入真實學員資料、PIN 或任何憑證；程式碼中的名字都是假資料。

## 系統目的

- 佛堂班程使用的點名、加減分、禮品兌換系統。多位服務人員用手機同時操作，取代原本單機版的 v2（根目錄 `AttendPoint.html`）。
- **網頁**放在 GitHub Pages：原生 JavaScript、沒有框架，建置時合併成單一 HTML；推送到 `main` 由 `.github/workflows/pages.yml` 自動測試、建置、發布。
- **後台**是 Google Apps Script（`src/Code.js`）：網頁以 `fetch` POST 純文字 JSON 呼叫 `doPost`。部署的執行身分為部署者，存取權為「所有人」，所以後台網址是公開的。
- **資料**存在部署者的 Google 試算表隱藏工作表，以 JSON 分段存放：`_data` 和 `_data_2` 輪流寫入，Script Properties 的 `DATA_SHEET` 指向目前使用中的那個；另有 `_backup_*` 備份、`_logo` 存 LOGO。帳號存在 Script Properties 的 `USERS`。
- **三級權限**：訪客（唯讀、學員名字遮蔽）／壇務（不能刪除）／擁有者（全部）。帳號以 PIN 登入。**權限一律由後台檢查**；網頁上的檢查只用來決定按鈕顯示與否。
- `src/store.js`、`src/auth.js`、`src/migrate-v2.js` **前後端共用**：網頁用來做樂觀更新，後台用來做最終驗證與寫入。
- 另有單機版 `dist/AttendPoint.html`：同一套介面與規則，資料存在瀏覽器 localStorage。
- 背景與設計說明：`CLAUDE.md`、`docs/data-model.md`（資料結構、所有操作、增量同步規則）、`docs/permissions.md`、`docs/deploy-gas.md`（部署、寫入安全、備份）、`docs/stress-test.md`（效能量測）。

## 審查範圍

- **基準**：`main` 的最新 commit `0f8c508`（共 28 個 commit），**整個 repo 都要審查**，不是只看最近的修改。
- **排除**：根目錄 `AttendPoint.html`（舊版 v2，只當移轉測試資料）、`dist/`（建置產物，不在 repo 裡）。
- 主要檔案（總共約 7,700 行，含測試與腳本）：

| 區塊 | 檔案 | 內容 |
|---|---|---|
| 資料層 | `src/store.js`（1055 行） | 所有修改經 `apply(state, op)`（先整份複製，失敗時原資料不變）；積分由流水帳 `logs` 計算；軟刪除；`appendOnly` 判斷是否更換 `meta.syncId`；`sessionOf` 依日期自動建立課次 |
| 權限 | `src/auth.js`（324 行） | `authorize`（擁有者限定的操作、壇務只能撤銷自己今天的紀錄、壇務不能移除小隊與規則）、`viewFor`（訪客遮蔽）、`syncView`／`mergeView`（增量同步）、PIN 雜湊、帳號操作 |
| 移轉 | `src/migrate-v2.js`（362 行） | v2 資料轉換、`loadAny()` |
| 後台 | `src/Code.js`（551 行） | `doPost` 白名單、登入 token（CacheService，6 小時自動延長）、錯誤 5 次鎖定、`LockService`、`writeData_` 輪流寫入與檢查、`readState_` 讀不到時拒絕、備份清理、LOGO、報表工作表、版本指紋 |
| 介面 | `src/ui/*.js` | `backend.js`（雲端 fetch／單機 localStorage、增量合併）、`app.js`（樂觀更新佇列、外框、LOGO）、`lib.js`（`App.html` 自動跳脫樣板）、各分頁 `view-*.js` |
| 設定 | `src/config.js` | 後台網址 `GAS_URL`（公開，不是秘密） |
| 建置與發布 | `scripts/build.js`、`.github/workflows/pages.yml` | 產生單機版、Pages 網頁、後台；後台版本指紋寫進兩邊，網頁比對不同時提示更新後台 |
| 模擬與量測 | `scripts/gas-mock.js`、`scripts/gas-sim.js`、`scripts/stress.js` | Node／瀏覽器模擬 Apps Script；壓力測試 |
| 測試 | `tests/*.test.js`、`tests/e2e/*.e2e.js` | 單元測試（node:test）、瀏覽器測試（Playwright） |

## 如何執行

需要 Node.js 22 以上，不需安裝套件：

```bash
npm test
```

```bash
npm run build
```

```bash
npm run stress
```

瀏覽器測試需要 Playwright：

```bash
npm install --no-save playwright
```

```bash
npx playwright install chromium
```

```bash
npm run e2e
```

`npm run gas-sim` 會產生 `dist/gas-sim.html`，在瀏覽器模擬整套雲端版（擁有者 PIN `246810`，資料只在記憶體）。

## 已驗證事項（請仍獨立判斷）

- **自動測試（2026-10-30）**
  - `npm test`：73 項全過（資料層、權限、增量同步、v2 移轉、後台在 Node 模擬環境的完整流程、寫入失敗、資料工作表遺失或損壞、備份清理、`doPost` 白名單、LOGO、建置設定）。
  - `npm run e2e`：23 項全過，分單機版與模擬雲端版兩組。內容包括：建班、名冊、點名、加減分、兌換、撤銷、重新開啟、名字含 HTML、訪客遮蔽、壇務權限、多裝置增量同步、寫入失敗退回、登入逾時、後台版本提示、存取權錯誤提示、服務人員點名、LOGO 上傳、職務選單。
  - GitHub Actions「發布網頁」每次推送都會跑 `npm test` 並發布。
- **壓力測試**（Node、記憶體模擬試算表，見 `docs/stress-test.md`）
  - 中型規模（3 班 × 50 人、一年）約 4.3 MB。
  - 一次點名回傳由整份 4.3 MB 降到約 59 KB；資料沒變時輪詢約 0.2 KB。
- **實際部署**：擁有者個人 Google 帳號、一個班試行。已確認的項目有：
  - 後台 `doGet` 正常回應「後台運作中」。
  - GitHub Pages 網頁可以連到後台。
  - 後台版本提示正常。
  - LOGO 上傳。
  - 手機上點名、加分。
- **未驗證**
  - 真實 Apps Script 上的速度、配額，以及多人同時點名時的鎖定等待（模擬環境沒有網路與試算表延遲）。
  - CacheService 提早清除時的影響：token 失效、版本快取遺失。
  - 一整年資料量在真實試算表上的讀寫時間。
  - 跨年度結算、v2 資料匯入、轉移到公用帳號（`docs/deploy-gas.md` 第 8 節）在真實環境的操作。
  - iOS「加入主畫面」使用 data URI 的 apple-touch-icon。

## 已知問題（上一次審查找到，尚未修正，請確認或補充）

上一次只審查了最新的修改（階段 6-5：服務人員職務改為下拉選單）：

1. `src/store.js:610` 的 `staffFields` 不檢查職務。四個職務（點傳師、主壇務、副主壇務、護持壇務）只由畫面的下拉選單限制，透過後台 API、匯入資料或舊版快取網頁，仍可存入其他職務。
2. `tests/e2e/standalone.e2e.js:139` 用 `hasText: '主壇務'` 等待，部分比對也會符合「副主壇務」。
3. 編輯舊職務時以「（舊）」顯示並保留的功能（`src/ui/view-manage.js:436`），沒有 e2e 測試。
4. 編輯舊職務的人時誤選其他職務，只能取消對話框才能回到舊職務。
5. `tests/store.test.js:216`、`tests/auth.test.js:46`、`scripts/stress.js:90` 仍使用舊職務（講師、輔導）當測試資料。

## 希望審查的重點

1. **權限與安全（最優先）**：後台網址公開，任何人都能直接呼叫 `doPost`，請特別注意。
   - **權限能否被繞過**：`apiApply` → `AttendAuth.authorize` → `AttendStore.apply`。壇務能否透過自己組的 op（例如在 `points.award`、`class.update`、`student.import`、`session.save` 的參數中夾帶欄位）做到刪除、校正、改別人的紀錄，或撤銷非今天、非本人的紀錄？訪客能否寫入，或讀到未遮蔽的名字、備註、操作者？
   - **`doPost`**：白名單、參數型態（傳物件、陣列、超大字串）、錯誤時是否洩漏內部資訊。
   - **登入**：PIN 雜湊（`hashPin`，SHA-256 500 輪加 salt）、錯誤 5 次鎖定（以 CacheService 計數）、token 存在 CacheService 並自動延長、停用或刪除帳號後 token 失效。對公開的後台而言是否足夠？例如能否針對不同帳號輪流猜 PIN。
   - **XSS**：介面用 `App.html` 樣板自動跳脫。有沒有地方用到未跳脫的字串（`innerHTML`、屬性、`App.raw`、CSV 匯出、`textContent` 以外的寫法）？LOGO 只接受 `data:image/(png|jpeg|webp);base64,` 是否足夠？
2. **資料正確性**
   - **積分與出席**：`computeTotals`、撤銷（`log.reverse`）、扣分不低於 0（`clampDelta`）、兌換、手動校正、團體加分、跨年度結算、v2 移轉（`migrate-v2.js`），有沒有算錯的情況？
   - **課次自動建立**：`sessionOf` 依日期建立課次，同一天、同一班會不會重複建立？改課次日期後會怎樣？
3. **增量同步**（`AttendAuth.syncView`／`mergeView`、`store.js` 的 `appendOnly`、`Code.js` 的 `SYNC_KEY` 快取）
   - 有沒有情況會讓網頁資料與試算表不一致，或讓訪客拿到不該看到的資料？例如多人同時操作、刪除或還原學員、跨年度結算、匯入資料、訪客與壇務切換、快取與試算表不同步。
   - `GasBackend.sync` 同時發出多個請求（輪詢與操作重疊）時，`base` 的更新順序。
4. **寫入安全與並行**（`Code.js`）
   - `writeData_` 寫到另一個工作表、`SpreadsheetApp.flush` 後檢查最後一段再切換 `DATA_SHEET`，這樣有沒有遺失或覆蓋資料的情況？
   - `readState_` 不加鎖讀取，遇到寫入中途或連續寫入時的行為。
   - `LockService` 的範圍：`apiUserOp`、`apiSetLogo` 與 `apiApply` 之間。
   - 備份清理 `pruneBackups_` 會不會刪錯（例如跨年度結算的備份）。
5. **樂觀更新**（`src/ui/app.js` 的 `OPTIMISTIC`、`queue`、`replayPending`、`confirmed`）
   - 後台失敗時畫面能否正確退回。
   - 連續快速操作、與 30 秒輪詢同時發生時。
   - 本機套用成功但後台拒絕（例如其他裝置已改過）時。
6. **Apps Script 的限制**：儲存格 5 萬字上限（目前每格 4 萬字）、單次執行時間、CacheService 的大小與保存期限、PropertiesService 單一值 9 KB 上限（`USERS` 帳號清單會不會超過）、每日配額。在一年份、數個班的資料量下，是否會出問題？
7. **建置與發布**（較低優先）
   - `scripts/build.js` 的版本指紋：涵蓋範圍是否正確。
   - 內嵌腳本的跳脫（`</script>`）。
   - `pages.yml` 的權限設定。
   - `src/config.js` 被改錯時的行為。
8. **測試本身**（較低優先）：有沒有測試其實沒驗證到它聲稱的事（例如等待條件太寬、比對用部分字串）。

## 參考：近期修改（最新在上）

| commit | 內容 |
|---|---|
| `0f8c508` | 階段 6-5：服務人員職務改為點傳師、主壇務、副主壇務、護持壇務 |
| `2c45470` | 階段 6-4：LOGO 由擁有者上傳，不放進 GitHub |
| `c73be12` | 階段 6-3：服務人員在點名頁直接點名（`session.duty`） |
| `2dc20fd` | 階段 6-2：網頁改放 GitHub Pages，Apps Script 只當後台 |
| `e7acb41` | 階段 6-1：第一次點名不必等後端建立課次 |
| `3a384d7` 以前 | 階段 4（壓力測試、增量同步、寫入安全、備份清理、瀏覽器測試）與階段 0–3（資料層、權限、後台、介面） |

完整列表：`git log --oneline`。
