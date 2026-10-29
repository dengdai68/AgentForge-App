/* 开发手册只读图：X6 负责端口、视口与小地图；ELK 为动态工作流计算布局与折线路径。领域语义仍由 docs/ 与服务端模块定义。 */
const instances = new Map();
const palette = {
  default: { fill: "#ffffff", stroke: "#dde3d8" }, agent: { fill: "#f1f7e7", stroke: "#d2e3b2" },
  task: { fill: "#edf5fa", stroke: "#c9e0eb" }, flow: { fill: "#f2f0fc", stroke: "#ddd7f2" },
  warm: { fill: "#fff5e8", stroke: "#f0d9b2" }, danger: { fill: "#fdefea", stroke: "#efd0c3" }, storage: { fill: "#eff6f0", stroke: "#cde3d0" }, dark: { fill: "#202720", stroke: "#202720" },
};
const portGroups = ["top", "right", "bottom", "left"].reduce((groups, side) => ({ ...groups, [side]: { position: side, attrs: { circle: { r: 3.5, magnet: true, stroke: "#93a384", strokeWidth: 1.5, fill: "#fbfcf8" } } } }), {});
const ports = { groups: portGroups, items: ["top", "right", "bottom", "left"].map((id) => ({ id, group: id })) };

function card(id, x, y, width, height, title, lines, tone = "default") {
  const colors = palette[tone] || palette.default;
  return { id, shape: "rect", x, y, width, height, ports, attrs: { body: { rx: 16, ry: 16, fill: colors.fill, stroke: colors.stroke, strokeWidth: 1.2 }, label: { text: [title, ...lines].join("\n"), fill: tone === "dark" ? "#e3efe0" : "#344031", fontSize: 12, fontWeight: 500, textAnchor: "middle", textVerticalAnchor: "middle", lineHeight: 20 } } };
}
function boundary(id, x, y, width, height, title, subtitle, tone = "#f7f8f1") {
  return { id, shape: "rect", x, y, width, height, zIndex: 0, attrs: { body: { rx: 22, ry: 22, fill: tone, fillOpacity: .72, stroke: "#e1e7dc", strokeWidth: 1.2 }, label: { text: `${title}\n${subtitle}`, fill: "#798573", fontSize: 11, fontWeight: 600, textAnchor: "start", textVerticalAnchor: "top", refX: 18, refY: 15, lineHeight: 17 } } };
}
function edge(source, sourcePort, target, targetPort, label, options = {}) {
  const router = options.router === "normal"
    ? { name: "normal" }
    : { name: "manhattan", args: { padding: 20, step: 12, startDirections: [sourcePort], endDirections: [targetPort] } };
  return { source: { cell: source, port: sourcePort }, target: { cell: target, port: targetPort }, router, vertices: options.vertices || [], connector: { name: "rounded", args: { radius: 8 } }, attrs: { line: { stroke: options.dashed ? "#9ba99a" : "#849579", strokeWidth: 1.6, strokeDasharray: options.dashed ? "6 5" : "", targetMarker: { name: "block", width: 8, height: 6 } } }, labels: label ? [{ position: options.position ?? .5, attrs: { label: { text: label, fill: "#64735f", fontSize: 10 }, body: { fill: "#fbfcf8", stroke: "#dce4d6", strokeWidth: 1, rx: 4, ry: 4, ref: "label", refWidth: "140%", refHeight: "150%", refX: "-20%", refY: "-25%" } } }] : [] };
}

/* 工作流图不复用手写坐标。它按依赖深度分列、同列按定义顺序分行，
 * 让每一条 dependency 都从真实右侧端口进入下游左侧端口。这样模板和
 * Task 快照节点增减时仍有稳定间距，且不会产生 SVG 悬空线。 */
