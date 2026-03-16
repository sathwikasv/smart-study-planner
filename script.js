// script.js (UI glue)
// Connects HTML -> JS logic and keeps UI reactive + persisted.
//
// NOTE: This app is intentionally written to work as a "double-click open" page (file://),
// so we load dependencies as classic scripts and read them from globals:
// - `window.SSP_SCHEDULER`
// - `window.SSP_ALGOS`

const {
  PRIORITY_MAP,
  normalizePriority,
  priorityLabel,
  parseDependsOn,
  comparePriorityScheduling,
  generateDailySchedule,
  formatMinToHHMM,
  toTimestamp,
} = window.SSP_SCHEDULER || {};

const { getSortSteps, prepareAlgoItems, COMPLEXITY } = window.SSP_ALGOS || {};

const STORAGE_KEY = "ssp_tasks_v1";
const SETTINGS_KEY = "ssp_settings_v1";

/** @type {Array<any>} */
let tasks = [];

let settings = {
  theme: "dark",
};

const vizState = {
  running: false,
  paused: false,
  steps: [],
  stepIdx: 0,
  baseOrder: [],
  locked: new Set(),
  timer: null,
  speedMs: 520,
  algorithm: "bubble",
  criteria: "priority",
};

function $(id) {
  return document.getElementById(id);
}

function uid() {
  const maxId = tasks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
  return maxId + 1;
}

function now() {
  return Date.now();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function isToday(ts) {
  const d = new Date(ts);
  const t = new Date();
  return (
    d.getFullYear() === t.getFullYear() &&
    d.getMonth() === t.getMonth() &&
    d.getDate() === t.getDate()
  );
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    tasks = raw ? JSON.parse(raw) : [];
  } catch {
    tasks = [];
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    settings = raw ? { ...settings, ...JSON.parse(raw) } : settings;
  } catch {
    settings = settings;
  }

  // Backfill / normalize fields for older data.
  for (const t of tasks) {
    t.priority = normalizePriority(t.priority);
    t.duration = Number(t.duration) || 1;
    t.status = t.status || "todo";
    t.dependsOn = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    t.createdAt = Number(t.createdAt) || now();
    t.order = Number.isFinite(Number(t.order)) ? Number(t.order) : t.id;
    if (t.status === "completed" && !t.completedAt) t.completedAt = now();
  }
}

function save() {
  // localStorage can be unavailable in some sandboxed contexts; fail gracefully.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    const root = $("notifications");
    if (root) {
      root.innerHTML =
        '<div class="notice"><strong>Storage disabled</strong>: Your browser blocked local storage for this page. Try opening via a local server (e.g., VS Code Live Server) or allow storage for file pages.</div>';
    }
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme === "light" ? "light" : "dark";
}

function priorityClass(p) {
  if (p === 1) return "pill--high";
  if (p === 2) return "pill--medium";
  return "pill--low";
}

function statusLabel(status) {
  if (status === "in_progress") return "In Progress";
  if (status === "completed") return "Completed";
  return "To Do";
}

