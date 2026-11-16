"use strict";

/* FrameForge dashboard.
 * Sections: helpers · API · session · data loading · rendering ·
 * thumbnails · file operations · uploads · jobs · admin · interaction. */

// ---------------------------------------------------------------- helpers
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const ACTIVE = ["queued", "downloading", "processing"];
const PAGE_SIZE = 120;            // cards added per scroll step
const THUMB_CONCURRENCY = 3;      // thumbnail requests in flight at once
const KEY_STORAGE = "frameforge_api_key";

const state = {
  dataset: [], jobs: [], health: null, role: null, keys: [], db: null,
  view: "overview", category: "all", jobFilter: "all", search: "", sort: "newest",
  selected: new Set(), anchorKey: null, focusedKey: null, limit: PAGE_SIZE,
  moveFiles: [], cutFiles: [], sourceJob: null, previewKey: null,
  confirmResolve: null, promptResolve: null,
};

const VIEW_LABELS = {
  overview: ["OPERATIONS", "Overview"],
  library: ["DATA MANAGEMENT", "Dataset library"],
  jobs: ["PIPELINE", "Processing jobs"],
  system: ["CONFIGURATION", "System & connection"],
};
const SYSTEM_CATEGORIES = {
  _downloads: { label: "Source videos", icon: "drive" },
  _temp: { label: "Temporary files", icon: "clock" },
};
const STATUS = {
  queued: ["Queued", "clock"], downloading: ["Downloading", "download"], processing: ["Processing", "loader"],
  completed: ["Completed", "check-circle"], partially_completed: ["Partly done", "alert"],
  awaiting_source: ["Needs source", "upload"], failed: ["Failed", "stop"], cancelled: ["Cancelled", "x"],
};

function icon(name) { return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`; }
function iconButton(name, tip, attrs = "", cls = "") {
  return `<button type="button" class="icon-btn ${cls}" ${attrs} data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">${icon(name)}</button>`;
}
function escapeHtml(value = "") { const node = document.createElement("div"); node.textContent = String(value); return node.innerHTML.replace(/"/g, "&quot;"); }
function bytes(value = 0) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"], i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}
// File times arrive as epoch seconds; database times as UTC strings without a zone suffix.
function toDate(value) {
  if (typeof value === "number") return new Date(value * 1000);
  return new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(value) ? value : value + "Z");
}
function date(value) {
  if (!value) return "—";
  const parsed = toDate(value);
  if (isNaN(parsed)) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(parsed);
}
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);
function isTextEntry(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && !NON_TEXT_INPUTS.has((el.type || "text").toLowerCase());
}
function plural(count, word) { return `${count} ${word}${count === 1 ? "" : "s"}`; }
function isVideo(file) { return /\.(mp4|mkv|webm|ts|avi|mov|m4v)$/i.test(file.filename); }
function isSystemCategory(name) { return name.startsWith("_"); }
function categoryLabel(cat) { return SYSTEM_CATEGORIES[cat.name]?.label || cat.display_name || cat.name; }
function fileKey(file) { return `${encodeURIComponent(file.category)}/${encodeURIComponent(file.filename)}`; }
function splitName(filename) { const dot = filename.lastIndexOf("."); return dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ""]; }

function toast(message, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === "error" ? "alert" : kind === "warn" ? "alert" : "check")}<span></span>`;
  el.lastChild.textContent = message;
  $("#toastStack").append(el);
  setTimeout(() => el.remove(), kind === "ok" ? 3200 : 6000);
}
function empty(iconName, title, message) {
  return `<div class="empty">${icon(iconName)}<strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
}
function progressBar(value = 0) {
  const safe = Math.max(0, Math.min(100, value));
  return `<div class="progress" title="${safe}%"><i style="width:${safe}%"></i></div>`;
}
function pill(status) {
  const [label, iconName] = STATUS[status] || [status, "clock"];
  return `<span class="pill ${escapeHtml(status)}">${icon(iconName)}${escapeHtml(label)}</span>`;
}

