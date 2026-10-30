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
- **安全性是這次的必審項目**：下面「安全性審查（必做）」的每一點都要有結論（有問題就列出；沒問題也請寫一句「已檢查，未發現問題」與檢查方式），不能只看程式正確性。
- 回覆與結果檔請用**繁體中文**。
- repo 是公開的，結果中不要寫入真實學員資料、PIN 或任何憑證；程式碼中的名字都是假資料。

## 系統目的

- 佛堂班程使用的點名、加減分、禮品兌換系統。多位服務人員用手機同時操作，取代原本單機版的 v2（根目錄 `AttendPoint.html`）。
- **網頁**放在 GitHub Pages：原生 JavaScript、沒有框架，建置時合併成單一 HTML；推送到 `main` 由 `.github/workflows/pages.yml` 自動測試、建置、發布。
- **後台**是 Google Apps Script（`src/Code.js`）：網頁以 `fetch` POST 純文字 JSON 呼叫 `doPost`。部署的執行身分為部署者，存取權為「所有人」，所以後台網址是公開的。
- **資料**存在部署者的 Google 試算表隱藏工作表，以 JSON 分段存放：`_data` 和 `_data_2` 輪流寫入，Script Properties 的 `DATA_SHEET` 指向目前使用中的那個；另有 `_backup_*` 備份、`_logo` 存 LOGO。帳號存在 Script Properties 的 `USERS`（帳號多時分段為 `USERS_2`…）。
- **三級權限**：訪客（唯讀、學員名字遮蔽）／壇務（不能刪除）／擁有者（全部）。帳號以 PIN 登入。**權限一律由後台檢查**；網頁上的檢查只用來決定按鈕顯示與否。
- `src/store.js`、`src/auth.js`、`src/migrate-v2.js` **前後端共用**：網頁用來做樂觀更新，後台用來做最終驗證與寫入。
- 另有單機版 `dist/AttendPoint.html`：同一套介面與規則，資料存在瀏覽器 localStorage。
- 背景與設計說明：`CLAUDE.md`、`docs/data-model.md`（資料結構、所有操作、增量同步規則）、`docs/permissions.md`、`docs/deploy-gas.md`（部署、寫入安全、備份）、`docs/stress-test.md`（效能量測）。

## 審查範圍

- **基準**：`main` 的最新 commit（`git log -1` 查看；撰寫時為階段 6-10 的最後一個 commit），**整個 repo 都要審查**，不是只看最近的修改。
- **排除**：根目錄 `AttendPoint.html`（舊版 v2，只當移轉測試資料）、`dist/`（建置產物，不在 repo 裡）。
- 主要檔案（總共約 8,700 行，含測試與腳本）：

| 區塊 | 檔案 | 內容 |
|---|---|---|
| 資料層 | `src/store.js`（1064 行） | 所有修改經 `apply(state, op)`（先整份複製，失敗時原資料不變）；積分由流水帳 `logs` 計算；軟刪除；`appendOnly` 判斷是否更換 `meta.syncId`；`sessionOf` 依日期自動建立課次 |
| 權限 | `src/auth.js`（324 行） | `authorize`（擁有者限定的操作、壇務只能撤銷自己今天的紀錄、壇務不能移除小隊與規則）、`viewFor`（訪客遮蔽）、`syncView`／`mergeView`（增量同步）、PIN 雜湊、帳號操作 |
| 移轉 | `src/migrate-v2.js`（367 行） | v2 資料轉換、`loadAny()` |
| 後台 | `src/Code.js`（574 行） | `doPost` 白名單、登入 token（CacheService，6 小時自動延長）、錯誤 5 次鎖定、`LockService`、`writeData_` 輪流寫入與檢查、`readState_` 讀不到時拒絕、備份清理、LOGO、報表工作表、版本指紋 |
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
  - `npm test`：83 項全過（資料層、權限、增量同步、v2 移轉、後台在 Node 模擬環境的完整流程、寫入失敗、資料工作表遺失或損壞、備份清理、`doPost` 白名單、LOGO、建置設定）。
  - `npm run e2e`：28 項全過，分單機版與模擬雲端版兩組。內容包括：建班、名冊、點名、加減分、兌換、撤銷、重新開啟、名字含 HTML、訪客遮蔽、壇務權限、多裝置增量同步、寫入失敗退回、登入逾時、後台版本提示、存取權錯誤提示、服務人員點名、LOGO 上傳、職務選單、舊職務保留、連續操作合併送出、關閉前提醒。
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

