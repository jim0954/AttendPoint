# v3 資料結構

程式：[`src/store.js`](../src/store.js)（資料層）、[`src/migrate-v2.js`](../src/migrate-v2.js)（v2 移轉）

## 設計原則

1. **所有修改都經過 `apply(state, op)`**：同一份程式在前端（單機版）與 Google Apps Script 後端執行，規則只寫一次。操作失敗時原資料不變。
2. **積分由流水帳計算**：學員身上不存分數，榮譽總分、可用點數、出席堂數都從 `logs` 加總，不會出現「分數和紀錄對不起來」。
3. **撤銷不刪紀錄**：撤銷是新增一筆反向的 `reversal` 紀錄，原紀錄保留，方便查帳。
4. **刪除是軟刪除**：設定 `deletedAt`，資料進回收區，可以還原；跨年度結算時才永久清除。
5. **用 id 關聯，不用名稱**：小隊改名、課次改日期，相關紀錄都會自動跟著走。

## 資料表

```
state
├─ schemaVersion   3
├─ meta            { templeTitle, yearLabel, rev, syncId, updatedAt }
├─ classes[]       班別
├─ sessions[]      課次
├─ staff[]         服務人員
├─ students[]      學員
├─ gifts[]         禮品
└─ logs[]          流水帳
```

### classes 班別

| 欄位 | 說明 |
|---|---|
| `id` | 班別 id |
| `name` | 班名（不可重複） |
| `icon`、`themeColor` | 圖示、主題色 |
| `idPrefix` | 學號前綴，1–3 碼英數（不可重複），例如 `K` → K01、K02 |
| `schedule[]` | 常態上課時段 `{ weekday: 0–6（0 = 週日）, nth, start: 'HH:MM', end: 'HH:MM' }`，`nth`：0 每週、1–5 每月第 N 個、-1 每月最後一個。例如每月第 1 個週六＋第 3 個週日就是兩個時段 |
| `teams[]` | 小隊 `{ id, name }`，可以是空陣列（不分小隊） |
| `addRules[]` | 加分規則 `{ id, label, points, icon, isCheckin }`，每班最多一個 `isCheckin` |
| `deductRules[]` | 扣分規則 `{ id, label, points, icon }`，`points` 存正數 |

### sessions 課次

| 欄位 | 說明 |
|---|---|
| `id`、`classId` | 課次 id、所屬班別 |
| `date` | 上課日期 `YYYY-MM-DD` |
| `start`、`end` | 起迄時間 `HH:MM`（可留空） |
| `topic` | 課程主題 |
| `dutyStaffIds[]` | 當日執勤服務人員 |

### staff 服務人員

`{ id, name, role, classIds[], note }`。護持堂數由 `computeStaffDuty()` 從課次的 `dutyStaffIds` 計算。
（登入帳號與權限會在階段 2 加入，PIN 碼不會存在這份資料裡。）

### students 學員

`{ id, classId, teamId, name, note }`。`teamId` 為 `null` 表示不分小隊。學號 `id` 建立後不可修改（流水帳以學號對應）。

### gifts 禮品

`{ id, name, cost, icon, desc }`

### logs 流水帳

| 欄位 | 說明 |
|---|---|
| `id`、`at` | 紀錄 id、時間（本地時間 `YYYY-MM-DDTHH:MM:SS`） |
| `type` | `checkin` 報到／`points` 加減分／`redeem` 兌換／`adjust` 手動校正／`reversal` 撤銷 |
| `classId`、`studentId`、`sessionId` | 關聯 |
| `ruleId`、`giftId`、`batchId`、`reversesId` | 依類型：規則、禮品、團體加分批次、被撤銷的紀錄 |
| `reason` | 事由（保留當時的文字，規則改名也不影響歷史） |
| `honorDelta`、`balanceDelta` | 榮譽分變動、可用點數變動 |
| `operatorId` | 操作者（階段 2 起記錄） |