function formatDeadline(deadlineIso) {
  const ts = toTimestamp(deadlineIso);
  if (!Number.isFinite(ts) || ts === Number.MAX_SAFE_INTEGER) return "—";
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function computeDerived(t) {
  return {
    ...t,
    deadlineTs: toTimestamp(t.deadline),
  };
}

function getFilteredTasks() {
  const q = String($("searchInput").value || "").trim().toLowerCase();
  const filterPriority = $("filterPriority").value;
  const filterSubject = String($("filterSubject").value || "").trim().toLowerCase();
  const filterStatus = $("filterStatus").value;
  const filterDeadline = $("filterDeadline").value; // yyyy-mm-dd

  const list = tasks
    .map(computeDerived)
    .sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id));

  return list.filter((t) => {
    if (filterPriority && String(t.priority) !== String(filterPriority)) return false;
    if (filterStatus && t.status !== filterStatus) return false;
    if (filterSubject && !String(t.subject || "").toLowerCase().includes(filterSubject)) return false;
    if (filterDeadline) {
      const d = new Date(t.deadlineTs);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const asDate = `${y}-${m}-${day}`;
      if (asDate !== filterDeadline) return false;
    }
    if (q) {
      const hay = `${t.name || ""} ${t.subject || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderStats() {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const pending = total - completed;
  const high = tasks.filter((t) => normalizePriority(t.priority) === 1 && t.status !== "completed").length;

  $("statTotal").textContent = String(total);
  $("statCompleted").textContent = String(completed);
  $("statPending").textContent = String(pending);
  $("statHigh").textContent = String(high);

  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  $("progressCompletion").style.width = `${pct}%`;
  $("statCompletionHint").textContent = `${pct}% completed`;

  // Performance analytics (simple but useful)
  const completedTasks = tasks.filter((t) => t.status === "completed" && t.completedAt && t.createdAt);
  if (completedTasks.length) {
    const avgMs =
      completedTasks.reduce((s, t) => s + (Number(t.completedAt) - Number(t.createdAt)), 0) /
      completedTasks.length;
    const hours = avgMs / (1000 * 60 * 60);
    $("statAvgCompletion").textContent = `Avg completion time: ${hours.toFixed(1)}h`;
  } else {
    $("statAvgCompletion").textContent = "Avg completion time: —";
  }

  const highDone = tasks.filter((t) => normalizePriority(t.priority) === 1 && t.status === "completed").length;
  const productivity =
    total === 0 ? 0 : Math.round(clamp((completed / total) * 70 + (highDone / Math.max(1, total)) * 30, 0, 100));
  $("statProductivity").textContent = `Productivity score: ${productivity}/100`;

  const todayHours = tasks
    .filter((t) => t.status === "completed" && t.completedAt && isToday(t.completedAt))
    .reduce((s, t) => s + (Number(t.duration) || 0), 0);
  $("statStudyHours").textContent = `Study hours/day: ${todayHours.toFixed(1)} (today)`;
}

function renderNotifications() {
  const root = $("notifications");
  root.innerHTML = "";

  const derived = tasks.map(computeDerived);
  const pending = derived.filter((t) => t.status !== "completed");
  const soonMs = 24 * 60 * 60 * 1000;
  const nowTs = now();

  const upcoming = pending
    .filter((t) => t.deadlineTs !== Number.MAX_SAFE_INTEGER && t.deadlineTs - nowTs <= soonMs && t.deadlineTs >= nowTs)
    .sort((a, b) => a.deadlineTs - b.deadlineTs)
    .slice(0, 3);

  const highNotDone = pending
    .filter((t) => normalizePriority(t.priority) === 1)
    .sort(comparePriorityScheduling)
    .slice(0, 2);

  const notices = [];
  for (const t of upcoming) {
    const mins = Math.round((t.deadlineTs - nowTs) / (1000 * 60));
    notices.push({
      html: `<strong>Upcoming deadline</strong>: ${escapeHtml(t.name)} (${escapeHtml(
        t.subject
      )}) in ~${mins} min`,
    });
  }
  for (const t of highNotDone) {
    notices.push({
      html: `<strong>High priority pending</strong>: ${escapeHtml(t.name)} — due ${escapeHtml(formatDeadline(t.deadline))}`,
    });
  }

  if (!notices.length) {
    const el = document.createElement("div");
    el.className = "notice";
    el.textContent = "No reminders right now. You’re on track.";
    root.appendChild(el);
    return;
  }

  for (const n of notices) {
    const el = document.createElement("div");
    el.className = "notice";
    el.innerHTML = n.html;
    root.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function taskCard(t) {
  const pill = `<span class="pill ${priorityClass(t.priority)}">${priorityLabel(t.priority)} (P${t.priority})</span>`;
  const deps = (t.dependsOn || []).length ? `Deps: ${t.dependsOn.join(", ")}` : "Deps: —";
  const status = statusLabel(t.status);
  const deadline = formatDeadline(t.deadline);
  const duration = `${Number(t.duration).toFixed(2).replace(/\.00$/, "")}h`;

  const completedBtn =
    t.status === "completed"
      ? ""
      : `<button class="btn iconBtn" data-action="complete" data-id="${t.id}">Complete</button>`;

  return `
    <div class="taskCard" draggable="true" data-id="${t.id}">
      <div class="taskMain">
        <div class="taskTitle">${escapeHtml(t.name)}</div>
        <div class="taskSubtitle">${escapeHtml(t.subject)} • ${escapeHtml(status)} • ${escapeHtml(deps)}</div>
      </div>
      <div>${pill}</div>
      <div class="taskMeta">
        <div><strong>Deadline</strong></div>
        <div>${escapeHtml(deadline)}</div>
      </div>
      <div class="taskMeta">
        <div><strong>Time</strong></div>
        <div>${escapeHtml(duration)}</div>
      </div>
      <div class="taskActions">
        ${completedBtn}
        <button class="btn iconBtn" data-action="edit" data-id="${t.id}">Edit</button>
        <button class="btn iconBtn" data-action="delete" data-id="${t.id}">Delete</button>
      </div>
    </div>
  `;
}

function renderTaskList() {
  const list = $("taskList");
  const filtered = getFilteredTasks();
  if (!filtered.length) {
    list.innerHTML = `<div class="notice">No tasks match your filters.</div>`;
    return;
  }
  list.innerHTML = filtered.map(taskCard).join("");
}

function renderSortedView() {
  const list = $("sortedList");
  const sorted = tasks.map(computeDerived).slice().sort(comparePriorityScheduling);
  if (!sorted.length) {
    list.innerHTML = `<div class="notice">Add tasks to see the priority-scheduled order.</div>`;
    return;
  }
  list.innerHTML = sorted.map(taskCard).join("");
}

function renderKanban() {
  const todo = $("kanbanTodo");
  const ip = $("kanbanInProgress");
  const done = $("kanbanCompleted");
  todo.innerHTML = "";
  ip.innerHTML = "";
  done.innerHTML = "";

  const ordered = tasks.map(computeDerived).slice().sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id));
  for (const t of ordered) {
    const el = document.createElement("div");
    el.className = "kanbanCard";
    el.draggable = true;
    el.dataset.id = String(t.id);
    el.innerHTML = `
      <div class="taskTitle">${escapeHtml(t.name)}</div>
      <div class="taskSubtitle">${escapeHtml(t.subject)} • P${t.priority} • ${escapeHtml(
        statusLabel(t.status)
      )}</div>
    `;
    if (t.status === "completed") done.appendChild(el);
    else if (t.status === "in_progress") ip.appendChild(el);
    else todo.appendChild(el);
  }
}

function renderSchedule() {
  const root = $("schedule");
  const start = $("scheduleStart").value || "08:00";
  const schedule = generateDailySchedule(tasks.map(computeDerived), start);
  if (!schedule.length) {
    root.innerHTML = `<div class="notice">No pending tasks to schedule.</div>`;
    return;
  }
  root.innerHTML = schedule
    .map((s) => {
      const tag = s.blocked ? `<span class="pill pill--medium">Blocked by deps</span>` : "";
      return `
        <div class="scheduleItem">
          <div class="scheduleItem__time">${formatMinToHHMM(s.startMin)} – ${formatMinToHHMM(s.endMin)}</div>
          <div class="scheduleItem__task">${escapeHtml(s.name)} (${escapeHtml(s.subject)}) ${tag}</div>
        </div>
      `;
    })
    .join("");
}

function resetViz() {
  stopVizTimer();
  vizState.running = false;
  vizState.paused = false;
  vizState.steps = [];
  vizState.stepIdx = 0;
  vizState.locked = new Set();
  $("algoSteps").textContent = "Steps: 0";
  $("btnPauseSort").textContent = "Pause";

  // Base order: current filtered list order.
  const base = getFilteredTasks();
  vizState.baseOrder = base.map((t) => t.id);
  renderVizStage(vizState.baseOrder, null);
}

function algoTitle(alg) {
  if (alg === "selection") return "Selection Sort";
  if (alg === "insertion") return "Insertion Sort";
  return "Bubble Sort";
}

function renderVizMeta() {
  $("algoName").textContent = `Algorithm: ${algoTitle(vizState.algorithm)}`;
  $("algoComplexity").textContent = `Complexity: ${COMPLEXITY[vizState.algorithm] || "—"}`;
}

function renderVizStage(orderIds, step) {
  const stage = $("vizStage");
  const map = new Map(tasks.map((t) => [t.id, computeDerived(t)]));
  stage.innerHTML = "";

  for (let idx = 0; idx < orderIds.length; idx++) {
    const id = orderIds[idx];
    const t = map.get(id);
    if (!t) continue;
    const card = document.createElement("div");
    card.className = "vizCard";
    card.dataset.idx = String(idx);

    if (step?.type === "compare" && (idx === step.i || idx === step.j)) card.classList.add("is-compare");
    if (step?.type === "swap" && (idx === step.i || idx === step.j)) card.classList.add("is-swap");
    if (vizState.locked.has(idx)) card.classList.add("is-locked");

    card.innerHTML = `
      <div class="vizCard__title">${escapeHtml(t.name)}</div>
      <div class="vizCard__sub">${escapeHtml(t.subject)} • ${escapeHtml(statusLabel(t.status))}</div>
      <div class="vizCard__meta">
        <span class="pill ${priorityClass(t.priority)}">P${t.priority}</span>
        <span class="chip">Due: ${escapeHtml(formatDeadline(t.deadline))}</span>
        <span class="chip">Time: ${escapeHtml(String(t.duration))}h</span>
      </div>
    `;
    stage.appendChild(card);
  }
}

function stopVizTimer() {
  if (vizState.timer) clearTimeout(vizState.timer);
  vizState.timer = null;
}

function tickViz() {
  if (!vizState.running || vizState.paused) return;
  if (vizState.stepIdx >= vizState.steps.length) {
    vizState.running = false;
    stopVizTimer();
    return;
  }

  const step = vizState.steps[vizState.stepIdx];
  const order = step.order || vizState.baseOrder;
  if (step.type === "lock" && typeof step.i === "number") vizState.locked.add(step.i);

  $("algoSteps").textContent = `Steps: ${vizState.stepIdx + 1}/${vizState.steps.length}`;
  renderVizStage(order, step);

  vizState.stepIdx++;
  vizState.timer = setTimeout(tickViz, vizState.speedMs);
}

function startSortingVisualization() {
  resetViz();
  vizState.algorithm = $("algoSelect").value;
  vizState.criteria = $("sortCriteria").value;
  renderVizMeta();
  $("btnPauseSort").textContent = "Pause";

  const baseTasks = getFilteredTasks().map(computeDerived);
  if (baseTasks.length < 2) {
    $("vizStage").innerHTML = `<div class="notice">Add at least 2 tasks (or clear filters) to visualize sorting.</div>`;
    return;
  }

  const prepared = prepareAlgoItems(baseTasks);
  const { steps } = getSortSteps(vizState.algorithm, prepared, vizState.criteria);
  vizState.steps = steps;
  vizState.running = true;
  vizState.paused = false;
  vizState.stepIdx = 0;
  vizState.locked = new Set();
  tickViz();
}

function togglePause() {
  if (!vizState.running) return;
  vizState.paused = !vizState.paused;
  $("btnPauseSort").textContent = vizState.paused ? "Resume" : "Pause";
  if (!vizState.paused) tickViz();
}

function clearForm() {
  $("taskId").value = "";
  $("taskName").value = "";
  $("taskSubject").value = "";
  $("taskPriority").value = "high";
  $("taskDeadline").value = "";
  $("taskDuration").value = "1";
  $("taskStatus").value = "todo";
  $("taskDepends").value = "";
  $("taskNotes").value = "";
  $("btnSubmitTask").textContent = "Add Task";
}

function fillForm(t) {
  $("taskId").value = String(t.id);
  $("taskName").value = t.name || "";
  $("taskSubject").value = t.subject || "";
  $("taskPriority").value = t.priority === 1 ? "high" : t.priority === 2 ? "medium" : "low";
  $("taskDeadline").value = String(t.deadline || "");
  $("taskDuration").value = String(t.duration ?? 1);
  $("taskStatus").value = t.status || "todo";
  $("taskDepends").value = (t.dependsOn || []).join(", ");
  $("taskNotes").value = t.notes || "";
  $("btnSubmitTask").textContent = "Save Changes";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function upsertTaskFromForm() {
  const idStr = $("taskId").value;
  const isEdit = Boolean(idStr);
  const id = isEdit ? Number(idStr) : uid();

  const name = String($("taskName").value || "").trim();
  const subject = String($("taskSubject").value || "").trim();
  const priority = PRIORITY_MAP[$("taskPriority").value] ?? 2;
  const deadline = String($("taskDeadline").value || "").trim();
  const duration = Number($("taskDuration").value) || 1;
  const status = $("taskStatus").value || "todo";
  const dependsOn = parseDependsOn($("taskDepends").value);
  const notes = String($("taskNotes").value || "").trim();

  if (!name || !subject || !deadline) {
    // Use a lightweight UI notice instead of failing silently.
    const root = $("notifications");
    if (root) {
      root.innerHTML =
        '<div class="notice"><strong>Missing fields</strong>: Task Name, Subject, and Deadline are required.</div>';
    }
    return;
  }

  const existingIdx = tasks.findIndex((t) => Number(t.id) === id);
  if (existingIdx >= 0) {
    const prev = tasks[existingIdx];
    const completedAt =
      status === "completed" ? prev.completedAt || now() : prev.status === "completed" ? null : prev.completedAt;
    tasks[existingIdx] = {
      ...prev,
      id,
      name,
      subject,
      priority,
      deadline,
      duration,
      status,
      dependsOn,
      notes,
      completedAt,
    };
  } else {
    tasks.push({
      id,
      name,
      subject,
      priority,
      deadline,
      duration,
      status,
      dependsOn,
      notes,
      createdAt: now(),
      completedAt: status === "completed" ? now() : null,
      order: tasks.length ? Math.max(...tasks.map((t) => Number(t.order) || 0)) + 1 : 1,
    });
  }
  save();
  clearForm();
  rerenderAll();
}

function deleteTask(id) {
  tasks = tasks.filter((t) => Number(t.id) !== Number(id));
  // Also remove dependencies pointing to this task.
  for (const t of tasks) {
    t.dependsOn = (t.dependsOn || []).filter((d) => Number(d) !== Number(id));
  }
  save();
  rerenderAll();
}

function markCompleted(id) {
  const t = tasks.find((x) => Number(x.id) === Number(id));
  if (!t) return;
  t.status = "completed";
  t.completedAt = t.completedAt || now();
  save();
  rerenderAll();
}

function rerenderAll() {
  renderStats();
  renderTaskList();
  renderSortedView();
  renderKanban();
  renderNotifications();
  resetViz();
}

// Drag & drop (Task List order)
let dragId = null;

function bindTaskListDnD() {
  const list = $("taskList");
  list.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".taskCard");
    if (!card) return;
    dragId = Number(card.dataset.id);
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });

  list.addEventListener("dragend", (e) => {
    const card = e.target.closest(".taskCard");
    if (card) card.classList.remove("dragging");
    dragId = null;
    [...list.querySelectorAll(".taskCard")].forEach((el) => el.classList.remove("dropTarget"));
  });

  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    const over = e.target.closest(".taskCard");
    if (!over || dragId == null) return;
    [...list.querySelectorAll(".taskCard")].forEach((el) => el.classList.remove("dropTarget"));
    over.classList.add("dropTarget");
    e.dataTransfer.dropEffect = "move";
  });

  list.addEventListener("drop", (e) => {
    e.preventDefault();
    const over = e.target.closest(".taskCard");
    if (!over || dragId == null) return;
    const overId = Number(over.dataset.id);
    if (overId === dragId) return;

    const ordered = tasks.slice().sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id));
    const fromIdx = ordered.findIndex((t) => Number(t.id) === dragId);
    const toIdx = ordered.findIndex((t) => Number(t.id) === overId);
    if (fromIdx < 0 || toIdx < 0) return;

    const [moved] = ordered.splice(fromIdx, 1);
    ordered.splice(toIdx, 0, moved);

    // Reassign order values.
    ordered.forEach((t, i) => (t.order = i + 1));
    tasks = ordered;
    save();
    rerenderAll();
  });
}

// Drag & drop (Kanban status)
let kanbanDragId = null;

function bindKanbanDnD() {
  const kanban = $("kanban");
  kanban.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".kanbanCard");
    if (!card) return;
    kanbanDragId = Number(card.dataset.id);
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  kanban.addEventListener("dragend", (e) => {
    const card = e.target.closest(".kanbanCard");
    if (card) card.classList.remove("dragging");
    kanbanDragId = null;
    [...kanban.querySelectorAll(".kanban__list")].forEach((l) => l.classList.remove("dropZone"));
  });
  kanban.addEventListener("dragover", (e) => {
    const list = e.target.closest(".kanban__list");
    if (!list) return;
    e.preventDefault();
    [...kanban.querySelectorAll(".kanban__list")].forEach((l) => l.classList.remove("dropZone"));
    list.classList.add("dropZone");
    e.dataTransfer.dropEffect = "move";
  });
  kanban.addEventListener("drop", (e) => {
    const list = e.target.closest(".kanban__list");
    if (!list || kanbanDragId == null) return;
    e.preventDefault();
    const status = list.dataset.status;
    const t = tasks.find((x) => Number(x.id) === kanbanDragId);
    if (!t) return;
    t.status = status;
    if (status === "completed") t.completedAt = t.completedAt || now();
    if (status !== "completed") t.completedAt = null;
    save();
    rerenderAll();
  });
}

function bindActions() {
  $("taskForm").addEventListener("submit", (e) => {
    e.preventDefault();
    upsertTaskFromForm();
  });
  $("btnClearForm").addEventListener("click", clearForm);

  $("btnClearFilters").addEventListener("click", () => {
    $("searchInput").value = "";
    $("filterPriority").value = "";
    $("filterSubject").value = "";
    $("filterStatus").value = "";
    $("filterDeadline").value = "";
    rerenderAll();
  });

  // Re-render on filter changes.
  for (const id of ["searchInput", "filterPriority", "filterSubject", "filterStatus", "filterDeadline"]) {
    $(id).addEventListener("input", () => rerenderAll());
    $(id).addEventListener("change", () => rerenderAll());
  }

  // Task card actions (event delegation)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = Number(btn.dataset.id);
    if (!Number.isFinite(id)) return;

    if (action === "delete") deleteTask(id);
    if (action === "complete") markCompleted(id);
    if (action === "edit") {
      const t = tasks.find((x) => Number(x.id) === id);
      if (t) fillForm(t);
    }
  });

  $("algoSelect").addEventListener("change", () => {
    vizState.algorithm = $("algoSelect").value;
    renderVizMeta();
    resetViz();
  });
  $("sortCriteria").addEventListener("change", () => {
    vizState.criteria = $("sortCriteria").value;
    resetViz();
  });

  $("btnStartSort").addEventListener("click", startSortingVisualization);
  $("btnPauseSort").addEventListener("click", togglePause);
  $("btnResetSort").addEventListener("click", resetViz);

  $("btnGenerateSchedule").addEventListener("click", () => renderSchedule());

  $("btnDarkMode").addEventListener("click", () => {
    settings.theme = settings.theme === "light" ? "dark" : "light";
    applyTheme();
    save();
  });

  $("btnAddSample").addEventListener("click", () => {
    if (tasks.length) return;
    const baseDate = new Date();
    const plusHours = (h) => {
      const d = new Date(baseDate.getTime() + h * 60 * 60 * 1000);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const HH = String(d.getHours()).padStart(2, "0");
      const MM = String(d.getMinutes()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}T${HH}:${MM}`;
    };
    tasks = [
      {
        id: 1,
        name: "DBMS Assignment",
        subject: "DBMS",
        priority: 1,
        deadline: plusHours(30),
        duration: 2,
        status: "todo",
        dependsOn: [],
        notes: "",
        createdAt: now(),
        completedAt: null,
        order: 1,
      },
      {
        id: 2,
        name: "Study ADSA (Heap & PQ)",
        subject: "ADSA",
        priority: 1,
        deadline: plusHours(18),
        duration: 1.5,
        status: "in_progress",
        dependsOn: [],
        notes: "",
        createdAt: now(),
        completedAt: null,
        order: 2,
      },
      {
        id: 3,
        name: "Lab Record",
        subject: "OS Lab",
        priority: 2,
        deadline: plusHours(48),
        duration: 0.5,
        status: "todo",
        dependsOn: [1],
        notes: "Finish DBMS first",
        createdAt: now(),
        completedAt: null,
        order: 3,
      },
      {
        id: 4,
        name: "Revise Networks",
        subject: "CN",
        priority: 3,
        deadline: plusHours(72),
        duration: 1,
        status: "todo",
        dependsOn: [],
        notes: "",
        createdAt: now(),
        completedAt: null,
        order: 4,
      },
    ];
    save();
    rerenderAll();
  });

  $("btnExportPdf").addEventListener("click", exportPdf);
  $("csvImportInput").addEventListener("change", importCsv);
}