// ------------------------------------------------------------------- API
function apiKey() { return localStorage.getItem(KEY_STORAGE) || ""; }
function authHeaders() { return apiKey() ? { "X-API-Key": apiKey() } : {}; }

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  let body = null;
  if ((response.headers.get("content-type") || "").includes("json")) body = await response.json();
  if (!response.ok) {
    const detail = body?.detail;
    const message = typeof detail === "string" ? detail
      : detail?.message || (Array.isArray(detail) ? detail.map(item => item.msg).join("; ") : "");
    throw Object.assign(new Error(message || `Request failed (${response.status})`), { status: response.status, detail });
  }
  return body;
}
function postJson(url, payload, method = "POST") {
  return request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

// Exchanges the key for an HttpOnly cookie so <video>, <img> and download links can load files.
async function ensureSession() {
  if (!apiKey()) { state.role = null; return false; }
  try { state.role = (await request("/api/v1/auth/session", { method: "POST" })).role; return true; }
  catch { state.role = null; return false; }
}

// ---------------------------------------------------------- data loading
async function loadAll(showToast = false) {
  $("#refreshButton").classList.add("spinning");
  const signedIn = await ensureSession();
  const [datasetResult, healthResult] = await Promise.allSettled([
    signedIn ? request("/api/v1/dataset/") : Promise.resolve({ categories: [] }),
    request("/api/v1/health"),
  ]);
  if (datasetResult.status === "fulfilled") state.dataset = datasetResult.value.categories || [];
  else { state.dataset = []; if (datasetResult.reason.status !== 401) toast(datasetResult.reason.message, "error"); }
  state.health = healthResult.status === "fulfilled" ? healthResult.value : null;
  await loadJobs(false);
  await loadAdmin();
  renderAll();
  $("#lastSync").textContent = `Synced ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  $("#refreshButton").classList.remove("spinning");
  if (showToast) toast("Refreshed");
}
async function loadDataset() {
  state.dataset = (await request("/api/v1/dataset/")).categories || [];
  pruneSelection();
  renderOverview(); renderCategories(); renderLibrary();
}
async function loadJobs(render = true) {
  if (!state.role) { state.jobs = []; }
  else {
    try { state.jobs = await request("/api/v1/jobs?limit=100"); }
    catch (error) { state.jobs = []; if (error.status !== 401) toast(error.message, "error"); }
  }
  if (render) { renderOverview(); renderJobs(); }
}
async function loadAdmin() {
  state.keys = []; state.db = null;
  if (state.role === "admin") {
    try { [state.keys, state.db] = await Promise.all([request("/api/v1/keys"), request("/api/v1/system/database")]); }
    catch (error) { toast(error.message, "error"); }
  }
  renderAdmin();
}

// -------------------------------------------------------------- selectors
function allFiles() {
  return state.dataset.flatMap(cat => cat.videos.map(video => ({ ...video, category: cat.name, displayCategory: categoryLabel(cat) })));
}
function findFile(key) { return allFiles().find(file => fileKey(file) === key); }
function filteredFiles() {
  const files = allFiles().filter(file =>
    (state.category === "all" ? file.category !== "_temp" : file.category === state.category) &&
    (!state.search || `${file.filename} ${file.displayCategory}`.toLowerCase().includes(state.search)));
  const order = {
    oldest: (a, b) => a.created_at - b.created_at,
    largest: (a, b) => b.size - a.size,
    name: (a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }),
    newest: (a, b) => b.created_at - a.created_at,
  };
  return files.sort(order[state.sort] || order.newest);
}
function selectedFiles() { return [...state.selected].map(findFile).filter(Boolean); }
function pruneSelection() {
  const existing = new Set(allFiles().map(fileKey));
  state.selected = new Set([...state.selected].filter(key => existing.has(key)));
}

// -------------------------------------------------------------- rendering
function setView(view) {
  state.view = view;
  $$(".view").forEach(el => el.classList.toggle("active", el.id === `view-${view}`));
  $$(".nav").forEach(el => el.classList.toggle("active", el.dataset.view === view));
  $("#pageEyebrow").textContent = VIEW_LABELS[view][0];
  $("#pageTitle").textContent = VIEW_LABELS[view][1];
  if (location.hash.slice(1) !== view) history.replaceState(null, "", `#${view}`);
  $("#sidebar").classList.remove("open");
  if (view === "jobs") loadJobs();
}
function renderAll() { renderConnection(); renderOverview(); renderCategories(); renderLibrary(); renderJobs(); renderHealth(); }

function renderConnection() {
  const healthy = state.health?.status === "healthy";
  $("#connectionDot").className = healthy ? "healthy" : state.health ? "degraded" : "";
  $("#connectionLabel").textContent = healthy ? "Service online" : state.health ? "Service degraded" : "Service unavailable";
  $("#connectionDetail").textContent = healthy ? "Pipeline is responding" : state.health ? "Review runtime checks" : "Connection failed";
  $("#authNotice").hidden = Boolean(state.role) || state.view === "system";
  $("#connectionStatus").innerHTML = state.role
    ? `${icon("check-circle")}<span>Connected as ${state.role === "admin" ? "administrator" : "client"}</span>`
    : apiKey() ? `${icon("alert")}<span>This key was not accepted</span>` : "";
  $("#connectionStatus").className = `status-line ${state.role ? "ok" : "bad"}`;
}

function renderOverview() {
  const files = allFiles().filter(file => !isSystemCategory(file.category));
  const categories = state.dataset.filter(cat => !isSystemCategory(cat.name));
  const active = state.jobs.filter(job => ACTIVE.includes(job.status)).length;
  const needs = state.jobs.filter(job => job.status === "awaiting_source").length;
  $("#navLibraryCount").textContent = files.length;
  $("#navJobsCount").textContent = active + needs;

  const cards = [
    ["Dataset clips", files.length, "film", "library"], ["Categories", categories.length, "folder", "library"],
    ["Active jobs", active, "activity", "jobs"], ["Need a source", needs, "upload", "jobs"],
  ];
  $("#metricGrid").innerHTML = cards.map(([name, value, iconName, go]) =>
    `<button class="metric" data-go="${go}"><span><small>${name}</small><strong>${value}</strong></span><i>${icon(iconName)}</i></button>`).join("");

  const recent = state.jobs.slice(0, 6);
  $("#recentJobs").innerHTML = recent.length
    ? recent.map(job => `<div class="job-row"><div><strong>${escapeHtml(sourceLabel(job))}</strong><small>${escapeHtml(job.job_id)} · ${plural(job.segments_count, "segment")}</small></div>${pill(job.status)}${progressBar(job.progress)}<small>${date(job.created_at)}</small></div>`).join("")
    : empty("activity", state.role ? "No jobs yet" : "Not connected", state.role ? "Jobs submitted from the extension appear here." : "Add the API key to see pipeline activity.");

  const top = [...categories].sort((a, b) => b.videos.length - a.videos.length).slice(0, 7);
  const max = Math.max(...top.map(cat => cat.videos.length), 1);
  $("#categorySummary").innerHTML = top.length
    ? top.map(cat => `<button class="category-line" data-open-category="${escapeHtml(cat.name)}"><div><span>${escapeHtml(categoryLabel(cat))}</span><small>${plural(cat.videos.length, "clip")}</small></div><i style="width:${cat.videos.length / max * 100}%"></i></button>`).join("")
    : empty("folder", "No output yet", "Completed segments are grouped here.");
}

function renderCategories() {
  const visibleTotal = allFiles().filter(file => file.category !== "_temp").length;
  const row = (name, label, iconName, count, droppable) =>
    `<button class="category-button ${state.category === name ? "active" : ""}" data-category="${escapeHtml(name)}" ${droppable ? "data-droppable" : ""}>${icon(iconName)}<span>${escapeHtml(label)}</span><em>${count}</em></button>`;
  const dataset = state.dataset.filter(cat => !isSystemCategory(cat.name)).sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
  const system = state.dataset.filter(cat => isSystemCategory(cat.name));
  $("#categoryRail").innerHTML = [
    row("all", "All files", "grid", visibleTotal, false),
    ...dataset.map(cat => row(cat.name, categoryLabel(cat), "folder", cat.videos.length, true)),
    system.length ? `<div class="rail-divider"></div>` : "",
    ...system.map(cat => row(cat.name, categoryLabel(cat), SYSTEM_CATEGORIES[cat.name]?.icon || "folder", cat.videos.length, cat.name === "_downloads")),
  ].join("");
}

function cardHtml(file) {
  const key = fileKey(file), selected = state.selected.has(key);
  const thumb = !file.thumb ? ""
    : file.thumb_ready
      ? `<img alt="" draggable="false" loading="lazy" decoding="async" class="ready" src="${escapeHtml(file.thumb)}">`
      : `<img alt="" draggable="false" data-thumb="${escapeHtml(file.thumb)}">`;
  return `<article class="file-card ${selected ? "selected" : ""}" data-key="${escapeHtml(key)}" tabindex="${state.focusedKey === key ? "0" : "-1"}" draggable="true" aria-selected="${selected}">
    <div class="file-thumb" data-action="preview">${thumb}<span class="file-placeholder">${icon(isVideo(file) ? "film" : "file")}</span>${isVideo(file) ? `<b class="play-badge">${icon("play")}</b>` : ""}</div>
    <label class="file-select"><input type="checkbox" data-action="select" ${selected ? "checked" : ""} aria-label="Select ${escapeHtml(file.filename)}"><span>${icon("check")}</span></label>
    <div class="file-tools">
      ${iconButton("download", "Download", 'data-action="download"', "small")}
      ${iconButton("pencil", "Rename (F2)", 'data-action="rename"', "small")}
      ${iconButton("move", "Move (M)", 'data-action="move"', "small")}
      ${iconButton("trash", "Delete (Del)", 'data-action="delete"', "small danger")}
    </div>
    <div class="file-info"><strong class="file-name" title="${escapeHtml(file.filename)}">${escapeHtml(file.filename)}</strong><small>${escapeHtml(file.displayCategory)} · ${bytes(file.size)} · ${date(file.created_at)}</small></div>
  </article>`;
}

function renderLibrary() {
  const files = filteredFiles();
  const current = state.dataset.find(cat => cat.name === state.category);
  $("#libraryHeading").textContent = state.category === "all" ? "All files" : current ? categoryLabel(current) : state.category;
  $("#libraryCount").textContent = plural(files.length, "item");
  $("#zipCategory").hidden = !current || isSystemCategory(current.name) || !current.videos.length;
  if (!files.some(file => fileKey(file) === state.focusedKey)) state.focusedKey = files.length ? fileKey(files[0]) : null;

  const grid = $("#fileGrid");
  grid.innerHTML = files.length
    ? files.slice(0, state.limit).map(cardHtml).join("")
    : state.role
      ? empty("folder", state.search ? "Nothing matches your search" : "This folder is empty", state.search ? "Try a different name." : "Drop videos here or drag clips onto a category.")
      : empty("key", "Not connected", "Add the API key under System & connection.");
  $("#gridSentinel").hidden = files.length <= state.limit;
  observeThumbnails(grid);
  updateSelectionUi();
}

// Selection changes only toggle classes; the grid (and its loaded images) is not rebuilt.
function updateSelectionUi() {
  $$(".file-card").forEach(card => {
    const selected = state.selected.has(card.dataset.key);
    card.classList.toggle("selected", selected);
    card.classList.toggle("cut", state.cutFiles.some(file => fileKey(file) === card.dataset.key));
    card.setAttribute("aria-selected", selected);
    card.tabIndex = state.focusedKey === card.dataset.key ? 0 : -1;
    $("input[data-action=select]", card).checked = selected;
  });
  $("#selectionBar").hidden = !state.selected.size;
  $("#selectionCount").textContent = `${state.selected.size} selected`;
}

function sourceLabel(job) { try { return new URL(job.page_url || job.media_url).hostname; } catch { return job.media_type || "Media source"; } }

function renderJobs() {
  const jobs = state.jobs.filter(job => state.jobFilter === "all" || (state.jobFilter === "processing" ? ACTIVE.includes(job.status) : state.jobFilter === "failed" ? ["failed", "partially_completed", "cancelled"].includes(job.status) : job.status === state.jobFilter));
  $("#jobsTable").innerHTML = jobs.length
    ? jobs.map(job => `<tr data-job="${escapeHtml(job.job_id)}">
        <td class="source-cell"><strong title="${escapeHtml(job.page_url)}">${escapeHtml(sourceLabel(job))}</strong><small>${escapeHtml(job.job_id)} · ${escapeHtml(job.media_type)}</small></td>
        <td>${pill(job.status)}</td>
        <td>${job.segments_count}</td>
        <td class="progress-cell">${progressBar(job.progress)}<small>${job.progress}%</small>${job.error ? `<small class="job-note" title="${escapeHtml(job.error)}">${escapeHtml(job.error)}</small>` : ""}</td>
        <td>${date(job.created_at)}</td>
        <td><div class="row-actions">
          ${job.source_required ? iconButton("upload", "Upload source video", 'data-job-action="source"', "small primary") : ""}
          ${ACTIVE.includes(job.status) ? iconButton("stop", "Cancel job", 'data-job-action="cancel"', "small") : ""}
          ${iconButton("trash", "Delete job and its files", 'data-job-action="delete"', "small danger")}
        </div></td></tr>`).join("")
    : `<tr><td colspan="6">${empty("activity", state.role ? "No matching jobs" : "Not connected", state.role ? "Try a different filter." : "Add the API key under System & connection.")}</td></tr>`;
}

function renderHealth() {
  const health = state.health || {};
  const checks = [
    ["API service", health.status || "unavailable", health.status === "healthy"],
    ["Database", health.database || "unknown", health.database === "writable"],
    ["FFmpeg", health.ffmpeg || "unknown", health.ffmpeg === "available"],
    ["FFprobe", health.ffprobe || "unknown", health.ffprobe === "available"],
    ["Storage", health.storage || "unknown", health.storage === "writable"],
    ["Accurate cutting", health.accurate_cutting ? "enabled" : "disabled", health.accurate_cutting === true],
  ];
  $("#healthChecks").innerHTML = checks.map(([name, value, ok]) =>
    `<div class="health-item ${ok ? "ok" : "bad"}"><span>${name}</span><span>${icon(ok ? "check-circle" : "alert")}${escapeHtml(value)}</span></div>`).join("");
}

function renderAdmin() {
  const admin = state.role === "admin";
  $("#keysPanel").hidden = !state.role;
  $("#dbPanel").hidden = !admin;
  $("#keyForm").hidden = !admin;
  $("#adminHint").hidden = admin;
  if (!admin) { $("#keysList").innerHTML = ""; $("#newKeyBox").hidden = true; return; }
  $("#keysList").innerHTML = state.keys.length
    ? state.keys.map(key => `<div class="key-row" data-key-id="${escapeHtml(key.id)}">${icon("key")}<div><strong>${escapeHtml(key.name)}</strong><small>${escapeHtml(key.prefix)}… · created ${date(key.created_at)} · ${key.last_used_at ? `last used ${date(key.last_used_at)}` : "never used"}</small></div>${iconButton("trash", "Revoke key", "data-revoke-key", "small danger")}</div>`).join("")
    : empty("key", "No client keys yet", "Generate one and paste it into the extension settings.");
  const db = state.db;
  $("#dbSummary").textContent = db ? `${plural(db.jobs, "job")} · ${plural(db.segments, "segment")} · ${plural(db.categories, "label")}${db.size != null ? ` · ${bytes(db.size)}` : ""}` : "";
  $("#dbDownload").disabled = !db?.downloadable;
}

// ------------------------------------------------------------- thumbnails
// Images load only when their card scrolls into view, a few at a time, so a
// large folder never floods the server with thumbnail jobs.
const thumbQueue = [];
const loadedThumbs = new Set();
let thumbsInFlight = 0;

const thumbObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const img = entry.target;
    if (entry.isIntersecting) { if (!thumbQueue.includes(img)) thumbQueue.push(img); }
    else { const index = thumbQueue.indexOf(img); if (index >= 0) thumbQueue.splice(index, 1); }
  }
  pumpThumbnails();
}, { rootMargin: "300px" });

