// Lumina Setup window. The install work happens in Rust (src-tauri/src/lib.rs); this file shows the screens,
// collects the choices and draws the progress it receives as `setup-progress` events.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const $ = (id) => document.getElementById(id);
const SCREENS = ["welcome", "choices", "progress", "done"];

const STEP_LABELS = {
  "remove-old": "Remove the old version",
  lumina: "Install Lumina",
  faces: "Face recognition models",
  clip: "Smart search models",
  ollama: "Install Ollama",
  model: "Download the vision model",
};

let info = null;
let installDir = "";
let installing = false;
let cancelArmed = false;
const tasks = new Map(); // step -> { state, message, downloaded, total, rate, lastBytes, lastTime }

// ---------- helpers ----------

function fmtBytes(n) {
  if (n >= 100e9) return `${Math.round(n / 1e9)} GB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

function fmtTime(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return "less than a minute left";
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} min left`;
  return `about ${Math.floor(m / 60)} h ${m % 60} min left`;
}

function show(screen) {
  SCREENS.forEach((s, i) => {
    $(`screen-${s}`).hidden = s !== screen;
    const li = document.querySelector(`.steps li[data-screen="${s}"]`);
    const current = SCREENS.indexOf(screen);
    li.classList.toggle("current", i === current);
    li.classList.toggle("past", i < current);
  });
}

// ---------- choices ----------

function selectedDownload() {
  if (!info) return 0;
  let bytes = 0;
  if ($("opt-ai").checked) {
    if (!info.ollama_installed) bytes += info.sizes.ollama;
    if (!info.model_present) bytes += info.sizes.model;
  }
  if ($("opt-faces").checked && !info.faces_present) bytes += info.sizes.faces;
  if ($("opt-clip").checked && !info.clip_present) bytes += info.sizes.clip;
  return bytes;
}

async function refreshSummary() {
  $("flash-row").hidden = !$("opt-ai").checked || info.model_present && info.ollama_installed;
  const download = selectedDownload();
  const free = await invoke("free_space", { path: installDir });
  // Downloads plus the app itself (~100 MB) and room for the Ollama installer to unpack
  const needed = download + 200e6 + ($("opt-ai").checked && !info.ollama_installed ? info.sizes.ollama : 0);
  const parts = [download > 0 ? `Downloads ${fmtBytes(download)}` : "Nothing to download"];
  if (free != null) parts.push(`${fmtBytes(free)} free on this drive`);
  const summary = $("summary");
  summary.textContent = parts.join(" · ");
  const tooLittle = free != null && free < needed;
  summary.classList.toggle("bad", tooLittle);
  if (tooLittle) summary.textContent += ` (needs about ${fmtBytes(needed)})`;
  $("btn-install").disabled = tooLittle || !info.can_install;
}

function setSize(id, present, bytes, presentText = "Downloaded") {
  const el = $(id);
  el.textContent = present ? presentText : fmtBytes(bytes);
  el.classList.toggle("ok", present);
}

function renderChoices() {
  $("install-dir").textContent = installDir;
  $("install-dir").title = installDir;
  const s = info.sizes;
  if (info.ollama_installed && info.model_present) {
    $("ai-detail").textContent = `Ollama and ${info.ai_model} are already installed.`;
    setSize("ai-size", true, 0, "Installed");
  } else if (info.ollama_installed) {
    $("ai-detail").textContent = `Uses your Ollama and downloads the ${info.ai_model} vision model.`;
    setSize("ai-size", false, s.model);
  } else {
    $("ai-detail").textContent = `Installs Ollama and the ${info.ai_model} vision model.`;
    setSize("ai-size", false, s.ollama + s.model);
  }
  setSize("faces-size", info.faces_present, s.faces);
  setSize("clip-size", info.clip_present, s.clip);
  if (info.machine_install) {
    $("old-install").hidden = false;
    $("old-install-text").textContent = `An older Lumina ${info.machine_install.version} is installed for all users in ${info.machine_install.dir}. Two copies would sit side by side.`;
  }
  refreshSummary();
}

// ---------- progress ----------

