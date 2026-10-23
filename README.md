# AttendPoint 佛堂點名加分系統

佛堂班程使用的報到、加減分、換禮系統，可以單機離線使用，也可以部署到 Google Apps Script，讓多位服務人員一起使用。

## 目前狀態

- `AttendPoint.html`：v2 版本（固定兩個班別），直接用瀏覽器開啟即可單機使用。
- v3 開發中：動態班別、課次、服務人員名冊，以及「擁有者／壇務／訪客」三級權限。
  - `src/store.js`：v3 資料層（已完成，說明見 [docs/data-model.md](docs/data-model.md)）
  - `src/migrate-v2.js`：v2 資料自動移轉（已完成）
  - `src/auth.js`：擁有者／壇務／訪客權限（已完成，說明見 [docs/permissions.md](docs/permissions.md)）
  - `src/Code.js`：Google Apps Script 後端（已完成，部署見 [docs/deploy-gas.md](docs/deploy-gas.md)）
  - 介面尚未接上 v3 資料層（階段 3）

## 開發

需要 Node.js 18 以上，不需安裝任何套件：

```bash
npm test
```

## 隱私說明

學員名冊與積分資料只存在瀏覽器或 Google 試算表中，**不會**放進這個 repo。程式碼內的名字都是範例假資料。
