(() => {
  "use strict";

  const HANDLE_KEY = "er-diagram-handle";
  const SNAPSHOT_KEY = `${HANDLE_KEY}:snapshot`;
  const LEGACY_STORAGE_KEY = "er-diagram-maker-v1";
  const MODE_KEY = "diagram-maker-active-mode";
  const CORE_TYPES = new Set(["entity", "weakEntity", "relationship", "identifyingRelationship"]);
  const ATTRIBUTE_TYPES = new Set(["attribute", "multivalued", "derived", "composite"]);
  const RELATION_TYPES = new Set(["relationship", "identifyingRelationship"]);
  const ENTITY_TYPES = new Set(["entity", "weakEntity"]);
  const NODE_TYPES = ["entity", "weakEntity", "relationship", "identifyingRelationship", "attribute", "multivalued", "derived", "composite"];

  const state = { version: 1, nodes: [], connections: [] };
  const files = window.diagramFileAccess;
  let selected = null;
  let connectMode = false;
  let connectSource = null;
  let currentFileName = "";
  let currentFileHandle = null;
  let activeDrag = null;
  let pendingType = "entity";
  let undoStack = [];
  let redoStack = [];
  let lastSnapshot = JSON.stringify(state);
  let restoringHistory = false;
  const measureCanvas = document.createElement("canvas");
  const measureContext = measureCanvas.getContext("2d");

  const els = {
    modeTabs: [...document.querySelectorAll("[data-editor-mode]")],
    eyebrow: document.querySelector("#editor-eyebrow"),
    relationalActions: document.querySelector("#relational-actions"),
    erActions: document.querySelector("#er-actions"),
    relationalWorkspace: document.querySelector("#relational-workspace"),
    workspace: document.querySelector("#er-workspace"),
    canvas: document.querySelector("#er-canvas"),
    edgeLayer: document.querySelector("#er-edge-layer"),
    nodeLayer: document.querySelector("#er-node-layer"),
    viewport: document.querySelector("#er-viewport"),
    summary: document.querySelector("#er-summary"),
    status: document.querySelector("#er-status"),
    inspector: document.querySelector("#er-inspector"),
    connect: document.querySelector("#er-connect-mode"),
    newButton: document.querySelector("#er-new"),
    undoButton: document.querySelector("#er-undo"),
    redoButton: document.querySelector("#er-redo"),
    currentName: document.querySelector("#er-current-file-name"),
    add: document.querySelector("#er-add-entity"),
    createButtons: [...document.querySelectorAll("[data-er-create]")],
    arrange: document.querySelector("#er-arrange"),
    unlock: document.querySelector("#er-unlock-all"),
    objectDialog: document.querySelector("#er-object-dialog"),
    objectForm: document.querySelector("#er-object-form"),
    objectType: document.querySelector("#er-object-type"),
    objectName: document.querySelector("#er-object-name"),
    objectTitle: document.querySelector("#er-object-title"),
    ownerNote: document.querySelector("#er-owner-note"),
    save: document.querySelector("#er-save"),
    saveAs: document.querySelector("#er-save-as"),
    open: document.querySelector("#er-open"),
    exportOpen: document.querySelector("#er-export-open"),
    exportDialog: document.querySelector("#er-export-dialog"),
    exportForm: document.querySelector("#er-export-form"),
    toast: document.querySelector("#toast")
  };

  function uid() { return `er-${Math.random().toString(36).slice(2, 10)}`; }
  function esc(value) { return String(value).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
  function updateHistoryButtons() {
    els.undoButton.disabled = undoStack.length === 0;
    els.redoButton.disabled = redoStack.length === 0;
  }
  function persist() {
    const snapshot = JSON.stringify(state);
    if (activeDrag) { updateHistoryButtons(); return; }
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
    state.version = data.version || 1;
    state.nodes = data.nodes || [];
    state.connections = data.connections || [];
    selected = null;
    connectSource = null;
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
  function nodeById(id) { return state.nodes.find(node => node.id === id); }
  function connectionById(id) { return state.connections.find(edge => edge.id === id); }
  function isRelation(node) { return node && RELATION_TYPES.has(node.type); }
  function isAttribute(node) { return node && ATTRIBUTE_TYPES.has(node.type); }
  function safeName(value) { return value.trim().replace(/\.json$/i, "").replace(/[^0-9A-Za-z._\-\u4e00-\u9fff]+/g, "-").replace(/^[.\-]+|[.\-]+$/g, "").slice(0, 80); }

  function setMode(mode) {
    const er = mode === "er";
    els.relationalWorkspace.hidden = er;
    els.relationalActions.hidden = er;
    els.workspace.hidden = !er;
    els.erActions.hidden = !er;
    els.eyebrow.textContent = er ? "ENTITY–RELATIONSHIP MODEL" : "RELATIONAL SCHEMA";
    els.modeTabs.forEach(tab => tab.classList.toggle("active", tab.dataset.editorMode === mode));
    localStorage.setItem(MODE_KEY, mode);
    document.title = er ? "ER Diagram Maker" : "Relational Diagram Maker";
    if (er) requestAnimationFrame(render);
  }

  function nodeSize(node) {
    measureContext.font = '12pt "Noto Serif CJK TC", "Noto Serif TC", Georgia, serif';
    const measured = Math.ceil(measureContext.measureText(node.name || "").width);
    if (RELATION_TYPES.has(node.type)) return { width: Math.max(116, measured + 62), height: 72 };
    if (ATTRIBUTE_TYPES.has(node.type)) return { width: Math.max(104, measured + 42), height: 50 };
    return { width: Math.max(106, measured + 44), height: 54 };
  }

  function initialPosition(type, owner) {
    if (owner) {
      const attached = state.connections.filter(edge => edge.from === owner.id || edge.to === owner.id)
        .map(edge => nodeById(edge.from === owner.id ? edge.to : edge.from)).filter(isAttribute);
      const angles = [-Math.PI / 2, Math.PI / 2, Math.PI, 0, -2.35, -.78, 2.35, .78];
      const angle = angles[attached.length % angles.length];
      const ring = 140 + Math.floor(attached.length / angles.length) * 70;
      return { x: owner.x + Math.cos(angle) * ring, y: owner.y + Math.sin(angle) * ring };
    }
    const coreCount = state.nodes.filter(node => CORE_TYPES.has(node.type)).length;
    const looseCount = state.nodes.filter(node => ATTRIBUTE_TYPES.has(node.type)).length;
    const index = CORE_TYPES.has(type) ? coreCount : looseCount;
    return { x: 170 + (index % 4) * 250, y: 150 + Math.floor(index / 4) * 190 };
  }

  function createNode(type, name) {
    const selectedNode = selected?.kind === "node" ? nodeById(selected.id) : null;
    const owner = ATTRIBUTE_TYPES.has(type) && selectedNode && (CORE_TYPES.has(selectedNode.type) || selectedNode.type === "composite") ? selectedNode : null;
    const position = initialPosition(type, owner);
    const node = { id: uid(), type, name: name.trim(), x: Math.max(80, position.x), y: Math.max(70, position.y), pinned: false, keyKind: "none" };
    state.nodes.push(node);
    if (owner) state.connections.push(newConnection(owner.id, node.id));
    selected = { kind: "node", id: node.id };
    resolveCollisions(node);
    render();
  }

  function newConnection(from, to) {
    const a = nodeById(from); const b = nodeById(to);
    const relationEdge = isRelation(a) || isRelation(b);
    return {
      id: uid(), from, to,
      participation: "partial",
      cardinality: relationEdge ? "N" : "",
      labelSide: "above",
      labelPosition: .23,
      roleName: ""
    };
  }

  function validConnection(a, b) {
    if (!a || !b || a.id === b.id) return false;
    if ((isRelation(a) && ENTITY_TYPES.has(b.type)) || (isRelation(b) && ENTITY_TYPES.has(a.type))) return true;
    if (isAttribute(a) && (CORE_TYPES.has(b.type) || b.type === "composite")) return true;
    if (isAttribute(b) && (CORE_TYPES.has(a.type) || a.type === "composite")) return true;
    return false;
  }

  function resolveCollisions(node) {
    if (node.pinned) return;
    placeNear(node, { x: node.x, y: node.y }, state.nodes.filter(other => other.id !== node.id));
  }

  function overlapsAt(node, x, y, other, padding = 24) {
    const size = nodeSize(node); const os = nodeSize(other);
    return Math.abs(x - other.x) < (size.width + os.width) / 2 + padding && Math.abs(y - other.y) < (size.height + os.height) / 2 + padding;
  }

  function placeNear(node, desired, obstacles) {
    const size = nodeSize(node);
    const minX = size.width / 2 + 58;
    const minY = size.height / 2 + 52;
    const candidates = [{ x: desired.x, y: desired.y }];
    for (let ring = 1; ring <= 12; ring++) {
      const step = 34 * ring;
      for (let i = -ring; i <= ring; i++) {
        candidates.push({ x: desired.x + i * 34, y: desired.y - step });
        candidates.push({ x: desired.x + i * 34, y: desired.y + step });
      }
      for (let i = -ring + 1; i < ring; i++) {
        candidates.push({ x: desired.x - step, y: desired.y + i * 34 });
        candidates.push({ x: desired.x + step, y: desired.y + i * 34 });
      }
    }
    const point = candidates.find(candidate => candidate.x >= minX && candidate.y >= minY && !obstacles.some(other => overlapsAt(node, candidate.x, candidate.y, other))) || candidates[candidates.length - 1];
    node.x = Math.max(minX, point.x); node.y = Math.max(minY, point.y);
  }

  function boundaryPoint(node, toward) {
    const size = nodeSize(node);
    const dx = toward.x - node.x; const dy = toward.y - node.y;
    const len = Math.hypot(dx, dy) || 1;
    let t;
    if (ATTRIBUTE_TYPES.has(node.type)) {
      t = 1 / Math.sqrt((dx * dx) / ((size.width / 2) ** 2) + (dy * dy) / ((size.height / 2) ** 2));
    } else if (RELATION_TYPES.has(node.type)) {
      t = 1 / (Math.abs(dx) / (size.width / 2) + Math.abs(dy) / (size.height / 2));
    } else {
      t = Math.min((size.width / 2) / Math.max(Math.abs(dx), .001), (size.height / 2) / Math.max(Math.abs(dy), .001));
    }
    return { x: node.x + dx * t, y: node.y + dy * t, ux: dx / len, uy: dy / len };
  }

  function edgeGeometry(edge) {
    const a = nodeById(edge.from); const b = nodeById(edge.to);
    if (!a || !b) return null;
    const start = boundaryPoint(a, b); const end = boundaryPoint(b, a);
    const dx = end.x - start.x; const dy = end.y - start.y; const len = Math.hypot(dx, dy) || 1;
    return { a, b, start, end, nx: -dy / len, ny: dx / len };
  }

  function edgeSvg(edge, selectedEdge = false) {
    const g = edgeGeometry(edge);
    if (!g) return "";
    const { start, end, nx, ny, a, b } = g;
    const path = `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
    const lines = edge.participation === "total"
      ? `<path class="er-edge-visible" d="M ${start.x + nx * 3} ${start.y + ny * 3} L ${end.x + nx * 3} ${end.y + ny * 3}"></path><path class="er-edge-visible" d="M ${start.x - nx * 3} ${start.y - ny * 3} L ${end.x - nx * 3} ${end.y - ny * 3}"></path>`
      : `<path class="er-edge-visible" d="${path}"></path>`;
    let labels = "";
    if (isRelation(a) || isRelation(b)) {
      const relation = isRelation(a) ? a : b;
      const other = relation.id === a.id ? b : a;
      const rs = relation.id === a.id ? start : end;
      const os = relation.id === a.id ? end : start;
      const rnx = relation.id === a.id ? nx : -nx;
      const rny = relation.id === a.id ? ny : -ny;
      const t = Number(edge.labelPosition) || .23;
      const sign = edge.labelSide === "below" ? 1 : -1;
      const lx = rs.x + (os.x - rs.x) * t + rnx * 15 * sign;
      const ly = rs.y + (os.y - rs.y) * t + rny * 15 * sign;
      if (edge.cardinality) labels += `<text class="er-edge-label" x="${lx}" y="${ly}">${esc(edge.cardinality)}</text>`;
      if (edge.roleName) {
        const rx = relation.x + (other.x - relation.x) * .62 - rnx * 14 * sign;
        const ry = relation.y + (other.y - relation.y) * .62 - rny * 14 * sign;
        labels += `<text class="er-edge-role" x="${rx}" y="${ry}">${esc(edge.roleName)}</text>`;
      }
    }
    return `<g class="er-edge ${selectedEdge ? "selected" : ""}" data-edge-id="${edge.id}"><path class="er-edge-hit" d="${path}"></path>${lines}${labels}</g>`;
  }

  function nodeSvg(node, selectedNode = false, exportMode = false) {
    const { width: w, height: h } = nodeSize(node);
    const x = -w / 2; const y = -h / 2;
    let shapes = "";
    if (ENTITY_TYPES.has(node.type)) {
      shapes = `<rect class="shape" x="${x}" y="${y}" width="${w}" height="${h}"></rect>`;
      if (node.type === "weakEntity") shapes += `<rect class="inner-shape" x="${x + 5}" y="${y + 5}" width="${w - 10}" height="${h - 10}"></rect>`;
    } else if (RELATION_TYPES.has(node.type)) {
      const points = `0,${y} ${w / 2},0 0,${h / 2} ${-w / 2},0`;
      shapes = `<polygon class="shape" points="${points}"></polygon>`;
      if (node.type === "identifyingRelationship") {
        const iw = w - 13; const ih = h - 11;
        shapes += `<polygon class="inner-shape" points="0,${-ih / 2} ${iw / 2},0 0,${ih / 2} ${-iw / 2},0"></polygon>`;
      }
    } else {
      const derived = node.type === "derived" ? " derived-shape" : "";
      shapes = `<ellipse class="shape${derived}" cx="0" cy="0" rx="${w / 2}" ry="${h / 2}"></ellipse>`;
      if (node.type === "multivalued") shapes += `<ellipse class="inner-shape" cx="0" cy="0" rx="${w / 2 - 5}" ry="${h / 2 - 5}"></ellipse>`;
    }
    const underlineWidth = Math.min(w - 22, Math.max(28, [...(node.name || "")].length * 8));
    const key = ATTRIBUTE_TYPES.has(node.type) && node.keyKind && node.keyKind !== "none"
      ? `<line class="er-key-line ${node.keyKind === "partial" ? "partial" : ""}" x1="${-underlineWidth / 2}" y1="10" x2="${underlineWidth / 2}" y2="10"></line>` : "";
    const pin = node.pinned && !exportMode ? `<circle class="er-pin" cx="${w / 2 - 4}" cy="${-h / 2 + 4}" r="4"></circle>` : "";
    return `<g class="er-node ${selectedNode ? "selected" : ""} ${connectSource === node.id && !exportMode ? "connect-source" : ""}" data-node-id="${node.id}" transform="translate(${node.x} ${node.y})">${shapes}<text x="0" y="1">${esc(node.name)}</text>${key}${pin}</g>`;
  }

  function renderCanvasOnly() {
    const maxX = Math.max(1400, ...state.nodes.map(node => node.x + nodeSize(node).width / 2 + 180));
    const maxY = Math.max(900, ...state.nodes.map(node => node.y + nodeSize(node).height / 2 + 180));
    els.canvas.setAttribute("width", maxX); els.canvas.setAttribute("height", maxY); els.canvas.setAttribute("viewBox", `0 0 ${maxX} ${maxY}`);
    els.edgeLayer.innerHTML = state.connections.map(edge => edgeSvg(edge, selected?.kind === "edge" && selected.id === edge.id)).join("");
    els.nodeLayer.innerHTML = state.nodes.map(node => nodeSvg(node, selected?.kind === "node" && selected.id === node.id)).join("");
    els.summary.textContent = `${state.nodes.length} objects · ${state.connections.length} connections`;
  }

  function render() {
    renderCanvasOnly();
    updateStatus(); updateInspector(); updateSaveLabel(); persist();
  }

  function updateStatus() {
    els.connect.classList.toggle("active", connectMode);
    els.connect.setAttribute("aria-pressed", String(connectMode));
    if (!connectMode) {
      els.status.hidden = true;
      els.status.innerHTML = "";
    } else if (!connectSource) {
      els.status.hidden = false;
      els.status.className = "status-card active";
      els.status.innerHTML = `<span class="status-dot"></span><div><strong>選擇第一個物件</strong><p>接著選擇要連接的另一個物件。</p></div>`;
    } else {
      els.status.hidden = false;
      els.status.className = "status-card active";
      els.status.innerHTML = `<span class="status-dot"></span><div><strong>選擇第二個物件</strong><p>${esc(nodeById(connectSource)?.name || "?")} → ?</p></div>`;
    }
  }

  function updateInspector() {
    if (!selected) { els.inspector.innerHTML = `<p class="reference-empty">尚未選取物件</p>`; return; }
    if (selected.kind === "node") {
      const node = nodeById(selected.id); if (!node) { selected = null; return updateInspector(); }
      const attributeControls = isAttribute(node) ? `
        <div class="er-property"><label>Key 類型</label><div class="er-inline-options three">
          ${["none", "key", "partial"].map(value => `<button class="er-option ${node.keyKind === value ? "active" : ""}" type="button" data-er-key="${value}">${value === "none" ? "無" : value === "key" ? "Key" : "Partial"}</button>`).join("")}
        </div></div>` : "";
      els.inspector.innerHTML = `
        <div class="er-property"><label>名稱</label><input id="er-selected-name" value="${esc(node.name)}" maxlength="50"></div>
        <div class="er-property"><label for="er-selected-type">類型</label><select id="er-selected-type">
          ${NODE_TYPES.map(type => `<option value="${type}" ${node.type === type ? "selected" : ""}>${esc(typeLabel(type))}</option>`).join("")}
        </select></div>
        ${attributeControls}
        <div class="er-inline-options"><button class="er-option ${node.pinned ? "active" : ""}" type="button" data-er-action="toggle-pin">${node.pinned ? "已鎖定" : "鎖定位置"}</button><button class="er-option er-danger" type="button" data-er-action="delete">刪除</button></div>`;
    } else {
      const edge = connectionById(selected.id); if (!edge) { selected = null; return updateInspector(); }
      const relationEdge = isRelation(nodeById(edge.from)) || isRelation(nodeById(edge.to));
      els.inspector.innerHTML = `
        ${relationEdge ? `<div class="er-property"><label>Participation</label><div class="er-inline-options"><button class="er-option ${edge.participation === "partial" ? "active" : ""}" type="button" data-er-participation="partial">單線</button><button class="er-option ${edge.participation === "total" ? "active" : ""}" type="button" data-er-participation="total">Total 雙線</button></div></div>
        <div class="er-property"><label>Cardinality</label><div class="er-inline-options three">${["", "1", "N", "M"].map(value => `<button class="er-option ${edge.cardinality === value ? "active" : ""}" type="button" data-er-cardinality="${value}">${value || "無"}</button>`).join("")}</div></div>
        <div class="er-property"><label>標記位置</label><div class="er-inline-options"><button class="er-option ${edge.labelSide === "above" ? "active" : ""}" type="button" data-er-label-side="above">線上</button><button class="er-option ${edge.labelSide === "below" ? "active" : ""}" type="button" data-er-label-side="below">線下</button></div></div>
        <div class="er-property"><label>角色名稱（選填）</label><input id="er-role-name" value="${esc(edge.roleName || "")}" maxlength="40" placeholder="例如 supervisor"></div>` : `<p class="hint">Attribute connection 使用一般單線。</p>`}
        <div class="er-inspector-actions"><button class="button er-danger" type="button" data-er-action="delete">刪除連線</button></div>`;
    }
  }

  function typeLabel(type) {
    return ({ entity: "Entity", weakEntity: "Weak entity", relationship: "Relationship", identifyingRelationship: "Identifying relationship", attribute: "Attribute", multivalued: "Multivalued attribute", derived: "Derived attribute", composite: "Composite attribute" })[type] || type;
  }

  function openCreate(type = "entity") {
    pendingType = type; els.objectType.value = type; els.objectName.value = "";
    els.objectTitle.textContent = `新增 ${typeLabel(type)}`;
    const owner = selected?.kind === "node" ? nodeById(selected.id) : null;
    els.ownerNote.textContent = ATTRIBUTE_TYPES.has(type) && owner ? `將自動連接至 ${owner.name}` : "Attribute 建立時若已選取 owner，會自動連線。";
    els.objectDialog.showModal(); requestAnimationFrame(() => els.objectName.focus());
  }

  function toggleConnect(force) {
    connectMode = typeof force === "boolean" ? force : !connectMode;
    connectSource = null; updateStatus(); render();
  }

  function deleteSelection() {
    if (!selected) return;
    if (selected.kind === "node") {
      state.connections = state.connections.filter(edge => edge.from !== selected.id && edge.to !== selected.id);
      state.nodes = state.nodes.filter(node => node.id !== selected.id);
    } else state.connections = state.connections.filter(edge => edge.id !== selected.id);
    selected = null; render();
  }

  function handleNodePointerDown(event) {
    const group = event.target.closest(".er-node"); if (!group) return;
    event.preventDefault(); event.stopPropagation();
    const node = nodeById(group.dataset.nodeId); if (!node) return;
    if (connectMode) {
      if (!connectSource) { connectSource = node.id; selected = { kind: "node", id: node.id }; render(); return; }
      const source = nodeById(connectSource);
      if (!validConnection(source, node)) { showToast("這兩種物件不能直接連接"); return; }
      const edge = newConnection(source.id, node.id); state.connections.push(edge);
      selected = { kind: "edge", id: edge.id }; connectMode = false; connectSource = null; render(); return;
    }
    selected = { kind: "node", id: node.id };
    const point = clientPoint(event);
    const children = state.connections.filter(edge => edge.from === node.id || edge.to === node.id)
      .map(edge => nodeById(edge.from === node.id ? edge.to : edge.from)).filter(child => child && isAttribute(child) && !child.pinned)
      .map(child => ({ node: child, x: child.x, y: child.y }));
    activeDrag = { node, start: point, x: node.x, y: node.y, children };
    render();
  }

  function clientPoint(event) {
    const point = els.canvas.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    const matrix = els.canvas.getScreenCTM();
    return matrix ? point.matrixTransform(matrix.inverse()) : { x: event.clientX, y: event.clientY };
  }

  function dragMove(event) {
    if (!activeDrag) return;
    event.preventDefault();
    const point = clientPoint(event); const dx = point.x - activeDrag.start.x; const dy = point.y - activeDrag.start.y;
    activeDrag.node.x = Math.max(70, Math.round((activeDrag.x + dx) / 8) * 8);
    activeDrag.node.y = Math.max(55, Math.round((activeDrag.y + dy) / 8) * 8);
    activeDrag.node.pinned = true;
    activeDrag.children.forEach(item => { item.node.x = item.x + dx; item.node.y = item.y + dy; });
    render();
  }

  function dragEnd() { if (!activeDrag) return; activeDrag = null; persist(); render(); }

  function arrangeUnpinned() {
    const entities = state.nodes.filter(node => ENTITY_TYPES.has(node.type));
    const relations = state.nodes.filter(node => RELATION_TYPES.has(node.type));
    const placed = state.nodes.filter(node => node.pinned);
    const placedIds = new Set(placed.map(node => node.id));
    const markPlaced = node => { if (!placedIds.has(node.id)) { placed.push(node); placedIds.add(node.id); } };
    const entityDegree = entity => state.connections.filter(edge => {
      if (edge.from !== entity.id && edge.to !== entity.id) return false;
      return isRelation(nodeById(edge.from === entity.id ? edge.to : edge.from));
    }).length;

    // Chen-style backbone: entities share a horizontal axis. The most connected
    // entity occupies the center; the remaining entities alternate right/left.
    const ranked = [...entities].sort((a, b) => entityDegree(b) - entityDegree(a) || state.nodes.indexOf(a) - state.nodes.indexOf(b));
    const count = ranked.length;
    const centerSlot = Math.floor((count - 1) / 2);
    const slots = [centerSlot];
    for (let distance = 1; slots.length < count; distance++) {
      if (centerSlot + distance < count) slots.push(centerSlot + distance);
      if (centerSlot - distance >= 0) slots.push(centerSlot - distance);
    }
    const orderedEntities = Array(count);
    ranked.forEach((node, index) => { orderedEntities[slots[index]] = node; });
    const linkedEntitiesFor = relation => state.connections
      .filter(edge => edge.from === relation.id || edge.to === relation.id)
      .map(edge => nodeById(edge.from === relation.id ? edge.to : edge.from))
      .filter(node => ENTITY_TYPES.has(node?.type));
    const relationsBetween = (left, right) => relations.filter(relation => {
      const ids = new Set(linkedEntitiesFor(relation).map(node => node.id));
      return ids.has(left.id) && ids.has(right.id);
    });
    let entityCursor = 360;
    orderedEntities.forEach((node, index) => {
      if (index === 0 && node.pinned) entityCursor = node.x;
      if (index > 0) {
        const previous = orderedEntities[index - 1];
        const between = relationsBetween(previous, node);
        const relationshipWidth = between.length ? Math.max(...between.map(relation => nodeSize(relation).width)) : 0;
        const labelClearance = between.length ? 48 : 0;
        const connectedDistance = Math.max(nodeSize(previous).width, nodeSize(node).width) + relationshipWidth + labelClearance * 2;
        const unconnectedDistance = nodeSize(previous).width / 2 + nodeSize(node).width / 2 + 130;
        const nextDistance = Math.max(250, between.length ? connectedDistance : unconnectedDistance);
        entityCursor = previous.x + nextDistance;
      }
      if (!node.pinned) {
        const desired = { x: entityCursor, y: 400 };
        const pinnedObstacles = placed.filter(other => other.pinned);
        if (pinnedObstacles.some(other => overlapsAt(node, desired.x, desired.y, other))) placeNear(node, desired, placed);
        else { node.x = desired.x; node.y = desired.y; }
      }
      markPlaced(node);
    });

    // Relationships sit between their participating entities. Parallel
    // relationships for the same pair are fanned above and below the axis.
    const relationGroups = new Map();
    relations.forEach(relation => {
      const linked = linkedEntitiesFor(relation);
      const key = linked.map(node => node.id).sort().join("|") || `loose:${relation.id}`;
      if (!relationGroups.has(key)) relationGroups.set(key, []);
      relationGroups.get(key).push({ relation, linked });
    });
    let looseRelationIndex = 0;
    relationGroups.forEach(group => {
      group.forEach((item, index) => {
        const { relation, linked } = item;
        if (!relation.pinned) {
          let desired;
          if (linked.length >= 2) {
            const x = linked.reduce((sum, node) => sum + node.x, 0) / linked.length;
            const y = linked.reduce((sum, node) => sum + node.y, 0) / linked.length;
            const minX = Math.min(...linked.map(node => node.x));
            const maxX = Math.max(...linked.map(node => node.x));
            const crossesEntity = entities.some(entity => !linked.includes(entity) && entity.x > minX && entity.x < maxX && Math.abs(entity.y - y) < 90);
            let offset = group.length === 1 ? 0 : (index - (group.length - 1) / 2) * 280;
            if (group.length === 1 && crossesEntity) offset = 140 * (looseRelationIndex++ % 2 ? 1 : -1);
            desired = { x, y: y + offset };
          } else if (linked.length === 1) {
            desired = { x: linked[0].x + 210, y: linked[0].y + (index - (group.length - 1) / 2) * 170 };
          } else {
            desired = { x: 240 + (looseRelationIndex++ % 4) * 260, y: 690 + Math.floor(looseRelationIndex / 4) * 160 };
          }
          const pinnedObstacles = placed.filter(other => other.pinned);
          if (pinnedObstacles.some(other => overlapsAt(relation, desired.x, desired.y, other))) placeNear(relation, desired, placed);
          else { relation.x = desired.x; relation.y = desired.y; }
        }
        markPlaced(relation);
      });
    });

    // Attributes choose directions that are furthest away from relationship
    // connections, then use collision-aware nearest placement.
    const laidOutAttributes = new Set(state.nodes.filter(node => node.pinned && isAttribute(node)).map(node => node.id));
    const owners = [...entities, ...relations, ...state.nodes.filter(node => node.type === "composite")];
    const candidates = [-Math.PI / 2, Math.PI / 2, Math.PI, 0, -2.35, 2.35, -.78, .78, -2.8, 2.8, -1.15, 1.15];
    const angleDistance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    owners.forEach(owner => {
      const attributes = state.connections
        .filter(edge => edge.from === owner.id || edge.to === owner.id)
        .map(edge => nodeById(edge.from === owner.id ? edge.to : edge.from))
        .filter(node => isAttribute(node) && node.id !== owner.id);
      const occupied = state.connections
        .filter(edge => edge.from === owner.id || edge.to === owner.id)
        .map(edge => nodeById(edge.from === owner.id ? edge.to : edge.from))
        .filter(node => node && !isAttribute(node))
        .map(node => Math.atan2(node.y - owner.y, node.x - owner.x));
      const used = [];
      attributes.forEach(attribute => {
        if (laidOutAttributes.has(attribute.id)) { markPlaced(attribute); return; }
        let bestAngle = candidates[0]; let bestScore = -Infinity;
        candidates.forEach(angle => {
          const relationClearance = occupied.length ? Math.min(...occupied.map(other => angleDistance(angle, other))) : Math.PI;
          const attributeClearance = used.length ? Math.min(...used.map(other => angleDistance(angle, other))) : Math.PI;
          const score = relationClearance * 1.4 + attributeClearance;
          if (score > bestScore) { bestScore = score; bestAngle = angle; }
        });
        used.push(bestAngle);
        const ownerSize = nodeSize(owner); const attributeSize = nodeSize(attribute);
        const radiusX = ownerSize.width / 2 + attributeSize.width / 2 + 70;
        const radiusY = ownerSize.height / 2 + attributeSize.height / 2 + 68;
        if (!attribute.pinned) placeNear(attribute, { x: owner.x + Math.cos(bestAngle) * radiusX, y: owner.y + Math.sin(bestAngle) * radiusY }, placed);
        laidOutAttributes.add(attribute.id); markPlaced(attribute);
      });
    });

    state.nodes.filter(node => isAttribute(node) && !laidOutAttributes.has(node.id)).forEach((node, index) => {
      if (!node.pinned) placeNear(node, { x: 180 + (index % 4) * 240, y: 760 + Math.floor(index / 4) * 130 }, placed);
      markPlaced(node);
    });
    render(); showToast("已整理未鎖定物件");
  }

  function diagramData(name = currentFileName) {
    return { diagramType: "er", version: 1, name, savedAt: new Date().toISOString(), nodes: state.nodes, connections: state.connections };
  }

  function loadDiagram(data, fallbackName = "") {
    if (!data || data.diagramType !== "er" || !Array.isArray(data.nodes) || !Array.isArray(data.connections)) throw new Error("這不是有效的 ER diagram JSON");
    state.nodes = data.nodes.map(node => ({ id: String(node.id || uid()), type: String(node.type), name: String(node.name || "").slice(0, 50), x: Number(node.x) || 100, y: Number(node.y) || 100, pinned: Boolean(node.pinned), keyKind: ["none", "key", "partial"].includes(node.keyKind) ? node.keyKind : "none" }));
    const ids = new Set(state.nodes.map(node => node.id));
    state.connections = data.connections.filter(edge => ids.has(String(edge.from)) && ids.has(String(edge.to))).map(edge => ({ id: String(edge.id || uid()), from: String(edge.from), to: String(edge.to), participation: edge.participation === "total" ? "total" : "partial", cardinality: ["", "1", "N", "M"].includes(edge.cardinality) ? edge.cardinality : "", labelSide: edge.labelSide === "below" ? "below" : "above", labelPosition: Number(edge.labelPosition) || .23, roleName: String(edge.roleName || "").slice(0, 40) }));
    currentFileName = String(fallbackName || data.name || "").replace(/\.json$/i, ""); selected = null; connectMode = false; connectSource = null; resetHistory(); render();
  }

  async function newDiagram() {
    if ((state.nodes.length || state.connections.length) && !window.confirm("建立新檔案會清空目前畫布。尚未儲存的變更將會遺失，確定繼續嗎？")) return;
    const handle = await files.pickSave("未命名.json", ".json", "application/json", "ER Diagram JSON");
    const nextName = handle.name.replace(/\.json$/i, "");
    const blank = { diagramType: "er", version: 1, name: nextName, savedAt: new Date().toISOString(), nodes: [], connections: [] };
    const content = JSON.stringify(blank, null, 2);
    await files.write(handle, content);
    state.nodes = [];
    state.connections = [];
    currentFileHandle = handle;
    currentFileName = nextName;
    selected = null;
    connectMode = false;
    connectSource = null;
    activeDrag = null;
    resetHistory();
    updateSaveLabel();
    render();
    await files.rememberHandle(HANDLE_KEY, handle);
    await files.rememberValue(SNAPSHOT_KEY, content);
    showToast(`已新增 ${handle.name}`);
  }

  function updateSaveLabel() {
    if (document.activeElement !== els.currentName) els.currentName.value = currentFileName || "未命名";
  }

  function suggestedJsonName() {
    return `${safeName(els.currentName.value) || currentFileName || "未命名"}.json`;
  }

  async function saveAsDiagram() {
    const handle = await files.pickSave(suggestedJsonName(), ".json", "application/json", "ER Diagram JSON");
    const nextName = handle.name.replace(/\.json$/i, "");
    const content = JSON.stringify(diagramData(nextName), null, 2);
    await files.write(handle, content);
    currentFileHandle = handle;
    currentFileName = nextName;
    updateSaveLabel();
    await files.rememberHandle(HANDLE_KEY, handle);
    await files.rememberValue(SNAPSHOT_KEY, content);
    showToast(`已另存為 ${handle.name}`);
  }

  async function saveDiagram() {
    if (!currentFileHandle) return saveAsDiagram();
    const requestedName = safeName(els.currentName.value === "未命名" ? "" : els.currentName.value);
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
    loadDiagram(JSON.parse(source), nextHandle.name);
    currentFileHandle = nextHandle;
    updateSaveLabel();
    await files.rememberHandle(HANDLE_KEY, nextHandle);
    await files.rememberValue(SNAPSHOT_KEY, JSON.stringify(diagramData(currentFileName), null, 2));
    showToast(`已開啟 ${nextHandle.name}`);
  }

  async function restoreLastFile() {
    try {
      const handle = await files.getHandle(HANDLE_KEY);
      if (!handle) return;
      if (state.nodes.length || state.connections.length || undoStack.length) return;
      if (await files.permission(handle, "read", false)) { await openFromDisk(handle); return; }
      let snapshot = await files.getValue(SNAPSHOT_KEY);
      if (!snapshot) {
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) snapshot = JSON.stringify({ ...JSON.parse(legacy), diagramType: "er", name: handle.name.replace(/\.json$/i, "") });
      }
      if (!snapshot) return;
      loadDiagram(JSON.parse(snapshot), handle.name);
      currentFileHandle = handle;
      updateSaveLabel();
      await files.rememberValue(SNAPSHOT_KEY, JSON.stringify(diagramData(currentFileName), null, 2));
      showToast(`已載入 ${handle.name} 的最後儲存版本`);
    } catch {
      currentFileHandle = null;
      currentFileName = "";
      state.nodes = [];
      state.connections = [];
      resetHistory();
      updateSaveLabel();
      render();
    }
  }

  function exportBounds() {
    if (!state.nodes.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.nodes.forEach(node => { const s = nodeSize(node); minX = Math.min(minX, node.x - s.width / 2); maxX = Math.max(maxX, node.x + s.width / 2); minY = Math.min(minY, node.y - s.height / 2); maxY = Math.max(maxY, node.y + s.height / 2); });
    return { minX: minX - 30, minY: minY - 30, width: maxX - minX + 60, height: maxY - minY + 60 };
  }

  async function exportPng(background) {
    const bounds = exportBounds(); if (!bounds) { showToast("請先建立 ER 物件"); return; }
    const baseName = safeName(els.currentName.value) || currentFileName || "未命名";
    const handle = await files.pickSave(`${baseName}.png`, ".png", "image/png", "PNG Image");
    const styles = `.shape{fill:#e8e8e6;stroke:#171717;stroke-width:1.5}.inner-shape{fill:none;stroke:#171717;stroke-width:1.2}.derived-shape{stroke-dasharray:7 5}.er-node text{font-family:'Noto Serif CJK TC','Noto Serif TC',serif;font-size:12pt;dominant-baseline:middle;text-anchor:middle}.er-key-line{stroke:#171717;stroke-width:1.4}.er-key-line.partial{stroke-dasharray:4 3}.er-edge-visible{fill:none;stroke:#171717;stroke-width:1.5}.er-edge-label{font:italic 12pt 'Noto Serif CJK TC','Noto Serif TC',serif;fill:#171717;text-anchor:middle;dominant-baseline:central}.er-edge-role{font:12pt 'Noto Serif CJK TC','Noto Serif TC',serif;fill:#444;text-anchor:middle}`;
    const bg = background === "white" ? `<rect x="${bounds.minX}" y="${bounds.minY}" width="${bounds.width}" height="${bounds.height}" fill="white"></rect>` : "";
    const edges = state.connections.map(edge => edgeSvg(edge, false).replace(/<path class="er-edge-hit"[^>]*><\/path>/g, "")).join("");
    const nodes = state.nodes.map(node => nodeSvg(node, false, true)).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}"><style>${styles}</style>${bg}<g>${edges}</g><g>${nodes}</g></svg>`;
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" })); const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
    const canvas = document.createElement("canvas"); canvas.width = Math.ceil(bounds.width * 2); canvas.height = Math.ceil(bounds.height * 2);
    const ctx = canvas.getContext("2d"); ctx.scale(2, 2); ctx.drawImage(image, 0, 0); URL.revokeObjectURL(url);
    const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await files.write(handle, png);
    showToast(`已匯出 ${handle.name}`);
  }

  function showToast(message) { els.toast.textContent = message; els.toast.classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 1900); }

  async function runFileAction(action) {
    try { await action(); }
    catch (error) { if (error?.name !== "AbortError") showToast(error.message || "檔案操作失敗"); }
  }

  els.modeTabs.forEach(tab => tab.addEventListener("click", () => setMode(tab.dataset.editorMode)));
  els.undoButton.addEventListener("click", undo);
  els.redoButton.addEventListener("click", redo);
  els.newButton.addEventListener("click", () => runFileAction(newDiagram));
  els.add.addEventListener("click", () => openCreate("entity"));
  document.querySelectorAll("[data-er-create]").forEach(button => button.addEventListener("click", () => openCreate(button.dataset.erCreate)));
  els.objectType.addEventListener("change", () => { pendingType = els.objectType.value; els.objectTitle.textContent = `新增 ${typeLabel(pendingType)}`; });
  els.objectName.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); els.objectForm.requestSubmit(); } });
  els.objectForm.addEventListener("submit", event => { if (event.submitter?.value === "cancel") return; event.preventDefault(); if (!els.objectName.value.trim()) return els.objectName.focus(); els.objectDialog.close(); createNode(els.objectType.value, els.objectName.value); });
  els.connect.addEventListener("click", () => toggleConnect());
  els.canvas.addEventListener("pointerdown", event => {
    if (event.target.closest(".er-node")) return handleNodePointerDown(event);
    const edgeGroup = event.target.closest(".er-edge");
    if (edgeGroup) { event.preventDefault(); event.stopPropagation(); selected = { kind: "edge", id: edgeGroup.dataset.edgeId }; render(); return; }
    selected = null; if (connectMode) { connectSource = null; updateStatus(); } render();
  });
  window.addEventListener("pointermove", dragMove, { passive: false }); window.addEventListener("pointerup", dragEnd); window.addEventListener("pointercancel", dragEnd);
  els.inspector.addEventListener("input", event => {
    if (event.target.id === "er-selected-name" && selected?.kind === "node") { nodeById(selected.id).name = event.target.value; renderCanvasOnly(); persist(); }
    if (event.target.id === "er-role-name" && selected?.kind === "edge") { connectionById(selected.id).roleName = event.target.value; renderCanvasOnly(); persist(); }
  });
  els.inspector.addEventListener("change", event => {
    if (event.target.id !== "er-selected-type" || selected?.kind !== "node") return;
    const node = nodeById(selected.id);
    const type = event.target.value;
    if (!node || !NODE_TYPES.includes(type)) return;
    node.type = type;
    if (!ATTRIBUTE_TYPES.has(type)) node.keyKind = "none";
    render();
    showToast(`已改為 ${typeLabel(type)}`);
  });
  els.inspector.addEventListener("click", event => {
    const button = event.target.closest("button"); if (!button || !selected) return;
    if (button.dataset.erAction === "delete") return deleteSelection();
    if (button.dataset.erAction === "toggle-pin" && selected.kind === "node") nodeById(selected.id).pinned = !nodeById(selected.id).pinned;
    if (button.dataset.erKey && selected.kind === "node") nodeById(selected.id).keyKind = button.dataset.erKey;
    if (button.dataset.erParticipation && selected.kind === "edge") connectionById(selected.id).participation = button.dataset.erParticipation;
    if (button.hasAttribute("data-er-cardinality") && selected.kind === "edge") connectionById(selected.id).cardinality = button.dataset.erCardinality;
    if (button.dataset.erLabelSide && selected.kind === "edge") connectionById(selected.id).labelSide = button.dataset.erLabelSide;
    render();
  });
  els.arrange.addEventListener("click", arrangeUnpinned);
  els.unlock.addEventListener("click", () => { state.nodes.forEach(node => node.pinned = false); render(); showToast("已解除全部位置鎖定"); });
  els.currentName.addEventListener("input", () => { currentFileName = safeName(els.currentName.value); });
  els.currentName.addEventListener("change", updateSaveLabel);
  els.save.addEventListener("click", () => runFileAction(saveDiagram));
  els.saveAs.addEventListener("click", () => runFileAction(saveAsDiagram));
  els.open.addEventListener("click", () => runFileAction(() => openFromDisk()));
  els.exportOpen.addEventListener("click", () => els.exportDialog.showModal());
  els.exportForm.addEventListener("submit", async event => { if (event.submitter?.value === "cancel") return; event.preventDefault(); const background = new FormData(els.exportForm).get("er-background"); els.exportDialog.close(); await runFileAction(() => exportPng(background)); });
  window.addEventListener("keydown", event => {
    if (els.workspace.hidden) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") { event.preventDefault(); runFileAction(saveDiagram); return; }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "y" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) { event.preventDefault(); redo(); return; }
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if (event.key === "Escape") { connectMode = false; connectSource = null; selected = null; activeDrag = null; render(); }
    if ((event.key === "Delete" || event.key === "Backspace") && selected) { event.preventDefault(); deleteSelection(); }
  });

  setMode(localStorage.getItem(MODE_KEY) === "er" ? "er" : "relational");
  render();
  restoreLastFile();
  if (document.fonts?.ready) document.fonts.ready.then(() => renderCanvasOnly());
})();
