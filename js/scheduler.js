/**
 * scheduler.js (ADSA)
 * - Priority scheduling rules (CPU-like): priority -> deadline -> duration
 * - Priority Queue (binary heap)
 * - Heap-based schedule generation with dependency support
 *
 * Note: exposed via `window.SSP_SCHEDULER` so the app works without ES modules.
 */

const PRIORITY_MAP = {
  high: 1,
  medium: 2,
  low: 3,
};

function priorityLabel(p) {
  if (p === 1) return "High";
  if (p === 2) return "Medium";
  return "Low";
}

function normalizePriority(priorityLike) {
  if (typeof priorityLike === "number") return priorityLike;
  const key = String(priorityLike || "").toLowerCase();
  return PRIORITY_MAP[key] ?? 2;
}

function parseDependsOn(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function toTimestamp(deadline) {
  // deadline is expected to be an ISO string (from datetime-local).
  // If invalid, treat as far future.
  const t = Date.parse(deadline);
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/**
 * CPU-like priority scheduling comparator:
 * 1) smaller priority number first (High=1)
 * 2) if same priority -> earlier deadline first
 * 3) if same deadline -> shorter duration first
 */
function comparePriorityScheduling(a, b) {
  const pa = normalizePriority(a.priority);
  const pb = normalizePriority(b.priority);
  if (pa !== pb) return pa - pb;

  const da = toTimestamp(a.deadline);
  const db = toTimestamp(b.deadline);
  if (da !== db) return da - db;

  const ta = Number(a.duration) || 0;
  const tb = Number(b.duration) || 0;
  if (ta !== tb) return ta - tb;

  return (a.id ?? 0) - (b.id ?? 0);
}

/**
 * Priority Queue (min-heap).
 * Used for heap-based scheduling: always pop the "highest" (smallest key) task.
 */
class PriorityQueue {
  constructor(compareFn) {
    this._compare = compareFn;
    this._heap = [];
  }

  size() {
    return this._heap.length;
  }

  peek() {
    return this._heap[0] ?? null;
  }

  push(item) {
    this._heap.push(item);
    this._siftUp(this._heap.length - 1);
  }

  pop() {
    const n = this._heap.length;
    if (n === 0) return null;
    if (n === 1) return this._heap.pop();
    const root = this._heap[0];
    this._heap[0] = this._heap.pop();
    this._siftDown(0);
    return root;
  }

  _siftUp(i) {
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this._compare(this._heap[i], this._heap[p]) >= 0) break;
      [this._heap[i], this._heap[p]] = [this._heap[p], this._heap[i]];
      i = p;
    }
  }

  _siftDown(i) {
    const n = this._heap.length;
    while (true) {
      const l = i * 2 + 1;
      const r = l + 1;
      let best = i;

      if (l < n && this._compare(this._heap[l], this._heap[best]) < 0) best = l;
      if (r < n && this._compare(this._heap[r], this._heap[best]) < 0) best = r;
      if (best === i) break;
      [this._heap[i], this._heap[best]] = [this._heap[best], this._heap[i]];
      i = best;
    }
  }
}

function canRunTask(task, completedIds) {
  const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  return deps.every((id) => completedIds.has(id));
}

/**
 * Heap-based daily schedule generator.
 *
 * Strategy:
 * - Consider tasks that are not completed
 * - Respect dependencies: only schedule if dependencies are completed OR also scheduled earlier today
 * - If there is a dependency cycle / missing dependency, the task is marked "blocked" and appended last
 */
function generateDailySchedule(tasks, startTimeHHMM = "08:00") {
  const pending = tasks.filter((t) => t.status !== "completed");

  const completedIds = new Set(tasks.filter((t) => t.status === "completed").map((t) => t.id));
  const scheduledIds = new Set();

  const pq = new PriorityQueue(comparePriorityScheduling);
  const blocked = [];

  // Prime the queue with tasks that are runnable immediately.
  for (const t of pending) {
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    if (deps.length === 0 || deps.every((id) => completedIds.has(id))) pq.push(t);
    else blocked.push(t);
  }

  // Convert start HH:MM to minutes.
  const [hh, mm] = String(startTimeHHMM).split(":").map((x) => Number(x));
  let cursorMin = (Number.isFinite(hh) ? hh : 8) * 60 + (Number.isFinite(mm) ? mm : 0);

  const schedule = [];

  // Keep trying to schedule tasks. After each scheduled task, see if it unblocks others.
  while (pq.size() > 0) {
    const task = pq.pop();
    scheduledIds.add(task.id);

    const durationHrs = Math.max(0.25, Number(task.duration) || 0.25);
    const durationMin = Math.round(durationHrs * 60);

    const start = cursorMin;
    const end = cursorMin + durationMin;
    cursorMin = end;

    schedule.push({
      id: task.id,
      name: task.name,
      subject: task.subject,
      priority: normalizePriority(task.priority),
      startMin: start,
      endMin: end,
      durationHours: durationHrs,
      blocked: false,
    });

    // Re-check blocked tasks: if now runnable, push into heap.
    for (let i = blocked.length - 1; i >= 0; i--) {
      const bt = blocked[i];
      const deps = Array.isArray(bt.dependsOn) ? bt.dependsOn : [];
      const depsMet = deps.every((id) => completedIds.has(id) || scheduledIds.has(id));
      if (depsMet) {
        blocked.splice(i, 1);
        pq.push(bt);
      }
    }
  }

  // Remaining blocked tasks: schedule after, flagged as blocked (dependency issues / cycle).
  for (const task of blocked.sort(comparePriorityScheduling)) {
    const durationHrs = Math.max(0.25, Number(task.duration) || 0.25);
    const durationMin = Math.round(durationHrs * 60);

    const start = cursorMin;
    const end = cursorMin + durationMin;
    cursorMin = end;

    schedule.push({
      id: task.id,
      name: task.name,
      subject: task.subject,
      priority: normalizePriority(task.priority),
      startMin: start,
      endMin: end,
      durationHours: durationHrs,
      blocked: true,
    });
  }

  return schedule;
}

function formatMinToHHMM(totalMin) {
  const h = Math.floor(totalMin / 60) % 24;
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Expose for classic script usage
window.SSP_SCHEDULER = {
  PRIORITY_MAP,
  priorityLabel,
  normalizePriority,
  parseDependsOn,
  toTimestamp,
  comparePriorityScheduling,
  PriorityQueue,
  canRunTask,
  generateDailySchedule,
  formatMinToHHMM,
};

