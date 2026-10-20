"use strict";

const $ = (sel, root = document) => root.querySelector(sel);

const FORMAT_LABELS = {
  copy: "Original (lossless copy)",
  mp3: "MP3",
  m4a: "M4A / AAC",
  opus: "Opus",
  ogg: "Ogg Vorbis",
  flac: "FLAC (lossless)",
  wav: "WAV (uncompressed)",
};
const NO_BITRATE = new Set(["copy", "flac", "wav"]);
const ENCODER = { mp3: "libmp3lame", m4a: "aac", opus: "libopus", ogg: "libvorbis", flac: "flac", wav: "pcm_s16le" };

let config = { formats: Object.keys(FORMAT_LABELS), bitrates: ["64k", "96k", "128k", "160k", "192k", "256k", "320k"] };

/* ───────── helpers ───────── */

function parseTime(text) {
  text = (text || "").trim();
  if (!text) return null;
  const parts = text.split(":");
  if (parts.length > 3) return NaN;
  let s = 0;
  for (const p of parts) {
    if (!/^\d*\.?\d+$/.test(p)) return NaN;
    s = s * 60 + parseFloat(p);
  }
  return s;
}

function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return "?";
  sec = Math.round(sec * 10) / 10;
  const m = Math.floor(sec / 60);
  const s = Math.round((sec - m * 60) * 10) / 10;
  const h = Math.floor(m / 60);
  const ss = (s < 10 ? "0" : "") + (Number.isInteger(s) ? s : s.toFixed(1));
  return h ? `${h}:${String(m % 60).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function fmtSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function ext(name) {
  const m = /\.([^.]+)$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

function stem(name) {
  return (name || "").replace(/\.[^.]+$/, "");
}

function shQuote(s) {
  return /^[\w.\/:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function fillSelect(select, values, labels, selected) {
  select.innerHTML = "";
  for (const v of values) {
    const opt = new Option(labels ? labels[v] || v : v, v);
    select.add(opt);
  }
  if (selected) select.value = selected;
}

function validateTimeInput(input) {
  const ok = !Number.isNaN(parseTime(input.value));
  input.classList.toggle("invalid", !ok);
  return ok;
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith("video") ? "video" : "audio");
    el.preload = "metadata";
    const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
    el.onloadedmetadata = () => done(isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
  });
}

/** POST a FormData with upload progress; resolves with { blob, filename }. */
function upload(url, form, statusEl) {
  const bar = $(".bar", statusEl);
  const text = $(".status-text", statusEl);
  statusEl.hidden = false;
  statusEl.className = "status";
  bar.style.width = "0%";
  text.textContent = "Uploading…";

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "blob";
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      bar.style.width = pct + "%";
      text.textContent = `Uploading… ${pct}%`;
    };
    xhr.upload.onload = () => {
      statusEl.classList.add("working");
      text.textContent = "ffmpeg is working its magic…";
    };
    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const cd = xhr.getResponseHeader("Content-Disposition") || "";
        const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(cd);
        const filename = m ? decodeURIComponent(m[1] || m[2]) : "output";
        resolve({ blob: xhr.response, filename });
      } else {
        let msg = `Request failed (${xhr.status})`;
        try {
          const body = JSON.parse(await xhr.response.text());
          if (body.detail) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
        } catch { /* keep generic message */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("Network error — is the server running?"));
    xhr.send(form);
  });
}

function showResult(resultEl, statusEl, { blob, filename }) {
  const audio = $("audio", resultEl);
  const link = $("a", resultEl);
  if (audio.src) URL.revokeObjectURL(audio.src);
  const url = URL.createObjectURL(blob);
  audio.src = url;
  link.href = url;
  link.download = filename;
  link.textContent = `Download ${filename} (${fmtSize(blob.size)})`;
  resultEl.hidden = false;
  statusEl.className = "status";
  $(".bar", statusEl).style.width = "100%";
  $(".status-text", statusEl).textContent = "Done!";
}

function showError(statusEl, err) {
  statusEl.hidden = false;
  statusEl.className = "status error";
  $(".status-text", statusEl).textContent = err.message;
}

function wireDrop(zone, input, onFiles) {
  input.addEventListener("change", () => { onFiles([...input.files]); input.value = ""; });
  zone.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    zone.classList.remove("over");
    onFiles([...e.dataTransfer.files]);
  });
}

function wireFormatControls(formatSel, bitrateSel, defaultFormat, onChange) {
  fillSelect(formatSel, config.formats, FORMAT_LABELS, defaultFormat);
  fillSelect(bitrateSel, config.bitrates, null, "128k");
  const sync = () => { bitrateSel.disabled = NO_BITRATE.has(formatSel.value); onChange(); };
  formatSel.addEventListener("change", sync);
  bitrateSel.addEventListener("change", onChange);
  sync();
}

function encodeArgs(format, bitrate) {
  if (format === "copy") return "-c copy";
  const br = NO_BITRATE.has(format) ? "" : ` -b:a ${bitrate}`;
  return `-c:a ${ENCODER[format]}${br}`;
}

/* ───────── tabs ───────── */

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => {
      const on = t === tab;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on);
      $(`#tab-${t.dataset.tab}`).hidden = !on;
    });
  });
});

