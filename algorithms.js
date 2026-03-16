/**
 * algorithms.js (ADSA)
 * Implements classic sorting algorithms with step capture for visualization.
 *
 * Step format:
 * - { type: "compare", i, j, order }      compare indices i & j
 * - { type: "swap", i, j, order }         swap items at i & j
 * - { type: "overwrite", i, from, order } insertion sort shift/insert (from -> i)
 * - { type: "lock", i, order }            index i is in final position (best-effort)
 *
 * "order" is an array of task ids in current order (snapshot).
 *
 * Note: exposed via `window.SSP_ALGOS` so the app works without ES modules.
 */

const COMPLEXITY = {
  bubble: "O(n²)",
  selection: "O(n²)",
  insertion: "O(n)", // (shown per project requirement; best-case O(n), avg/worst O(n²))
};

function snapshotIds(arr) {
  return arr.map((x) => x.id);
}

function buildComparator(criteria) {
  // Tie-breakers ensure deterministic ordering for stable visualization.
  if (criteria === "deadline") {
    return (a, b) =>
      a.deadlineTs - b.deadlineTs ||
      a.priority - b.priority ||
      a.duration - b.duration ||
      a.id - b.id;
  }
  if (criteria === "duration") {
    return (a, b) =>
      a.duration - b.duration ||
      a.priority - b.priority ||
      a.deadlineTs - b.deadlineTs ||
      a.id - b.id;
  }
  // criteria === "priority" (default): priority scheduling mapping
  return (a, b) =>
    a.priority - b.priority ||
    a.deadlineTs - b.deadlineTs ||
    a.duration - b.duration ||
    a.id - b.id;
}

function prepareAlgoItems(tasks) {
  return tasks.map((t) => ({
    id: t.id,
    name: t.name,
    subject: t.subject,
    priority: Number(t.priority),
    deadlineTs: Number(t.deadlineTs),
    duration: Number(t.duration) || 0,
    status: t.status,
  }));
}

function bubbleSortSteps(items, compare) {
  const arr = items.slice();
  const steps = [];
  const n = arr.length;

  for (let i = 0; i < n; i++) {
    let swapped = false;
    for (let j = 0; j < n - i - 1; j++) {
      steps.push({ type: "compare", i: j, j: j + 1, order: snapshotIds(arr) });
      if (compare(arr[j], arr[j + 1]) > 0) {
        [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]];
        swapped = true;
        steps.push({ type: "swap", i: j, j: j + 1, order: snapshotIds(arr) });
      }
    }
    steps.push({ type: "lock", i: n - i - 1, order: snapshotIds(arr) });
    if (!swapped) {
      // If no swaps, the remaining prefix is already sorted.
      for (let k = 0; k < n - i - 1; k++) steps.push({ type: "lock", i: k, order: snapshotIds(arr) });
      break;
    }
  }
  return { steps, finalOrder: snapshotIds(arr) };
}

function selectionSortSteps(items, compare) {
  const arr = items.slice();
  const steps = [];
  const n = arr.length;

  for (let i = 0; i < n; i++) {
    let min = i;
    for (let j = i + 1; j < n; j++) {
      steps.push({ type: "compare", i: min, j, order: snapshotIds(arr) });
      if (compare(arr[j], arr[min]) < 0) min = j;
    }
    if (min !== i) {
      [arr[i], arr[min]] = [arr[min], arr[i]];
      steps.push({ type: "swap", i, j: min, order: snapshotIds(arr) });
    }
    steps.push({ type: "lock", i, order: snapshotIds(arr) });
  }
  return { steps, finalOrder: snapshotIds(arr) };
}

function insertionSortSteps(items, compare) {
  const arr = items.slice();
  const steps = [];
  const n = arr.length;

  for (let i = 1; i < n; i++) {
    const key = arr[i];
    let j = i - 1;

    // Compare and shift larger elements to the right.
    while (j >= 0) {
      steps.push({ type: "compare", i: j, j: j + 1, order: snapshotIds(arr) });
      if (compare(arr[j], key) <= 0) break;
      arr[j + 1] = arr[j];
      steps.push({ type: "overwrite", i: j + 1, from: j, order: snapshotIds(arr) });
      j--;
    }
    arr[j + 1] = key;
    steps.push({ type: "overwrite", i: j + 1, from: i, order: snapshotIds(arr) });
  }

  // Mark final "locks"
  for (let i = 0; i < n; i++) steps.push({ type: "lock", i, order: snapshotIds(arr) });
  return { steps, finalOrder: snapshotIds(arr) };
}

function getSortSteps(algorithm, tasksPrepared, criteria) {
  const items = tasksPrepared.slice();
  const compare = buildComparator(criteria);

  if (algorithm === "selection") return selectionSortSteps(items, compare);
  if (algorithm === "insertion") return insertionSortSteps(items, compare);
  return bubbleSortSteps(items, compare);
}

// Expose for classic script usage
window.SSP_ALGOS = {
  COMPLEXITY,
  buildComparator,
  prepareAlgoItems,
  bubbleSortSteps,
  selectionSortSteps,
  insertionSortSteps,
  getSortSteps,
};

