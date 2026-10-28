"use strict";

/* ==========================================================
   مختبر تصميم شبكات المياه
   طريقتان للحل: هاردي كروس + نيوتن-رافسون
   ========================================================== */

const SVG_NS = "http://www.w3.org/2000/svg";
const svg = document.getElementById("network");
const pipesLayer = document.getElementById("pipesLayer");
const nodesLayer = document.getElementById("nodesLayer");
const statusBox = document.getElementById("status");
const detailsContent = document.getElementById("detailsContent");
const modeBadge = document.getElementById("modeBadge");
const analysisReport = document.getElementById("analysisReport");
const analysisBadge = document.getElementById("analysisBadge");
const solverMethodSelect = document.getElementById("solverMethod");

const buttons = {
  source: document.getElementById("addSource"),
  junction: document.getElementById("addJunction"),
  demand: document.getElementById("addDemand"),
  connect: document.getElementById("connect"),
  calculate: document.getElementById("calculateNetwork"),
  delete: document.getElementById("deleteElement"),
  clear: document.getElementById("clearNetwork")
};

let nodes = [];
let pipes = [];
let nextNodeId = 1;
let nextPipeId = 1;
let mode = "select";
let firstNodeId = null;
let selected = null;
let draggingNodeId = null;
let pointerStart = null;
let dragMoved = false;
let suppressClick = false;
let hydraulicResults = null;

const STORAGE_KEY = "waterNetworkLab_v1";
const GRAVITY = 9.80665;
const WATER_KINEMATIC_VISCOSITY = 1.004e-6;

const HC_TOL = 1e-6;
const HC_MAX_ITER = 200;
const HC_DQ_CAP = 10;

const nodeTitles = {
  source: "مصدر",
  junction: "عقدة ربط",
  demand: "عقدة استهلاك"
};

/* ------------------------- أدوات عامة ------------------------- */

function setStatus(message) { statusBox.textContent = message; }

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function fmt(value, digits = 3) {
  if (!Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 0, maximumFractionDigits: digits
  });
}

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, String(value)));
  return element;
}

function nodeById(id) { return nodes.find(node => Number(node.id) === Number(id)); }
function pipeById(id) { return pipes.find(pipe => Number(pipe.id) === Number(id)); }
function invalidateHydraulics() { hydraulicResults = null; }

function screenToSvg(event) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return { x: 100, y: 100 };
  return {
    x: (event.clientX - rect.left) * 800 / rect.width,
    y: (event.clientY - rect.top) * 500 / rect.height
  };
}

function saveNetwork() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes, pipes, nextNodeId, nextPipeId }));
    return true;
  } catch (error) { setStatus("تعذر الحفظ التلقائي."); return false; }
}

function loadNetwork() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    nodes = data.nodes || [];
    pipes = data.pipes || [];
    nextNodeId = data.nextNodeId || 1;
    nextPipeId = data.nextPipeId || 1;
    return true;
  } catch (error) { return false; }
}

function selectNode(id) { selected = { type: "node", id: Number(id) }; render(); }
function selectPipe(id) { selected = { type: "pipe", id: Number(id) }; render(); }

/* ------------------------- إضافة العناصر ------------------------- */

function addNode(type) {
  const count = nodes.length;
  const id = nextNodeId++;
  const node = {
    id, type,
    x: 130 + (count % 4) * 155, y: 100 + Math.floor(count / 4) * 115,
    name: nodeTitles[type] + " " + id, elevation: 0,
    demand: type === "demand" ? 5 : 0,
    sourceType: "tank", sourceMode: "head", head: 100, sourceFlow: 30
  };
  nodes.push(node);
  invalidateHydraulics(); saveNetwork();
  selected = { type: "node", id }; mode = "select"; firstNodeId = null;
  render();
  setStatus("أضيفت " + nodeTitles[type] + ".");
}

function handleConnectClick(id) {
  const node = nodeById(id);
  if (!node) { setStatus("لم يتم العثور على العقدة."); return; }

  if (firstNodeId === null) {
    firstNodeId = id; selected = { type: "node", id }; render();
    setStatus("تم اختيار " + node.name + ". اضغط الآن على العقدة الثانية.");
    return;
  }

  if (Number(firstNodeId) === Number(id)) { setStatus("اختر عقدة أخرى."); return; }

  const startId = Number(firstNodeId);
  const endId = Number(id);
  const existing = pipes.find(pipe => (pipe.a === startId && pipe.b === endId) || (pipe.a === endId && pipe.b === startId));

  if (existing) {
    firstNodeId = null; mode = "select"; selected = { type: "pipe", id: existing.id }; render();
    setStatus("يوجد أنبوب بالفعل."); return;
  }

  const pipe = {
    id: nextPipeId++, a: startId, b: endId, L: 100, D: 0.2,
    eps: Number(document.getElementById("materialRoughness")?.value) || 0.00015,
    kMinor: 0, q0: 0,
    pMaxBar: 10 // القيمة الافتراضية للضغط
  };
  pipes.push(pipe);
  invalidateHydraulics(); saveNetwork();
  firstNodeId = null; mode = "select"; selected = { type: "pipe", id: pipe.id };
  render();
  setStatus("تم إنشاء الأنبوب.");
}

/* ------------------------- الرسم ------------------------- */

function render() {
  renderPipes();
  renderNodes();
  renderSummary();
  renderDetails();
  renderAnalysisReport();
  updateToolbar();
}

function renderPipes() {
  if (!pipesLayer) return;
  while (pipesLayer.firstChild) pipesLayer.removeChild(pipesLayer.firstChild);

  pipes.forEach(pipe => {
    const a = nodeById(pipe.a);
    const b = nodeById(pipe.b);
    if (!a || !b) return;

    const hasResult = !!hydraulicResults && hydraulicResults.pipeData.has(pipe.id);
    const result = hasResult ? hydraulicResults.pipeData.get(pipe.id) : null;
    const qLps = result ? result.q * 1000 : null;

    let start = a;
    let end = b;
    if (result && qLps < 0) { start = b; end = a; }

    const isSelected = selected?.type === "pipe" && Number(selected.id) === pipe.id;

    const line = svgElement("line", {
      x1: start.x, y1: start.y, x2: end.x, y2: end.y,
      stroke: isSelected ? "#f2b84b" : "#738797",
      "stroke-width": isSelected ? "8" : "5",
      "stroke-linecap": "round",
      class: "pipe",
      "data-pipe-id": pipe.id
    });

    if (result && Math.abs(qLps) > 0.0001) {
      line.setAttribute("marker-end", "url(#flowArrow)");
    }
    pipesLayer.appendChild(line);

    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;

    const label = svgElement("text", { x: midX, y: midY - 9, class: "pipe-label" });
    label.textContent = "P" + pipe.id;
    pipesLayer.appendChild(label);

    const flowLabel = svgElement("text", { x: midX, y: midY + 15, class: "pipe-label" });
    if (result) {
      const sign = qLps > 0 ? "+" : qLps < 0 ? "−" : "";
      flowLabel.textContent = "Q=" + sign + fmt(Math.abs(qLps), 3) + " L/s";
    } else {
      flowLabel.textContent = Number(pipe.q0) > 0 ? "Q₀=" + fmt(pipe.q0, 3) + " L/s" : "لم يُحسب";
    }
    pipesLayer.appendChild(flowLabel);
  });
}

