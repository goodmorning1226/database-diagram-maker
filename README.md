# Database Diagram Maker

純前端的 Relational Schema 與 ER Diagram 編輯器，可直接部署至 Vercel，不需要後端服務或套件安裝。

## 使用方式

以最新版 Chrome 或 Edge 開啟網站。建立、開啟、儲存及匯出會使用瀏覽器的 File System Access API，檔案位置由使用者自行選擇。

- `Relational`：建立 table、欄位、Primary Key 與可調整路徑的 reference。
- `ER Diagram`：建立 entity、relationship、attribute、participation 與 cardinality。
- JSON 檔案可再次開啟編輯。
- PNG 可選擇白色或透明背景。
- 最近開啟的檔案控制代碼與最後儲存快照會保存在瀏覽器 IndexedDB。

本機預覽請使用任一靜態 HTTP server，不要直接雙擊 `index.html`。例如：

```powershell
python -m http.server 8000
```

再開啟 `http://localhost:8000`。

## 專案結構

- `index.html`：頁面與操作介面。
- `styles.css`、`er-styles.css`：Relational 與 ER 樣式。
- `app.js`、`er-app.js`：兩種編輯器邏輯。
- `file-access.js`：瀏覽器檔案開啟、儲存與控制代碼管理。
- `reference/`：講義、LaTeX 範例、圖片與舊 JSON 圖檔。