const ICONS = {
  waiting: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" stroke="#3a4450"/></svg>',
  active: '<svg viewBox="0 0 24 24" class="spin"><circle cx="12" cy="12" r="8" stroke="#2a3a33"/><path d="M12 4a8 8 0 0 1 8 8" stroke="#34d399"/></svg>',
  done: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke="#10b981" fill="rgba(16,185,129,.15)"/><path d="M8 12.3l2.8 2.8L16.2 9.5" stroke="#34d399"/></svg>',
  error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke="#f87171" fill="rgba(248,113,113,.12)"/><path d="M12 7.5v5.5M12 16.2v.3" stroke="#fca5a5"/></svg>',
  skipped: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke="#3a4450"/><path d="M8.5 12h7" stroke="#66717d"/></svg>',
};

function stepLabel(step) {
  return step === "model" && info ? `Download ${info.ai_model}` : STEP_LABELS[step] || step;
}

function renderTasks(steps) {
  const list = $("tasks");
  list.innerHTML = "";
  for (const step of steps) {
    tasks.set(step, { state: "waiting", message: "", downloaded: 0, total: 0, rate: 0, lastBytes: 0, lastTime: 0 });
    const li = document.createElement("li");
    li.className = "task";
    li.id = `task-${step}`;
    li.dataset.state = "waiting";
    li.innerHTML = `<span class="state">${ICONS.waiting}</span><span class="label"></span><span class="right"></span>
      <span class="detail"></span><span class="bar"><i></i></span>`;
    li.querySelector(".label").textContent = stepLabel(step);
    list.appendChild(li);
  }
}

function updateTask(p) {
  const t = tasks.get(p.step);
  const li = $(`task-${p.step}`);
  if (!t || !li) return;
  const now = performance.now();
  if (p.state === "active" && p.total > 0) {
    // Smoothed download speed for the time estimate
    if (t.lastTime && p.downloaded > t.lastBytes) {
      const rate = (p.downloaded - t.lastBytes) / ((now - t.lastTime) / 1000);
      t.rate = t.rate ? t.rate * 0.85 + rate * 0.15 : rate;
    }
    t.lastBytes = p.downloaded;
    t.lastTime = now;
  }
  Object.assign(t, { state: p.state, message: p.message, downloaded: p.downloaded, total: p.total });

  li.dataset.state = p.state;
  li.querySelector(".state").innerHTML = ICONS[p.state] || ICONS.waiting;
  const bar = li.querySelector(".bar");
  const detail = li.querySelector(".detail");
  const right = li.querySelector(".right");
  right.innerHTML = "";

  if (p.state === "active") {
    if (p.total > 0) {
      bar.classList.remove("indeterminate");
      bar.firstElementChild.style.width = `${Math.min(100, (p.downloaded / p.total) * 100).toFixed(1)}%`;
      const eta = t.rate > 0 ? fmtTime((p.total - p.downloaded) / t.rate) : "";
      detail.textContent = [`${fmtBytes(p.downloaded)} of ${fmtBytes(p.total)}`, eta].filter(Boolean).join(" · ");
    } else {
      bar.classList.add("indeterminate");
      detail.textContent = p.message || "Working…";
    }
  } else if (p.state === "done") {
    detail.textContent = "Done";
  } else if (p.state === "error") {
    detail.textContent = p.message;
    const retry = document.createElement("button");
    retry.className = "secondary retry";
    retry.textContent = "Retry";
    retry.onclick = () => retryStep(p.step);
    right.appendChild(retry);
  } else if (p.state === "skipped") {
    detail.textContent = p.message || "Skipped";
  }
  refreshProgressSummary();
}

function refreshProgressSummary() {
  const active = [...tasks.values()].filter((t) => t.state === "active" && t.total > 0);
  const left = active.reduce((s, t) => s + (t.total - t.downloaded), 0);
  $("progress-summary").textContent = active.length ? `${fmtBytes(left)} left to download` : "";
}

async function startInstall() {
  const options = {
    dir: installDir,
    desktop_shortcut: $("opt-desktop").checked,
    ai: $("opt-ai").checked,
    flash_attention: $("opt-flash").checked,
    faces: $("opt-faces").checked,
    clip: $("opt-clip").checked,
    remove_machine_install: !!info.machine_install && $("opt-remove-old").checked,
  };
  installing = true;
  show("progress");
  $("btn-continue").hidden = true;
  $("btn-cancel").hidden = false;
  const steps = await invoke("start_install", { options });
  renderTasks(steps);
}