function renderNodes() {
  if (!nodesLayer) return;
  while (nodesLayer.firstChild) nodesLayer.removeChild(nodesLayer.firstChild);

  nodes.forEach(node => {
    const isSel = selected?.type === "node" && Number(selected.id) === node.id;
    const group = svgElement("g", {
      class: "node " + node.type + (isSel ? " selected" : ""),
      "data-node-id": node.id,
      transform: "translate(" + node.x + " " + node.y + ")"
    });

    const circle = svgElement("circle", { r: node.type === "source" ? 17 : 14, class: "node-shape" });
    const label = svgElement("text", { y: 34, class: "node-label" });
    label.textContent = node.name;

    const subtitle = svgElement("text", { y: 48, class: "node-subtitle" });

    if (hydraulicResults && hydraulicResults.nodeHeads.has(node.id)) {
      const head = hydraulicResults.nodeHeads.get(node.id);
      if (hydraulicResults.relativeHeadNodeIds.has(node.id)) {
        subtitle.textContent = "حمل نسبي: " + fmt(head, 2) + " م";
      } else if (node.type === "source") {
        subtitle.textContent = "الحمل: " + fmt(head, 2) + " م";
      } else {
        const pressure = head - Number(node.elevation || 0);
        subtitle.textContent = "H=" + fmt(head, 2) + " م • ضغط=" + fmt(pressure, 2) + " م";
      }
    } else if (node.type === "demand") {
      subtitle.textContent = fmt(node.demand, 3) + " لتر/ث";
    } else if (node.type === "source") {
      subtitle.textContent = node.sourceMode === "flow" ? "التصريف: " + fmt(node.sourceFlow, 3) + " لتر/ث" : "الحمل: " + fmt(node.head, 2) + " م";
    } else {
      subtitle.textContent = "منسوب: " + fmt(node.elevation, 2) + " م";
    }

    group.append(circle, label, subtitle);
    nodesLayer.appendChild(group);
  });
}

function renderSummary() {
  document.getElementById("nodeCount").textContent = nodes.length;
  document.getElementById("pipeCount").textContent = pipes.length;
  const totalDemand = nodes.reduce((sum, node) => sum + (node.type === "demand" ? Number(node.demand) || 0 : 0), 0);
  document.getElementById("totalDemand").textContent = fmt(totalDemand, 3);
}

function updateToolbar() {
  if (buttons.connect) buttons.connect.classList.toggle("active", mode === "connect");
  if (modeBadge) modeBadge.textContent = mode === "connect" ? "وضع توصيل الأنابيب" : "وضع التحديد";
}

/* ------------------------- تفاصيل العناصر ------------------------- */

function renderDetails() {
  if (!detailsContent) return;
  if (!selected) {
    detailsContent.innerHTML = '<p class="muted">اختر عقدة أو أنبوباً لعرض بياناته.</p>';
    return;
  }

  if (selected.type === "node") {
    const node = nodeById(selected.id);
    if (!node) { selected = null; renderDetails(); return; }

    let extraFields = "";
    if (node.type === "source") {
      extraFields = `
        <div class="field full"><label>شرط المصدر</label>
          <select id="edit_sourceMode" name="sourceMode">
            <option value="head" ${node.sourceMode === "head" ? "selected" : ""}>حمل معلوم</option>
            <option value="flow" ${node.sourceMode === "flow" ? "selected" : ""}>تصريف معلوم</option>
          </select>
        </div>
        <div id="sourceHeadField" class="field full" ${node.sourceMode === "head" ? "" : "hidden"}>
          <label>الحمل (م)</label><input name="head" type="number" step="any" value="${escapeHTML(node.head)}">
        </div>
        <div id="sourceFlowField" class="field full" ${node.sourceMode === "flow" ? "" : "hidden"}>
          <label>التصريف (لتر/ث)</label><input name="sourceFlow" type="number" step="any" value="${escapeHTML(node.sourceFlow)}">
        </div>`;
    }
    if (node.type === "demand") {
      extraFields += `<div class="field full"><label>الطلب (لتر/ث)</label><input name="demand" type="number" step="any" value="${escapeHTML(node.demand)}"></div>`;
    }

    detailsContent.innerHTML = `
      <form id="detailsForm">
        <div class="field-grid">
          <div class="field full"><label>اسم العقدة</label><input name="name" value="${escapeHTML(node.name)}" required></div>
          <div class="field full"><label>المنسوب (م)</label><input name="elevation" type="number" step="any" value="${escapeHTML(node.elevation)}"></div>
          ${extraFields}
        </div>
        <div class="save-row"><button class="save-button" type="submit">حفظ التعديلات</button></div>
      </form>`;

    const form = document.getElementById("detailsForm");
    if (node.type === "source") {
      document.getElementById("edit_sourceMode").addEventListener("change", (e) => {
        const isHead = e.target.value === "head";
        document.getElementById("sourceHeadField").hidden = !isHead;
        document.getElementById("sourceFlowField").hidden = isHead;
      });
    }

    form.addEventListener("submit", event => {
      event.preventDefault();
      const data = new FormData(form);
      node.name = String(data.get("name"));
      node.elevation = Number(data.get("elevation"));
      if (node.type === "source") {
        node.sourceMode = data.get("sourceMode");
        node.head = Number(data.get("head"));
        node.sourceFlow = Number(data.get("sourceFlow"));
      }
      if (node.type === "demand") node.demand = Number(data.get("demand"));
      invalidateHydraulics(); saveNetwork(); render();
      setStatus("تم حفظ بيانات العقدة.");
    });
    return;
  }

  if (selected.type === "pipe") {
    const pipe = pipeById(selected.id);
    if (!pipe) { selected = null; renderDetails(); return; }

    detailsContent.innerHTML = `
      <form id="detailsForm">
        <div class="field-grid">
          <div class="field"><label>الطول (م)</label><input name="L" type="number" step="any" value="${pipe.L}"></div>
          <div class="field"><label>القطر (م)</label><input name="D" type="number" step="any" value="${pipe.D}"></div>
          <div class="field"><label>الخشونة (م)</label><input name="eps" type="number" step="any" value="${pipe.eps}"></div>
          <div class="field"><label>معامل K</label><input name="kMinor" type="number" step="any" value="${pipe.kMinor}"></div>
          <div class="field full"><label>أقصى ضغط يتحمله الأنبوب (بار)</label><input name="pMaxBar" type="number" step="any" value="${pipe.pMaxBar || 10}"></div>
        </div>
        <div class="save-row"><button class="save-button" type="submit">حفظ التعديلات</button></div>
      </form>`;

    document.getElementById("detailsForm").addEventListener("submit", event => {
      event.preventDefault();
      const data = new FormData(event.target);
      pipe.L = Number(data.get("L"));
      pipe.D = Number(data.get("D"));
      pipe.eps = Number(data.get("eps"));
      pipe.kMinor = Number(data.get("kMinor"));
      pipe.pMaxBar = Number(data.get("pMaxBar")) || 10;
      invalidateHydraulics(); saveNetwork(); render();
      setStatus("تم حفظ بيانات الأنبوب.");
    });
  }
}

