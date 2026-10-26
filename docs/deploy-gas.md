# 部署到 Google Apps Script

先在電腦上產生部署檔（需要 Node.js 18 以上）：

```bash
npm run build
```

會產生 `dist/gas/`，裡面就是要放進 Apps Script 的全部檔案。

## 1. 建立試算表與 Apps Script 專案

1. 到 Google 雲端硬碟建立一個新的試算表，例如「佛堂點名加分系統」。
2. 在試算表選單點「擴充功能 → Apps Script」。

## 2. 放入程式

**方法 A：手動複製（不需安裝任何東西）**

在 Apps Script 編輯器中，依照下面的順序新增檔案，再把 `dist/gas/` 裡對應檔案的內容貼上：

| 順序 | 新增類型 | 檔名 | 來源 |
|---|---|---|---|
| 1 | 指令碼 | `store` | `dist/gas/store.js` |
| 2 | 指令碼 | `auth` | `dist/gas/auth.js` |
| 3 | 指令碼 | `migrate-v2` | `dist/gas/migrate-v2.js` |
| 4 | 指令碼 | `Code` | `dist/gas/Code.js`（取代預設的 Code.gs 內容） |
| 5 | HTML | `Index` | `dist/gas/Index.html` |

順序很重要：前三個指令碼要排在 `Code` 上面。

**方法 B：使用 clasp**

```bash
npm install -g @google/clasp
```

```bash
clasp login
```

把 `.clasp.json.example` 複製成 `.clasp.json`，填入專案 ID（Apps Script 編輯器 → 專案設定 → 指令碼 ID），然後：

```bash
npm run build
```

```bash
clasp push
```

（`.clasp.json` 已設定推送 `dist/gas/`，並指定載入順序。）

## 3. 設定擁有者 PIN

Apps Script 編輯器 → 左側「專案設定」（齒輪）→ 最下方「指令碼屬性」→ 新增：

| 屬性 | 值 | 說明 |
|---|---|---|
| `OWNER_PIN` | 例如 `246810` | 擁有者主帳號 PIN，4–8 位數字，**必填** |
| `OWNER_NAME` | 例如 `堂主` | 選填，登入畫面顯示的名稱 |

**請勿把真實 PIN 寫進程式碼或 commit 到 GitHub。**

## 4. 部署網頁

1. 編輯器右上角「部署 → 新增部署作業」，類型選「網頁應用程式」。
2. 執行身分：**我**；存取權：
   - **所有人**：不需要 Google 帳號就能開啟（訪客看到的名字是遮蔽的）
   - **擁有 Google 帳戶的所有使用者**：較保守，需要登入 Google 才能開啟
3. 把網址分享在佛堂群組即可。
4. 用擁有者帳號登入（PIN 是 `OWNER_PIN`），到「👑 擁有者 → 帳號管理」為每位服務人員建立壇務帳號。
5. 如果之前用過 v2 單機版：在 v2 電腦的瀏覽器中按 F12 → Console 輸入 `copy(localStorage.temple_checkin_annual_v2)`，再到「擁有者 → 系統與備份 → 匯入資料」貼上，會自動轉換。

之後更新程式：重新 `npm run build`、`clasp push`，再到「部署 → 管理部署作業」編輯現有部署、版本選「新版本」，網址不會變。

## 5. 選用：自動更新報表工作表

試算表中的「學員總表／流水帳／服務人員／課次」是給人看的報表，可以：

- 在試算表選單點「AttendPoint → 更新報表工作表」手動更新，或
- Apps Script 編輯器 →「觸發條件」→ 新增 `rebuildReportSheets`，時間驅動、每小時一次。

## 資料存放在哪裡

- 實際資料：隱藏的 `_data` 與 `_data_2` 工作表（JSON 分段存放，請勿手動修改）。兩個工作表輪流寫入，Script Properties 的 `DATA_SHEET` 記錄目前使用哪一個，另一個是前一版。
- 備份：隱藏的 `_backup_日期時間` 工作表（跨年度結算、匯入資料前自動產生）
- 帳號：Script Properties 的 `USERS`（PIN 已雜湊）

### 寫入安全

每次操作都先寫到沒在使用的那個工作表，確認寫入完整後才切換 `DATA_SHEET`。寫到一半出錯（逾時、試算表忙碌）時，這次操作不會生效，原本的資料也不受影響，再操作一次即可。

如果網頁顯示「資料讀取失敗，為了保護資料已暫停操作」，表示目前使用中的資料工作表被刪除或內容被改壞。系統不會用空白資料覆蓋，請擁有者：

1. 到試算表確認 `_data`、`_data_2` 是否還在（隱藏的工作表可在左下角「所有工作表」清單中找到）。
2. 如果其中一個被刪除或改壞，把 Script Properties 的 `DATA_SHEET` 改成另一個工作表的名稱，就會改用前一版的資料（最後一次操作會遺失）。
3. 或者用擁有者登入，到「擁有者 → 系統與備份 → 匯入資料」匯入之前下載的備份檔（資料讀不到時仍可以匯入）。

## 部署前先在電腦上試用

- **單機版**：`npm run build` 後用瀏覽器開啟 `dist/AttendPoint.html`，資料存在瀏覽器中。
- **模擬雲端版**：`npm run gas-sim` 產生 `dist/gas-sim.html`，在瀏覽器模擬 Apps Script 環境（擁有者 PIN `246810`，資料只存在記憶體）。需要用本機網頁伺服器開啟，例如 `python -m http.server --directory dist`。