function observeThumbnails(root) {
  thumbQueue.length = 0;
  $$("img[data-thumb]", root).forEach(img => {
    if (loadedThumbs.has(img.dataset.thumb)) { showThumbnail(img); return; }  // already in the browser cache
    thumbObserver.observe(img);
  });
}
function showThumbnail(img) {
  img.src = img.dataset.thumb;
  img.addEventListener("load", () => img.classList.add("ready"), { once: true });
  if (img.complete && img.naturalWidth) img.classList.add("ready");
}
function pumpThumbnails() {
  while (thumbsInFlight < THUMB_CONCURRENCY && thumbQueue.length) {
    const img = thumbQueue.shift();
    thumbObserver.unobserve(img);
    if (!img.isConnected) continue;
    thumbsInFlight++;
    const done = ok => { thumbsInFlight--; if (ok) { loadedThumbs.add(img.dataset.thumb); img.classList.add("ready"); } else img.remove(); pumpThumbnails(); };
    img.addEventListener("load", () => done(true), { once: true });
    img.addEventListener("error", () => done(false), { once: true });
    img.src = img.dataset.thumb;
  }
}
new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting) && filteredFiles().length > state.limit) { state.limit += PAGE_SIZE; renderLibrary(); }
}, { rootMargin: "600px" }).observe($("#gridSentinel"));