/* ------------------------- النموذج الهيدروليكي الأساسي ------------------------- */

function pipeArea(pipe) { return Math.PI * pipe.D * pipe.D / 4; }

function classifyFlow(reynolds) {
  if (!Number.isFinite(reynolds) || reynolds < 0) return "غير محدد";
  if (reynolds < 2300) return "صفحي";
  if (reynolds <= 4000) return "انتقالي";
  return "مضطرب";
}

function frictionFactor(pipe, qAbs) {
  if (qAbs <= 1e-14) return 0;
  const velocity = qAbs / pipeArea(pipe);
  const re = velocity * pipe.D / WATER_KINEMATIC_VISCOSITY;
  if (re < 1e-12) return 0;
  if (re < 2000) return 64 / re;
  const turbulent = 0.25 / Math.pow(Math.log10(pipe.eps / (3.7 * pipe.D) + 5.74 / Math.pow(re, 0.9)), 2);
  if (re >= 4000) return turbulent;
  const t = (re - 2000) / 2000;
  const smooth = t * t * (3 - 2 * t);
  const laminarAtRe = 64 / re;
  return laminarAtRe * (1 - smooth) + turbulent * smooth;
}

function headLossMagnitude(pipe, qAbs) {
  if (qAbs <= 0) return 0;
  const area = pipeArea(pipe);
  const velocity = qAbs / area;
  const f = frictionFactor(pipe, qAbs);
  return (f * pipe.L / pipe.D + pipe.kMinor) * velocity * velocity / (2 * GRAVITY);
}

function signedHeadLoss(pipe, q) {
  if (q === 0) return 0;
  return Math.sign(q) * headLossMagnitude(pipe, Math.abs(q));
}

function derivativeHeadLoss(pipe, q) {
  const qa = Math.abs(q);
  if (qa < 1e-8) return (32 * WATER_KINEMATIC_VISCOSITY * pipe.L) / (GRAVITY * pipe.D * pipe.D * pipeArea(pipe));
  const step = Math.max(qa * 1e-4, 1e-9);
  const low = Math.max(0, qa - step);
  const high = qa + step;
  const derivative = (headLossMagnitude(pipe, high) - headLossMagnitude(pipe, low)) / (high - low);
  return Number.isFinite(derivative) && derivative > 1e-12 ? derivative : 1e-8;
}

function buildComponents() {
  const adjacency = new Map(nodes.map(node => [node.id, []]));
  pipes.forEach(pipe => {
    if (!adjacency.has(pipe.a) || !adjacency.has(pipe.b)) throw new Error("يوجد أنبوب مرتبط بعقدة غير موجودة.");
    adjacency.get(pipe.a).push({ pipe, other: pipe.b });
    adjacency.get(pipe.b).push({ pipe, other: pipe.a });
  });
  for (const node of nodes) {
    if (!adjacency.get(node.id)?.length) throw new Error("العقدة «" + node.name + "» غير متصلة بأي أنبوب.");
  }
  const seen = new Set();
  const components = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const queue = [node.id];
    const ids = [];
    seen.add(node.id);
    while (queue.length) {
      const current = queue.shift();
      ids.push(current);
      for (const item of adjacency.get(current)) {
        if (!seen.has(item.other)) { seen.add(item.other); queue.push(item.other); }
      }
    }
    components.push({ ids, nodes: ids.map(nodeById) });
  }
  return { components, adjacency };
}

function solveLinearSystem(matrix, rhs) {
  const n = rhs.length;
  const A = matrix.map((row, i) => row.slice().concat(rhs[i]));
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let largest = Math.abs(A[col][col]);
    for (let row = col + 1; row < n; row++) {
      const value = Math.abs(A[row][col]);
      if (value > largest) { largest = value; pivotRow = row; }
    }
    if (!Number.isFinite(largest) || largest < 1e-13) throw new Error("تعذر حل معادلات الشبكة.");
    if (pivotRow !== col) [A[pivotRow], A[col]] = [A[col], A[pivotRow]];
    const pivot = A[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = A[row][col] / pivot;
      if (factor === 0) continue;
      A[row][col] = 0;
      for (let j = col + 1; j <= n; j++) A[row][j] -= factor * A[col][j];
    }
  }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let total = A[i][n];
    for (let j = i + 1; j < n; j++) total -= A[i][j] * x[j];
    x[i] = total / A[i][i];
    if (!Number.isFinite(x[i])) throw new Error("ظهرت قيمة غير محدودة أثناء الحل.");
  }
  return x;
}

/* ------------------------- هاردي كروس (Hardy Cross) ------------------------- */

function buildLoopsWithSigns(nodesArr, pipesArr, refNodeId) {
  const adjacency = new Map(nodesArr.map(n => [n.id, []]));
  pipesArr.forEach(pipe => {
    adjacency.get(pipe.a).push({ pipe, other: pipe.b });
    adjacency.get(pipe.b).push({ pipe, other: pipe.a });
  });

  const visited = new Set([refNodeId]);
  const parentNode = new Map([[refNodeId, null]]);
  const parentPipe = new Map();
  const treePipeIds = new Set();
  const queue = [refNodeId];

  while (queue.length) {
    const cur = queue.shift();
    for (const item of adjacency.get(cur)) {
      if (visited.has(item.other)) continue;
      visited.add(item.other);
      parentNode.set(item.other, cur);
      parentPipe.set(item.other, item.pipe);
      treePipeIds.add(item.pipe.id);
      queue.push(item.other);
    }
  }

  if (visited.size !== nodesArr.length) throw new Error("الشبكة غير متصلة بالكامل.");

  const findPipeBetween = (a, b) => pipesArr.find(p => (p.a === a && p.b === b) || (p.a === b && p.b === a));

  const treePathFinder = (from, to) => {
    const upFrom = [];
    let cur = from;
    while (cur !== null) { upFrom.push(cur); cur = parentNode.get(cur); }
    const upTo = [];
    cur = to;
    while (cur !== null) { upTo.push(cur); cur = parentNode.get(cur); }
    const setFrom = new Set(upFrom);
    let lca = null;
    for (const n of upTo) { if (setFrom.has(n)) { lca = n; break; } }
    if (lca === null) return null;
    const upPart = [];
    cur = from;
    while (cur !== lca) { upPart.push(cur); cur = parentNode.get(cur); }
    upPart.push(lca);
    const downPart = [];
    cur = to;
    while (cur !== lca) { downPart.push(cur); cur = parentNode.get(cur); }
    downPart.reverse();
    return upPart.concat(downPart);
  };

  const nodeMap = new Map(nodesArr.map(n => [n.id, n]));
  const chordPipes = pipesArr.filter(p => !treePipeIds.has(p.id));
  const loops = [];

  for (const chord of chordPipes) {
    const path = treePathFinder(chord.a, chord.b);
    if (!path) throw new Error("تعذر بناء حلقة.");
    const orderedNodes = [chord.a, chord.b];
    const orderedPipes = [chord];
    const orderedSigns = [+1];
    for (let k = path.length - 2; k >= 0; k--) {
      const from = path[k + 1], to = path[k];
      const pipe = findPipeBetween(from, to);
      orderedPipes.push(pipe);
      orderedSigns.push((pipe.a === from && pipe.b === to) ? +1 : -1);
      orderedNodes.push(to);
    }
    let area2 = 0;
    for (let i = 0; i < orderedNodes.length - 1; i++) {
      const p1 = nodeMap.get(orderedNodes[i]), p2 = nodeMap.get(orderedNodes[i + 1]);
      area2 += p1.x * p2.y - p2.x * p1.y;
    }
    loops.push({
      nodes: orderedNodes, pipes: orderedPipes, signs: orderedSigns,
      orientation: area2 > 0 ? "CW" : "CCW", chordPipeId: chord.id
    });
  }
  return { loops, treePipeIds, parentNode, parentPipe };
}