function exportPdf() {
  const jspdf = window.jspdf;
  if (!jspdf?.jsPDF) return;
  const doc = new jspdf.jsPDF();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Smart Study Planner - Tasks", 14, 16);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);

  const lines = tasks
    .map(computeDerived)
    .slice()
    .sort(comparePriorityScheduling)
    .map((t) => {
      const due = formatDeadline(t.deadline);
      const deps = (t.dependsOn || []).length ? ` deps:${t.dependsOn.join(",")}` : "";
      return `#${t.id} [P${t.priority}] ${t.name} (${t.subject}) - ${statusLabel(t.status)} - due ${due} - ${t.duration}h${deps}`;
    });

  let y = 26;
  for (const line of lines) {
    const chunks = doc.splitTextToSize(line, 180);
    for (const c of chunks) {
      if (y > 280) {
        doc.addPage();
        y = 16;
      }
      doc.text(c, 14, y);
      y += 7;
    }
  }
  doc.save("smart-study-planner-tasks.pdf");
}

function parseCsv(text) {
  // Small CSV parser supporting quoted fields.
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === "," || ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") continue;
      row.push(cur);
      cur = "";
      if (ch === "\n") {
        rows.push(row);
        row = [];
      }
      continue;
    }
    cur += ch;
  }
  row.push(cur);
  rows.push(row);
  return rows.filter((r) => r.some((c) => String(c || "").trim() !== ""));
}