## 操作一覽（`AttendStore.OP_TYPES`）

| 分類 | 操作 |
|---|---|
| 班別 | `class.create`、`class.update`、`class.delete`、`class.restore` |
| 課次 | `session.save`、`session.ensure`、`session.generate`（依常態時間產生課表）、`session.duty`（服務人員點名：標記某人某天到或取消）、`session.delete` |
| 服務人員 | `staff.create`、`staff.update`、`staff.delete`、`staff.restore` |
| 學員 | `student.create`、`student.import`（批次）、`student.update`、`student.delete`、`student.restore` |
| 積分 | `points.checkin`、`points.award`、`points.batch`、`points.redeem`、`points.adjust`、`log.reverse` |
| 禮品 | `gift.create`、`gift.update`、`gift.delete`、`gift.restore` |
| 系統 | `meta.update`、`year.reset` |

積分操作的課次可以給 `sessionId`，或只給 `date`（上課日期）：`points.checkin`、`points.award`、`points.batch` 給 `date` 時，該班當天還沒有課次就依常態時間自動建立；`points.redeem` 給 `date` 只對應既有課次，不會建立。點名畫面一律送 `date`，第一次點名不必先等後端建立課次，按下去畫面就立即更新。

階段 2 會依這份清單訂出權限表：`*.delete`、`*.restore`、`points.adjust`、`year.reset` 僅限擁有者。

## 雲端同步（只傳變動）

雲端版不會每次都傳整份資料（一年可達數 MB），而是由前端送出手上的版本，後端只回傳差異（`AttendAuth.syncView`／`mergeView`）：

- `meta.rev`：每次操作加 1。版本相同時，後端只回「沒有變動」，而且直接比對快取，不必打開試算表。
- `meta.syncId`：流水帳只新增紀錄時不變，前端只要補上新紀錄，其他資料表（都不大）整份附上。
- 跨年度結算、刪除或還原學員、匯入資料時，會換一個 `syncId`（由 `apply()` 自動判斷），各裝置下次就整份重新下載。
- 訪客與壇務看到的資料不同（訪客名字遮蔽），切換登入身分時也會整份重新下載。

## 錯誤代碼

操作失敗時丟出 `StoreError`，`code` 供程式判斷，`message` 是可直接顯示的中文訊息。

| code | 情況 |
|---|---|
| `INVALID_INPUT` | 欄位格式錯誤或缺漏 |
| `NOT_FOUND` | 找不到資料（或已在回收區） |
| `DUPLICATE` | 名稱、學號、前綴、課次重複 |
| `ALREADY_CHECKED_IN` | 已經報到過 |
| `ALREADY_REVERSED` | 紀錄已撤銷過 |
| `INSUFFICIENT_POINTS` | 可用點數不足 |
| `NEGATIVE_POINTS` | 操作後分數會變負數 |
| `TEAM_IN_USE`、`CLASS_HAS_STUDENTS`、`SESSION_HAS_LOGS` | 還有關聯資料，不能直接刪除 |
| `NO_MATCH` | 團體加分找不到對象 |
| `NOT_DELETED`、`CLASS_DELETED` | 還原時的狀態錯誤 |
| `INVALID_OP` | 不支援的操作 |

## v2 移轉

`AttendMigrate.loadAny(raw)` 讀到 v2 資料（localStorage `temple_checkin_annual_v2`）時會自動移轉：

- 兩個固定班別變成 id 為 `kids`、`youth` 的班別，保留自訂班名與小隊。
- v2 的流水帳全部保留並依時間排序；同一天重複的報到只算第一筆。
- 有出席日期但沒有報到紀錄的，補一筆 0 分報到；分數對不上的部分補一筆「期初分數移轉」。
- **移轉後每位學員的分數與出席日期與 v2 完全相同**（有自動測試驗證）。
- v2 的壇務密碼不移轉。