function initializeHardyCrossFlows(nodesArr, pipesArr, treePipeIds, parentNode, parentPipe, rootId) {
  const children = new Map(nodesArr.map(n => [n.id, []]));
  for (const [nodeId, parentId] of parentNode) {
    if (parentId !== null && children.has(parentId)) children.get(parentId).push(nodeId);
  }
  const netDemand = new Map();
  nodesArr.forEach(n => {
    let d = 0;
    if (n.type === "demand") d = Number(n.demand) / 1000;
    if (n.type === "source" && n.sourceMode === "flow") d = -Number(n.sourceFlow) / 1000;
    netDemand.set(n.id, d);
  });
  const subtreeNet = new Map();
  const postOrder = (id) => {
    let s = netDemand.get(id);
    for (const c of children.get(id)) s += postOrder(c);
    subtreeNet.set(id, s);
    return s;
  };
  postOrder(rootId);
  const Q = new Map();
  pipesArr.forEach(p => Q.set(p.id, 0));
  for (const [nodeId, parentId] of parentNode) {
    if (parentId === null) continue;
    const pipe = parentPipe.get(nodeId);
    if (!pipe) continue;
    const flow = subtreeNet.get(nodeId);
    Q.set(pipe.id, pipe.a === parentId ? flow : -flow);
  }
  for (const p of pipesArr) { if (!treePipeIds.has(p.id)) Q.set(p.id, 0); }
  return Q;
}

function solveHydraulicsHardyCross() {
  if (nodes.length < 2 || pipes.length < 1) throw new Error("أضف عقدتين على الأقل وأنبوباً واحداً.");
  
  const { components } = buildComponents();
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const Q = new Map(pipes.map(p => [p.id, 0]));
  const heads = new Map();
  const fixedHeadIds = new Set();
  const relativeHeadNodeIds = new Set();
  const allLoopInfo = [];
  const warnings = [];
  const iterationLog = [];
  let loopCounter = 0, totalIterations = 0, finalMaxDelta = 0;

  for (const comp of components) {
    const compNodes = comp.nodes;
    const compIds = new Set(compNodes.map(n => n.id));
    const compPipes = pipes.filter(p => compIds.has(p.a) && compIds.has(p.b));

    const headSources = compNodes.filter(n => n.type === "source" && n.sourceMode === "head");
    const flowSources = compNodes.filter(n => n.type === "source" && n.sourceMode === "flow");

    if (headSources.length === 0 && flowSources.length === 0) throw new Error("المكوّن لا يحتوي على مصدر.");
    if (headSources.length > 1) throw new Error("هاردي كروس يدعم مصدر حمل واحد فقط. استخدم نيوتن-رافسون.");

    let refNode, refHead;
    if (headSources.length === 1) {
      refNode = headSources[0]; refHead = Number(refNode.head);
      fixedHeadIds.add(refNode.id); heads.set(refNode.id, refHead);
    } else {
      const sourceIn = flowSources.reduce((s, n) => s + Number(n.sourceFlow) / 1000, 0);
      const demandOut = compNodes.filter(n => n.type === "demand").reduce((s, n) => s + Number(n.demand) / 1000, 0);
      if (Math.abs(sourceIn - demandOut) > 1e-5) throw new Error("المكوّن غير متزن.");
      refNode = flowSources[0]; refHead = 0;
      fixedHeadIds.add(refNode.id); heads.set(refNode.id, 0);
      compNodes.forEach(n => relativeHeadNodeIds.add(n.id));
    }

    const { loops, treePipeIds, parentNode, parentPipe } = buildLoopsWithSigns(compNodes, compPipes, refNode.id);
    const initQ = initializeHardyCrossFlows(compNodes, compPipes, treePipeIds, parentNode, parentPipe, refNode.id);
    compPipes.forEach(p => Q.set(p.id, initQ.get(p.id) ?? 0));

    let iter = 0, maxDelta = Infinity;
    const compLog = [];

    while (iter < HC_MAX_ITER && maxDelta > HC_TOL) {
      maxDelta = 0;
      const stepLog = { iteration: iter + 1, loops: [] };
      for (let li = 0; li < loops.length; li++) {
        const loop = loops[li];
        let sumHf = 0, sumDH = 0;
        for (let k = 0; k < loop.pipes.length; k++) {
          const pipe = loop.pipes[k];
          const qLoop = loop.signs[k] * Q.get(pipe.id);
          sumHf += signedHeadLoss(pipe, qLoop);
          sumDH += Math.abs(derivativeHeadLoss(pipe, qLoop));
        }
        if (sumDH < 1e-14) sumDH = 1e-14;
        let deltaQ = -sumHf / sumDH;
        if (Math.abs(deltaQ) > HC_DQ_CAP) deltaQ = Math.sign(deltaQ) * HC_DQ_CAP;
        for (let k = 0; k < loop.pipes.length; k++) {
          Q.set(loop.pipes[k].id, Q.get(loop.pipes[k].id) + deltaQ * loop.signs[k]);
        }
        maxDelta = Math.max(maxDelta, Math.abs(deltaQ));
        stepLog.loops.push({ loopLocalId: li + 1, deltaQ, sumHf, sumDH });
      }
      compLog.push(stepLog);
      iter++;
    }

    for (const loop of loops) {
      loopCounter++;
      allLoopInfo.push({
        globalId: loopCounter, component: compNodes[0].name,
        nodeNames: loop.nodes.map(id => nodeMap.get(id)?.name || "N" + id),
        nodeIds: loop.nodes, pipeIds: loop.pipes.map(p => p.id),
        pipeLabels: loop.pipes.map((p, k) => "P" + p.id + (loop.signs[k] > 0 ? "(+)" : "(−)")),
        signs: loop.signs, orientation: loop.orientation, chordPipeId: loop.chordPipeId
      });
    }

    iterationLog.push({ component: compNodes[0].name, iterations: iter, converged: maxDelta <= HC_TOL, finalMaxDelta: maxDelta, steps: compLog });
    totalIterations = Math.max(totalIterations, iter);
    finalMaxDelta = Math.max(finalMaxDelta, maxDelta);

    const subtreeHeads = new Map([[refNode.id, refHead]]);
    const queue = [refNode.id], headSeen = new Set([refNode.id]);
    while (queue.length) {
      const cur = queue.shift(), curHead = subtreeHeads.get(cur);
      for (const pipe of compPipes) {
        let other = null, fromHere = null;
        if (pipe.a === cur && !headSeen.has(pipe.b)) { other = pipe.b; fromHere = true; }
        else if (pipe.b === cur && !headSeen.has(pipe.a)) { other = pipe.a; fromHere = false; }
        else continue;
        headSeen.add(other);
        const q = Q.get(pipe.id), hf = fromHere ? signedHeadLoss(pipe, q) : -signedHeadLoss(pipe, q);
        subtreeHeads.set(other, curHead - hf);
        queue.push(other);
      }
    }
    compNodes.forEach(n => { if (!heads.has(n.id)) heads.set(n.id, subtreeHeads.get(n.id) ?? 0); });
  }

  const pipeData = new Map();
  pipes.forEach(pipe => {
    const q = Q.get(pipe.id) ?? 0, absQ = Math.abs(q);
    const velocity = absQ / pipeArea(pipe);
    const re = velocity * pipe.D / WATER_KINEMATIC_VISCOSITY;
    pipeData.set(pipe.id, { q, velocity, reynolds: re, frictionFactor: absQ <= 1e-12 ? NaN : frictionFactor(pipe, absQ), headloss: signedHeadLoss(pipe, q) });
  });

  const nodeHeads = new Map(nodes.map(n => [n.id, heads.get(n.id) ?? 0]));
  const netOut = new Map(nodes.map(n => [n.id, 0]));
  pipes.forEach(pipe => {
    const q = Q.get(pipe.id) ?? 0;
    netOut.set(pipe.a, netOut.get(pipe.a) + q);
    netOut.set(pipe.b, netOut.get(pipe.b) - q);
  });

  let maxContinuityLps = 0;
  nodes.forEach(node => {
    if (fixedHeadIds.has(node.id) && node.sourceMode === "head") return;
    const demand = node.type === "demand" ? Number(node.demand) / 1000 : 0;
    const inj = node.type === "source" && node.sourceMode === "flow" ? Number(node.sourceFlow) / 1000 : 0;
    maxContinuityLps = Math.max(maxContinuityLps, Math.abs((netOut.get(node.id) + demand - inj) * 1000));
  });

  const fixedSourceFlows = new Map();
  nodes.filter(n => fixedHeadIds.has(n.id) && n.sourceMode === "head").forEach(node => {
    fixedSourceFlows.set(node.id, netOut.get(node.id) * 1000);
  });

  const loopResiduals = allLoopInfo.map(loop => {
    let sum = 0;
    for (let k = 0; k < loop.pipeIds.length; k++) {
      const pid = loop.pipeIds[k];
      sum += signedHeadLoss(pipes.find(p => p.id === pid), loop.signs[k] * (Q.get(pid) ?? 0));
    }
    return { loopId: loop.globalId, chordPipeId: loop.chordPipeId, residual: sum };
  });

  const maxLoopResidual = loopResiduals.reduce((m, l) => Math.max(m, Math.abs(l.residual)), 0);

  // فحص الضغوط والسرعات
  nodes.forEach(node => {
    if (relativeHeadNodeIds.has(node.id)) return;
    if (node.type === "source" && node.sourceMode === "head") return;
    const pH = nodeHeads.get(node.id) - Number(node.elevation || 0);
    if (pH < -0.01) warnings.push("ضغط سالب عند «" + node.name + "». الماء لا يصل لهذه العقدة.");
    else if (pH < 15) warnings.push("الضغط منخفض عند «" + node.name + "» (" + fmt(pH, 1) + " م). قد لا يصل للطوابق العليا.");
    else if (pH > 60) warnings.push("الضغط مرتفع جداً عند «" + node.name + "» (" + fmt(pH, 1) + " م). خطر كسر المواسير.");
  });

  pipes.forEach(pipe => {
    const res = pipeData.get(pipe.id);
    if (!res) return;
    const v = res.velocity;
    if (v > 2.0) warnings.push("السرعة عالية في الأنبوب P" + pipe.id + " (" + fmt(v, 2) + " م/ث). قلل القطر أو راجع التصريف.");
    else if (v < 0.6 && v > 0.01) warnings.push("السرعة منخفضة في الأنبوب P" + pipe.id + " (" + fmt(v, 2) + " م/ث). قد تسبب ترسيباً. كبّر القطر أو راجع التصريف.");
  });

  return {
    method: "hardyCross", iterations: totalIterations, convergenceMaxDelta: finalMaxDelta,
    pipeData, nodeHeads, fixedSourceFlows, relativeHeadNodeIds,
    maxContinuityLps, maxHeadEquationResidual: 0, loopCount: allLoopInfo.length,
    maxLoopResidual, loopResiduals, loopDetails: allLoopInfo, iterationLog, warnings, componentCount: components.length
  };
}