function toDatetimeLocalMaybe(s) {
  const raw = String(s || "").trim();
  if (!raw) return "";
  // Accept yyyy-mm-ddTHH:MM or yyyy-mm-dd HH:MM
  if (raw.includes("T")) return raw.slice(0, 16);
  if (raw.includes(" ")) return raw.replace(" ", "T").slice(0, 16);
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}`;
}

async function importCsv(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const rows = parseCsv(text);
  if (!rows.length) return;

  const header = rows[0].map((h) => String(h || "").trim().toLowerCase());
  const idx = (name) => header.indexOf(name);

  const iName = idx("name");
  const iSubject = idx("subject");
  const iPriority = idx("priority");
  const iDeadline = idx("deadline");
  const iDuration = idx("duration");
  const iStatus = idx("status");
  const iDepends = idx("dependson");
  const iNotes = idx("notes");

  const startId = uid();
  let nextId = startId;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = String(row[iName] ?? "").trim();
    const subject = String(row[iSubject] ?? "").trim();
    if (!name || !subject) continue;

    const prRaw = String(row[iPriority] ?? "").trim().toLowerCase();
    const priority =
      prRaw === "1" || prRaw === "high"
        ? 1
        : prRaw === "2" || prRaw === "medium"
          ? 2
          : prRaw === "3" || prRaw === "low"
            ? 3
            : 2;
    const deadline = toDatetimeLocalMaybe(row[iDeadline]);
    const duration = Number(row[iDuration]) || 1;
    const statusRaw = String(row[iStatus] ?? "").trim().toLowerCase();
    const status =
      statusRaw === "completed" ? "completed" : statusRaw === "in_progress" || statusRaw === "in progress" ? "in_progress" : "todo";
    const dependsOn = parseDependsOn(row[iDepends]);
    const notes = String(row[iNotes] ?? "").trim();

    tasks.push({
      id: nextId++,
      name,
      subject,
      priority,
      deadline: deadline || "",
      duration,
      status,
      dependsOn,
      notes,
      createdAt: now(),
      completedAt: status === "completed" ? now() : null,
      order: tasks.length ? Math.max(...tasks.map((t) => Number(t.order) || 0)) + 1 : 1,
    });
  }

  save();
  rerenderAll();
  e.target.value = "";
}

function startClock() {
  const el = $("footerClock");
  const tick = () => {
    const d = new Date();
    el.textContent = d.toLocaleString();
  };
  tick();
  setInterval(tick, 1000);
}

function init() {
  // If these are missing, script loading order is wrong.
  if (!PRIORITY_MAP || !getSortSteps) {
    const root = document.getElementById("notifications");
    if (root) {
      root.innerHTML =
        '<div class="notice"><strong>Script load error</strong>: Please ensure `scheduler.js` and `algorithms.js` are loaded before `script.js`.</div>';
    }
    return;
  }
  load();
  applyTheme();
  bindActions();
  bindTaskListDnD();
  bindKanbanDnD();
  renderVizMeta();
  rerenderAll();
  renderSchedule();
  startClock();
}

init();