## 安全性審查（必做）

### 威脅模型

- **後台網址是公開的**：`src/config.js` 的 `GAS_URL` 寫在公開的 GitHub repo，部署存取權是「所有人」。任何人不用登入就能直接呼叫 `doPost`，可以自己組任何 `{ fn, args }`，也可以大量、並行呼叫。
- **原始碼是公開的**：攻擊者知道所有規則、驗證方式與錯誤訊息。
- **使用者**：壇務是佛堂的服務人員，大多在自己的手機上操作，也可能共用佛堂的平板。訪客（未登入）可以看到點名與榮譽榜，所以學員名字要遮蔽。
- **資料內容**：學員多為兒童，名冊屬於個資，包括姓名、班別、小隊、備註、出席與積分紀錄。
- **不在範圍內**：Google 帳號本身、Apps Script 平台、部署者的試算表共用設定被盜用。但如果系統的設計讓這些風險變大，仍請指出。

### 必須逐項給出結論

1. **身分驗證與暴力破解**（`src/Code.js` 的 `apiLogin`、`checkPin_`、`userFromToken_`；`src/auth.js` 的 `hashPin`、`verifyPin`、`PIN_RE`）
   - PIN 只有 4–8 位數字。錯誤 5 次鎖定 15 分鐘的計數存在 CacheService，而且是「讀取 → 比對 PIN → 寫回」，中間沒有加鎖。**並行送出大量登入請求能不能繞過次數限制？** 照這樣算，猜中 4 位數或 6 位數 PIN 需要多久？
   - 對所有帳號輪流猜（`apiLoginOptions` 會公開帳號清單）、CacheService 提早清除計數，這兩種情況的影響。
   - 另一面：任何人都能故意輸錯 PIN，把所有帳號鎖住（上次審查第 3 項，評估後暫不修，請判斷理由是否成立）。有沒有兩全的做法？
   - token：用兩個 UUID 產生、存在 CacheService、6 小時內有使用就自動延長。登出、停用帳號、修改擁有者 PIN（`OWNER_PIN`）後，舊 token 會不會仍然有效？token 存在 localStorage，在共用裝置上的風險。
2. **授權能否被繞過**（`apiApply`、`apiApplyBatch`（合併送出，每個操作各自檢查）→ `AttendAuth.authorize` → `AttendStore.apply`；`apiUserOp` → `applyUserOp`）
   - 壇務能否自己組 op，做到擁有者才能做的事？例如在 `*.update` 的 patch、`points.*`、`student.import`、`session.save`、`class.update` 的參數中夾帶欄位，造成刪除、還原、改分、改別人的紀錄，或撤銷不是自己、不是今天的紀錄。
   - 壇務能否提升自己的權限、改別人的 PIN、改擁有者主帳號，或讓停用的帳號恢復。
   - 訪客能否寫入任何資料：`apiApply`、`apiApplyBatch`、`apiUserOp`、`apiSetLogo`、`apiImportState`、`apiRebuildReports`、`apiExportBackup`。
3. **資料外洩**（`AttendAuth.viewFor`、`syncView`；`apiLoginOptions`、`apiGetState` 的 `since` 參數）
   - 訪客能否拿到未遮蔽的學員名字、備註、操作者，或回收區的資料？例如偽造 `since.view`、`logCount`，或在登入登出之間切換。
   - 訪客看得到的欄位是否恰當：流水帳的 `reason`（壇務自己輸入的事由、擁有者校正的原因）、服務人員的完整姓名、`apiLoginOptions` 公開的帳號名稱。對公開網址而言，這些合適嗎？
   - 錯誤訊息、`console.error`、回應內容會不會洩漏內部資訊。