/* ------------------------- نيوتن-رافسون (Global Gradient) ------------------------- */
function solveHydraulics() {
  if (nodes.length < 2 || pipes.length < 1) throw new Error("أضف عقدتين على الأقل وأنبوباً واحداً.");
  for (const pipe of pipes) {
    if (!(Number(pipe.L) > 0) || !(Number(pipe.D) > 0) || !(Number(pipe.eps) >= 0) || !(Number(pipe.kMinor) >= 0)) throw new Error("بيانات أنبوب غير صحيحة.");
  }

  const { components } = buildComponents();
  const fixedHeadIds = new Set();
  const anchorIds = new Set();
  const knownHeads = new Map();
  const relativeHeadNodeIds = new Set();
  const initialHeads = new Map();

  for (const component of components) {
    const fixedSources = component.nodes.filter(node => node.type === "source" && node.sourceMode === "head");
    if (fixedSources.length) {
      const avgHead = fixedSources.reduce((sum, node) => sum + Number(node.head), 0) / fixedSources.length;
      component.nodes.forEach(node => initialHeads.set(node.id, avgHead));
      fixedSources.forEach(node => { fixedHeadIds.add(node.id); knownHeads.set(node.id, Number(node.head)); initialHeads.set(node.id, Number(node.head)); });
    } else {
      const sourceNodes = component.nodes.filter(node => node.type === "source" && node.sourceMode === "flow");
      if (!sourceNodes.length) throw new Error("المكوّن لا يحتوي على مصدر.");
      const sourceIn = component.nodes.reduce((sum, node) => sum + (node.type === "source" && node.sourceMode === "flow" ? Number(node.sourceFlow) / 1000 : 0), 0);
      const demandOut = component.nodes.reduce((sum, node) => sum + (node.type === "demand" ? Number(node.demand) / 1000 : 0), 0);
      if (Math.abs(sourceIn - demandOut) > 1e-5) throw new Error("المكوّن غير متزن.");
      const anchor = sourceNodes[0];
      anchorIds.add(anchor.id); knownHeads.set(anchor.id, 0);
      component.nodes.forEach(node => { initialHeads.set(node.id, 0); relativeHeadNodeIds.add(node.id); });
    }
  }

  const headVariableNodes = nodes.filter(node => !knownHeads.has(node.id));
  const headColumn = new Map(headVariableNodes.map((node, index) => [node.id, pipes.length + index]));
  const continuityNodes = nodes.filter(node => !fixedHeadIds.has(node.id) && !anchorIds.has(node.id));
  const dimension = pipes.length + headVariableNodes.length;

  let heads = new Map(nodes.map(node => [node.id, initialHeads.has(node.id) ? initialHeads.get(node.id) : 0]));
  knownHeads.forEach((value, id) => heads.set(id, value));
  let flows = pipes.map(pipe => (Number(pipe.q0) > 0 ? Number(pipe.q0) : 0.5) / 1000);

  const totalDemand = nodes.reduce((sum, node) => sum + (node.type === "demand" ? Number(node.demand) / 1000 : 0), 0);
  const totalKnownInflow = nodes.reduce((sum, node) => sum + (node.type === "source" && node.sourceMode === "flow" ? Number(node.sourceFlow) / 1000 : 0), 0);
  const flowScale = Math.max(1e-3, totalDemand + totalKnownInflow, flows.reduce((sum, q) => sum + Math.abs(q), 0));
  const headScale = Math.max(1, ...components.map(c => { const v = c.nodes.filter(n => fixedHeadIds.has(n.id)).map(n => Number(n.head)); return v.length ? Math.max(...v) - Math.min(...v) : 1; }));

  function evaluate(qValues, hValues, withJacobian) {
    const energyResiduals = [];
    const massByNode = new Map(nodes.map(node => [node.id, 0]));
    const residual = Array(dimension).fill(0);
    const J = withJacobian ? Array.from({ length: dimension }, () => Array(dimension).fill(0)) : null;

    pipes.forEach((pipe, index) => {
      const q = qValues[index];
      const loss = signedHeadLoss(pipe, q);
      residual[index] = hValues.get(pipe.a) - hValues.get(pipe.b) - loss;
      energyResiduals.push(residual[index]);
      massByNode.set(pipe.a, massByNode.get(pipe.a) + q);
      massByNode.set(pipe.b, massByNode.get(pipe.b) - q);
      if (J) {
        J[index][index] = -derivativeHeadLoss(pipe, q);
        const colA = headColumn.get(pipe.a); const colB = headColumn.get(pipe.b);
        if (colA !== undefined) J[index][colA] = 1;
        if (colB !== undefined) J[index][colB] = -1;
      }
    });

    const massResiduals = [];
    continuityNodes.forEach((node, rowIndex) => {
      const demand = node.type === "demand" ? Number(node.demand) / 1000 : 0;
      const injection = node.type === "source" && node.sourceMode === "flow" ? Number(node.sourceFlow) / 1000 : 0;
      const mass = massByNode.get(node.id) + demand - injection;
      massResiduals.push(mass); residual[pipes.length + rowIndex] = mass;
      if (J) pipes.forEach((pipe, pipeIndex) => {
        if (pipe.a === node.id) J[pipes.length + rowIndex][pipeIndex] = 1;
        else if (pipe.b === node.id) J[pipes.length + rowIndex][pipeIndex] = -1;
      });
    });

    let normSquared = 0;
    energyResiduals.forEach(v => normSquared += Math.pow(v / headScale, 2));
    massResiduals.forEach(v => normSquared += Math.pow(v / flowScale, 2));
    return { residual, J, maxEnergy: energyResiduals.reduce((m, v) => Math.max(m, Math.abs(v)), 0), maxMass: massResiduals.reduce((m, v) => Math.max(m, Math.abs(v)), 0), norm: Math.sqrt(normSquared) };
  }

  const maxIterations = 100, headTolerance = 1e-5, massTolerance = Math.max(1e-8, flowScale * 1e-6);
  let converged = false, iterations = 0;

  for (iterations = 0; iterations < maxIterations; iterations++) {
    const current = evaluate(flows, heads, true);
    if (current.maxEnergy <= headTolerance && current.maxMass <= massTolerance) { converged = true; break; }
    const delta = solveLinearSystem(current.J, current.residual.map(v => -v));
    let accepted = false;
    for (let lambda = 1; lambda >= 1 / 4096; lambda /= 2) {
      const candFlows = flows.map((v, i) => v + lambda * delta[i]);
      const candHeads = new Map(heads);
      headVariableNodes.forEach((node, i) => candHeads.set(node.id, heads.get(node.id) + lambda * delta[pipes.length + i]));
      if (candFlows.some(v => !Number.isFinite(v)) || Array.from(candHeads.values()).some(v => !Number.isFinite(v))) continue;
      const cand = evaluate(candFlows, candHeads, false);
      if (cand.norm < current.norm || (cand.maxEnergy <= headTolerance && cand.maxMass <= massTolerance)) {
        flows = candFlows; heads = candHeads; accepted = true; break;
      }
    }
    if (!accepted) throw new Error("لم تتقارب المعادلات. راجع البيانات.");
  }

  const finalCheck = evaluate(flows, heads, false);
  const pipeData = new Map();
  pipes.forEach((pipe, index) => {
    const q = flows[index], absQ = Math.abs(q);
    const velocity = absQ / pipeArea(pipe);
    const re = velocity * pipe.D / WATER_KINEMATIC_VISCOSITY;
    pipeData.set(pipe.id, { q, velocity, reynolds: re, frictionFactor: absQ <= 1e-12 ? NaN : frictionFactor(pipe, absQ), headloss: signedHeadLoss(pipe, q) });
  });

  const nodeHeads = new Map(nodes.map(node => [node.id, heads.get(node.id)]));
  const netOut = new Map(nodes.map(node => [node.id, 0]));
  pipes.forEach((pipe, index) => {
    netOut.set(pipe.a, netOut.get(pipe.a) + flows[index]);
    netOut.set(pipe.b, netOut.get(pipe.b) - flows[index]);
  });

  let maxContinuityLps = 0;
  nodes.forEach(node => {
    if (fixedHeadIds.has(node.id)) return;
    const demand = node.type === "demand" ? Number(node.demand) / 1000 : 0;
    const inj = node.type === "source" && node.sourceMode === "flow" ? Number(node.sourceFlow) / 1000 : 0;
    maxContinuityLps = Math.max(maxContinuityLps, Math.abs((netOut.get(node.id) + demand - inj) * 1000));
  });

  const fixedSourceFlows = new Map();
  nodes.filter(node => fixedHeadIds.has(node.id)).forEach(node => fixedSourceFlows.set(node.id, netOut.get(node.id) * 1000));

  const loopDiagnostics = computeLoopBalances(nodes, pipes, pipeData);
  
  const warnings = [];
  // فحص الضغوط والسرعات
  nodes.forEach(node => {
    if (relativeHeadNodeIds.has(node.id)) return;
    if (node.type === "source" && node.sourceMode === "head") return;
    const pH = nodeHeads.get(node.id) - Number(node.elevation || 0);
    if (pH < -0.01) warnings.push("ضغط سالب عند «" + node.name + "». الماء لا يصل لهذه العقدة.");
    else if (pH < 15) warnings.push("الضغط منخفض عند «" + node.name + "» (" + fmt(pH, 1) + " م). قد لا يصل للطوابق العليا.");
    else if (pH > 60) warnings.push("الضغط مرتفع جداً عند «" + node.name + "» (" + fmt(pH, 1) + " م). خطر كسر المواسير.");
  });

  pipes.forEach(pipe => {
    const res = pipeData.get(pipe.id);
    if (!res) return;
    const v = res.velocity;
    if (v > 2.0) warnings.push("السرعة عالية في الأنبوب P" + pipe.id + " (" + fmt(v, 2) + " م/ث). قلل القطر أو راجع التصريف.");
    else if (v < 0.6 && v > 0.01) warnings.push("السرعة منخفضة في الأنبوب P" + pipe.id + " (" + fmt(v, 2) + " م/ث). قد تسبب ترسيباً. كبّر القطر أو راجع التصريف.");
  });

  return {
    method: "globalGradient", iterations: Math.min(iterations + 1, maxIterations),
    pipeData, nodeHeads, fixedSourceFlows, relativeHeadNodeIds,
    maxContinuityLps, maxHeadEquationResidual: finalCheck.maxEnergy,
    loopCount: loopDiagnostics.loopCount, maxLoopResidual: loopDiagnostics.maxResidual,
    loopResiduals: loopDiagnostics.residuals, warnings, componentCount: components.length
  };
}