async function retryStep(step) {
  installing = true;
  $("btn-continue").hidden = true;
  $("btn-cancel").hidden = false;
  $("progress-title").textContent = "Setting things up";
  await invoke("retry_step", { step });
}

function onFinished() {
  installing = false;
  cancelArmed = false;
  $("btn-cancel").textContent = "Cancel";
  const states = [...tasks.values()].map((t) => t.state);
  if (states.every((s) => s === "done")) {
    setTimeout(() => finish(), 700);
    return;
  }
  $("progress-title").textContent = states.includes("error") ? "Some steps need attention" : "Setup was stopped";
  $("btn-cancel").hidden = true;
  $("btn-continue").hidden = false;
}

// ---------- done ----------

function finish() {
  const state = (s) => tasks.get(s)?.state;
  const notes = [];
  const missed = (s) => tasks.has(s) && state(s) !== "done";
  if (missed("faces")) notes.push("<b>Face recognition</b> isn't downloaded yet: Lumina gets it the first time you scan for faces.");
  if (missed("clip")) notes.push("<b>Smart search</b> isn't downloaded yet: Lumina gets it the first time you use it.");
  if (missed("ollama") || missed("model"))
    notes.push("<b>AI captions</b> aren't set up yet: in Lumina, use <b>Start Ollama</b> or <b>Get AI Model</b> at the top.");
  if (missed("remove-old")) notes.push("<b>The old version</b> is still installed: remove it in Windows Settings › Apps.");
  if (!tasks.has("ollama") && !tasks.has("faces") && !tasks.has("clip"))
    notes.push("The <b>AI features</b> can be added any time: Lumina downloads them when you first use them.");

  const installed = state("lumina") === "done";
  $("done-title").textContent = installed ? "Lumina is ready" : "Lumina wasn't installed";
  $("done-lead").textContent = installed
    ? "Open a folder of photos to get started. Lumina indexes it in the background while you work."
    : tasks.get("lumina")?.message || "Setup couldn't install Lumina.";
  $("btn-open").hidden = !installed;
  $("done-notes").innerHTML = notes.map((n) => `<li>${n}</li>`).join("");
  show("done");
}

// ---------- wiring ----------

async function closeWindow() {
  if (installing && !confirm("Setup is still working. Stop and close?")) return;
  if (installing) await invoke("cancel_install");
  appWindow.close();
}

async function init() {
  $("btn-minimize").onclick = () => appWindow.minimize();
  $("btn-close").onclick = closeWindow;
  $("btn-start").onclick = () => show("choices");
  $("btn-back").onclick = () => show("welcome");
  $("btn-install").onclick = startInstall;
  $("btn-continue").onclick = finish;
  $("btn-finish").onclick = () => appWindow.close();
  $("btn-open").onclick = () => invoke("launch_lumina", { dir: installDir });
  $("btn-cancel").onclick = async () => {
    if (!cancelArmed) {
      cancelArmed = true;
      $("btn-cancel").textContent = "Click again to stop";
      setTimeout(() => {
        cancelArmed = false;
        if (installing) $("btn-cancel").textContent = "Cancel";
      }, 3000);
      return;
    }
    $("btn-cancel").textContent = "Stopping…";
    await invoke("cancel_install");
  };
  $("btn-change-dir").onclick = async () => {
    const picked = await invoke("pick_folder", { current: installDir });
    if (picked) {
      installDir = picked;
      renderChoices();
    }
  };
  ["opt-ai", "opt-faces", "opt-clip"].forEach((id) => ($(id).onchange = refreshSummary));

  await listen("setup-progress", (e) => updateTask(e.payload));
  await listen("setup-finished", onFinished);

  info = await invoke("system_info");
  installDir = info.default_dir;
  $("version-label").textContent = `Version ${info.version}`;
  const update = $("welcome-update");
  if (!info.can_install) {
    update.hidden = false;
    update.textContent = "This build of Setup doesn't contain Lumina (developer build).";
  } else if (info.lumina_running) {
    update.hidden = false;
    update.textContent = "Lumina is open. Close it before you install.";
  } else if (info.user_install) {
    update.hidden = false;
    update.textContent = `Lumina ${info.user_install.version} is installed. Setup updates it; your library, names and albums stay as they are.`;
    $("btn-install").textContent = "Update";
  }
  renderChoices();
  show("welcome");
}

init();
