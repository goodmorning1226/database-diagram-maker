(() => {
  "use strict";

  const DB_NAME = "database-diagram-maker-files";
  const STORE_NAME = "handles";

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function handleRecord(mode, key, value) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = mode === "readonly" ? store.get(key) : value === undefined ? store.delete(key) : store.put(value, key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => database.close();
    });
  }

  function ensureSupported() {
    if (!("showOpenFilePicker" in window) || !("showSaveFilePicker" in window)) {
      throw new Error("此瀏覽器不支援直接存取檔案，請使用最新版 Chrome 或 Edge");
    }
  }

  async function permission(handle, mode = "readwrite", request = false) {
    if (!handle) return false;
    const options = { mode };
    if ((await handle.queryPermission(options)) === "granted") return true;
    return request && (await handle.requestPermission(options)) === "granted";
  }

  async function pickOpen() {
    ensureSupported();
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: "Diagram JSON", accept: { "application/json": [".json"] } }]
    });
    return handle;
  }

  async function pickSave(suggestedName, extension, mime, description) {
    ensureSupported();
    return window.showSaveFilePicker({
      suggestedName,
      types: [{ description, accept: { [mime]: [extension] } }]
    });
  }

  async function readText(handle) {
    return (await handle.getFile()).text();
  }

  async function write(handle, content) {
    const writable = await handle.createWritable();
    try { await writable.write(content); await writable.close(); }
    catch (error) { await writable.abort(); throw error; }
  }

  window.diagramFileAccess = {
    supported: () => "showOpenFilePicker" in window && "showSaveFilePicker" in window,
    getHandle: key => handleRecord("readonly", key),
    rememberHandle: (key, handle) => handleRecord("readwrite", key, handle),
    forgetHandle: key => handleRecord("readwrite", key),
    getValue: key => handleRecord("readonly", key),
    rememberValue: (key, value) => handleRecord("readwrite", key, value),
    permission,
    pickOpen,
    pickSave,
    readText,
    write
  };
})();