function computeLoopBalances(allNodes, allPipes, pipeData) {
  const adjacency = new Map(allNodes.map(node => [node.id, []]));
  allPipes.forEach(pipe => {
    adjacency.get(pipe.a).push({ pipe, other: pipe.b });
    adjacency.get(pipe.b).push({ pipe, other: pipe.a });
  });
  const visited = new Set(), treeEdgeIds = new Set(), treeAdjacency = new Map(allNodes.map(node => [node.id, []]));
  for (const root of allNodes) {
    if (visited.has(root.id)) continue;
    visited.add(root.id); const queue = [root.id];
    while (queue.length) {
      const current = queue.shift();
      for (const item of adjacency.get(current)) {
        if (visited.has(item.other)) continue;
        visited.add(item.other); treeEdgeIds.add(item.pipe.id);
        treeAdjacency.get(current).push({ pipe: item.pipe, other: item.other });
        treeAdjacency.get(item.other).push({ pipe: item.pipe, other: current });
        queue.push(item.other);
      }
    }
  }
  const nonTreePipes = allPipes.filter(pipe => !treeEdgeIds.has(pipe.id)), residuals = [];
  for (const chord of nonTreePipes) {
    const queue = [chord.b], parent = new Map([[chord.b, null]]), parentEdge = new Map();
    while (queue.length && !parent.has(chord.a)) {
      const current = queue.shift();
      for (const item of treeAdjacency.get(current)) {
        if (parent.has(item.other)) continue;
        parent.set(item.other, current); parentEdge.set(item.other, item.pipe);
        queue.push(item.other);
      }
    }
    if (!parent.has(chord.a)) continue;
    let sum = pipeData.get(chord.id).headloss, current = chord.a;
    while (current !== chord.b) {
      const previous = parent.get(current), pipe = parentEdge.get(current);
      if (previous === null || !pipe) throw new Error("تعذر استكمال مسار إحدى الحلقات.");
      const h = pipeData.get(pipe.id).headloss;
      sum += (previous === pipe.a && current === pipe.b) ? h : -h;
      current = previous;
    }
    residuals.push({ chordPipeId: chord.id, residual: sum });
  }
  return { loopCount: residuals.length, residuals, maxResidual: residuals.reduce((max, item) => Math.max(max, Math.abs(item.residual)), 0) };
}

