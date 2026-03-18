/**
 * Smart Study Planner (Frontend-only)
 *
 * Upgrades included:
 * - Sticky navbar with smooth scroll + active section highlight
 * - Improved Task Form (separate date + time, floating labels, icons)
 * - Analytics Dashboard using Chart.js (dynamic updates)
 * - Kanban UX improvements (badges, deadline, color-coded columns)
 * - Sorted Task Review (ranked lists by priority/deadline/duration)
 * - Daily plan rendered as a vertical timeline
 *
 * Data structure used:
 * - `tasks`: Array of task objects persisted in localStorage.
 *
 * Priority scheduling (CPU-like):
 * - Sort by: priority (High=1) -> earlier deadline -> shorter duration
 */

document.addEventListener("DOMContentLoaded", () => {
  // ----------------------------
  // Dependencies
  // ----------------------------
  const S = window.SSP_SCHEDULER;
  if (!S) {
    console.error("Missing scheduler globals. Ensure `scheduler.js` loads before `script.js`.");
    return;
  }

  // Chart.js is optional (but required by the upgrade)
  const ChartLib = window.Chart;
  if (!ChartLib) console.warn("Chart.js not found. Analytics charts will not render.");

  // ----------------------------
  // Helpers
  // ----------------------------
  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function now() {
    return Date.now();
  }

  function showNotice(html) {
    const root = $("notifications");
    if (!root) return;
    root.innerHTML = `<div class="notice">${html}</div>`;
  }

  function clearNotice() {
    const root = $("notifications");
    if (!root) return;
    root.innerHTML = "";
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function minutesTo12h(min) {
    const h24 = Math.floor(min / 60) % 24;
    const m = min % 60;
    const suffix = h24 >= 12 ? "PM" : "AM";
    const h12 = ((h24 + 11) % 12) + 1;
    return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${suffix}`;
  }

  function time24To12h(hhmm) {
    const [hh, mm] = String(hhmm || "").split(":").map((x) => Number(x));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return "—";
    const suffix = hh >= 12 ? "PM" : "AM";
    const h12 = ((hh + 11) % 12) + 1;
    return `${String(h12).padStart(2, "0")}:${String(mm).padStart(2, "0")} ${suffix}`;
  }

  function formatTimeTo12Hr(time) {
    let [hour, minute] = String(time || "").split(":");
    hour = Number(hour);
    minute = String(minute ?? "00").padStart(2, "0");
    if (!Number.isFinite(hour)) return "—";
    let ampm = hour >= 12 ? "PM" : "AM";
    hour = hour % 12 || 12;
    return `${hour}:${minute} ${ampm}`;
  }

  function deadlineFromDateTime(dateStr, timeStr) {
    const d = String(dateStr || "").trim();
    const t = String(timeStr || "").trim();
    if (!d || !t) return "";
    // Store as datetime-local style so Date.parse works consistently
    return `${d}T${t}`;
  }

  function splitDeadline(deadline) {
    const raw = String(deadline || "");
    if (!raw.includes("T")) return { date: "", time: "" };
    const [date, time] = raw.split("T");
    return { date: date || "", time: (time || "").slice(0, 5) };
  }

  function formatDeadline(deadlineIso) {
    const ts = S.toTimestamp(deadlineIso);
    if (!Number.isFinite(ts) || ts === Number.MAX_SAFE_INTEGER) return "—";
    const d = new Date(ts);
    return d.toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  }

  const PRIORITY_STR_TO_NUM = { high: 1, medium: 2, low: 3 };
  const PRIORITY_NUM_TO_STR = { 1: "1", 2: "2", 3: "3" };

  function priorityLabel(p) {
    return S.priorityLabel(p);
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

  function computeDerived(t) {
    return { ...t, deadlineTs: S.toTimestamp(t.deadline) };
  }

  // ----------------------------
  // Storage
  // ----------------------------
  const STORAGE_KEY = "ssp_tasks_v3";
  const SETTINGS_KEY = "ssp_settings_v3";

  /** @type {Array<any>} */
  let tasks = [];
  let settings = { theme: "dark" };

  function saveTasks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      return true;
    } catch (e) {
      console.warn("localStorage save blocked", e);
      showNotice(
        "<strong>Storage blocked</strong>: Your browser blocked localStorage. Run with a local server (e.g., VS Code Live Server) for persistence."
      );
      return false;
    }
  }

  function loadTasks() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      tasks = raw ? JSON.parse(raw) : [];
    } catch {
      tasks = [];
    }
    tasks = (Array.isArray(tasks) ? tasks : []).map(normalizeTask).filter(Boolean);
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      return true;
    } catch {
      return false;
    }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      settings = raw ? { ...settings, ...JSON.parse(raw) } : settings;
    } catch {
      settings = settings;
    }
  }

  // ----------------------------
  // Theme (dark-mode class on body)
  // ----------------------------
  function applyTheme() {
    const isDark = settings.theme !== "light";
    document.body.classList.toggle("dark-mode", isDark);
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
  }

  function toggleDarkMode() {
    settings.theme = settings.theme === "light" ? "dark" : "light";
    applyTheme();
    saveSettings();
  }

  // ----------------------------
  // Task normalization + validation
  // ----------------------------
  function normalizeTask(t) {
    if (!t || typeof t !== "object") return null;
    const id = Number(t.id);
    const name = String(t.name ?? "").trim();
    const subject = String(t.subject ?? "").trim();
    const priority = S.normalizePriority(t.priority);
    const deadline = String(t.deadline ?? "").trim();
    const duration = Math.max(0.25, Number(t.duration) || 1);
    const status = ["todo", "in_progress", "completed"].includes(t.status) ? t.status : "todo";
    const dependencies = Array.isArray(t.dependencies)
      ? t.dependencies
      : Array.isArray(t.dependsOn)
        ? t.dependsOn
        : [];
    const notes = String(t.notes ?? "").trim();

    if (!Number.isFinite(id) || !name || !subject) return null;

    return {
      id,
      name,
      subject,
      priority,
      deadline,
      duration,
      status,
      dependencies: dependencies.map(Number).filter((n) => Number.isFinite(n) && n > 0),
      notes,
      createdAt: Number(t.createdAt) || now(),
      completedAt: status === "completed" ? Number(t.completedAt) || now() : null,
      order: Number.isFinite(Number(t.order)) ? Number(t.order) : id,
    };
  }

  function validateTaskInput({ name, subject, date, time, duration }) {
    const errs = [];
    if (!name) errs.push("Task Name is required.");
    if (!subject) errs.push("Subject is required.");
    if (!date) errs.push("Deadline date is required.");
    if (!time) errs.push("Deadline time is required.");
    const deadline = deadlineFromDateTime(date, time);
    const ts = S.toTimestamp(deadline);
    if (!Number.isFinite(ts) || ts === Number.MAX_SAFE_INTEGER) errs.push("Deadline must be a valid date/time.");
    if (!(Number(duration) > 0)) errs.push("Duration must be > 0.");
    return errs;
  }

  // ----------------------------
  // Navbar: smooth scroll + active highlight
  // ----------------------------
  const SECTION_IDS = [
    "taskFormSection",
    "taskListSection",
    "sortedReviewSection",
    "dailyPlanSection",
    "analyticsSection",
    "kanbanSection",
  ];

  function setActiveNav(id) {
    document.querySelectorAll(".navLink").forEach((a) => {
      a.classList.toggle("is-active", a.dataset.target === id);
    });
  }

  function bindNavbar() {
    const navbar = $("navbar");
    const toggle = $("btnNavToggle");
    const links = $("navLinks");

    toggle?.addEventListener("click", () => {
      const open = navbar.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    links?.addEventListener("click", (e) => {
      const a = e.target.closest("a.navLink");
      if (!a) return;
      e.preventDefault();
      const id = a.dataset.target;
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      navbar.classList.remove("is-open");
      toggle?.setAttribute("aria-expanded", "false");
    });

    // Active section tracking
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((x) => x.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target?.id) setActiveNav(visible.target.id);
      },
      { root: null, threshold: [0.25, 0.35, 0.5, 0.65] }
    );
    SECTION_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    });
  }

  // ----------------------------
  // Filters/Search
  // ----------------------------
  function getFilteredTasks() {
    const q = String($("searchInput").value || "").trim().toLowerCase();
    const filterPriority = $("filterPriority").value;
    const filterSubject = String($("filterSubject").value || "").trim().toLowerCase();
    const filterStatus = $("filterStatus").value;
    const filterDeadline = $("filterDeadline").value;

    const ordered = tasks
      .map(computeDerived)
      .slice()
      .sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id));

    return ordered.filter((t) => {
      if (filterPriority && String(t.priority) !== String(filterPriority)) return false;
      if (filterStatus && t.status !== filterStatus) return false;
      if (filterSubject && !String(t.subject || "").toLowerCase().includes(filterSubject)) return false;
      if (filterDeadline) {
        const d = new Date(t.deadlineTs);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        if (`${y}-${m}-${day}` !== filterDeadline) return false;
      }
      if (q) {
        const hay = `${t.name || ""} ${t.subject || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  // ----------------------------
  // Rendering: Dashboard
  // ----------------------------
  function renderDashboard() {
    const total = tasks.length;
    const completed = tasks.filter((t) => t.status === "completed").length;
    const pending = total - completed;
    const highPriority = tasks.filter((t) => t.priority === 1 && t.status !== "completed").length;

    $("statTotal").textContent = String(total);
    $("statCompleted").textContent = String(completed);
    $("statPending").textContent = String(pending);
    $("statHigh").textContent = String(highPriority);

    const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
    $("progressCompletion").style.width = `${pct}%`;
    $("statCompletionHint").textContent = `${pct}% completed`;
  }

  // ----------------------------
  // Rendering: Task cards (list + kanban + sorted review)
  // ----------------------------
  function taskCardHtml(t, { rank = null, highlightTop = false } = {}) {
    const deps = (t.dependencies || []).length ? `Deps: ${t.dependencies.join(", ")}` : "Deps: —";
    const pill = `<span class="pill ${priorityClass(t.priority)}">P${t.priority}</span>`;
    const due = formatDeadline(t.deadline);
    const rankChip = rank != null ? `<span class="rankBadge">#${rank}</span>` : "";

    const completeBtn =
      t.status === "completed"
        ? ""
        : `<button class="btn iconBtn" data-action="complete" data-id="${t.id}">Complete</button>`;

    return `
      <div class="taskCard ${highlightTop ? "is-top" : ""}" draggable="true" data-id="${t.id}">
        <div class="taskMain">
          <div class="taskTitle">${rankChip} ${escapeHtml(t.name)}</div>
          <div class="taskSubtitle">${escapeHtml(t.subject)} • ${escapeHtml(statusLabel(t.status))} • ${escapeHtml(deps)}</div>
        </div>
        <div>${pill}</div>
        <div class="taskMeta">
          <div><strong>Deadline</strong></div>
          <div>${escapeHtml(due)}</div>
        </div>
        <div class="taskMeta">
          <div><strong>Time</strong></div>
          <div>${escapeHtml(String(t.duration))}h</div>
        </div>
        <div class="taskActions">
          ${completeBtn}
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
    list.innerHTML = filtered.map((t) => taskCardHtml(t)).join("");
  }

  function renderSortedReview() {
    const byPriority = $("sortedByPriority");
    const byDeadline = $("sortedByDeadline");
    const byDuration = $("sortedByDuration");

    const derived = tasks.map(computeDerived);
    if (!derived.length) {
      byPriority.innerHTML = `<div class="notice">Add tasks to see rankings.</div>`;
      byDeadline.innerHTML = `<div class="notice">Add tasks to see rankings.</div>`;
      byDuration.innerHTML = `<div class="notice">Add tasks to see rankings.</div>`;
      return;
    }

    // Priority scheduling ranking
    const pr = derived.slice().sort(S.comparePriorityScheduling);
    // Deadline ranking
    const dl = derived
      .slice()
      .sort((a, b) => a.deadlineTs - b.deadlineTs || a.priority - b.priority || a.duration - b.duration || a.id - b.id);
    // Duration ranking
    const du = derived
      .slice()
      .sort((a, b) => a.duration - b.duration || a.priority - b.priority || a.deadlineTs - b.deadlineTs || a.id - b.id);

    const topId = pr[0]?.id;
    byPriority.innerHTML = pr.map((t, i) => taskCardHtml(t, { rank: i + 1, highlightTop: t.id === topId })).join("");
    byDeadline.innerHTML = dl.map((t, i) => taskCardHtml(t, { rank: i + 1, highlightTop: t.id === topId })).join("");
    byDuration.innerHTML = du.map((t, i) => taskCardHtml(t, { rank: i + 1, highlightTop: t.id === topId })).join("");
  }

  function renderKanban() {
    const todo = $("kanbanTodo");
    const ip = $("kanbanInProgress");
    const done = $("kanbanCompleted");
    todo.innerHTML = "";
    ip.innerHTML = "";
    done.innerHTML = "";

    const ordered = tasks.slice().sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id));
    for (const t of ordered) {
      const card = document.createElement("div");
      card.className = "kanbanCard";
      card.draggable = true;
      card.dataset.id = String(t.id);
      card.innerHTML = `
        <div class="taskTitle">${escapeHtml(t.name)}</div>
        <div class="taskSubtitle">${escapeHtml(t.subject)} • ${escapeHtml(statusLabel(t.status))}</div>
        <div class="taskSubtitle"><strong>Due:</strong> ${escapeHtml(formatDeadline(t.deadline))}</div>
        <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
          <span class="pill ${priorityClass(t.priority)}">P${t.priority}</span>
          <span class="chip">${escapeHtml(String(t.duration))}h</span>
        </div>
      `;
      if (t.status === "completed") done.appendChild(card);
      else if (t.status === "in_progress") ip.appendChild(card);
      else todo.appendChild(card);
    }
  }

  // ----------------------------
  // Notifications (simple reminders)
  // ----------------------------
  function renderNotifications() {
    const root = $("notifications");
    if (!root) return;
    root.innerHTML = "";

    const nowTs = now();
    const soonMs = 24 * 60 * 60 * 1000;
    const pending = tasks.map(computeDerived).filter((t) => t.status !== "completed");

    const upcoming = pending
      .filter((t) => t.deadlineTs !== Number.MAX_SAFE_INTEGER && t.deadlineTs >= nowTs && t.deadlineTs - nowTs <= soonMs)
      .sort((a, b) => a.deadlineTs - b.deadlineTs)
      .slice(0, 3);

    const highPending = pending
      .filter((t) => t.priority === 1)
      .sort(S.comparePriorityScheduling)
      .slice(0, 2);

    const notices = [];
    for (const t of upcoming) {
      const mins = Math.round((t.deadlineTs - nowTs) / (1000 * 60));
      notices.push(`<strong>Upcoming</strong>: ${escapeHtml(t.name)} in ~${mins} min`);
    }
    for (const t of highPending) {
      notices.push(`<strong>High priority</strong>: ${escapeHtml(t.name)} — due ${escapeHtml(formatDeadline(t.deadline))}`);
    }

    if (!notices.length) {
      root.innerHTML = `<div class="notice">No reminders right now. You’re on track.</div>`;
      return;
    }
    root.innerHTML = notices.map((h) => `<div class="notice">${h}</div>`).join("");
  }

  // ----------------------------
  // Daily plan: timeline UI
  // ----------------------------
  function renderSchedule() {
    const root = $("schedule");
    const start = $("scheduleStart").value || "08:00";
    const schedule = S.generateDailySchedule(
      tasks.map((t) => ({ ...t, dependsOn: t.dependencies })), // scheduler expects dependsOn
      start
    );

    if (!schedule.length) {
      root.innerHTML = `<div class="notice">No pending tasks to schedule.</div>`;
      return;
    }

    root.innerHTML = schedule
      .map((s) => {
        const start12 = minutesTo12h(s.startMin);
        const tag = s.blocked ? `<span class="pill pill--medium">Blocked</span>` : "";
        return `
          <div class="timelineItem">
            <div class="timelineDot" aria-hidden="true"></div>
            <div class="timelineCard">
              <div class="timelineTime">${escapeHtml(start12)}</div>
              <div class="timelineTask">${escapeHtml(s.name)} (${escapeHtml(s.subject)}) ${tag}</div>
            </div>
          </div>
        `;
      })
      .join("");
  }

  // ----------------------------
  // Analytics Dashboard (Chart.js)
  // ----------------------------
  const charts = {
    priority: null,
    status: null,
    hours: null,
    productivity: null,
  };

  function dayKey(ts) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function lastNDaysKeys(n = 7) {
    const out = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(base.getTime() - i * 24 * 60 * 60 * 1000);
      out.push(dayKey(d.getTime()));
    }
    return out;
  }

  function initCharts() {
    if (!ChartLib) return;

    // Destroy previous instances before re-init (prevents lag/freezing)
    for (const k of Object.keys(charts)) {
      if (charts[k]) {
        charts[k].destroy();
        charts[k] = null;
      }
    }

    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: getComputedStyle(document.documentElement).getPropertyValue("--text") } },
      },
      scales: {
        x: { ticks: { color: getComputedStyle(document.documentElement).getPropertyValue("--muted") } },
        y: { ticks: { color: getComputedStyle(document.documentElement).getPropertyValue("--muted") } },
      },
    };

    const ctxPriority = $("chartPriority")?.getContext("2d");
    const ctxStatus = $("chartStatus")?.getContext("2d");
    const ctxHours = $("chartHours")?.getContext("2d");
    const ctxProd = $("chartProductivity")?.getContext("2d");

    if (ctxPriority) {
      charts.priority = new ChartLib(ctxPriority, {
        type: "pie",
        data: {
          labels: ["High", "Medium", "Low"],
          datasets: [
            {
              data: [0, 0, 0],
              backgroundColor: ["rgba(255,77,90,0.85)", "rgba(255,176,32,0.85)", "rgba(32,210,125,0.85)"],
              borderColor: ["rgba(255,77,90,1)", "rgba(255,176,32,1)", "rgba(32,210,125,1)"],
              borderWidth: 1,
            },
          ],
        },
        options: { ...commonOptions, scales: {} },
      });
    }

    if (ctxStatus) {
      charts.status = new ChartLib(ctxStatus, {
        type: "bar",
        data: {
          labels: ["Completed", "Pending"],
          datasets: [
            {
              label: "Tasks",
              data: [0, 0],
              backgroundColor: ["rgba(32,210,125,0.75)", "rgba(74,163,255,0.75)"],
              borderColor: ["rgba(32,210,125,1)", "rgba(74,163,255,1)"],
              borderWidth: 1,
            },
          ],
        },
        options: commonOptions,
      });
    }

    if (ctxHours) {
      charts.hours = new ChartLib(ctxHours, {
        type: "line",
        data: {
          labels: lastNDaysKeys(7),
          datasets: [
            {
              label: "Hours",
              data: Array(7).fill(0),
              borderColor: "rgba(74,163,255,1)",
              backgroundColor: "rgba(74,163,255,0.2)",
              tension: 0.35,
              fill: true,
              pointRadius: 3,
            },
          ],
        },
        options: commonOptions,
      });
    }

    if (ctxProd) {
      charts.productivity = new ChartLib(ctxProd, {
        type: "line",
        data: {
          labels: lastNDaysKeys(7),
          datasets: [
            {
              label: "Productivity (0-100)",
              data: Array(7).fill(0),
              borderColor: "rgba(167,139,250,1)",
              backgroundColor: "rgba(167,139,250,0.2)",
              tension: 0.35,
              fill: true,
              pointRadius: 3,
            },
          ],
        },
        options: commonOptions,
      });
    }
  }

  function updateCharts() {
    if (!ChartLib) return;

    const prCounts = { 1: 0, 2: 0, 3: 0 };
    const statusCounts = { completed: 0, pending: 0 };

    for (const t of tasks) {
      prCounts[t.priority] = (prCounts[t.priority] || 0) + 1;
      if (t.status === "completed") statusCounts.completed++;
      else statusCounts.pending++;
    }

    if (charts.priority) {
      charts.priority.data.datasets[0].data = [prCounts[1], prCounts[2], prCounts[3]];
      charts.priority.update();
    }

    if (charts.status) {
      charts.status.data.datasets[0].data = [statusCounts.completed, statusCounts.pending];
      charts.status.update();
    }

    // Hours/day: sum duration of completed tasks per day (last 7 days)
    const keys = lastNDaysKeys(7);
    const hoursByDay = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const t of tasks) {
      if (t.status !== "completed" || !t.completedAt) continue;
      const k = dayKey(t.completedAt);
      if (k in hoursByDay) hoursByDay[k] += Number(t.duration) || 0;
    }

    if (charts.hours) {
      charts.hours.data.labels = keys;
      charts.hours.data.datasets[0].data = keys.map((k) => Number(hoursByDay[k] || 0));
      charts.hours.update();
    }

    // Productivity trend: (completed tasks per day) scaled to 0..100 (cap at 5 tasks/day)
    const completedByDay = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const t of tasks) {
      if (t.status !== "completed" || !t.completedAt) continue;
      const k = dayKey(t.completedAt);
      if (k in completedByDay) completedByDay[k] += 1;
    }
    const prod = keys.map((k) => Math.round(clamp((completedByDay[k] / 5) * 100, 0, 100)));

    if (charts.productivity) {
      charts.productivity.data.labels = keys;
      charts.productivity.data.datasets[0].data = prod;
      charts.productivity.update();
    }
  }

  // ----------------------------
  // CRUD
  // ----------------------------
  function clearForm() {
    $("taskId").value = "";
    $("taskName").value = "";
    $("taskSubject").value = "";
    $("taskPriority").value = "1";
    $("taskDate").value = "";
    $("taskTime").value = "";
    $("taskDuration").value = "1";
    $("taskStatus").value = "todo";
    $("taskDepends").value = "";
    $("taskNotes").value = "";
    $("btnSubmitTask").textContent = "Add Task";
    updateTimeHint();
  }

  function fillForm(t) {
    $("taskId").value = String(t.id);
    $("taskName").value = t.name || "";
    $("taskSubject").value = t.subject || "";
    $("taskPriority").value = String(t.priority || 2);
    const { date, time } = splitDeadline(t.deadline);
    $("taskDate").value = date || "";
    $("taskTime").value = time || "";
    $("taskDuration").value = String(t.duration ?? 1);
    $("taskStatus").value = t.status || "todo";
    $("taskDepends").value = (t.dependencies || []).join(", ");
    $("taskNotes").value = t.notes || "";
    $("btnSubmitTask").textContent = "Save Changes";
    updateTimeHint();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function createTaskFromForm() {
    const idExisting = $("taskId").value ? Number($("taskId").value) : null;
    const name = String($("taskName").value || "").trim();
    const subject = String($("taskSubject").value || "").trim();
    const priority = Number($("taskPriority").value) || 2;
    const date = String($("taskDate").value || "").trim();
    const time = String($("taskTime").value || "").trim();
    const deadline = deadlineFromDateTime(date, time);
    const duration = Number($("taskDuration").value) || 1;
    const status = $("taskStatus").value || "todo";
    const dependencies = S.parseDependsOn($("taskDepends").value);
    const notes = String($("taskNotes").value || "").trim();

    const errs = validateTaskInput({ name, subject, date, time, duration });
    if (errs.length) {
      console.warn("Validation errors:", errs);
      showNotice(`<strong>Fix these:</strong> ${escapeHtml(errs.join(" "))}`);
      return null;
    }

    // Duplicate check (same name + subject + deadline) for new tasks
    if (!idExisting) {
      const dupe = tasks.some(
        (t) =>
          t.name.toLowerCase() === name.toLowerCase() &&
          t.subject.toLowerCase() === subject.toLowerCase() &&
          String(t.deadline) === String(deadline)
      );
      if (dupe) {
        showNotice("<strong>Duplicate task</strong>: Same name/subject/deadline already exists.");
        return null;
      }
    }

    const id = idExisting ?? now();
    const existing = idExisting ? tasks.find((t) => t.id === idExisting) : null;
    return normalizeTask({
      id,
      name,
      subject,
      priority,
      deadline,
      duration,
      status,
      dependencies,
      notes,
      createdAt: existing?.createdAt || now(),
      completedAt: status === "completed" ? existing?.completedAt || now() : null,
      order: existing?.order ?? (tasks.length ? Math.max(...tasks.map((t) => t.order || 0)) + 1 : 1),
    });
  }

  function addOrUpdateTask(task) {
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) {
      const prev = tasks[idx];
      const completedAt =
        task.status === "completed" ? prev.completedAt || now() : prev.status === "completed" ? null : prev.completedAt;
      tasks[idx] = { ...prev, ...task, completedAt };
    } else {
      tasks.push(task);
    }
    saveTasks();
    renderAll();
  }

  function deleteTask(id) {
    tasks = tasks.filter((t) => t.id !== id);
    for (const t of tasks) {
      t.dependencies = (t.dependencies || []).filter((d) => d !== id);
    }
    saveTasks();
    renderAll();
  }

  function completeTask(id) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    t.status = "completed";
    t.completedAt = t.completedAt || now();
    saveTasks();
    renderAll();
  }

  // ----------------------------
  // PDF Export + CSV Import + Sample tasks
  // ----------------------------
  function exportPdf() {
    const jspdf = window.jspdf;
    if (!jspdf?.jsPDF) {
      showNotice("<strong>PDF export failed</strong>: jsPDF not loaded.");
      return;
    }
    const doc = new jspdf.jsPDF();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("Smart Study Planner - Tasks", 14, 16);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);

    const lines = tasks
      .map(computeDerived)
      .slice()
      .sort(S.comparePriorityScheduling)
      .map((t) => `#${t.id} [P${t.priority}] ${t.name} (${t.subject}) - ${statusLabel(t.status)} - due ${formatDeadline(t.deadline)} - ${t.duration}h`);

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
    const iDepends = idx("dependencies") >= 0 ? idx("dependencies") : idx("dependson");
    const iNotes = idx("notes");

    const imported = [];
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

      const dl = toDatetimeLocalMaybe(row[iDeadline]);
      const { date, time } = splitDeadline(dl);
      const deadline = deadlineFromDateTime(date, time);
      const duration = Number(row[iDuration]) || 1;
      const statusRaw = String(row[iStatus] ?? "").trim().toLowerCase();
      const status =
        statusRaw === "completed" ? "completed" : statusRaw === "in_progress" || statusRaw === "in progress" ? "in_progress" : "todo";
      const dependencies = S.parseDependsOn(row[iDepends]);
      const notes = String(row[iNotes] ?? "").trim();

      imported.push(
        normalizeTask({
          id: now() + r,
          name,
          subject,
          priority,
          deadline,
          duration,
          status,
          dependencies,
          notes,
          createdAt: now(),
          completedAt: status === "completed" ? now() : null,
          order: (tasks.length ? Math.max(...tasks.map((t) => t.order || 0)) : 0) + imported.length + 1,
        })
      );
    }

    tasks = tasks.concat(imported.filter(Boolean));
    saveTasks();
    renderAll();
    e.target.value = "";
  }

  function addSampleTasks() {
    if (tasks.length) {
      showNotice("<strong>Sample not added</strong>: Your list is not empty.");
      return;
    }

    const base = new Date();
    const plusHours = (h) => {
      const d = new Date(base.getTime() + h * 60 * 60 * 1000);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const HH = String(d.getHours()).padStart(2, "0");
      const MM = String(d.getMinutes()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}T${HH}:${MM}`;
    };

    const t1 = normalizeTask({
      id: now(),
      name: "DBMS Assignment",
      subject: "DBMS",
      priority: 1,
      deadline: plusHours(30),
      duration: 2,
      status: "todo",
      dependencies: [],
      notes: "Complete first",
      order: 1,
    });
    const t2 = normalizeTask({
      id: now() + 1,
      name: "Study ADSA (Heap + PQ)",
      subject: "ADSA",
      priority: 1,
      deadline: plusHours(18),
      duration: 1.5,
      status: "in_progress",
      dependencies: [],
      notes: "",
      order: 2,
    });
    const t3 = normalizeTask({
      id: now() + 2,
      name: "Lab Record",
      subject: "OS Lab",
      priority: 2,
      deadline: plusHours(48),
      duration: 0.5,
      status: "todo",
      dependencies: [t1.id],
      notes: "Blocked until DBMS is done",
      order: 3,
    });
    const t4 = normalizeTask({
      id: now() + 3,
      name: "Revise Computer Networks",
      subject: "CN",
      priority: 3,
      deadline: plusHours(72),
      duration: 1,
      status: "todo",
      dependencies: [],
      notes: "",
      order: 4,
    });

    tasks = [t1, t2, t3, t4].filter(Boolean);
    saveTasks();
    clearNotice();
    renderAll();
  }

  // ----------------------------
  // Drag & drop (Task list order)
  // ----------------------------
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
      const fromIdx = ordered.findIndex((t) => t.id === dragId);
      const toIdx = ordered.findIndex((t) => t.id === overId);
      if (fromIdx < 0 || toIdx < 0) return;

      const [moved] = ordered.splice(fromIdx, 1);
      ordered.splice(toIdx, 0, moved);
      ordered.forEach((t, i) => (t.order = i + 1));
      tasks = ordered;
      saveTasks();
      renderAll();
    });
  }

  // ----------------------------
  // Drag & drop (Kanban status)
  // ----------------------------
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
      const t = tasks.find((x) => x.id === kanbanDragId);
      if (!t) return;
      t.status = status;
      t.completedAt = status === "completed" ? t.completedAt || now() : null;
      saveTasks();
      renderAll();
    });
  }

  // ----------------------------
  // Form time hint (12-hour)
  // ----------------------------
  function updateTimeHint() {
    const hint = $("taskTimeHint");
    if (!hint) return;
    hint.textContent = formatTimeTo12Hr($("taskTime").value);
  }

  // ----------------------------
  // Render all
  // ----------------------------
  function renderAll() {
    renderDashboard();
    renderTaskList();
    renderSortedReview();
    renderSchedule();
    renderKanban();
    renderNotifications();
    updateCharts();
  }

  // ----------------------------
  // Event binding
  // ----------------------------
  function bindEvents() {
    $("btnDarkMode").addEventListener("click", toggleDarkMode);
    $("btnAddSample").addEventListener("click", addSampleTasks);
    $("btnExportPdf").addEventListener("click", exportPdf);
    $("csvImportInput").addEventListener("change", importCsv);

    $("taskTime").addEventListener("input", updateTimeHint);
    $("taskTime").addEventListener("change", updateTimeHint);

    $("taskForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const task = createTaskFromForm();
      if (!task) return;
      clearNotice();
      addOrUpdateTask(task);
      clearForm();
    });
    $("btnClearForm").addEventListener("click", clearForm);

    $("btnGenerateSchedule").addEventListener("click", renderSchedule);

    // Filters/search
    for (const id of ["searchInput", "filterPriority", "filterSubject", "filterStatus", "filterDeadline"]) {
      $(id).addEventListener("input", renderAll);
      $(id).addEventListener("change", renderAll);
    }
    $("btnClearFilters").addEventListener("click", () => {
      $("searchInput").value = "";
      $("filterPriority").value = "";
      $("filterSubject").value = "";
      $("filterStatus").value = "";
      $("filterDeadline").value = "";
      renderAll();
    });

    // Card actions
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const id = Number(btn.dataset.id);
      if (!Number.isFinite(id)) return;

      if (action === "delete") deleteTask(id);
      if (action === "complete") completeTask(id);
      if (action === "edit") {
        const t = tasks.find((x) => x.id === id);
        if (t) fillForm(t);
      }
    });
  }

  // ----------------------------
  // Footer clock
  // ----------------------------
  function startClock() {
    const el = $("footerClock");
    if (!el) return;
    const tick = () => (el.textContent = new Date().toLocaleString());
    tick();
    setInterval(tick, 1000);
  }

  // ----------------------------
  // Init
  // ----------------------------
  loadSettings();
  applyTheme();
  loadTasks();
  bindNavbar();
  bindEvents();
  bindTaskListDnD();
  bindKanbanDnD();
  initCharts();
  updateTimeHint();
  renderAll();
  startClock();
});

