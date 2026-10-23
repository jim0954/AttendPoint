# 部署到 Google Apps Script

> 網頁介面（`Index.html`）會在階段 3 完成。在那之前可以先完成下面的步驟 1–3，把後端架好。

## 1. 建立試算表與 Apps Script 專案

1. 到 Google 雲端硬碟建立一個新的試算表，例如「佛堂點名加分系統」。
2. 在試算表選單點「擴充功能 → Apps Script」。

## 2. 放入程式

**方法 A：手動複製（不需安裝任何東西）**

在 Apps Script 編輯器中，依照下面的順序新增「指令碼」檔案，再把 `src/` 裡同名檔案的內容貼上：

| 順序 | 檔名 | 來源 |
|---|---|---|
| 1 | `store.gs` | `src/store.js` |
| 2 | `auth.gs` | `src/auth.js` |
| 3 | `migrate-v2.gs` | `src/migrate-v2.js` |
| 4 | `Code.gs` | `src/Code.js`（取代預設的 Code.gs 內容） |

順序很重要：前三個檔案要排在 `Code.gs` 上面。

**方法 B：使用 clasp**

```bash
npm install -g @google/clasp
```

```bash
clasp login
```

把 `.clasp.json.example` 複製成 `.clasp.json`，填入專案 ID（Apps Script 編輯器 → 專案設定 → 指令碼 ID），然後：

```bash
clasp push
```

## 3. 設定擁有者 PIN

Apps Script 編輯器 → 左側「專案設定」（齒輪）→ 最下方「指令碼屬性」→ 新增：

| 屬性 | 值 | 說明 |
|---|---|---|
| `OWNER_PIN` | 例如 `246810` | 擁有者主帳號 PIN，4–8 位數字，**必填** |
| `OWNER_NAME` | 例如 `堂主` | 選填，登入畫面顯示的名稱 |

**請勿把真實 PIN 寫進程式碼或 commit 到 GitHub。**

## 4. 部署網頁（階段 3 完成後）

1. 編輯器右上角「部署 → 新增部署作業」，類型選「網頁應用程式」。
2. 執行身分：**我**；存取權：
   - **所有人**：不需要 Google 帳號就能開啟（訪客看到的名字是遮蔽的）
   - **擁有 Google 帳戶的所有使用者**：較保守，需要登入 Google 才能開啟
3. 把網址分享在佛堂群組即可。

## 5. 選用：自動更新報表工作表

試算表中的「學員總表／流水帳／服務人員／課次」是給人看的報表，可以：

- 在試算表選單點「AttendPoint → 更新報表工作表」手動更新，或
- Apps Script 編輯器 →「觸發條件」→ 新增 `rebuildReportSheets`，時間驅動、每小時一次。

## 資料存放在哪裡

- 實際資料：隱藏的 `_data` 工作表（JSON 分段存放，請勿手動修改）
- 備份：隱藏的 `_backup_日期時間` 工作表
- 帳號：Script Properties 的 `USERS`（PIN 已雜湊）
