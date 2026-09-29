(() => {
  "use strict";

  const HANDLE_KEY = "relational-diagram-handle";
  const SNAPSHOT_KEY = `${HANDLE_KEY}:snapshot`;
  const LEGACY_STORAGE_KEY = "relational-diagram-maker-v1";
  const TABLE_GAP = 66;
  const TRACK_MIN_GAP = 16;
  const state = { tables: [], references: [] };
  const files = window.diagramFileAccess;

  const els = {
    tables: document.querySelector("#tables"),
    diagram: document.querySelector("#diagram"),
    workspace: document.querySelector("#relational-workspace"),
    viewport: document.querySelector("#diagram-viewport"),
    paths: document.querySelector("#connection-paths"),
    controls: document.querySelector("#connection-controls"),
    empty: document.querySelector("#empty-state"),
    newButton: document.querySelector("#new-diagram"),
    undoButton: document.querySelector("#undo-diagram"),
    redoButton: document.querySelector("#redo-diagram"),
    currentName: document.querySelector("#relational-file-name"),
    addTable: document.querySelector("#add-table"),
    emptyAdd: document.querySelector("#empty-add"),
    refMode: document.querySelector("#reference-mode"),
    refStatus: document.querySelector("#reference-status"),
    tableList: document.querySelector("#table-list"),
    tableCount: document.querySelector("#table-count"),
    refList: document.querySelector("#reference-list"),
    refCount: document.querySelector("#reference-count"),
    summary: document.querySelector("#diagram-summary"),
    tableDialog: document.querySelector("#table-dialog"),
    tableForm: document.querySelector("#table-form"),
    tableName: document.querySelector("#table-name"),
    exportDialog: document.querySelector("#export-dialog"),
    exportForm: document.querySelector("#export-form"),
    saveButton: document.querySelector("#save-diagram"),
    saveAsButton: document.querySelector("#save-as-diagram"),
    openButton: document.querySelector("#open-diagram"),
    toast: document.querySelector("#toast")
  };

  let referenceMode = false;
  let referenceSource = null;
  let selectedReference = null;
  let currentFileName = "";
  let currentFileHandle = null;
  let activeReferenceDrag = null;
  let resizeFrame = null;
  let undoStack = [];
  let redoStack = [];
  let lastSnapshot = JSON.stringify(state);
  let restoringHistory = false;

  function uid() { return Math.random().toString(36).slice(2, 9); }
  function createField(name = "", primary = false) { return { id: uid(), name, primary }; }
  function updateHistoryButtons() {
    els.undoButton.disabled = undoStack.length === 0;
    els.redoButton.disabled = redoStack.length === 0;
  }
  function persist() {
    const snapshot = JSON.stringify(state);
    if (!restoringHistory && snapshot !== lastSnapshot) {
      undoStack.push(lastSnapshot);
      if (undoStack.length > 100) undoStack.shift();
      redoStack = [];
      lastSnapshot = snapshot;
    }
    updateHistoryButtons();
  }
  function resetHistory() {
    undoStack = [];
    redoStack = [];
    lastSnapshot = JSON.stringify(state);
    updateHistoryButtons();
  }
  function restoreSnapshot(snapshot) {
    const data = JSON.parse(snapshot);
    state.tables = data.tables || [];
    state.references = data.references || [];
    lastSnapshot = snapshot;
    restoringHistory = true;
    render();
    restoringHistory = false;
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(state));
    restoreSnapshot(undoStack.pop());
    updateHistoryButtons();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(state));
    restoreSnapshot(redoStack.pop());
    updateHistoryButtons();
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
  }
  function fieldWidth(name) { return Math.max(108, Math.min(280, 34 + [...(name || "欄位名稱")].length * 12)); }

  function render() {
    els.tables.innerHTML = state.tables.map((table, ti) => `
      <article class="table-block" data-table-id="${table.id}">
        <div class="table-topline">
          <input class="table-name" value="${escapeHtml(table.name)}" aria-label="Table 名稱" maxlength="40" data-action="rename-table">
        </div>
        <div class="fields">
          ${table.fields.map((f, fi) => `
            <div class="field ${f.primary ? "primary" : ""}" style="width:${fieldWidth(f.name)}px" data-table-id="${table.id}" data-field-id="${f.id}">
              <div class="field-name" contenteditable="true" role="textbox" aria-label="欄位名稱" data-placeholder="欄位名稱" data-action="rename-field">${escapeHtml(f.name)}</div>
              <div class="field-controls">
                <button title="左移" data-action="move-field-left" ${fi === 0 ? "disabled" : ""}>←</button>
                <button title="Primary key" class="pk-control ${f.primary ? "active" : ""}" data-action="toggle-primary">PK</button>
                <button title="右移" data-action="move-field-right" ${fi === table.fields.length - 1 ? "disabled" : ""}>→</button>
                <button title="刪除欄位" data-action="delete-field">×</button>
              </div>
            </div>`).join("")}
          <button class="add-field" title="新增欄位" data-action="add-field">＋</button>
        </div>
      </article>`).join("");

    els.empty.hidden = state.tables.length > 0;
    els.tables.hidden = state.tables.length === 0;
    updateReferenceUI();
    updateTableList();
    updateSummary();
    requestAnimationFrame(drawConnections);
    persist();
  }

  function diagramData(name = currentFileName) {
    return {
      version: 1,
      name,
      savedAt: new Date().toISOString(),
      tables: state.tables,
      references: state.references
    };
  }

  function loadDiagramData(data, fallbackName = "") {
    if (!data || !Array.isArray(data.tables) || !Array.isArray(data.references || [])) {
      throw new Error("這不是有效的 relational diagram JSON");
    }
    const tables = data.tables.map(table => ({
      id: String(table.id || uid()),
      name: String(table.name || "UNTITLED").slice(0, 40),
      fields: Array.isArray(table.fields) ? table.fields.map(item => ({
        id: String(item.id || uid()),
        name: String(item.name || "").slice(0, 40),
        primary: Boolean(item.primary)
      })) : []
    }));
    const tableIds = new Set(tables.map(table => table.id));
    const fieldIds = new Set(tables.flatMap(table => table.fields.map(item => item.id)));
    const references = (data.references || []).filter(ref =>
      ref?.from && ref?.to && tableIds.has(String(ref.from.tableId)) && tableIds.has(String(ref.to.tableId)) &&
      fieldIds.has(String(ref.from.fieldId)) && fieldIds.has(String(ref.to.fieldId))
    ).map((ref, index) => ({
      id: String(ref.id || uid()),
      from: { tableId: String(ref.from.tableId), fieldId: String(ref.from.fieldId) },
      to: { tableId: String(ref.to.tableId), fieldId: String(ref.to.fieldId) },
      route: {
        trackOffset: Math.max(minTrackOffset(index), Math.min(420, Number(ref.route?.trackOffset ?? ref.offset) || 0)),
        sourceGap: Math.max(12, Math.min(240, Number(ref.route?.sourceGap) || 20)),
        targetGap: Math.max(12, Math.min(240, Number(ref.route?.targetGap) || 20))
      }
    }));
    state.tables = tables;
    state.references = references;
    currentFileName = String(fallbackName || data.name || "").replace(/\.json$/i, "");
    resetHistory();
    updateFileUI();
    render();
  }

  async function newDiagram() {
    if ((state.tables.length || state.references.length) && !window.confirm("建立新檔案會清空目前畫布。尚未儲存的變更將會遺失，確定繼續嗎？")) return;
    const handle = await files.pickSave("未命名.json", ".json", "application/json", "Relational Diagram JSON");
    const nextName = handle.name.replace(/\.json$/i, "");
    const blank = { version: 1, name: nextName, savedAt: new Date().toISOString(), tables: [], references: [] };
    const content = JSON.stringify(blank, null, 2);
    await files.write(handle, content);
    state.tables = [];
    state.references = [];
    currentFileHandle = handle;
    currentFileName = nextName;
    referenceMode = false;
    referenceSource = null;
    selectedReference = null;
    activeReferenceDrag = null;
    resetHistory();
    updateFileUI();
    render();
    await files.rememberHandle(HANDLE_KEY, handle);
    await files.rememberValue(SNAPSHOT_KEY, content);
    showToast(`已新增 ${handle.name}`);
  }

  function updateFileUI() {
    if (document.activeElement !== els.currentName) els.currentName.value = currentFileName || "未命名";
    els.saveButton.title = currentFileName ? `目前檔案：${currentFileName}.json` : "儲存 Diagram";
  }

  function safeClientName(value) {
    return value.trim().replace(/\.json$/i, "").replace(/[^0-9A-Za-z._\-\u4e00-\u9fff]+/g, "-").replace(/^[.\-]+|[.\-]+$/g, "").slice(0, 80);
  }

  function suggestedJsonName() {
    return `${safeClientName(els.currentName.value) || currentFileName || "未命名"}.json`;
  }

  async function saveAsDiagram() {
    const handle = await files.pickSave(suggestedJsonName(), ".json", "application/json", "Relational Diagram JSON");
    const nextName = handle.name.replace(/\.json$/i, "");
    const content = JSON.stringify(diagramData(nextName), null, 2);
    await files.write(handle, content);
    currentFileHandle = handle;
    currentFileName = nextName;
    updateFileUI();
    await files.rememberHandle(HANDLE_KEY, handle);
    await files.rememberValue(SNAPSHOT_KEY, content);
    showToast(`已另存為 ${handle.name}`);
  }

  async function saveDiagram() {
    if (!currentFileHandle) return saveAsDiagram();
    const requestedName = safeClientName(els.currentName.value === "未命名" ? "" : els.currentName.value);
    const physicalName = currentFileHandle.name.replace(/\.json$/i, "");
    if (requestedName && requestedName !== physicalName) return saveAsDiagram();
    if (!(await files.permission(currentFileHandle, "readwrite", true))) return saveAsDiagram();
    const content = JSON.stringify(diagramData(currentFileName), null, 2);
    await files.write(currentFileHandle, content);
    await files.rememberValue(SNAPSHOT_KEY, content);
    showToast(`已儲存 ${currentFileHandle.name}`);
  }

  async function openFromDisk(handle = null) {
    const nextHandle = handle || await files.pickOpen();
    if (!(await files.permission(nextHandle, "read", false))) throw new Error("未取得檔案讀取權限");
    const source = await files.readText(nextHandle);
    const data = JSON.parse(source);
    loadDiagramData(data, nextHandle.name);
    currentFileHandle = nextHandle;
    updateFileUI();
    await files.rememberHandle(HANDLE_KEY, nextHandle);
    await files.rememberValue(SNAPSHOT_KEY, JSON.stringify(diagramData(currentFileName), null, 2));
    showToast(`已開啟 ${nextHandle.name}`);
  }

  async function restoreLastFile() {
    try {
      const handle = await files.getHandle(HANDLE_KEY);
      if (!handle) return;
      if (state.tables.length || state.references.length || undoStack.length) return;
      if (await files.permission(handle, "read", false)) { await openFromDisk(handle); return; }
      let snapshot = await files.getValue(SNAPSHOT_KEY);
      if (!snapshot) {
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) snapshot = JSON.stringify({ ...JSON.parse(legacy), name: handle.name.replace(/\.json$/i, "") });
      }
      if (!snapshot) return;
      loadDiagramData(JSON.parse(snapshot), handle.name);
      currentFileHandle = handle;
      updateFileUI();
      await files.rememberValue(SNAPSHOT_KEY, JSON.stringify(diagramData(currentFileName), null, 2));
      showToast(`已載入 ${handle.name} 的最後儲存版本`);
    } catch {
      currentFileHandle = null;
      currentFileName = "";
      state.tables = [];
      state.references = [];
      resetHistory();
      updateFileUI();
      render();
    }
  }

  function updateSummary() {
    const columns = state.tables.reduce((sum, t) => sum + t.fields.length, 0);
    els.summary.textContent = `${state.tables.length} tables · ${columns} columns`;
  }

  function updateTableList() {
    els.tableCount.textContent = state.tables.length;
    els.tableList.innerHTML = state.tables.length ? state.tables.map((table, index) => `
      <div class="table-list-item" data-table-id="${table.id}">
        <span class="table-list-name">${escapeHtml(table.name || "UNTITLED")}</span>
        <div class="table-list-actions">
          <button title="上移" data-action="move-table-left" ${index === 0 ? "disabled" : ""}>↑</button>
          <button title="下移" data-action="move-table-right" ${index === state.tables.length - 1 ? "disabled" : ""}>↓</button>
          <button class="danger" title="刪除 Table" data-action="delete-table">×</button>
        </div>
      </div>`).join("") : `<p class="reference-empty">尚未建立 table</p>`;
  }

  function updateReferenceUI() {
    els.refMode.classList.toggle("active", referenceMode);
    els.refMode.setAttribute("aria-pressed", String(referenceMode));
    document.querySelectorAll(".field").forEach(node => {
      const isSource = referenceSource && node.dataset.fieldId === referenceSource.fieldId;
      node.classList.toggle("reference-source", Boolean(isSource));
      node.classList.toggle("reference-target-candidate", referenceMode && Boolean(referenceSource) && !isSource);
    });
    if (!referenceMode) {
      els.refStatus.hidden = true;
      els.refStatus.innerHTML = "";
    } else if (!referenceSource) {
      els.refStatus.hidden = false;
      els.refStatus.className = "status-card active";
      els.refStatus.innerHTML = `<span class="status-dot"></span><div><strong>選擇來源欄位</strong><p>點擊要拉出 reference 的欄位。</p></div>`;
    } else {
      els.refStatus.hidden = false;
      const label = getFieldLabel(referenceSource.tableId, referenceSource.fieldId);
      els.refStatus.className = "status-card active";
      els.refStatus.innerHTML = `<span class="status-dot"></span><div><strong>選擇目標欄位</strong><p>${escapeHtml(label)} → ?</p></div>`;
    }
    els.refCount.textContent = state.references.length;
    els.refList.innerHTML = state.references.length ? state.references.map(ref => `
      <div class="reference-item" data-ref-id="${ref.id}">
        ${escapeHtml(getFieldLabel(ref.from.tableId, ref.from.fieldId))}<br>↗ ${escapeHtml(getFieldLabel(ref.to.tableId, ref.to.fieldId))}
        <button title="刪除 Reference" data-action="delete-reference">×</button>
      </div>`).join("") : `<p class="reference-empty">尚未建立 reference</p>`;
  }

  function getFieldLabel(tableId, fieldId) {
    const table = state.tables.find(t => t.id === tableId);
    const f = table?.fields.find(item => item.id === fieldId);
    return `${table?.name || "?"}.${f?.name || "?"}`;
  }

  function mutateOrder(array, index, delta) {
    const target = index + delta;
    if (target < 0 || target >= array.length) return;
    [array[index], array[target]] = [array[target], array[index]];
  }

  function onTableClick(event) {
    const referenceFieldNode = event.target.closest(".field");
    if (referenceMode && referenceFieldNode && !event.target.closest(".field-controls")) {
      event.preventDefault();
      const point = { tableId: referenceFieldNode.dataset.tableId, fieldId: referenceFieldNode.dataset.fieldId };
      if (!referenceSource) {
        referenceSource = point;
        updateReferenceUI();
      } else if (referenceSource.fieldId !== point.fieldId) {
        const duplicate = state.references.some(r => r.from.fieldId === referenceSource.fieldId && r.to.fieldId === point.fieldId);
        if (!duplicate) state.references.push({ id: uid(), from: referenceSource, to: point, route: { trackOffset: 0, sourceGap: 20, targetGap: 20 } });
        referenceSource = null;
        referenceMode = false;
        render();
        showToast(duplicate ? "這條 Reference 已存在" : "Reference 已建立");
      }
      return;
    }

    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const tableNode = button.closest(".table-block");
    const tableIndex = state.tables.findIndex(t => t.id === tableNode?.dataset.tableId);
    const table = state.tables[tableIndex];
    const fieldNode = button.closest(".field");
    const fieldIndex = fieldNode ? table.fields.findIndex(f => f.id === fieldNode.dataset.fieldId) : -1;
    const action = button.dataset.action;

    if (action === "add-field") table.fields.push(createField());
    if (action === "move-field-left") mutateOrder(table.fields, fieldIndex, -1);
    if (action === "move-field-right") mutateOrder(table.fields, fieldIndex, 1);
    if (action === "toggle-primary") table.fields[fieldIndex].primary = !table.fields[fieldIndex].primary;
    if (action === "delete-field") {
      const id = table.fields[fieldIndex].id;
      state.references = state.references.filter(r => r.from.fieldId !== id && r.to.fieldId !== id);
      table.fields.splice(fieldIndex, 1);
    }
    render();
  }

  function onTableListClick(event) {
    const button = event.target.closest("button[data-action]");
    const item = event.target.closest(".table-list-item");
    if (!button || !item) return;
    const tableIndex = state.tables.findIndex(t => t.id === item.dataset.tableId);
    const table = state.tables[tableIndex];
    if (!table) return;
    if (button.dataset.action === "move-table-left") mutateOrder(state.tables, tableIndex, -1);
    if (button.dataset.action === "move-table-right") mutateOrder(state.tables, tableIndex, 1);
    if (button.dataset.action === "delete-table") {
      const fieldIds = new Set(table.fields.map(f => f.id));
      state.references = state.references.filter(r => !fieldIds.has(r.from.fieldId) && !fieldIds.has(r.to.fieldId));
      state.tables.splice(tableIndex, 1);
    }
    render();
  }

  function onInput(event) {
    const tableNode = event.target.closest(".table-block");
    const table = state.tables.find(t => t.id === tableNode?.dataset.tableId);
    if (!table) return;
    if (event.target.dataset.action === "rename-table") table.name = event.target.value;
    if (event.target.dataset.action === "rename-field") {
      const fieldNode = event.target.closest(".field");
      const f = table.fields.find(item => item.id === fieldNode.dataset.fieldId);
      f.name = event.target.textContent.replace(/\n/g, "").slice(0, 40);
      if (event.target.textContent !== f.name) event.target.textContent = f.name;
      if (!f.name) event.target.innerHTML = "";
      fieldNode.style.width = `${fieldWidth(f.name)}px`;
    }
    persist();
    updateReferenceUI();
    updateTableList();
    queueConnectionDraw();
  }

  function addTable(name) {
    state.tables.push({ id: uid(), name: name.trim() || "UNTITLED", fields: [createField()] });
    render();
    requestAnimationFrame(() => {
      const last = els.tables.lastElementChild;
      last?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      last?.querySelector(".field-name")?.focus();
    });
  }

  function openTableDialog() {
    els.tableName.value = "";
    els.tableDialog.showModal();
    requestAnimationFrame(() => els.tableName.focus());
  }

  function toggleReferenceMode(force) {
    referenceMode = typeof force === "boolean" ? force : !referenceMode;
    referenceSource = null;
    selectedReference = null;
    updateReferenceUI();
    drawConnections();
  }

  function fieldConnections(fieldId) {
    const connections = [];
    state.references.forEach((ref, referenceIndex) => {
      if (ref.from.fieldId === fieldId) connections.push({ refId: ref.id, role: "from", referenceIndex });
      if (ref.to.fieldId === fieldId) connections.push({ refId: ref.id, role: "to", referenceIndex });
    });
    return connections.sort((a, b) => a.referenceIndex - b.referenceIndex || a.role.localeCompare(b.role));
  }

  function distributedAnchorX(fieldId, refId, role, left, width) {
    const connections = fieldConnections(fieldId);
    if (connections.length <= 1) return left + width / 2;
    const slot = connections.findIndex(item => item.refId === refId && item.role === role);
    if (slot < 0) return left + width / 2;
    const sidePadding = Math.min(18, Math.max(8, width * 0.12));
    const usableWidth = Math.max(0, width - sidePadding * 2);
    return left + sidePadding + usableWidth * slot / (connections.length - 1);
  }

  function fieldAnchor(point, refId, role) {
    const node = document.querySelector(`.field[data-table-id="${point.tableId}"][data-field-id="${point.fieldId}"]`);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    const d = els.diagram.getBoundingClientRect();
    const left = r.left - d.left;
    return { x: distributedAnchorX(point.fieldId, refId, role, left, r.width), y: r.bottom - d.top };
  }

  function pathFor(ref, index) {
    const from = fieldAnchor(ref.from, ref.id, "from");
    const to = fieldAnchor(ref.to, ref.id, "to");
    if (!from || !to) return null;
    const route = getRoute(ref, index);
    const drop = from.y + route.sourceGap;
    const approach = to.y + route.targetGap;
    const obstacleRight = getObstacleRight(from, to, drop, approach);
    const outside = obstacleRight + 44 + index * 15 + route.trackOffset;
    return {
      from, to, outside, drop, approach,
      sourceHandle: { x: (from.x + outside) / 2, y: drop },
      trackHandle: { x: outside, y: (drop + approach) / 2 },
      targetHandle: { x: (outside + to.x) / 2, y: approach },
      d: `M ${from.x} ${from.y} L ${from.x} ${drop} L ${outside} ${drop} L ${outside} ${approach} L ${to.x} ${approach} L ${to.x} ${to.y + 2}`
    };
  }

  function getObstacleRight(from, to, drop, approach) {
    const diagramRect = els.diagram.getBoundingClientRect();
    // Only the outside vertical segment needs to avoid table rows. The short
    // endpoint segments deliberately touch their own fields and must not make
    // the entire source/target table count as an obstacle.
    const corridorTop = Math.min(drop, approach) + 1;
    const corridorBottom = Math.max(drop, approach) - 1;
    const relevantRights = [...document.querySelectorAll(".table-block")].flatMap(table => {
      const fields = table.querySelector(".fields");
      const lastField = table.querySelector(".field:last-of-type");
      if (!fields || !lastField) return [];
      const rowRect = fields.getBoundingClientRect();
      const rowTop = rowRect.top - diagramRect.top;
      const rowBottom = rowRect.bottom - diagramRect.top;
      const intersectsCorridor = corridorTop <= corridorBottom && rowBottom > corridorTop && rowTop < corridorBottom;
      return intersectsCorridor ? [lastField.getBoundingClientRect().right - diagramRect.left] : [];
    });
    return Math.max(from.x, to.x, ...relevantRights);
  }

  function getRoute(ref, index = 0) {
    if (!ref.route) {
      ref.route = {
        trackOffset: Number(ref.offset) || 0,
        sourceGap: 20 + (index % 3) * 7,
        targetGap: 20
      };
    }
    ref.route.trackOffset = Math.max(minTrackOffset(index), Math.min(420, Number(ref.route.trackOffset) || 0));
    ref.route.sourceGap = Math.max(12, Math.min(240, Number(ref.route.sourceGap) || 20));
    ref.route.targetGap = Math.max(12, Math.min(240, Number(ref.route.targetGap) || 20));
    return ref.route;
  }

  function minTrackOffset(index) {
    return TRACK_MIN_GAP - 44 - index * 15;
  }

  function drawConnections() {
    const contentWidth = Math.max(900, ...[...document.querySelectorAll(".fields")].map(n => n.offsetLeft + n.offsetWidth + 230));
    const contentHeight = Math.max(500, els.tables.offsetHeight + 130);
    els.diagram.style.width = `${contentWidth}px`;
    els.diagram.style.height = `${contentHeight}px`;
    const paths = [];
    const controls = [];
    state.references.forEach((ref, index) => {
      const p = pathFor(ref, index);
      if (!p) return;
      const selected = selectedReference === ref.id;
      paths.push(`<g class="connection ${selected ? "selected" : ""}" data-ref-id="${ref.id}"><path class="connection-hit" d="${p.d}"></path><path class="connection-path" d="${p.d}"></path></g>`);
      if (selected) {
        controls.push(`<button type="button" class="connection-handle-button move-y" data-ref-id="${ref.id}" data-handle-type="source-y" aria-label="上下拖曳來源端水平線" title="上下調整來源端水平線" style="left:${p.sourceHandle.x}px;top:${p.sourceHandle.y}px"></button>`);
        controls.push(`<button type="button" class="connection-handle-button move-x" data-ref-id="${ref.id}" data-handle-type="track-x" aria-label="左右拖曳垂直線" title="左右調整垂直線" style="left:${p.trackHandle.x}px;top:${p.trackHandle.y}px"></button>`);
        controls.push(`<button type="button" class="connection-handle-button move-y" data-ref-id="${ref.id}" data-handle-type="target-y" aria-label="上下拖曳目標端水平線" title="上下調整目標端水平線" style="left:${p.targetHandle.x}px;top:${p.targetHandle.y}px"></button>`);
      }
    });
    els.paths.innerHTML = paths.join("");
    if (!activeReferenceDrag) els.controls.innerHTML = controls.join("");
  }

  function updateDraggedConnection(ref) {
    const index = state.references.findIndex(item => item.id === ref.id);
    const p = pathFor(ref, index);
    if (!p) return;
    const connection = [...els.paths.querySelectorAll(".connection")].find(node => node.dataset.refId === ref.id);
    connection?.querySelectorAll("path").forEach(path => path.setAttribute("d", p.d));
    els.controls.querySelectorAll(".connection-handle-button").forEach(handle => {
      if (handle.dataset.refId !== ref.id) return;
      const point = handle.dataset.handleType === "source-y" ? p.sourceHandle :
        handle.dataset.handleType === "target-y" ? p.targetHandle : p.trackHandle;
      handle.style.left = `${point.x}px`;
      handle.style.top = `${point.y}px`;
    });
  }

  function queueConnectionDraw() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(drawConnections);
  }

  function deleteReference(id) {
    state.references = state.references.filter(r => r.id !== id);
    if (selectedReference === id) selectedReference = null;
    render();
  }

  function beginHandleDrag(event) {
    const handle = event.target.closest?.(".connection-handle-button");
    if (!handle || (event.button !== undefined && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation();
    const ref = state.references.find(r => r.id === handle.dataset.refId);
    if (!ref) return;
    const index = state.references.findIndex(item => item.id === ref.id);
    const route = getRoute(ref, index);
    const type = handle.dataset.handleType;
    const startValue = type === "track-x" ? route.trackOffset : type === "source-y" ? route.sourceGap : route.targetGap;
    activeReferenceDrag = { ref, handle, type, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startValue };
    handle.classList.add("dragging");
    try { handle.setPointerCapture(event.pointerId); } catch { /* document capture remains as fallback */ }
    document.body.classList.add(type === "track-x" ? "dragging-reference-x" : "dragging-reference-y");
  }

  function moveHandleDrag(event) {
    if (!activeReferenceDrag) return;
    event.preventDefault();
    const { ref, type, startX, startY, startValue } = activeReferenceDrag;
    const route = getRoute(ref, state.references.findIndex(item => item.id === ref.id));
    if (type === "track-x") {
      const index = state.references.findIndex(item => item.id === ref.id);
      route.trackOffset = Math.max(minTrackOffset(index), Math.min(420, startValue + event.clientX - startX));
    }
    if (type === "source-y") route.sourceGap = Math.max(12, Math.min(240, startValue + event.clientY - startY));
    if (type === "target-y") route.targetGap = Math.max(12, Math.min(240, startValue + event.clientY - startY));
    updateDraggedConnection(ref);
  }

  function endHandleDrag(event) {
    if (!activeReferenceDrag) return;
    const { handle, pointerId } = activeReferenceDrag;
    handle.classList.remove("dragging");
    try {
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    } catch { /* handle may already have released capture */ }
    activeReferenceDrag = null;
    document.body.classList.remove("dragging-reference-x", "dragging-reference-y");
    persist();
    drawConnections();
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 1800);
  }

  function svgText(text, x, y, options = {}) {
    const { size = 18, weight = 400, family = "mono", underline = false, anchor = "middle" } = options;
    const safe = escapeHtml(text);
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${family === "sans" ? "'Noto Sans CJK TC',sans-serif" : "'Noto Sans Mono CJK TC','Noto Sans CJK TC',monospace"}" font-size="${size}" font-weight="${weight}" ${underline ? 'text-decoration="underline"' : ""}>${safe}</text>`;
  }

  function buildExportSvg(background) {
    const pad = 24;
    const tableBounds = [];
    let y = pad;
    let maxTableWidth = 0;
    const tableParts = [];
    const anchors = new Map();
    state.tables.forEach(table => {
      const widths = table.fields.map(f => fieldWidth(f.name));
      const total = widths.reduce((a, b) => a + b, 0);
      maxTableWidth = Math.max(maxTableWidth, total);
      tableBounds.push({ top: y + 24, bottom: y + 67, right: pad + total });
      tableParts.push(svgText(table.name.toUpperCase(), pad + 2, y + 17, { size: "14pt", weight: 700, family: "sans", anchor: "start" }));
      let x = pad;
      table.fields.forEach((f, i) => {
        const w = widths[i];
        tableParts.push(`<rect x="${x}" y="${y + 24}" width="${w}" height="43" fill="#e8e8e6" stroke="#171717" stroke-width="1.5"/>`);
        tableParts.push(svgText(f.name || "欄位名稱", x + w / 2, y + 51, { size: "12pt", underline: f.primary }));
        anchors.set(f.id, { left: x, width: w, y: y + 67 });
        x += w;
      });
      y += 67 + TABLE_GAP;
    });
    const lineParts = [];
    let maxTrack = pad + maxTableWidth;
    let maxLineY = 0;
    state.references.forEach((ref, index) => {
      const fromField = anchors.get(ref.from.fieldId); const toField = anchors.get(ref.to.fieldId);
      if (!fromField || !toField) return;
      const from = {
        x: distributedAnchorX(ref.from.fieldId, ref.id, "from", fromField.left, fromField.width),
        y: fromField.y
      };
      const to = {
        x: distributedAnchorX(ref.to.fieldId, ref.id, "to", toField.left, toField.width),
        y: toField.y
      };
      const route = getRoute(ref, index);
      const drop = from.y + route.sourceGap;
      const approach = to.y + route.targetGap;
      const corridorTop = Math.min(drop, approach) + 1;
      const corridorBottom = Math.max(drop, approach) - 1;
      const relevantRights = tableBounds
        .filter(bounds => corridorTop <= corridorBottom && bounds.bottom > corridorTop && bounds.top < corridorBottom)
        .map(bounds => bounds.right);
      const obstacleRight = Math.max(from.x, to.x, ...relevantRights);
      const track = obstacleRight + 44 + index * 15 + route.trackOffset;
      maxTrack = Math.max(maxTrack, track);
      maxLineY = Math.max(maxLineY, drop, approach);
      lineParts.push(`<path d="M ${from.x} ${from.y} L ${from.x} ${drop} L ${track} ${drop} L ${track} ${approach} L ${to.x} ${approach} L ${to.x} ${to.y + 2}" fill="none" stroke="#111" stroke-width="1.65" marker-end="url(#export-arrow)"/>`);
    });
    const width = Math.ceil(Math.max(pad * 2 + maxTableWidth, maxTrack + pad));
    const height = Math.max(120, Math.ceil(y - TABLE_GAP + pad), Math.ceil(maxLineY + pad));
    const bg = background === "white" ? `<rect width="100%" height="100%" fill="white"/>` : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${bg}<defs><marker id="export-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#111"/></marker></defs>${lineParts.join("")}${tableParts.join("")}</svg>`;
  }

  async function exportPng(background) {
    if (!state.tables.length) { showToast("請先建立至少一個 Table"); return; }
    const baseName = safeClientName(els.currentName.value) || currentFileName || "未命名";
    const handle = await files.pickSave(`${baseName}.png`, ".png", "image/png", "PNG Image");
    const svg = buildExportSvg(background);
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = img.width * scale; canvas.height = img.height * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await files.write(handle, png);
    showToast(`已匯出 ${handle.name}`);
  }

  async function runFileAction(action) {
    try { await action(); }
    catch (error) { if (error?.name !== "AbortError") showToast(error.message || "檔案操作失敗"); }
  }

  els.tables.addEventListener("click", onTableClick);
  els.tables.addEventListener("input", onInput);
  els.tables.addEventListener("keydown", event => {
    if (event.target.matches("[contenteditable='true']") && event.key === "Enter") {
      event.preventDefault(); event.target.blur();
    }
  });
  els.tableList.addEventListener("click", onTableListClick);
  els.undoButton.addEventListener("click", undo);
  els.redoButton.addEventListener("click", redo);
  els.newButton.addEventListener("click", () => runFileAction(newDiagram));
  els.addTable.addEventListener("click", openTableDialog);
  els.emptyAdd.addEventListener("click", openTableDialog);
  els.refMode.addEventListener("click", () => toggleReferenceMode());
  els.tableName.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); els.tableForm.requestSubmit(); } });
  els.currentName.addEventListener("input", () => { currentFileName = safeClientName(els.currentName.value); });
  els.currentName.addEventListener("change", updateFileUI);
  els.saveButton.addEventListener("click", () => runFileAction(saveDiagram));
  els.saveAsButton.addEventListener("click", () => runFileAction(saveAsDiagram));
  els.openButton.addEventListener("click", () => runFileAction(() => openFromDisk()));
  document.querySelector("#export-open").addEventListener("click", () => els.exportDialog.showModal());
  document.querySelector("#fit-view").addEventListener("click", () => { els.viewport.scrollTo({ top: 0, left: 0, behavior: "smooth" }); });
  els.tableForm.addEventListener("submit", event => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    if (!els.tableName.value.trim()) { els.tableName.focus(); return; }
    els.tableDialog.close(); addTable(els.tableName.value);
  });
  els.exportForm.addEventListener("submit", async event => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    const background = new FormData(els.exportForm).get("background");
    els.exportDialog.close();
    await runFileAction(() => exportPng(background));
  });
  els.refList.addEventListener("click", event => {
    const item = event.target.closest(".reference-item");
    if (!item) return;
    if (event.target.closest("[data-action='delete-reference']")) deleteReference(item.dataset.refId);
    else { selectedReference = item.dataset.refId; drawConnections(); }
  });
  els.paths.addEventListener("pointerdown", event => {
    const connection = event.target.closest(".connection");
    if (!connection) return;
    event.preventDefault();
    event.stopPropagation();
    selectedReference = connection.dataset.refId; drawConnections();
  });
  document.addEventListener("pointerdown", event => {
    if (els.workspace.hidden || event.target.closest(".connection, .connection-handle-button, .reference-item")) return;
    if (selectedReference) { selectedReference = null; drawConnections(); }
  });
  els.controls.addEventListener("pointerdown", beginHandleDrag);
  window.addEventListener("pointermove", moveHandleDrag, { passive: false });
  window.addEventListener("pointerup", endHandleDrag);
  window.addEventListener("pointercancel", endHandleDrag);
  window.addEventListener("resize", queueConnectionDraw);
  window.addEventListener("keydown", event => {
    if (els.workspace.hidden) return;
    const editing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") { event.preventDefault(); runFileAction(saveDiagram); return; }
    if (!editing && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    if (!editing && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
    if (!editing && (event.key === "Delete" || event.key === "Backspace") && selectedReference) { event.preventDefault(); deleteReference(selectedReference); return; }
    if (event.key !== "Escape") return;
    if (activeReferenceDrag) endHandleDrag(event);
    const hadSelection = Boolean(selectedReference);
    selectedReference = null;
    if (referenceMode) toggleReferenceMode(false);
    else if (hadSelection) drawConnections();
  });
  new ResizeObserver(queueConnectionDraw).observe(els.tables);

  updateFileUI();
  render();
  restoreLastFile();
})();