// --------------------------------------------------------- file operations
function downloadFile(file) {
  const a = document.createElement("a");
  a.href = file.url; a.download = file.filename;
  document.body.append(a); a.click(); a.remove();
}
function removeLocally(files) {
  const keys = new Set(files.map(fileKey));
  state.dataset.forEach(cat => { cat.videos = cat.videos.filter(video => !keys.has(fileKey({ ...video, category: cat.name }))); });
  state.dataset = state.dataset.filter(cat => isSystemCategory(cat.name) || cat.videos.length || cat.name === state.category);
  keys.forEach(key => state.selected.delete(key));
}
async function deleteFiles(files) {
  files = files.filter(Boolean);
  if (!files.length) return false;
  const what = files.length === 1 ? `"${files[0].filename}"` : plural(files.length, "file");
  if (!await confirmAction("Delete permanently?", `${what} will be removed from the server. This cannot be undone.`)) return false;
  try {
    await postJson("/api/v1/dataset/bulk/delete", { files: files.map(({ category, filename }) => ({ category, filename })) });
    removeLocally(files);
    renderOverview(); renderCategories(); renderLibrary();
    toast(`Deleted ${what}`);
    loadDataset().catch(() => {});
    return true;
  } catch (error) { toast(error.message, "error"); loadDataset().catch(() => {}); return false; }
}
async function moveFiles(files, category) {
  files = files.filter(file => file && file.category !== category);
  if (!files.length) return;
  try {
    await postJson("/api/v1/dataset/bulk/move", { files: files.map(({ category: from, filename }) => ({ category: from, filename })), new_category: category });
    state.selected.clear(); state.cutFiles = [];
    await loadDataset();
    toast(`Moved ${plural(files.length, "file")} to ${categoryLabel(state.dataset.find(cat => cat.name === category) || { name: category })}`);
  } catch (error) { toast(error.message, "error"); loadDataset().catch(() => {}); }
}
async function renameFile(file, newName) {
  newName = newName.trim();
  if (!newName) return false;
  const [, extension] = splitName(file.filename);
  if (extension && !newName.toLowerCase().endsWith(extension.toLowerCase())) newName += extension;  // keep the type
  if (newName === file.filename) return true;
  if (/[\\/]/.test(newName)) { toast("A name cannot contain / or \\", "error"); return false; }
  try {
    await postJson("/api/v1/dataset/move", { old_category: file.category, old_filename: file.filename, new_category: file.category, new_filename: newName });
    const renamed = fileKey({ category: file.category, filename: newName });
    if (state.selected.delete(fileKey(file))) state.selected.add(renamed);
    state.focusedKey = renamed;
    await loadDataset();
    return true;
  } catch (error) { toast(error.message, "error"); return false; }
}
// Inline rename on the card, like a file manager: Enter saves, Esc cancels.
function startRename(key) {
  const card = document.querySelector(`.file-card[data-key="${CSS.escape(key)}"]`), file = findFile(key);
  if (!card || !file || $(".rename-input", card)) return;
  const label = $(".file-name", card), input = document.createElement("input");
  const [stem] = splitName(file.filename);
  input.className = "rename-input"; input.value = file.filename; input.maxLength = 255; input.setAttribute("aria-label", "New name");
  label.replaceWith(input); card.draggable = false;
  input.focus(); input.setSelectionRange(0, stem.length);
  let finished = false;
  const finish = async save => {
    if (finished) return; finished = true;
    if (save && await renameFile(file, input.value)) return;       // success re-renders the grid
    input.replaceWith(label); card.draggable = true; card.focus();
  };
  input.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Enter") { event.preventDefault(); finish(true); }
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  ["click", "dblclick", "mousedown"].forEach(type => input.addEventListener(type, event => event.stopPropagation()));
}
function openMove(files) {
  files = files.filter(Boolean);
  if (!files.length) return;
  state.moveFiles = files;
  $("#moveTitle").textContent = `Move ${plural(files.length, "file")}`;
  $("#moveChips").innerHTML = state.dataset.filter(cat => !isSystemCategory(cat.name))
    .map(cat => `<button type="button" class="chip" data-move-to="${escapeHtml(cat.name)}">${icon("folder")}${escapeHtml(categoryLabel(cat))}</button>`).join("");
  $("#moveCategory").value = "";
  $("#moveModal").hidden = false;
  $("#moveCategory").focus();
}
async function createCategory() {
  const name = await promptText("NEW CATEGORY", "Create category", "", "Category name");
  if (!name) return;
  try {
    const created = await postJson("/api/v1/dataset/category", { name: name.trim().replace(/\s+/g, "_") });
    state.category = created.name; state.selected.clear(); state.limit = PAGE_SIZE;
    await loadDataset();
    toast("Category created");
  } catch (error) { toast(error.message, "error"); }
}