/* ------------------------- تقرير النتائج ------------------------- */

function renderAnalysisReport() {
  if (!analysisReport || !analysisBadge) return;
  if (!hydraulicResults) {
    analysisBadge.textContent = "لم يُحسب بعد"; analysisBadge.dataset.state = "idle";
    analysisReport.innerHTML = '<p class="muted">أكمل البيانات ثم اضغط «تحليل هيدروليكي».</p>'; return;
  }

  const r = hydraulicResults;
  const methodLabel = r.method === "hardyCross" ? '<span class="method-tag">هاردي كروس</span>' : '<span class="method-tag">نيوتن-رافسون</span>';
  analysisBadge.textContent = "اكتمل الحل"; analysisBadge.dataset.state = "success";

  const pipeRows = pipes.map(pipe => {
    const res = r.pipeData.get(pipe.id);
    if (!res) return "";
    const from = res.q >= 0 ? nodeById(pipe.a) : nodeById(pipe.b);
    const to = res.q >= 0 ? nodeById(pipe.b) : nodeById(pipe.a);
    
    const headA = r.nodeHeads.get(pipe.a) || 0;
    const headB = r.nodeHeads.get(pipe.b) || 0;
    const elevA = Number(nodeById(pipe.a)?.elevation || 0);
    const elevB = Number(nodeById(pipe.b)?.elevation || 0);
    
    const pA_bar = Math.max(0, (headA - elevA) / 10.197);
    const pB_bar = Math.max(0, (headB - elevB) / 10.197);
    const maxPressure = Math.max(pA_bar, pB_bar);
    
    const limit = pipe.pMaxBar || 10;
    const isSafe = maxPressure <= limit;
    const statusHTML = isSafe 
      ? `<span style="color:green; font-weight:bold;">آمن</span>` 
      : `<span style="color:red; font-weight:bold;">تجاوز الحد!</span>`;

    return `<tr>
      <td>P${pipe.id}</td><td>من ${escapeHTML(from?.name || "—")} إلى ${escapeHTML(to?.name || "—")}</td>
      <td dir="ltr">${res.q > 0 ? "+" : res.q < 0 ? "−" : ""}${fmt(Math.abs(res.q * 1000), 4)}</td>
      <td dir="ltr">${fmt(res.velocity, 4)}</td><td dir="ltr">${fmt(Math.abs(res.headloss), 5)}</td>
      <td dir="ltr">${fmt(maxPressure, 2)} بار</td>
      <td>${statusHTML}</td>
    </tr>`;
  }).join("");

  const nodeRows = nodes.map(node => {
    const head = r.nodeHeads.get(node.id), relative = r.relativeHeadNodeIds.has(node.id);
    const pressure = relative ? "غير مطلق" : fmt(head - Number(node.elevation || 0), 4);
    let sourceText = "—";
    if (node.type === "source" && node.sourceMode === "flow") sourceText = fmt(node.sourceFlow, 4) + " (معلوم)";
    else if (node.type === "source" && node.sourceMode === "head") {
      const supply = r.fixedSourceFlows.get(node.id) || 0;
      sourceText = fmt(supply, 4) + (supply >= 0 ? " (تغذية)" : " (استقبال)");
    }
    return `<tr><td>${escapeHTML(node.name)}</td><td>${nodeTitles[node.type]}</td><td dir="ltr">${fmt(head, 4)}</td><td dir="ltr">${pressure}</td><td dir="ltr">${sourceText}</td></tr>`;
  }).join("");

  const warningsHtml = r.warnings.length ? `<div class="analysis-warnings"><strong>تنبيهات:</strong><ul>${r.warnings.map(w => "<li>" + escapeHTML(w) + "</li>").join("")}</ul></div>` : `<p class="field-help">اجتاز الحل فحوص الاتزان العددية. هذا تحقق حسابي أولي.</p>`;
  
  const loopDetailsSection = (r.method === "hardyCross" && r.loopDetails?.length) ? `
    <section class="analysis-section"><h3>تفاصيل الحلقات الأساسية</h3><div class="table-wrap"><table class="results-table"><thead><tr><th>الحلقة</th><th>الاتجاه</th><th>الأنابيب (الإشارة)</th><th>Σhf المتبقي (م)</th></tr></thead><tbody>
      ${r.loopDetails.map(loop => {
        const res = r.loopResiduals.find(l => l.loopId === loop.globalId);
        const badge = loop.orientation === "CW" ? '<span class="loop-badge cw">مع عقارب الساعة ↻</span>' : '<span class="loop-badge ccw">عكس عقارب الساعة ↺</span>';
        return `<tr><td>L${loop.globalId}</td><td>${badge}</td><td dir="ltr" style="font-size:11px; white-space:normal;">${loop.pipeLabels.join(" ")}</td><td dir="ltr">${fmt(res?.residual ?? 0, 8)}</td></tr>`;
      }).join("")}
    </tbody></table></div></section>` : "";

  analysisReport.innerHTML = `
    <section class="analysis-section"><h3>ملخص الحل</h3><div class="field-help">
      <p><strong>الطريقة:</strong> ${methodLabel}</p><p><strong>التكرارات:</strong> ${r.iterations}</p>
      <p><strong>الحلقات:</strong> ${r.loopCount}</p><p><strong>خطأ الاستمرارية:</strong> ${fmt(r.maxContinuityLps, 8)} لتر/ث</p>
      ${r.method === "hardyCross" ? `<p><strong>ΔQ النهائي:</strong> ${fmt(r.convergenceMaxDelta * 1000, 6)} لتر/ث</p>` : ""}
    </div></section>
    <section class="analysis-section"><h3>جدول نتائج الأنابيب</h3><div class="table-wrap"><table class="results-table"><thead><tr><th>الأنبوب</th><th>الاتجاه</th><th>التصريف (لتر/ث)</th><th>السرعة (م/ث)</th><th>فقد الحمل (م)</th><th>الضغط (بار)</th><th>حالة الأنبوب</th></tr></thead><tbody>${pipeRows}</tbody></table></div></section>
    <section class="analysis-section"><h3>جدول نتائج العقد</h3><div class="table-wrap"><table class="results-table"><thead><tr><th>العقدة</th><th>النوع</th><th>الحمل H (م)</th><th>الضغط التقريبي (م)</th><th>تصريف المصدر</th></tr></thead><tbody>${nodeRows}</tbody></table></div></section>
    ${loopDetailsSection}
    <section class="analysis-section"><h3>فحوص واتزان الشبكة</h3>${warningsHtml}</section>
  `;
}