/* ───────── bubbles ───────── */

(function bubbles() {
  const host = $(".bubbles");
  for (let i = 0; i < 18; i++) {
    const b = document.createElement("span");
    const size = 14 + Math.random() * 70;
    b.className = "bubble";
    b.style.width = b.style.height = `${size}px`;
    b.style.left = `${Math.random() * 100}%`;
    b.style.setProperty("--drift", `${(Math.random() - 0.5) * 120}px`);
    b.style.animationDuration = `${14 + Math.random() * 18}s`;
    b.style.animationDelay = `${-Math.random() * 30}s`;
    host.appendChild(b);
  }
})();

/* ───────── splice ───────── */

const splice = {
  clips: [], // { id, file, duration, el }
  nextId: 1,
  list: $("#clip-list"),
  player: new Audio(),
  playingId: null,
};

function clipById(id) {
  return splice.clips.find((c) => c.id === id);
}

async function addClips(files) {
  for (const file of files) {
    const clip = { id: splice.nextId++, file, duration: null };
    clip.el = buildClipRow(clip);
    splice.clips.push(clip);
    splice.list.appendChild(clip.el);
    probeDuration(file).then((d) => { clip.duration = d; renderClipMeta(clip); });
  }
  refreshSplice();
}

function buildClipRow(clip) {
  const li = $("#clip-template").content.firstElementChild.cloneNode(true);
  li.dataset.id = clip.id;
  $(".clip-name", li).textContent = clip.file.name;
  $(".clip-name", li).title = clip.file.name;
  renderClipMeta(clip, li);

  $(".play", li).addEventListener("click", () => togglePreview(clip));
  $(".remove", li).addEventListener("click", () => removeClip(clip));
  $(".up", li).addEventListener("click", () => moveClip(clip, -1));
  $(".down", li).addEventListener("click", () => moveClip(clip, +1));
  li.querySelectorAll(".clip-trim input").forEach((inp) =>
    inp.addEventListener("input", () => { validateTimeInput(inp); refreshSplice(); }));
  li.querySelectorAll("[data-mark]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (splice.player.dataset.id !== String(clip.id)) return; // nothing previewed for this clip yet
      const inp = $(btn.dataset.mark === "start" ? ".t-start" : ".t-end", li);
      inp.value = fmtTime(splice.player.currentTime);
      validateTimeInput(inp);
      refreshSplice();
    }));

  // Drag-and-drop reordering.
  li.addEventListener("dragstart", (e) => {
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/x-clip", String(clip.id));
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    splice.list.querySelectorAll(".drop-above,.drop-below").forEach((x) => x.classList.remove("drop-above", "drop-below"));
  });
  li.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("text/x-clip")) return;
    e.preventDefault();
    const below = e.offsetY > li.offsetHeight / 2 || e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
    li.classList.toggle("drop-below", below);
    li.classList.toggle("drop-above", !below);
  });
  li.addEventListener("dragleave", () => li.classList.remove("drop-above", "drop-below"));
  li.addEventListener("drop", (e) => {
    const draggedId = Number(e.dataTransfer.getData("text/x-clip"));
    if (!draggedId) return;
    e.preventDefault();
    const below = li.classList.contains("drop-below");
    li.classList.remove("drop-above", "drop-below");
    if (draggedId === clip.id) return;
    const dragged = clipById(draggedId);
    splice.clips.splice(splice.clips.indexOf(dragged), 1);
    const target = splice.clips.indexOf(clip) + (below ? 1 : 0);
    splice.clips.splice(target, 0, dragged);
    reorderDom();
  });
  return li;
}

function renderClipMeta(clip, li = clip.el) {
  const bits = [fmtTime(clip.duration), fmtSize(clip.file.size)];
  if (ext(clip.file.name)) bits.push(ext(clip.file.name).toUpperCase());
  $(".clip-meta", li).textContent = bits.join(" · ");
}