// Preview
function previewFile(file) {
  if (!file) return;
  if (!isVideo(file)) { downloadFile(file); return; }
  state.previewKey = fileKey(file);
  $("#previewCategory").textContent = file.displayCategory;
  $("#previewTitle").textContent = file.filename;
  $("#previewVideo").src = file.url;
  $("#previewMeta").innerHTML = `<span>${bytes(file.size)}</span><span>${date(file.created_at)}</span>`;
  $("#previewModal").hidden = false;
  $("#previewVideo").play().catch(() => {});
}
function stepPreview(delta) {
  const files = filteredFiles().filter(isVideo), index = files.findIndex(file => fileKey(file) === state.previewKey);
  if (index < 0 || !files.length) return;
  previewFile(files[(index + delta + files.length) % files.length]);
}
function closeModal(id) {
  if (id === "previewModal") { $("#previewVideo").pause(); $("#previewVideo").removeAttribute("src"); $("#previewVideo").load(); state.previewKey = null; }
  if (id === "promptModal") { state.promptResolve?.(null); state.promptResolve = null; }
  if (id === "confirmModal") { state.confirmResolve?.(false); state.confirmResolve = null; }
  $("#" + id).hidden = true;
}
function confirmAction(title, message) {
  $("#confirmTitle").textContent = title; $("#confirmMessage").textContent = message; $("#confirmModal").hidden = false;
  $("[data-confirm=ok]").focus();
  return new Promise(resolve => { state.confirmResolve = resolve; });
}
function promptText(eyebrow, title, value, placeholder) {
  $("#promptEyebrow").textContent = eyebrow; $("#promptTitle").textContent = title;
  $("#promptInput").value = value; $("#promptInput").placeholder = placeholder;
  $("#promptModal").hidden = false; $("#promptInput").focus();
  return new Promise(resolve => { state.promptResolve = resolve; });
}

// ---------------------------------------------------------------- uploads
let activeUploads = 0;
window.addEventListener("beforeunload", event => { if (activeUploads > 0) { event.preventDefault(); event.returnValue = ""; } });