function workflowDefinition(workflow, { focus = {}, assignments = {}, agentsById = {}, compact = false } = {}) {
  const nodes = workflow?.nodes || [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depthFor = (node, visiting = new Set()) => {
    if (!node || visiting.has(node.id)) return 0;
    const dependencies = (node.dependsOn || []).map((id) => byId.get(id)).filter(Boolean);
    return dependencies.length ? Math.max(...dependencies.map((dependency) => depthFor(dependency, new Set([...visiting, node.id])))) + 1 : 0;
  };
  const columns = new Map();
  nodes.forEach((node) => {
    const depth = depthFor(node);
    columns.set(depth, [...(columns.get(depth) || []), node]);
  });
  // Six standard delivery nodes must remain readable in the compact views.
  // Keep the logical canvas just wider than its card chain; a fixed 300px
  // minimum here previously forced the browser to scale the whole diagram down.
  const nodeWidth = compact ? 168 : 242;
  const nodeHeight = compact ? 64 : 108;
  const xGap = compact ? 50 : 132;
  const yGap = compact ? 28 : 56;
  const top = compact ? 22 : 74;
  const maxRows = Math.max(1, ...[...columns.values()].map((items) => items.length));
  const width = Math.max(720, 60 + columns.size * (nodeWidth + xGap));
  const height = Math.max(compact ? 120 : 300, top * 2 + maxRows * nodeHeight + Math.max(0, maxRows - 1) * yGap);
  const positions = new Map();
  [...columns.entries()].forEach(([depth, items]) => {
    const columnHeight = items.length * nodeHeight + Math.max(0, items.length - 1) * yGap;
    const offset = Math.max(top, Math.round((height - columnHeight) / 2));
    items.forEach((node, index) => positions.set(node.id, { x: compact ? 30 + depth * (nodeWidth + xGap) : 72 + depth * (nodeWidth + xGap), y: offset + index * (nodeHeight + yGap) }));
  });
  const toneFor = (node) => {
    const state = focus[node.id];
    if (state === "recent") return "storage";
    if (state === "current") return "task";
    if (state === "active") return "agent";
    if (["waiting_human", "waiting_agent"].includes(state)) return "warm";
    if (state === "attention") return "danger";
    return "flow";
  };
  return {
    nodes: nodes.map((node) => {
      const position = positions.get(node.id);
      const state = focus[node.id];
      const assigned = agentsById[assignments[node.id]];
      const owner = assigned?.name || node.ownerRole || "未分配角色";
      const labels = { active: "正在处理", current: "项目经理当前重心", waiting_human: "等待澄清", waiting_agent: "等待协作", attention: "需要关注", recent: "最近交付" };
      return card(node.id, position.x, position.y, nodeWidth, nodeHeight, node.title || node.id, [node.id, state ? `${owner} · ${labels[state]}` : owner], toneFor(node));
    }),
    edges: nodes.flatMap((node) => (node.dependsOn || []).filter((dependency) => byId.has(dependency)).map((dependency) =>
      edge(dependency, "right", node.id, "left", "交接参考", { position: .5 }))),
  };
}

const graphs = {
  "data-model": {
    nodes: [
      card("agent", 70, 110, 220, 112, "Agent", ["kind · role · systemPrompt", "description · runtime · repository"], "agent"),
      card("team", 405, 110, 220, 112, "Team", ["members · managerAgentId", "业务成员 / 经理 / 人类"], "default"),
      card("workflow", 740, 110, 245, 112, "WorkflowTemplate", ["nodes[] · dependsOn", "职责与文档交付定义"], "flow"),
      card("task", 1085, 110, 300, 112, "Task", ["workflowSnapshot", "nodeAssignments{} · workspacePath"], "task"),
      card("run", 1085, 390, 300, 150, "Run", ["taskId · participants 快照", "manager · currentFocus", "memberSessions · 成员会话绑定", "deliveryReview · overall status"], "task"),
      card("trace", 70, 760, 220, 130, "Trace", ["runId · nodeId · agentId", "type · status · tracePath", "providerSessionId · sessionMode"], "default"),
      card("message", 365, 760, 220, 112, "Message", ["replyToMessageId · questionType", "sender · recipient · kind"], "warm"),
      card("dispatch", 365, 1040, 300, 112, "Dispatch · 内部投递", ["messageIds · parentDispatchId", "status · nextRetryAt · traceIds"], "default"),
      card("decision", 660, 760, 210, 112, "Decision", ["runId · traceId", "impact · affected nodes"], "flow"),
      card("defect", 950, 760, 210, 112, "Defect", ["runId · traceId", "open → fixed → closed"], "danger"),
      card("artifact", 1240, 760, 230, 112, "Artifact", ["runId · traceId", "hash · version · storagePath"], "storage"),
      card("files", 1195, 1040, 320, 86, "Run Files", ["traces/<traceId>/events.ndjson", "output/ · workspace/"], "storage"),
    ],
    edges: [
      edge("team", "left", "agent", "right", "成员"), edge("workflow", "right", "task", "left", "冻结快照"),
      edge("task", "bottom", "run", "top", "创建 Run"), edge("run", "bottom", "trace", "top", "1:N Trace", { position: .22 }),
      edge("run", "bottom", "message", "top", "conversationId", { position: .32 }), edge("run", "bottom", "decision", "top", "traceId", { position: .45 }),
      edge("run", "bottom", "defect", "top", "traceId", { position: .6 }), edge("run", "bottom", "artifact", "top", "验收文件", { position: .75 }),
      edge("trace", "bottom", "artifact", "left", "输出关联", { position: .58 }), edge("artifact", "bottom", "files", "top", "storagePath"),
      edge("message", "bottom", "dispatch", "top", "触发 / 答复唤醒"),
    ],
  },
  "system-architecture": {
    nodes: [
      boundary("browser-boundary", 24, 32, 178, 356, "① Browser boundary", "读模型 · HTTP 命令 · SSE", "#f4f7ed"),
      boundary("control-boundary", 222, 32, 460, 356, "② AgentForge Node.js boundary", "传输 · 状态 · 编排 · 本机 Runtime", "#f7f6ed"),
      boundary("persistence-boundary", 702, 32, 228, 356, "③ Local persistence boundary", "metadata 与 Run 文件分离", "#f2f7f2"),
      card("web", 43, 184, 140, 78, "web/ Console", ["路由 · 渲染 · 命令", "不写领域状态"], "agent"),
      card("http", 246, 104, 170, 78, "server/index.mjs", ["auth.guard → HTTP / SSE", "登录鉴权 · 协议边界"], "task"),
      card("store", 246, 266, 170, 82, "server/store.mjs", ["状态机 · ID · Event", "唯一状态写入"], "flow"),
      card("orchestrator", 466, 184, 192, 82, "server/orchestrator.mjs", ["候选节点 · 推进 · 验收", "仅通过 Store 写入"], "agent"),
      card("runtime", 466, 286, 192, 62, "server/runtime/", ["Claude / Codex · JSONL 规范化"], "default"),
      card("sqlite", 725, 118, 180, 78, "SQLite", ["metadata 与状态", "不保存 Trace 内容"], "storage"),
      card("files", 725, 270, 180, 78, "Run Files", ["Trace · 结果 · 文件快照", "受限预览"], "storage"),
    ],
    edges: [
      edge("web", "right", "http", "left", "HTTP 命令", { router: "normal" }),
      edge("http", "left", "web", "top", "SSE", { dashed: true, position: .22, router: "normal", vertices: [{ x: 216, y: 143 }, { x: 216, y: 82 }, { x: 113, y: 82 }] }),
      edge("http", "bottom", "store", "top", "校验 / 查询", { router: "normal" }),
      edge("http", "right", "orchestrator", "top", "启动 / 恢复", { position: .4, router: "normal", vertices: [{ x: 440, y: 143 }, { x: 440, y: 160 }, { x: 562, y: 160 }] }),
      edge("orchestrator", "left", "store", "right", "Store command", { router: "normal", vertices: [{ x: 440, y: 225 }, { x: 440, y: 307 }] }),
      edge("orchestrator", "bottom", "runtime", "top", "启动 / 续接成员 CLI", { router: "normal" }),
      edge("store", "bottom", "sqlite", "left", "metadata", { position: .32, router: "normal", vertices: [{ x: 331, y: 370 }, { x: 694, y: 370 }, { x: 694, y: 157 }] }),
      edge("orchestrator", "right", "files", "left", "Trace / Artifact", { router: "normal", vertices: [{ x: 684, y: 225 }, { x: 684, y: 309 }] }),
    ],
  },
  "task-flow": {
    nodes: [
      boundary("control-lane", 24, 32, 1042, 132, "① 创建、调度与交付主路径", "项目经理从全部职责中选择当前最需要的协作；Trace 是唯一执行记录", "#f4f7ed"),
      boundary("exception-lane", 24, 194, 1042, 258, "② 回路与质量收束", "澄清答复与临时错误恢复原投递；后续协作由项目经理选择职责", "#f2f7f2"),
      card("task", 48, 78, 145, 58, "创建 Task", ["冻结流程与分配"], "task"),
      card("eligible", 250, 78, 162, 58, "职责定义", ["交接提示 · 不存节点状态"], "flow"),
      card("manager", 470, 78, 162, 58, "项目经理 Trace", ["选择 nextNodeId"], "agent"),
      card("agent", 690, 78, 162, 58, "业务 Agent", ["真实 Provider Trace"], "agent"),
      card("accept", 910, 68, 132, 78, "验收", ["node_result", "文件 → Artifact"], "task"),
      card("consult", 60, 276, 172, 68, "角色咨询", ["Message · 团队内答复"], "warm"),
      card("human", 280, 276, 172, 68, "等待人类", ["仅团队不能回答时"], "warm"),
      card("retry", 500, 276, 172, 68, "自动重试", ["失败 Trace 保留", "五分钟无活跃角色巡检"], "danger"),
      card("requeue", 500, 374, 172, 54, "恢复原 Dispatch", ["原成员续接 · 新 Trace"], "flow"),
      card("quality", 740, 262, 172, 68, "质量闭环", ["Defect：open → fixed → closed"], "default"),
      card("reflection", 740, 374, 172, 54, "经理提交人类验收", ["按成员交接决定下一步"], "flow"),
      card("done", 942, 374, 116, 54, "待人类验收", ["确认后完成"], "storage"),
    ],
    edges: [
      edge("task", "right", "eligible", "left", "创建", { router: "normal" }),
      edge("eligible", "right", "manager", "left", "职责与证据", { router: "normal" }),
      edge("manager", "right", "agent", "left", "nextNodeId", { router: "normal" }),
      edge("agent", "right", "accept", "left", "Trace + node_result", { router: "normal" }),
      edge("agent", "bottom", "consult", "top", "业务问题", { position: .24, router: "normal", vertices: [{ x: 771, y: 190 }, { x: 146, y: 190 }] }),
      edge("agent", "bottom", "human", "top", "needsHuman", { position: .52, router: "normal", vertices: [{ x: 771, y: 218 }, { x: 366, y: 218 }] }),
      edge("agent", "bottom", "retry", "top", "临时错误", { position: .72, router: "normal", vertices: [{ x: 771, y: 246 }, { x: 586, y: 246 }] }),
      edge("consult", "right", "requeue", "left", "答复后", { router: "normal", vertices: [{ x: 260, y: 310 }, { x: 260, y: 401 }] }),
      edge("human", "right", "requeue", "left", "回答后", { router: "normal", vertices: [{ x: 476, y: 310 }, { x: 476, y: 401 }] }),
      edge("retry", "bottom", "requeue", "top", "巡检后", { router: "normal" }),
      edge("requeue", "right", "agent", "bottom", "续接原成员", { dashed: true, position: .45, router: "normal", vertices: [{ x: 704, y: 401 }, { x: 704, y: 176 }, { x: 771, y: 176 }] }),
      edge("accept", "bottom", "quality", "top", "验收 / Defect", { router: "normal", vertices: [{ x: 976, y: 214 }, { x: 826, y: 214 }] }),
      edge("quality", "bottom", "reflection", "top", "Defect 全部 closed", { router: "normal" }),
      edge("reflection", "right", "done", "left", "pass", { router: "normal" }),
      edge("reflection", "bottom", "eligible", "bottom", "rework · 重选职责", { dashed: true, position: .5, router: "normal", vertices: [{ x: 826, y: 444 }, { x: 440, y: 444 }, { x: 440, y: 164 }, { x: 331, y: 164 }] }),
    ],
  },
};

function requireX6() {
  if (!globalThis.X6?.Graph) throw new Error("关系图引擎未加载；请刷新页面后重试。");
  return globalThis.X6;
}
function requireElk() {
  if (typeof globalThis.ELK !== "function") throw new Error("关系图布局引擎未加载；请刷新页面后重试。");
  return new globalThis.ELK();
}
function updateScale(key, onViewport) { const item = instances.get(key); if (item) onViewport?.(item.graph.zoom()); }

function disposeGraph(key) {
  const item = instances.get(key);
  if (!item) return;
  item.disposeInteractions?.();
  item.observer?.disconnect();
  item.graph.dispose();
  instances.delete(key);
}
function disposeMatching(prefix) {
  [...instances.keys()].filter((key) => key.startsWith(prefix)).forEach(disposeGraph);
}
export function disposeManualGraphs() {
  disposeMatching("manual:");
}
export function disposeWorkflowGraphs(scope) {
  disposeMatching(`workflow:${scope}:`);
}
function attachViewportInteractions(graph, viewport, onViewport) {
  if (!viewport) return () => {};
  const zoomFromWheel = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const amount = Math.max(-.18, Math.min(.18, -event.deltaY * .0015));
    if (amount) graph.zoom(amount, { minScale: .55, maxScale: 1.85 });
    onViewport?.(graph.zoom());
  };
  const keyControls = (event) => {
    if (!["+", "=", "-", "_", "0"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "0") graph.zoomToFit({ padding: 42, maxScale: 1 });
    else graph.zoom(["+", "="].includes(event.key) ? .16 : -.16, { minScale: .55, maxScale: 1.85 });
    onViewport?.(graph.zoom());
  };
  // Capture first so page scrolling and browser pinch/trackpad gestures cannot swallow graph zoom.
  viewport.addEventListener("wheel", zoomFromWheel, { passive: false, capture: true });
  viewport.addEventListener("keydown", keyControls);
  return () => {
    viewport.removeEventListener("wheel", zoomFromWheel, { capture: true });
    viewport.removeEventListener("keydown", keyControls);
  };
}
function fitGraph(graph, key, onViewport) {
  graph.zoomToFit({ padding: 28, maxScale: 1.08 });
  updateScale(key, onViewport);
}

async function applyElkWorkflowLayout(key, graph, definition) {
  const elk = requireElk();
  const layout = await elk.layout({
    id: key,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "76",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: definition.nodes.map((node) => ({ id: node.id, width: node.width, height: node.height })),
    edges: definition.edges.map((item, index) => ({ id: `elk-edge-${index}`, sources: [item.source.cell], targets: [item.target.cell] })),
  });
  // A navigation change can dispose this graph while ELK's worker is resolving.
  if (instances.get(key)?.graph !== graph) return;
  const offset = 30;
  layout.children?.forEach((item) => graph.getCellById(item.id)?.position(item.x + offset, item.y + offset));
  (layout.edges || []).forEach((item, index) => {
    const cell = graph.getEdges()[index];
    const bendPoints = item.sections?.[0]?.bendPoints || [];
    if (!cell) return;
    cell.setRouter({ name: "normal" });
    cell.setVertices(bendPoints.map((point) => ({ x: point.x + offset, y: point.y + offset })));
  });
}

function mountGraph(key, definition, container, minimap, onViewport, { elkLayout = false, fixed = false } = {}) {
  disposeGraph(key);
  if (!definition || !container) return null;
  try {
    const { Graph, MiniMap } = requireX6();
    const graph = new Graph({ container, width: container.clientWidth, height: container.clientHeight, panning: { enabled: !fixed, eventTypes: ["leftMouseDown"] }, mousewheel: { enabled: false }, interacting: { nodeMovable: false, edgeMovable: false, edgeLabelMovable: false, arrowheadMovable: false, vertexMovable: false }, background: { color: "#fbfcf8" }, grid: { visible: !fixed, type: "dot", args: { color: "#e6ebdf", thickness: 1 } } });
    // 手册图的面积较大，保留小地图；线性工作流已有完整主路径与缩放控制，
    // 不额外占用一行高度来重复展示同一条链。
    if (minimap) graph.use(new MiniMap({ container: minimap, width: 156, height: 102, padding: 8, scalable: true, graphOptions: { background: { color: "#f7f8f2" } } }));
    definition.nodes.forEach((node) => graph.addNode(node)); definition.edges.forEach((item) => graph.addEdge(item));
    const viewport = container.closest(".diagram-viewport") || container;
    const observer = new ResizeObserver(() => { graph.resize(viewport.clientWidth, viewport.clientHeight); if (fixed && viewport.clientWidth && viewport.clientHeight) fitGraph(graph, key, onViewport); });
    observer.observe(viewport);
    const disposeInteractions = fixed ? () => {} : attachViewportInteractions(graph, container.closest(".diagram-viewport"), onViewport);
    instances.set(key, { graph, observer, disposeInteractions });
    graph.on("scale translate", () => updateScale(key, onViewport));
    requestAnimationFrame(() => {
      if (!elkLayout) {
        fitGraph(graph, key, onViewport);
        return;
      }
      applyElkWorkflowLayout(key, graph, definition)
        .catch(() => undefined) // The pre-ELK definition remains a readable local fallback.
        .finally(() => { if (instances.get(key)?.graph === graph) fitGraph(graph, key, onViewport); });
    });
    return graph;
  } catch (error) { container.innerHTML = `<div class="diagram-engine-error">${error.message}</div>`; return null; }
}
export function mountManualGraph(key, container, minimap, onViewport) {
  return mountGraph(`manual:${key}`, graphs[key], container, minimap, onViewport);
}
export function mountWorkflowGraph(scope, key, container, minimap, workflow, options, onViewport) {
  return mountGraph(`workflow:${scope}:${key}`, workflowDefinition(workflow, options), container, minimap, onViewport, { elkLayout: true, fixed: true });
}
function graphFor(key) { return instances.get(key)?.graph; }
export function zoomManualGraph(key, amount, onViewport) { const graph = graphFor(`manual:${key}`); if (!graph) return; graph.zoom(amount, { minScale: .55, maxScale: 1.85 }); updateScale(`manual:${key}`, onViewport); }
export function fitManualGraph(key, onViewport) { const graph = graphFor(`manual:${key}`); if (!graph) return; graph.zoomToFit({ padding: 42, maxScale: 1 }); updateScale(`manual:${key}`, onViewport); }
export function zoomWorkflowGraph(scope, key, amount, onViewport) { const fullKey = `workflow:${scope}:${key}`; const graph = graphFor(fullKey); if (!graph) return; graph.zoom(amount, { minScale: .55, maxScale: 1.85 }); updateScale(fullKey, onViewport); }
export function fitWorkflowGraph(scope, key, onViewport) { const fullKey = `workflow:${scope}:${key}`; const graph = graphFor(fullKey); if (!graph) return; graph.zoomToFit({ padding: 42, maxScale: 1 }); updateScale(fullKey, onViewport); }