function reorderDom() {
  for (const c of splice.clips) splice.list.appendChild(c.el);
  refreshSplice();
}

function moveClip(clip, delta) {
  const i = splice.clips.indexOf(clip);
  const j = i + delta;
  if (j < 0 || j >= splice.clips.length) return;
  [splice.clips[i], splice.clips[j]] = [splice.clips[j], splice.clips[i]];
  reorderDom();
}

function removeClip(clip) {
  if (splice.player.dataset.id === String(clip.id)) stopPreview();
  splice.clips.splice(splice.clips.indexOf(clip), 1);
  clip.el.remove();
  refreshSplice();
}

function stopPreview() {
  splice.player.pause();
  if (splice.player.src) URL.revokeObjectURL(splice.player.src);
  splice.player.removeAttribute("src");
  delete splice.player.dataset.id;
  splice.playingId = null;
  splice.clips.forEach((c) => { c.el.classList.remove("playing"); $(".play", c.el).textContent = "▶"; });
}

function togglePreview(clip) {
  const p = splice.player;
  if (p.dataset.id === String(clip.id)) {
    if (p.paused) { p.play(); } else { p.pause(); }
  } else {
    stopPreview();
    p.src = URL.createObjectURL(clip.file);
    p.dataset.id = clip.id;
    const start = parseTime($(".t-start", clip.el).value);
    if (start) p.currentTime = start;
    p.play();
  }
}

splice.player.addEventListener("play", () => {
  splice.playingId = Number(splice.player.dataset.id);
  splice.clips.forEach((c) => {
    const on = c.id === splice.playingId;
    c.el.classList.toggle("playing", on);
    $(".play", c.el).textContent = on ? "❚❚" : "▶";
  });
});
splice.player.addEventListener("pause", () => {
  const c = clipById(Number(splice.player.dataset.id));
  if (c) $(".play", c.el).textContent = "▶";
});
splice.player.addEventListener("ended", () => {
  const c = clipById(Number(splice.player.dataset.id));
  if (c) c.el.classList.remove("playing");
});

function refreshSplice() {
  splice.clips.forEach((c, i) => { $(".idx", c.el).textContent = i + 1; });
  $("#clip-empty").hidden = splice.clips.length > 0;
  const allValid = [...splice.list.querySelectorAll("input")].every((i) => !i.classList.contains("invalid"));
  $("#splice-go").disabled = splice.clips.length === 0 || !allValid;
  $("#splice-go").textContent = splice.clips.length > 1 ? `Splice ${splice.clips.length} clips` : "Splice";

  const fmt = $("#splice-format").value;
  const br = $("#splice-bitrate").value;
  const name = ($("#splice-name").value.trim() || "merged");
  const outExt = fmt === "copy" ? (ext(splice.clips[0]?.file.name) || "m4a") : (fmt === "m4a" ? "m4a" : fmt);
  const files = splice.clips.length ? splice.clips.map((c) => c.file.name) : ["p1.m4a", "p2.m4a", "p3.m4a"];

  let cmd;
  if (fmt === "copy") {
    const trimmed = splice.clips.some((c) => $(".t-start", c.el).value || $(".t-end", c.el).value);
    cmd = trimmed
      ? `# list.txt uses inpoint/outpoint lines for trimmed clips\n`
      : `printf "file '%s'\\n" ${files.map(shQuote).join(" ")} > list.txt\n`;
    cmd += `ffmpeg -f concat -safe 0 -i list.txt -c copy ${shQuote(`${name}.${outExt}`)}`;
  } else {
    const ins = files.map((f) => `-i ${shQuote(f)}`).join(" ");
    const labels = files.map((_, i) => `[${i}:a]`).join("");
    cmd = `ffmpeg ${ins} \\\n  -filter_complex "${labels}concat=n=${files.length}:v=0:a=1[out]" -map "[out]" \\\n  ${encodeArgs(fmt, br)} ${shQuote(`${name}.${outExt}`)}`;
  }
  $("#splice-cmd").textContent = cmd;
}