/* ------------------------- الأحداث والتفاعل ------------------------- */

buttons.source.addEventListener("click", () => addNode("source"));
buttons.junction.addEventListener("click", () => addNode("junction"));
buttons.demand.addEventListener("click", () => addNode("demand"));

buttons.connect.addEventListener("click", () => {
  if (mode === "connect") { mode = "select"; firstNodeId = null; setStatus("أُلغي وضع التوصيل."); }
  else { mode = "connect"; firstNodeId = null; setStatus("اضغط العقدة الأولى ثم الثانية."); }
  render();
});

buttons.calculate.addEventListener("click", () => {
  try {
    const method = solverMethodSelect?.value || "hardyCross";
    if (method === "hardyCross") {
      hydraulicResults = solveHydraulicsHardyCross();
    } else {
      hydraulicResults = solveHydraulics();
    }
    render();
    setStatus("اكتمل التحليل بنجاح.");
  } catch (error) {
    invalidateHydraulics(); render();
    setStatus("تعذر إكمال التحليل: " + (error?.message || "خطأ"));
  }
});

svg.addEventListener("click", event => {
  if (suppressClick) { suppressClick = false; return; }
  const nodeEl = event.target.closest?.(".node");
  if (nodeEl && svg.contains(nodeEl)) {
    const id = Number(nodeEl.dataset.nodeId);
    if (mode === "connect") handleConnectClick(id);
    else if (draggingNodeId === null && !dragMoved) { selectNode(id); setStatus("تم تحديد العقدة."); }
    return;
  }
  const pipeEl = event.target.closest?.(".pipe");
  if (pipeEl && svg.contains(pipeEl)) {
    if (mode === "connect") { setStatus("اختر عقدتين."); return; }
    selectPipe(Number(pipeEl.dataset.pipeId)); setStatus("تم تحديد الأنبوب.");
  }
});

svg.addEventListener("pointerdown", event => {
  if (mode !== "select") return;
  const nodeEl = event.target.closest?.(".node");
  if (!nodeEl || !svg.contains(nodeEl)) return;
  const id = Number(nodeEl.dataset.nodeId);
  const node = nodeById(id);
  if (!node) return;

  draggingNodeId = id;
  const point = screenToSvg(event);
  pointerStart = { x: point.x - node.x, y: point.y - node.y };
  dragMoved = false; selected = { type: "node", id };
  render();
  try { svg.setPointerCapture(event.pointerId); } catch (_) {}
  event.preventDefault();
});

svg.addEventListener("pointermove", event => {
  if (draggingNodeId === null || !pointerStart) return;
  const node = nodeById(draggingNodeId);
  if (!node) return;
  const point = screenToSvg(event);
  const newX = point.x - pointerStart.x;
  const newY = point.y - pointerStart.y;
  if (!dragMoved && Math.hypot(newX - node.x, newY - node.y) < 2) return;
  dragMoved = true; node.x = newX; node.y = newY; render();
  event.preventDefault();
});

function finishDrag() {
  if (draggingNodeId === null) return;
  if (dragMoved) {
    const node = nodeById(draggingNodeId);
    if (node) {
      node.x = Math.max(20, Math.min(780, node.x));
      node.y = Math.max(20, Math.min(480, node.y));
    }
    saveNetwork(); suppressClick = true; setStatus("تم تحريك العقدة بنجاح.");
  }
  draggingNodeId = null; pointerStart = null; dragMoved = false; render();
}
svg.addEventListener("pointerup", finishDrag);
svg.addEventListener("pointercancel", finishDrag);

buttons.delete.addEventListener("click", () => {
  if (!selected) { setStatus("حدد عنصراً أولاً."); return; }
  if (selected.type === "node") {
    const id = Number(selected.id);
    nodes = nodes.filter(n => n.id !== id);
    pipes = pipes.filter(p => p.a !== id && p.b !== id);
  } else { pipes = pipes.filter(p => p.id !== Number(selected.id)); }
  selected = null; firstNodeId = null; mode = "select"; invalidateHydraulics(); saveNetwork(); render();
  setStatus("تم الحذف.");
});

buttons.clear.addEventListener("click", () => {
  nodes = []; pipes = []; nextNodeId = 1; nextPipeId = 1; mode = "select"; firstNodeId = null; selected = null;
  draggingNodeId = null; pointerStart = null; dragMoved = false; suppressClick = false;
  invalidateHydraulics(); saveNetwork(); render(); setStatus("مساحة فارغة.");
});

// بدء التشغيل
const hasSaved = loadNetwork();
render();