4. **輸入驗證與注入**
   - `doPost`：白名單是否完整（有沒有其他全域函式能被呼叫）、`args` 傳物件、陣列、`null`、超大字串時的行為。
   - XSS：介面用 `App.html` 樣板自動跳脫。請找出所有 `innerHTML` 與屬性輸出，確認沒有未跳脫的資料，包括匯入檔、CSV 匯入的名冊、LOGO（只接受 `data:image/(png|jpeg|webp);base64,`）。
   - 試算表與 CSV 的公式注入（階段 6-8 已處理，請確認是否完整）。
   - 匯入：惡意或損壞的備份檔、v2 資料（`migrate-v2.js`），會不會寫入破壞後續讀取的資料，或繞過 store 的欄位驗證。
5. **資源濫用**（推測也可以，請寫出需要確認什麼）
   - 不用登入就能呼叫的 API（`apiLoginOptions`、`apiLogin`、`apiGetState`、`apiGetLogo`）被大量呼叫時，Apps Script 的配額、並行上限、試算表讀取，會不會讓佛堂當天無法點名。
   - 已登入的壇務能否用超大 op（例如上萬筆 `student.import`、很長的文字）讓資料變得過大而無法讀寫。
6. **供應鏈與發布**
   - `.github/workflows/pages.yml` 的權限、使用的 actions 是否固定版本。
   - 公開 repo 中有沒有不該公開的內容（PIN、`.clasp.json`、試算表 ID、真實姓名、組織圖檔）。

## 已知問題（前四次審查找到，請確認或補充）

第一次審查只看了階段 6-5（職務下拉選單），找到 5 項，都已在階段 6-7、6-8 處理。第二次是全 repo 審查（基準 `0f8c508`），找到 16 項，以下依那次的編號列出。第三次是 Claude 的安全性複查，找到 A–C 三項；第四次 Gemini 的安全性審查確認了 A–C，另有幾項低風險發現。

**第三次（Claude，基準 `e134950`）與第四次（Gemini，基準 `699a366`）審查都找到，已在階段 6-10 修正（請確認修正是否正確）：**

- A（高）登入失敗次數沒有加鎖，並行請求可以猜遠超過 5 次。改為在鎖內先記下這次嘗試、再比對 PIN（`apiLogin`）；新設定的 PIN 至少 6 位數（`PIN_RE`），`OWNER_PIN` 少於 6 位時拒絕登入並提示修改。改版前的 4、5 位數壇務 PIN 仍可登入。
- B（中）擁有者的 token 無法撤銷。token 改為記下 PIN 指紋（`tokenValue_`、`pinStamp_`），重設、修改 PIN 或改 `OWNER_PIN` 後舊 token 失效；改版前格式的 token 需要重新登入。
- C（中）訪客看得到自行輸入的事由。訪客畫面只顯示報到、規則、兌換的名稱，其他改為「加分」「扣分」「校正」「撤銷：…」（`AttendAuth.viewFor` 的 `guestReason`）。服務人員姓名與登入清單的帳號名稱維持公開：服務人員是成年志工，登入清單是點選登入所必需。

**第四次審查的其他發現，評估後不修改：**

- CacheService 提早清除會讓鎖定提前解除（低）：A 修正後一輪最多 5 次，提早清除只是偶爾多幾次，配合 6 位數 PIN 仍需數年才能猜中。
- 共用裝置上 token 存在 localStorage（低）：靠使用者按「登出」，登出會立即遮蔽並清除 token。
- 公開 API 被大量呼叫耗盡配額（建議，推測）：Apps Script 沒有可靠的來源識別，自建計數也要讀寫 CacheService，等於多一次負擔。等真實環境出現問題再處理。（審查提到「每日 90 分鐘」是觸發器的限制，網頁應用程式呼叫不適用，請再確認。）
- 第 9 項「舊職務缺少測試」：已在階段 6-7 補上（`tests/e2e/standalone.e2e.js` 的「服務人員：舊職務編輯時以「（舊）」保留，改選後才換掉」）。
- 第 4–8 項：同第二次審查的評估，維持不修改。