async function runSplice() {
  const form = new FormData();
  const trims = [];
  for (const c of splice.clips) {
    form.append("files", c.file, c.file.name);
    trims.push({ start: $(".t-start", c.el).value.trim(), end: $(".t-end", c.el).value.trim() });
  }
  form.append("trims", JSON.stringify(trims));
  form.append("format", $("#splice-format").value);
  form.append("bitrate", $("#splice-bitrate").value);
  form.append("output_name", $("#splice-name").value.trim() || "merged");

  const btn = $("#splice-go");
  const statusEl = $("#splice-status");
  btn.disabled = true;
  $("#splice-result").hidden = true;
  try {
    showResult($("#splice-result"), statusEl, await upload("api/splice", form, statusEl));
  } catch (err) {
    showError(statusEl, err);
  } finally {
    refreshSplice();
  }
}

wireDrop($("#splice-drop"), $("#splice-input"), addClips);
$("#splice-go").addEventListener("click", runSplice);
$("#splice-clear").addEventListener("click", () => {
  stopPreview();
  splice.clips.forEach((c) => c.el.remove());
  splice.clips = [];
  $("#splice-result").hidden = true;
  $("#splice-status").hidden = true;
  refreshSplice();
});
$("#splice-name").addEventListener("input", refreshSplice);

/* ───────── extract ───────── */

const extract = { file: null, preview: $("#extract-preview") };

async function setExtractFile(files) {
  const file = files[0];
  if (!file) return;
  extract.file = file;
  if (extract.preview.src) URL.revokeObjectURL(extract.preview.src);
  extract.preview.src = URL.createObjectURL(file);
  extract.preview.classList.toggle("audio-only", !file.type.startsWith("video"));
  $(".source-name", $("#extract-source")).textContent = file.name;
  $(".source-meta", $("#extract-source")).textContent = fmtSize(file.size);
  $("#extract-source").hidden = false;
  $("#extract-result").hidden = true;
  $("#extract-status").hidden = true;
  $("#extract-name").placeholder = `${stem(file.name)}-audio`;
  const d = await probeDuration(file);
  if (extract.file === file) $(".source-meta", $("#extract-source")).textContent = `${fmtTime(d)} · ${fmtSize(file.size)}`;
  refreshExtract();
}

function refreshExtract() {
  const okStart = validateTimeInput($("#extract-start"));
  const okEnd = validateTimeInput($("#extract-end"));
  $("#extract-go").disabled = !extract.file || !okStart || !okEnd;

  const fmt = $("#extract-format").value;
  const br = $("#extract-bitrate").value;
  const src = extract.file ? extract.file.name : "video.mp4";
  const name = $("#extract-name").value.trim() || `${stem(src)}-audio`;
  const outExt = fmt === "copy" ? "m4a" : fmt;
  const start = $("#extract-start").value.trim();
  const end = $("#extract-end").value.trim();
  const range = `${start ? ` -ss ${start}` : ""}${end ? ` -to ${end}` : ""}`;
  const copyNote = fmt === "copy" ? "# container picked to match the source codec\n" : "";
  $("#extract-cmd").textContent =
    `${copyNote}ffmpeg${range} -i ${shQuote(src)} -vn ${fmt === "copy" ? "-c:a copy" : encodeArgs(fmt, br)} ${shQuote(`${name}.${outExt}`)}`;
}

async function runExtract() {
  const form = new FormData();
  form.append("file", extract.file, extract.file.name);
  form.append("start", $("#extract-start").value.trim());
  form.append("end", $("#extract-end").value.trim());
  form.append("format", $("#extract-format").value);
  form.append("bitrate", $("#extract-bitrate").value);
  form.append("output_name", $("#extract-name").value.trim());

  const btn = $("#extract-go");
  const statusEl = $("#extract-status");
  btn.disabled = true;
  $("#extract-result").hidden = true;
  try {
    showResult($("#extract-result"), statusEl, await upload("api/extract", form, statusEl));
  } catch (err) {
    showError(statusEl, err);
  } finally {
    refreshExtract();
  }
}

wireDrop($("#extract-drop"), $("#extract-input"), setExtractFile);
$("#extract-go").addEventListener("click", runExtract);
["#extract-start", "#extract-end", "#extract-name"].forEach((s) => $(s).addEventListener("input", refreshExtract));
document.querySelectorAll("#extract-source [data-mark]").forEach((btn) =>
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    $(`#${btn.dataset.mark}`).value = fmtTime(extract.preview.currentTime);
    refreshExtract();
  }));

/* ───────── boot ───────── */

(async function boot() {
  try {
    const res = await fetch("api/config");
    if (res.ok) config = await res.json();
  } catch { /* fall back to defaults */ }
  wireFormatControls($("#splice-format"), $("#splice-bitrate"), "copy", refreshSplice);
  wireFormatControls($("#extract-format"), $("#extract-bitrate"), "mp3", refreshExtract);
})();