function progressToast(label) {
  const el = document.createElement("div");
  el.className = "toast sticky";
  el.innerHTML = `${icon("upload")}<span></span><div class="progress"><i></i></div>`;
  $("span", el).textContent = label;
  $("#toastStack").append(el);
  return {
    update(text, pct) { $("span", el).textContent = text; $("i", el).style.width = `${Math.max(0, Math.min(100, pct))}%`; },
    done() { el.remove(); },
  };
}
// Sends the file in chunks; after a dropped connection it asks the server how much arrived and continues from there.
async function chunkedUpload(file, jobId, onProgress) {
  const session = await postJson("/api/v1/uploads", { filename: file.name, size: file.size, job_id: jobId || null });
  const id = session.upload_id, chunkSize = session.chunk_size || 8388608;
  let offset = 0, failures = 0;
  try {
    while (offset < file.size) {
      try {
        const result = await request(`/api/v1/uploads/${id}?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, offset + chunkSize) });
        offset = result.received; failures = 0; onProgress(offset, file.size, false);
      } catch (error) {
        if ([401, 403, 404, 413, 415].includes(error.status)) throw error;
        if (typeof error.detail?.received === "number") { offset = error.detail.received; continue; }
        if (++failures > 8) throw new Error(`Upload interrupted: ${error.message}`);
        await sleep(Math.min(1000 * 2 ** failures, 15000));
        try { offset = (await request(`/api/v1/uploads/${id}`)).received; } catch (inner) { if (inner.status === 404) throw inner; }
      }
    }
    onProgress(file.size, file.size, true);
    return await request(`/api/v1/uploads/${id}/complete`, { method: "POST" });
  } catch (error) { request(`/api/v1/uploads/${id}`, { method: "DELETE" }).catch(() => {}); throw error; }
}
async function uploadWithProgress(file, jobId, label) {
  const indicator = progressToast(label); activeUploads++;
  try {
    return await chunkedUpload(file, jobId, (sent, total, verifying) =>
      indicator.update(verifying ? `Verifying ${file.name}…` : `${label} · ${bytes(sent)} / ${bytes(total)}`, sent / total * 100));
  } finally { activeUploads--; indicator.done(); }
}
async function uploadVideos(fileList) {
  const files = [...fileList].filter(file => isVideo({ filename: file.name }));
  if (!files.length) { toast("Only video files can be uploaded", "error"); return; }
  if (!state.role) { toast("Add the API key first", "error"); setView("system"); return; }
  let added = 0;
  for (const file of files) {
    try { await uploadWithProgress(file, null, file.name); added++; }
    catch (error) { toast(`${file.name}: ${error.message}`, "error"); }
  }
  if (!added) return;
  state.category = "_downloads"; state.limit = PAGE_SIZE;
  await loadDataset(); setView("library");
  toast(`${plural(added, "video")} verified and added to source videos`);
}

// ------------------------------------------------------------------- jobs
async function jobAction(jobId, action) {
  if (action === "source") { state.sourceJob = jobId; $("#jobSourceUpload").click(); return; }
  const deleting = action === "delete";
  if (!await confirmAction(deleting ? "Delete job?" : "Cancel job?", deleting ? "The job, its downloaded source and every clip it produced are removed." : "Processing stops; clips already produced are kept.")) return;
  try {
    await request(`/api/v1/jobs/${encodeURIComponent(jobId)}${deleting ? "" : "/cancel"}`, { method: deleting ? "DELETE" : "POST" });
    await loadJobs();
    if (deleting) loadDataset().catch(() => {});
    toast(deleting ? "Job deleted" : "Job cancelled");
  } catch (error) { toast(error.message, "error"); }
}

// ------------------------------------------------------------------ admin
async function downloadDatabase() {
  try {
    const response = await fetch("/api/v1/system/database/download", { headers: authHeaders() });
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const name = /filename="?([^";]+)"?/.exec(response.headers.get("content-disposition") || "")?.[1] || "tagger.db";
    const url = URL.createObjectURL(await response.blob()), a = document.createElement("a");
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) { toast(error.message, "error"); }
}
async function resetDatabase() {
  if (!await confirmAction("Reset the job database?", "All jobs, segments and labels are erased and running jobs are cancelled. Video files and client keys are kept. Download a backup first if you may need it.")) return;
  try {
    const result = await postJson("/api/v1/system/database/reset", { confirm: "RESET" });
    await loadAll();
    toast(`Database reset — ${plural(result.deleted_jobs, "job")} removed`);
  } catch (error) { toast(error.message, "error"); }
}

// ------------------------------------------------------------ interaction
function selectOnly(key) { state.selected = new Set([key]); state.anchorKey = key; state.focusedKey = key; }
function selectAllVisible() { state.selected = new Set(filteredFiles().map(fileKey)); updateSelectionUi(); }
function openCategory(name) {
  state.category = name; state.selected.clear(); state.limit = PAGE_SIZE; state.focusedKey = null;
  renderCategories(); renderLibrary();
}

function fileAction(action, key) {
  const file = findFile(key);
  if (!file) return;
  // Bulk actions apply to the whole selection when the target is part of it.
  const targets = state.selected.has(key) && state.selected.size > 1 ? selectedFiles() : [file];
  if (action === "preview") previewFile(file);
  if (action === "download") targets.forEach(downloadFile);
  if (action === "rename") startRename(key);
  if (action === "move") openMove(targets);
  if (action === "delete") deleteFiles(targets);
}

document.addEventListener("click", async event => {
  hideContextMenu();
  const target = event.target;

  const go = target.closest("[data-view],[data-go]");
  if (go) { setView(go.dataset.view || go.dataset.go); renderConnection(); return; }
  if (target.closest("#mobileMenu")) { $("#sidebar").classList.toggle("open"); return; }
  const openCat = target.closest("[data-open-category]");
  if (openCat) { setView("library"); openCategory(openCat.dataset.openCategory); return; }
  const category = target.closest("[data-category]");
  if (category) { openCategory(category.dataset.category); return; }
  const close = target.closest("[data-close]");
  if (close) { closeModal(close.dataset.close); return; }
  if (target.classList.contains("modal")) { closeModal(target.id); return; }  // backdrop click

  const chip = target.closest("[data-move-to]");
  if (chip) { closeModal("moveModal"); moveFiles(state.moveFiles, chip.dataset.moveTo); return; }

  const menuItem = target.closest("[data-menu-action]");
  if (menuItem) { fileAction(menuItem.dataset.menuAction, menuItem.dataset.key); return; }

  const card = target.closest(".file-card");
  const action = target.closest("[data-action]")?.dataset.action;
  if (card && action === "select") {
    const key = card.dataset.key;
    state.selected.has(key) ? state.selected.delete(key) : state.selected.add(key);
    state.anchorKey = key; state.focusedKey = key; updateSelectionUi(); card.focus({ preventScroll: true }); return;
  }
  if (card && action && action !== "preview") { fileAction(action, card.dataset.key); return; }
  if (card) {
    const keys = filteredFiles().map(fileKey), key = card.dataset.key;
    if (event.shiftKey && state.anchorKey) {
      const a = keys.indexOf(state.anchorKey), b = keys.indexOf(key);
      if (a >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.selected.add(keys[i]);
    } else if (event.ctrlKey || event.metaKey) {
      state.selected.has(key) ? state.selected.delete(key) : state.selected.add(key); state.anchorKey = key;
    } else selectOnly(key);
    state.focusedKey = key; updateSelectionUi(); card.focus({ preventScroll: true }); return;
  }
  if (target.closest("#filesPane") && !target.closest("button,input,select,label") && state.selected.size) { state.selected.clear(); updateSelectionUi(); return; }

  const bulk = target.closest("[data-bulk]")?.dataset.bulk;
  if (bulk) {
    const files = selectedFiles();
    if (bulk === "select-all") selectAllVisible();
    if (bulk === "clear") { state.selected.clear(); updateSelectionUi(); }
    if (bulk === "download") files.forEach(downloadFile);
    if (bulk === "move") openMove(files);
    if (bulk === "delete") deleteFiles(files);
    return;
  }
  const filter = target.closest("[data-status]");
  if (filter) { state.jobFilter = filter.dataset.status; $$("#jobFilters button").forEach(button => button.classList.toggle("active", button === filter)); renderJobs(); return; }
  const jobButton = target.closest("[data-job-action]");
  if (jobButton) { jobAction(jobButton.closest("tr").dataset.job, jobButton.dataset.jobAction); return; }
  const confirmation = target.closest("[data-confirm]");
  if (confirmation) { const ok = confirmation.dataset.confirm === "ok"; const resolve = state.confirmResolve; state.confirmResolve = null; $("#confirmModal").hidden = true; resolve?.(ok); return; }
  const revoke = target.closest("[data-revoke-key]");
  if (revoke) {
    const row = revoke.closest("[data-key-id]");
    if (!await confirmAction("Revoke this key?", "The extension using it will stop working immediately.")) return;
    try { await request(`/api/v1/keys/${encodeURIComponent(row.dataset.keyId)}`, { method: "DELETE" }); $("#newKeyBox").hidden = true; await loadAdmin(); toast("Key revoked"); }
    catch (error) { toast(error.message, "error"); }
  }
});

$("#fileGrid").addEventListener("dblclick", event => {
  const card = event.target.closest(".file-card");
  if (!card || event.target.closest("button,input,label")) return;
  if (event.target.closest(".file-name")) startRename(card.dataset.key); else previewFile(findFile(card.dataset.key));
});

// Right-click menu
function hideContextMenu() { $("#contextMenu").hidden = true; }
$("#fileGrid").addEventListener("contextmenu", event => {
  const card = event.target.closest(".file-card");
  if (!card) return;
  event.preventDefault();
  const key = card.dataset.key;
  if (!state.selected.has(key)) { selectOnly(key); updateSelectionUi(); }
  const many = state.selected.size > 1;
  const item = (action, iconName, label, cls = "") => `<button class="${cls}" data-menu-action="${action}" data-key="${escapeHtml(key)}">${icon(iconName)}<span>${label}</span></button>`;
  const menu = $("#contextMenu");
  menu.innerHTML = [
    many ? "" : item("preview", "play", "Preview"),
    item("download", "download", many ? `Download ${state.selected.size}` : "Download"),
    many ? "" : item("rename", "pencil", "Rename"),
    item("move", "move", many ? `Move ${state.selected.size}…` : "Move…"),
    item("delete", "trash", many ? `Delete ${state.selected.size}` : "Delete", "danger"),
  ].join("");
  menu.hidden = false;
  menu.style.left = `${Math.min(event.clientX, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, innerHeight - menu.offsetHeight - 8)}px`;
});
window.addEventListener("scroll", hideContextMenu, true);
window.addEventListener("blur", hideContextMenu);

// Drag clips onto a category to move them
$("#fileGrid").addEventListener("dragstart", event => {
  const card = event.target.closest(".file-card");
  if (!card) return;
  if (!state.selected.has(card.dataset.key)) { selectOnly(card.dataset.key); updateSelectionUi(); }
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-frameforge-files", String(state.selected.size));
  document.body.classList.add("dragging-files");
});
document.addEventListener("dragend", () => { document.body.classList.remove("dragging-files"); $$(".drop-target").forEach(el => el.classList.remove("drop-target")); });
$("#categoryRail").addEventListener("dragover", event => {
  const target = event.target.closest("[data-droppable]");
  if (!target || !event.dataTransfer.types.includes("application/x-frameforge-files")) return;
  event.preventDefault(); event.dataTransfer.dropEffect = "move";
  $$(".drop-target").forEach(el => el !== target && el.classList.remove("drop-target"));
  target.classList.add("drop-target");
});
$("#categoryRail").addEventListener("dragleave", event => event.target.closest("[data-droppable]")?.classList.remove("drop-target"));
$("#categoryRail").addEventListener("drop", event => {
  const target = event.target.closest("[data-droppable]");
  if (!target || !event.dataTransfer.types.includes("application/x-frameforge-files")) return;
  event.preventDefault(); target.classList.remove("drop-target");
  moveFiles(selectedFiles(), target.dataset.category);
});

// Drop video files from the computer to upload them
let dragDepth = 0;
const draggingOsFiles = event => event.dataTransfer?.types.includes("Files");
window.addEventListener("dragenter", event => { if (draggingOsFiles(event)) { dragDepth++; $("#dropOverlay").hidden = false; } });
window.addEventListener("dragleave", event => { if (draggingOsFiles(event) && --dragDepth <= 0) { dragDepth = 0; $("#dropOverlay").hidden = true; } });
window.addEventListener("dragover", event => { if (draggingOsFiles(event)) event.preventDefault(); });
window.addEventListener("drop", event => {
  if (!draggingOsFiles(event)) return;
  event.preventDefault(); dragDepth = 0; $("#dropOverlay").hidden = true;
  uploadVideos(event.dataTransfer.files);
});

// Forms and toolbar
$("#refreshButton").addEventListener("click", () => loadAll(true));
$("#jobsRefresh").addEventListener("click", () => loadJobs());
$("#newCategory").addEventListener("click", createCategory);
$("#librarySearch").addEventListener("input", event => { state.search = event.target.value.trim().toLowerCase(); state.limit = PAGE_SIZE; renderLibrary(); });
$("#sortLibrary").addEventListener("change", event => { state.sort = event.target.value; state.limit = PAGE_SIZE; renderLibrary(); });
$("#zipCategory").addEventListener("click", () => { const a = document.createElement("a"); a.href = `/api/v1/dataset/download_folder/${encodeURIComponent(state.category)}`; a.download = `${state.category}.zip`; document.body.append(a); a.click(); a.remove(); toast("Preparing zip…"); });
$("#globalUpload").addEventListener("change", event => { uploadVideos(event.target.files); event.target.value = ""; });
$("#moveForm").addEventListener("submit", event => { event.preventDefault(); const name = $("#moveCategory").value.trim().replace(/\s+/g, "_"); closeModal("moveModal"); if (name) moveFiles(state.moveFiles, name); });
$("#promptForm").addEventListener("submit", event => { event.preventDefault(); const resolve = state.promptResolve; state.promptResolve = null; $("#promptModal").hidden = true; resolve?.($("#promptInput").value); });
$("#connectionForm").addEventListener("submit", async event => {
  event.preventDefault();
  localStorage.setItem(KEY_STORAGE, $("#apiKeyInput").value.trim());
  await loadAll();
  toast(state.role ? `Connected as ${state.role === "admin" ? "administrator" : "client"}` : "Could not authenticate with this key", state.role ? "ok" : "error");
});
$("#toggleKey").addEventListener("click", () => { const input = $("#apiKeyInput"); input.type = input.type === "password" ? "text" : "password"; });
$("#jobSourceUpload").addEventListener("change", async event => {
  const file = event.target.files[0], jobId = state.sourceJob;
  event.target.value = ""; state.sourceJob = null;
  if (!file || !jobId) return;
  try {
    const result = await uploadWithProgress(file, jobId, file.name);
    await loadJobs();
    toast(result.warning || "Source verified; job resumed", result.warning ? "warn" : "ok");
  } catch (error) { toast(error.message, "error"); }
});
$("#keyForm").addEventListener("submit", async event => {
  event.preventDefault();
  const name = $("#keyName").value.trim();
  if (!name) return;
  try {
    const created = await postJson("/api/v1/keys", { name });
    $("#keyName").value = ""; await loadAdmin();
    $("#newKeyValue").textContent = created.key; $("#newKeyBox").hidden = false;
  } catch (error) { toast(error.message, "error"); }
});
$("#copyNewKey").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#newKeyValue").textContent); toast("Key copied"); }
  catch { toast("Select the key and copy it manually", "error"); }
});
$("#dbDownload").addEventListener("click", downloadDatabase);
$("#dbReset").addEventListener("click", resetDatabase);
$("#previewPrev").addEventListener("click", () => stepPreview(-1));
$("#previewNext").addEventListener("click", () => stepPreview(1));
$("#previewDownload").addEventListener("click", () => { const file = findFile(state.previewKey); if (file) downloadFile(file); });
$("#previewDelete").addEventListener("click", async () => {
  const file = findFile(state.previewKey);
  if (!file) return;
  const files = filteredFiles().filter(isVideo), index = files.findIndex(item => fileKey(item) === state.previewKey);
  const next = files.length > 1 ? files[(index + 1) % files.length] : null;
  $("#previewVideo").pause();
  if (await deleteFiles([file])) { if (next) previewFile(findFile(fileKey(next)) || null); else closeModal("previewModal"); }
});

// Keyboard: the same shortcuts as a file manager
document.addEventListener("keydown", async event => {
  const active = document.activeElement;
  const typing = isTextEntry(active);
  const onSelectMenu = active?.tagName === "SELECT";
  if (event.key === "Escape") {
    hideContextMenu();
    const open = $$(".modal:not([hidden])");
    if (open.length) { open.forEach(modal => closeModal(modal.id)); return; }
    if (state.view === "library" && !typing) { state.selected.clear(); state.cutFiles = []; updateSelectionUi(); }
    return;
  }
  if (!$("#previewModal").hidden && !typing) {
    if (event.key === "ArrowLeft") { event.preventDefault(); stepPreview(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); stepPreview(1); }
    return;
  }
  if (state.view !== "library" || $(".modal:not([hidden])") || typing) return;
  if (onSelectMenu && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " "].includes(event.key)) return;

  const selected = selectedFiles(), ctrl = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
  if (ctrl && key === "a") { event.preventDefault(); selectAllVisible(); return; }
  if (ctrl && key === "x" && selected.length) { event.preventDefault(); state.cutFiles = selected; updateSelectionUi(); toast(`${plural(selected.length, "file")} cut — open a category and press Ctrl+V`); return; }
  if (ctrl && key === "v" && state.cutFiles.length) {
    event.preventDefault();
    if (state.category === "all" || state.category === "_temp") { toast("Open a category first", "error"); return; }
    await moveFiles(state.cutFiles, state.category); return;
  }
  if (event.key === "Delete" && selected.length) { event.preventDefault(); deleteFiles(selected); return; }
  if (event.key === "Enter" && selected.length) { event.preventDefault(); previewFile(selected[0]); return; }
  if (event.key === "F2" && state.focusedKey) { event.preventDefault(); startRename(state.focusedKey); return; }
  if (key === "m" && !ctrl && selected.length) { event.preventDefault(); openMove(selected); return; }
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    const cards = $$(".file-card");
    if (!cards.length) return;
    const keys = cards.map(card => card.dataset.key);
    let index = Math.max(0, keys.indexOf(state.focusedKey));
    const columns = Math.max(1, Math.round($("#fileGrid").clientWidth / cards[0].getBoundingClientRect().width));
    index += event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -columns : columns;
    index = Math.max(0, Math.min(keys.length - 1, index));
    if (event.shiftKey) { state.selected.add(keys[index]); state.focusedKey = keys[index]; } else if (ctrl) state.focusedKey = keys[index]; else selectOnly(keys[index]);
    updateSelectionUi();
    cards[index].focus(); cards[index].scrollIntoView({ block: "nearest" });
  }
});

// ------------------------------------------------------------------ start
$("#apiKeyInput").value = apiKey();
setView(location.hash.slice(1) in VIEW_LABELS ? location.hash.slice(1) : "overview");
loadAll();
setInterval(() => { if (state.role && !document.hidden) loadJobs(); }, 15000);
setInterval(ensureSession, 6 * 3600 * 1000);