**已在階段 6-8 修正（請確認修正是否正確）：**

- 1. 背景重新整理與點名同時進行時，較晚回來的舊讀取回應會蓋掉剛點的名。改為每次讀寫附請求編號，比已採用回應更舊的回應不採用（`src/ui/backend.js` 的 `seq`／`latest`）。
- 2. 帳號清單整份存在一個指令碼屬性，約 35 個帳號就超過 9 KB。改為分段存在 `USERS`、`USERS_2`…（`saveUsers_`）。
- 4. 報表工作表與 CSV 匯出的公式注入。開頭是 `= + - @` 的文字前面補 `'`。
- 6. 登出要等後台回應才遮蔽名字。改為按下就先遮蔽，並丟掉登入時的完整資料。
- 8. 後台不檢查服務人員職務。改由 `store.js` 檢查（`AttendStore.STAFF_ROLES`），舊職務沒改動時保留。
- 9. 後台版本指紋沒有統一換行符號。
- 12. 過長的帳號 id 會讓快取鍵出錯。
- 13. 匯入 v3 備份時沒有檢查結構。
- 10、11、16 在審查基準之後已修正（階段 6-7）。

**評估後暫不修改（請判斷理由是否成立）：**

- 3. 公開登入清單，可被人故意輸錯 PIN 鎖住帳號。後台拿不到來源 IP，拿掉鎖定會讓 4 位數 PIN 可被暴力猜中；改成手動輸入帳號名稱則會讓登入變麻煩。目前是一個班試行，先不改；被鎖住時等 15 分鐘即可再登入。
- 5. `findSession` 只依日期找課次。整個點名頁就是「一班一天一堂」的設計（`App.session` 也只依日期），目前沒有同一天兩堂課的需求。
- 7. `apiRebuildReports` 沒加鎖。報表是唯讀參考、隨時可重建；加上同一把鎖會讓重建期間的點名排隊等待。
- 14. 同一秒內兩次備份會撞名。只有匯入與跨年度結算會備份，而且都在鎖內、由擁有者操作，實務上不會同一秒發生兩次。
- 15. 修改課次日期會連帶改變歷史紀錄的日期。這正是修正選錯日期的方式。
- 第一次審查的第 4 項：編輯舊職務時誤選其他職務，只能取消對話框回到舊職務。影響很小。

## 希望審查的重點

1. **權限與安全（最優先）**：見上方「安全性審查（必做）」，以下為補充。
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
5. **樂觀更新與合併送出**（`src/ui/app.js` 的 `OPTIMISTIC`、`queue`、`pump`、`replayPending`、`confirmed`；`apiApplyBatch`）
   - 合併送出時部分操作被拒絕：其他操作的結果、畫面資料、回應的對應順序是否正確；後台寫入失敗時是否全部退回。
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
| 階段 6-11 | 連續操作合併送出（`apiApplyBatch`）、還沒同步完成時關閉網頁先提醒 |
| 階段 6-10 | 修正第三、四次審查的 A–C（登入安全、訪客事由） |
| 階段 6-9 | REQUEST.md 加入安全性審查（必做） |
| 階段 6-8 | 修正第二次審查的發現（見上方「已知問題」） |
| `ab504b1` | 階段 6-7：修正第一次審查的職務相關測試問題 |
| `0f8c508` | 階段 6-5：服務人員職務改為點傳師、主壇務、副主壇務、護持壇務 |
| `2c45470` | 階段 6-4：LOGO 由擁有者上傳，不放進 GitHub |
| `c73be12` | 階段 6-3：服務人員在點名頁直接點名（`session.duty`） |
| `2dc20fd` | 階段 6-2：網頁改放 GitHub Pages，Apps Script 只當後台 |
| `e7acb41` | 階段 6-1：第一次點名不必等後端建立課次 |
| `3a384d7` 以前 | 階段 4（壓力測試、增量同步、寫入安全、備份清理、瀏覽器測試）與階段 0–3（資料層、權限、後台、介面） |

完整列表：`git log --oneline`。
