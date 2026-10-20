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
  link.textContent = `Download · ${fmtSize(blob.size)}`;
  link.title = filename;
  resultEl.hidden = false;
  statusEl.className = "status";
  $(".bar", statusEl).style.width = "100%";
  $(".status-text", statusEl).textContent = `Done! ${filename}`;
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

/* ───────── in-browser ffmpeg ───────── */

// Splicing and extracting run in ffmpeg.wasm, so files never leave the browser.
// The build is self-hosted under vendor/ffmpeg (scripts/vendor-ffmpeg-wasm.sh);
// if it can't be loaded the app falls back to the server's /api endpoints.
const WASM_DIR = new URL("vendor/ffmpeg/", location.href).href;
const OUT_EXT = { mp3: "mp3", m4a: "m4a", opus: "opus", ogg: "ogg", flac: "flac", wav: "wav" };
const MIME = {
  mp3: "audio/mpeg", m4a: "audio/mp4", opus: "audio/ogg", ogg: "audio/ogg",
  flac: "audio/flac", wav: "audio/wav", mka: "audio/x-matroska",
};
// Container to use when stream-copying a given codec.
const COPY_CONTAINERS = { aac: "m4a", alac: "m4a", mp3: "mp3", opus: "opus", vorbis: "ogg", flac: "flac" };

function copyContainer(codec) {
  return codec?.startsWith("pcm_") ? "wav" : COPY_CONTAINERS[codec] || "mka";
}

function safeName(name, fallback) {
  const s = stem(name).replace(/[^\p{L}\p{N}_\-. ]+/gu, "_").replace(/^[ .]+|[ .]+$/g, "");
  return s.slice(0, 100) || fallback;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`couldn't load ${src}`));
    document.head.appendChild(s);
  });
}

const engine = (() => {
  let loading = null;
  let queue = Promise.resolve();
  let listener = null;
  let jobs = 0;

  /** Fetch and start ffmpeg.wasm once (~32 MB, cached by the browser afterwards). */
  function load() {
    return (loading ||= (async () => {
      if (!window.FFmpegWASM) await loadScript(WASM_DIR + "ffmpeg.js");
      const ff = new FFmpegWASM.FFmpeg();
      ff.on("log", (e) => listener?.(e.message));
      await ff.load({ coreURL: WASM_DIR + "ffmpeg-core.js", wasmURL: WASM_DIR + "ffmpeg-core.wasm" });
      return ff;
    })().catch((err) => { loading = null; throw err; }));
  }

  /** Run ffmpeg/ffprobe; returns the exit code and the tail of the log, which is where errors are. */
  async function exec(ff, method, args, onLine) {
    const tail = [];
    listener = (line) => {
      tail.push(line);
      if (tail.length > 8) tail.shift();
      onLine?.(line);
    };
    let code;
    try {
      code = await ff[method](args);
    } catch (err) {
      // The wasm instance aborted (usually out of memory); start a fresh one next time.
      ff.terminate();
      loading = null;
      throw new Error(`ffmpeg.wasm crashed (inputs too large for in-browser processing?)\n${err}`);
    } finally {
      listener = null;
    }
    return { code, tail: tail.join("\n") };
  }

  /**
   * Run fn with `files` mounted read-only at <dir>/in (WORKERFS, so inputs are
   * read straight from the File objects instead of being copied into wasm memory).
   * ffmpeg.wasm runs one command at a time, so jobs are queued.
   */
  function job(files, fn) {
    const run = queue.then(async () => {
      const ff = await load();
      const dir = `/job${++jobs}`;
      const names = files.map((f, i) => `in${String(i).padStart(3, "0")}${ext(f.name) ? "." + ext(f.name).slice(0, 10) : ""}`);
      await ff.createDir(dir);
      await ff.createDir(`${dir}/in`);
      await ff.mount("WORKERFS", { blobs: files.map((data, i) => ({ name: names[i], data })) }, `${dir}/in`);
      try {
        return await fn({
          dir,
          paths: names.map((n) => `${dir}/in/${n}`),
          ffmpeg: async (args, onLine) => {
            // Log level is global in the wasm instance and ffprobe lowers it; progress lines are "info".
            const { code, tail } = await exec(ff, "exec", ["-hide_banner", "-loglevel", "info", "-y", ...args], onLine);
            if (code !== 0) throw new Error(`ffmpeg failed:\n${tail || `exit code ${code}`}`);
          },
          probe: async (path, label) => {
            const out = `${dir}/probe.json`;
            // The wasm ffprobe reports -1 even on success, so judge it by its output file.
            const { tail } = await exec(ff, "ffprobe", [
              "-v", "error", "-select_streams", "a:0",
              "-show_entries", "stream=codec_name,sample_rate,channels:format=duration",
              "-of", "json", "-o", out, path,
            ]);
            const json = await ff.readFile(out, "utf8").catch(() => null);
            await ff.deleteFile(out).catch(() => {});
            if (!json) throw new Error(`${label}: ${tail || "couldn't read this file"}`);
            const data = JSON.parse(json);
            const s = data.streams?.[0];
            if (!s) throw new Error(`${label}: no audio stream found`);
            const duration = parseFloat(data.format?.duration);
            return {
              codec: s.codec_name,
              sample_rate: s.sample_rate ? parseInt(s.sample_rate, 10) : null,
              channels: s.channels,
              duration: Number.isFinite(duration) ? duration : null,
            };
          },
          write: (path, data) => ff.writeFile(path, data),
          read: (path) => ff.readFile(path),
        });
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err)); // the worker rejects with plain strings
      } finally {
        await ff.unmount(`${dir}/in`).catch(() => {});
        await ff.deleteDir(`${dir}/in`).catch(() => {});
        for (const entry of await ff.listDir(dir).catch(() => [])) {
          if (!entry.isDir) await ff.deleteFile(`${dir}/${entry.name}`).catch(() => {});
        }
        await ff.deleteDir(dir).catch(() => {});
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  return { load, job };
})();

/** "1:15.5" → 75.5; empty or zero means "no trim", like the server. */
function trimValue(text, label) {
  const t = parseTime(text);
  if (Number.isNaN(t)) throw new Error(`${label}: '${text}' is not a valid time`);
  return t || null;
}

function checkRange(start, end, label) {
  if (start != null && end != null && end <= start) throw new Error(`${label}: end must be after start`);
}

function timeArgs(start, end) {
  return [...(start ? ["-ss", start.toFixed(3)] : []), ...(end ? ["-to", end.toFixed(3)] : [])];
}

function codecArgs(format, bitrate) {
  // ffmpeg.wasm's libopus crashes ("memory access out of bounds") on any stereo
  // input, so use ffmpeg's own Opus encoder; it only takes 48 kHz.
  const codec = format === "opus" ? ["opus", "-strict", "-2", "-ar", "48000"] : [ENCODER[format]];
  return ["-c:a", ...codec, ...(NO_BITRATE.has(format) ? [] : ["-b:a", bitrate])];
}

/** How long a trimmed input will be in the output, for progress reporting. */
function outputLength(start, end, duration) {
  const stop = end != null && duration != null ? Math.min(end, duration) : end ?? duration;
  return stop != null ? Math.max(0, stop - (start || 0)) : null;
}

/** Turn ffmpeg's "time=00:01:02.34" log lines into a 0–1 fraction of `total`. */
function progressReader(total, onProgress) {
  return (line) => {
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (m && total) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / total));
  };
}

/** Join clips in order. parts: [{ file, start, end }] with raw trim text. */
function spliceInBrowser(parts, { format, bitrate, name }, onProgress) {
  const trims = parts.map((p) => {
    const label = p.file.name;
    const start = trimValue(p.start, label);
    const end = trimValue(p.end, label);
    checkRange(start, end, label);
    return { start, end };
  });
  return engine.job(parts.map((p) => p.file), async ({ dir, paths, ffmpeg, probe, write, read }) => {
    const probes = [];
    for (const [i, path] of paths.entries()) probes.push(await probe(path, parts[i].file.name));
    const lengths = probes.map((p, i) => outputLength(trims[i].start, trims[i].end, p.duration));
    const total = lengths.every((l) => l != null) ? lengths.reduce((a, b) => a + b, 0) : null;

    let outExt;
    let args;
    if (format === "copy") {
      // Lossless join via the concat demuxer; inputs must share codec / rate / layout.
      const sigs = new Set(probes.map((p) => `${p.codec} ${p.sample_rate}Hz ${p.channels}ch`));
      if (sigs.size > 1) {
        throw new Error(
          `Lossless join needs identical audio formats, but got: ${[...sigs].sort().join(", ")}. ` +
          "Pick an output format to re-encode instead.");
      }
      outExt = copyContainer(probes[0].codec);
      const list = paths.map((path, i) => [
        `file '${path}'`,
        trims[i].start && `inpoint ${trims[i].start.toFixed(3)}`,
        trims[i].end && `outpoint ${trims[i].end.toFixed(3)}`,
      ].filter(Boolean).join("\n")).join("\n") + "\n";
      await write(`${dir}/list.txt`, list);
      args = ["-f", "concat", "-safe", "0", "-i", `${dir}/list.txt`, "-vn", "-map", "0:a", "-c", "copy"];
    } else {
      // Re-encoding join via the concat filter, which tolerates mixed inputs
      // once every one is normalised to the same rate and layout.
      outExt = OUT_EXT[format];
      const rate = Math.max(...probes.map((p) => p.sample_rate || 44100));
      args = paths.flatMap((path, i) => [...timeArgs(trims[i].start, trims[i].end), "-i", path]);
      const chains = paths.map((_, i) =>
        `[${i}:a:0]aresample=${rate},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
      const joined = paths.map((_, i) => `[a${i}]`).join("");
      args.push("-filter_complex", `${chains.join(";")};${joined}concat=n=${paths.length}:v=0:a=1[out]`, "-map", "[out]");
      args.push(...codecArgs(format, bitrate));
    }
    const out = `${dir}/out.${outExt}`;
    await ffmpeg([...args, out], progressReader(total, onProgress));
    return { blob: new Blob([await read(out)], { type: MIME[outExt] }), filename: `${safeName(name, "merged")}.${outExt}` };
  });
}

/** Pull the audio track out of an audio/video file, optionally trimmed. */
function extractInBrowser(file, { start, end, format, bitrate, name }, onProgress) {
  const t0 = trimValue(start, "start");
  const t1 = trimValue(end, "end");
  checkRange(t0, t1, "range");
  return engine.job([file], async ({ dir, paths: [path], ffmpeg, probe, read }) => {
    const info = await probe(path, file.name);
    const outExt = format === "copy" ? copyContainer(info.codec) : OUT_EXT[format];
    const out = `${dir}/out.${outExt}`;
    await ffmpeg([
      ...timeArgs(t0, t1), "-i", path, "-vn", "-sn", "-dn",
      ...(format === "copy" ? ["-c:a", "copy"] : codecArgs(format, bitrate)),
      "-map", "0:a:0", out,
    ], progressReader(outputLength(t0, t1, info.duration), onProgress));
    const filename = `${safeName(name || `${stem(file.name) || "audio"}-audio`, "audio")}.${outExt}`;
    return { blob: new Blob([await read(out)], { type: MIME[outExt] }), filename };
  });
}

/**
 * Run a job with ffmpeg.wasm, showing progress in statusEl; if the wasm build
 * can't be loaded, run `remote` (a server upload) instead.
 */
async function processLocally(statusEl, local, remote) {
  const bar = $(".bar", statusEl);
  const text = $(".status-text", statusEl);
  statusEl.hidden = false;
  statusEl.className = "status working";
  bar.style.width = "0%";
  text.textContent = "Loading ffmpeg.wasm…";
  try {
    await engine.load();
  } catch (err) {
    console.warn("ffmpeg.wasm unavailable, using the server:", err);
    setHealth("ok", "server ffmpeg");
    return remote();
  }
  setHealth("ok", "ffmpeg.wasm · in-browser");
  text.textContent = "ffmpeg is working its magic…";
  return local((frac) => {
    const pct = Math.round(frac * 100);
    statusEl.className = "status";
    bar.style.width = pct + "%";
    text.textContent = `ffmpeg is working its magic… ${pct}%`;
  });
}

/* ───────── browser storage ───────── */

// Processing happens in the browser too, so the session (source files, trims,
// settings, last results) lives in IndexedDB and survives a reload. Keys: "tab", "splice", "extract", "file:clip:<id>",
// "file:extract", "result:splice", "result:extract".
const store = (() => {
  let dbp = null;
  const open = () => (dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open("aerosplice", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction("kv", mode);
      const req = fn(t.objectStore("kv"));
      t.oncomplete = () => resolve(req.result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  }
  // Storage is a convenience: private windows, full quota etc. just mean nothing is remembered.
  const safe = (p, fallback) => p.catch((e) => { console.warn("storage:", e); return fallback; });
  return {
    get: (k) => safe(tx("readonly", (s) => s.get(k)), undefined),
    keys: () => safe(tx("readonly", (s) => s.getAllKeys()), []),
    set: (k, v) => safe(tx("readwrite", (s) => s.put(v, k))),
    del: (k) => safe(tx("readwrite", (s) => s.delete(k))),
  };
})();

let sessionLoaded = false;
let markSessionReady;
const sessionReady = new Promise((r) => { markSessionReady = r; });

const saveTimers = {};
function persistLater(key, snapshot) {
  if (!sessionLoaded) return; // don't overwrite the saved session with boot-time defaults
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => store.set(key, snapshot()), 250);
}

let persistAsked = false;
/** Ask the browser not to evict our blobs under storage pressure. */
function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}

function setSelect(select, value) {
  if (value && [...select.options].some((o) => o.value === value)) select.value = value;
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
    if (sessionLoaded) store.set("tab", tab.dataset.tab);
  });
});

/* ───────── bubbles ───────── */

function launchBubble(b, delay) {
  const size = 14 + Math.random() * 70;
  b.className = "bubble";
  b.style.transform = "";
  b.style.width = b.style.height = `${size}px`;
  b.style.left = `${Math.random() * 100}%`;
  b.style.setProperty("--drift", `${(Math.random() - 0.5) * 120}px`);
  b.style.animationDuration = `${14 + Math.random() * 18}s`;
  b.style.animationDelay = `${delay}s`;
}

let audioCtx = null;

/** A short synthesized "bloop": a falling sine plus a tiny burst of filtered noise. */
function popSound(size) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const out = audioCtx.createGain();
    out.gain.value = 0.5;
    out.connect(audioCtx.destination);

    // Smaller bubbles pop higher.
    const pitch = 1100 - size * 8 + Math.random() * 150;
    const osc = audioCtx.createOscillator();
    const og = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(pitch, t);
    osc.frequency.exponentialRampToValueAtTime(pitch * 0.25, t + 0.09);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.6, t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.13);

    const len = Math.floor(audioCtx.sampleRate * 0.03);
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const noise = audioCtx.createBufferSource();
    const bp = audioCtx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2400;
    bp.Q.value = 1.2;
    const ng = audioCtx.createGain();
    ng.gain.value = 0.35;
    noise.buffer = buf;
    noise.connect(bp).connect(ng).connect(out);
    noise.start(t);
  } catch { /* no audio, still pop visually */ }
}

const droplets = [];
let dropletFrame = 0;

/** Step every live droplet with simple ballistic physics, removing ones that fade out or fall off-screen. */
function stepDroplets(now) {
  const floor = innerHeight + 20;
  for (let i = droplets.length - 1; i >= 0; i--) {
    const d = droplets[i];
    const dt = Math.min((now - d.last) / 1000, 0.05); // clamp so a background tab doesn't teleport them
    d.last = now;
    d.vy += 1400 * dt; // gravity, px/s²
    d.vx *= 1 - 0.8 * dt; // a little air drag
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.age += dt;
    const fade = Math.max(0, 1 - Math.max(0, d.age - d.life * 0.6) / (d.life * 0.4));
    // Stretch slightly along the direction of travel, like a falling drop.
    const speed = Math.hypot(d.vx, d.vy);
    const stretch = 1 + Math.min(speed / 1500, 0.6);
    const angle = Math.atan2(d.vy, d.vx);
    d.el.style.transform =
      `translate3d(${d.x - d.r}px, ${d.y - d.r}px, 0) rotate(${angle}rad) scale(${stretch}, ${1 / stretch})`;
    d.el.style.opacity = fade;
    if (fade <= 0 || d.y > floor) {
      d.el.remove();
      droplets.splice(i, 1);
    }
  }
  dropletFrame = droplets.length ? requestAnimationFrame(stepDroplets) : 0;
}

function burst(host, cx, cy, size) {
  const spark = document.createElement("span");
  spark.className = "pop-spark";
  spark.style.left = `${cx}px`;
  spark.style.top = `${cy}px`;
  spark.style.setProperty("--s", `${size * 0.9 + 16}px`);
  spark.style.setProperty("--rot", `${Math.random() * 45}deg`);
  spark.addEventListener("animationend", () => spark.remove());
  host.appendChild(spark);

  const now = performance.now();
  const count = 6 + Math.round(size / 8);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const rim = size / 2 * (0.7 + Math.random() * 0.3);
    const speed = 60 + Math.random() * 140 + size * 1.2;
    const r = 1.2 + Math.random() * (1.5 + size / 40);
    const el = document.createElement("span");
    el.className = "droplet";
    el.style.width = el.style.height = `${r * 2}px`;
    host.appendChild(el);
    droplets.push({
      el, r, age: 0, last: now,
      life: 0.7 + Math.random() * 0.6,
      x: cx + Math.cos(a) * rim,
      y: cy + Math.sin(a) * rim,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - 120, // a small upward kick before gravity wins
    });
  }
  dropletFrame ||= requestAnimationFrame(stepDroplets);
}

function popBubble(b) {
  const r = b.getBoundingClientRect();
  // Freeze it where it is, then let the pop animation take over.
  b.style.transform = getComputedStyle(b).transform;
  b.style.animationDuration = b.style.animationDelay = ""; // these belong to the rise animation
  b.classList.add("popping");
  popSound(b.offsetWidth);
  burst(b.parentElement, r.left + r.width / 2, r.top + r.height / 2, r.width);
  setTimeout(() => {
    b.style.animation = "none";
    void b.offsetWidth; // restart the rise animation from the bottom
    b.style.animation = "";
    launchBubble(b, 1 + Math.random() * 4);
  }, 120);
}

// Bubbles live behind the layout, so hit-test them by hand on clicks that
// land on empty sky rather than on a panel or control.
const NOT_SKY = ".glass, .tabs, .health, .brand, button, input, select, a, label, audio, video, details";

function bubbleAt(x, y, target) {
  if (target.closest(NOT_SKY)) return null;
  for (const b of document.querySelectorAll(".bubble:not(.popping)")) {
    const r = b.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    if (dx * dx + dy * dy <= (r.width / 2 + 4) ** 2) return b;
  }
  return null;
}

(function bubbles() {
  const host = $(".bubbles");
  for (let i = 0; i < 18; i++) {
    const b = document.createElement("span");
    launchBubble(b, -Math.random() * 30);
    host.appendChild(b);
  }

  document.addEventListener("pointerdown", (e) => {
    const b = bubbleAt(e.clientX, e.clientY, e.target);
    if (b) popBubble(b);
  });

  let pending = false;
  document.addEventListener("pointermove", (e) => {
    if (pending || e.pointerType !== "mouse") return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      document.body.classList.toggle("over-bubble", !!bubbleAt(e.clientX, e.clientY, e.target));
    });
  });
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

function addClip(file, { id = splice.nextId, start = "", end = "" } = {}) {
  splice.nextId = Math.max(splice.nextId, id + 1);
  const clip = { id, file, duration: null };
  clip.el = buildClipRow(clip);
  $(".t-start", clip.el).value = start;
  $(".t-end", clip.el).value = end;
  clip.el.querySelectorAll(".clip-trim input").forEach(validateTimeInput);
  splice.clips.push(clip);
  splice.list.appendChild(clip.el);
  probeDuration(file).then((d) => { clip.duration = d; renderClipMeta(clip); renderTimeline(); });
  return clip;
}

async function addClips(files) {
  await sessionReady; // restored clips claim their ids first
  for (const file of files) store.set(`file:clip:${addClip(file).id}`, file);
  if (files.length) { requestPersistence(); warmUp(); }
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
  store.del(`file:clip:${clip.id}`);
  refreshSplice();
}

function stopPreview() {
  splice.player.pause();
  if (splice.player.src) URL.revokeObjectURL(splice.player.src);
  splice.player.removeAttribute("src");
  delete splice.player.dataset.id;
  splice.playingId = null;
  splice.clips.forEach((c) => { c.el.classList.remove("playing"); $(".play", c.el).textContent = "▶"; });
  document.querySelectorAll(".seg.playing").forEach((seg) => seg.classList.remove("playing"));
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
  renderTimeline();
});
splice.player.addEventListener("timeupdate", () => {
  const seg = $(`.seg[data-id="${splice.player.dataset.id}"]`);
  const c = clipById(Number(splice.player.dataset.id));
  if (!seg || !c) return;
  const { start, length } = clipSpan(c);
  const pct = Math.min(100, Math.max(0, ((splice.player.currentTime - start) / length) * 100));
  seg.classList.add("playing");
  seg.style.setProperty("--pos", `${pct}%`);
});

/** The part of a clip that will end up in the output, in seconds. */
function clipSpan(clip) {
  const start = parseTime($(".t-start", clip.el).value) || 0;
  const end = parseTime($(".t-end", clip.el).value);
  const stop = Number.isFinite(end) && end > start ? Math.min(end, clip.duration ?? end) : clip.duration;
  const length = stop != null && stop > start ? stop - start : null;
  return { start, length };
}

function renderRuler(el, total) {
  el.innerHTML = "";
  if (!total) return;
  for (let i = 0; i <= 4; i++) {
    const tick = document.createElement("span");
    tick.textContent = fmtTime((total * i) / 4);
    el.appendChild(tick);
  }
}

function renderTimeline() {
  const tl = $("#timeline");
  const known = splice.clips.map((c) => clipSpan(c).length).filter((l) => l != null);
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  let total = 0;
  let allKnown = true;

  tl.innerHTML = "";
  if (!splice.clips.length) {
    tl.innerHTML = '<div class="timeline-empty">Your spliced track will take shape here</div>';
  }
  splice.clips.forEach((c, i) => {
    const { length } = clipSpan(c);
    if (length == null) allKnown = false;
    total += length ?? 0;
    const seg = document.createElement("div");
    seg.className = "seg";
    seg.dataset.id = c.id;
    seg.style.flexGrow = length ?? fallback;
    seg.title = `${c.file.name} — ${fmtTime(length)}`;
    seg.innerHTML = "<b></b><span></span>";
    $("b", seg).textContent = i + 1;
    $("span", seg).textContent = c.file.name;
    seg.addEventListener("mouseenter", () => c.el.classList.add("hot"));
    seg.addEventListener("mouseleave", () => c.el.classList.remove("hot"));
    seg.addEventListener("click", () => c.el.scrollIntoView({ behavior: "smooth", block: "center" }));
    c.el.onmouseenter = () => seg.classList.add("hot");
    c.el.onmouseleave = () => seg.classList.remove("hot");
    tl.appendChild(seg);
  });

  renderRuler($("#ruler"), allKnown ? total : 0);
  const n = splice.clips.length;
  $("#splice-total").textContent = n
    ? `${n} clip${n > 1 ? "s" : ""} · ${allKnown ? fmtTime(total) : "…"}`
    : "0 clips";
}

function refreshSplice() {
  splice.clips.forEach((c, i) => { $(".idx", c.el).textContent = i + 1; });
  renderTimeline();
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
  persistLater("splice", () => ({
    nextId: splice.nextId,
    clips: splice.clips.map((c) => ({ id: c.id, start: $(".t-start", c.el).value, end: $(".t-end", c.el).value })),
    format: $("#splice-format").value,
    bitrate: $("#splice-bitrate").value,
    name: $("#splice-name").value,
  }));
}

function spliceForm(parts, settings) {
  const form = new FormData();
  for (const p of parts) form.append("files", p.file, p.file.name);
  form.append("trims", JSON.stringify(parts.map(({ start, end }) => ({ start, end }))));
  form.append("format", settings.format);
  form.append("bitrate", settings.bitrate);
  form.append("output_name", settings.name);
  return form;
}

async function runSplice() {
  const parts = splice.clips.map((c) => ({
    file: c.file, start: $(".t-start", c.el).value.trim(), end: $(".t-end", c.el).value.trim(),
  }));
  const settings = {
    format: $("#splice-format").value,
    bitrate: $("#splice-bitrate").value,
    name: $("#splice-name").value.trim() || "merged",
  };

  const btn = $("#splice-go");
  const statusEl = $("#splice-status");
  btn.disabled = true;
  $("#splice-result").hidden = true;
  try {
    const result = await processLocally(statusEl,
      (onProgress) => spliceInBrowser(parts, settings, onProgress),
      () => upload("api/splice", spliceForm(parts, settings), statusEl));
    showResult($("#splice-result"), statusEl, result);
    store.set("result:splice", result);
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
  splice.clips.forEach((c) => { c.el.remove(); store.del(`file:clip:${c.id}`); });
  splice.clips = [];
  store.del("result:splice");
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
  await sessionReady;
  store.set("file:extract", file);
  store.del("result:extract");
  requestPersistence();
  warmUp();
  await loadExtractFile(file);
}

async function loadExtractFile(file) {
  extract.file = file;
  if (extract.preview.src) URL.revokeObjectURL(extract.preview.src);
  extract.preview.src = URL.createObjectURL(file);
  const isVideo = file.type.startsWith("video");
  extract.preview.classList.toggle("audio-only", !isVideo);
  $("#extract-screen").classList.toggle("audio-mode", !isVideo);
  extract.preview.hidden = false;
  $("#extract-empty").hidden = true;
  extract.duration = null;
  const src = $("#extract-source");
  $(".source-name", src).textContent = file.name;
  $(".source-duration", src).textContent = "…";
  $(".source-size", src).textContent = fmtSize(file.size);
  $(".source-type", src).textContent = file.type || ext(file.name).toUpperCase() || "unknown";
  src.hidden = false;
  $("#extract-result").hidden = true;
  $("#extract-status").hidden = true;
  $("#extract-name").placeholder = `${stem(file.name)}-audio`;
  const d = await probeDuration(file);
  if (extract.file !== file) return;
  extract.duration = d;
  $(".source-duration", $("#extract-source")).textContent = fmtTime(d);
  refreshExtract();
}

function refreshExtract() {
  const okStart = validateTimeInput($("#extract-start"));
  const okEnd = validateTimeInput($("#extract-end"));
  $("#extract-go").disabled = !extract.file || !okStart || !okEnd;
  renderRange();

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
  persistLater("extract", () => ({
    start: $("#extract-start").value,
    end: $("#extract-end").value,
    format: $("#extract-format").value,
    bitrate: $("#extract-bitrate").value,
    name: $("#extract-name").value,
  }));
}

function extractForm(file, settings) {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("start", settings.start);
  form.append("end", settings.end);
  form.append("format", settings.format);
  form.append("bitrate", settings.bitrate);
  form.append("output_name", settings.name);
  return form;
}

async function runExtract() {
  const file = extract.file;
  const settings = {
    start: $("#extract-start").value.trim(),
    end: $("#extract-end").value.trim(),
    format: $("#extract-format").value,
    bitrate: $("#extract-bitrate").value,
    name: $("#extract-name").value.trim(),
  };

  const btn = $("#extract-go");
  const statusEl = $("#extract-status");
  btn.disabled = true;
  $("#extract-result").hidden = true;
  try {
    const result = await processLocally(statusEl,
      (onProgress) => extractInBrowser(file, settings, onProgress),
      () => upload("api/extract", extractForm(file, settings), statusEl));
    showResult($("#extract-result"), statusEl, result);
    store.set("result:extract", result);
  } catch (err) {
    showError(statusEl, err);
  } finally {
    refreshExtract();
  }
}

/** Draw the selected start–end slice on the range bar. */
function renderRange() {
  const d = extract.duration;
  const range = $("#extract-range");
  const start = parseTime($("#extract-start").value) || 0;
  const endRaw = parseTime($("#extract-end").value);
  const end = Number.isFinite(endRaw) && endRaw > start ? endRaw : d;
  renderRuler($("#extract-ruler"), d);
  if (!d) {
    range.style.setProperty("--from", "0%");
    range.style.setProperty("--to", "100%");
    $("#extract-span").textContent = extract.file ? "whole file" : "no file";
    return;
  }
  const pct = (t) => `${Math.min(100, Math.max(0, (t / d) * 100))}%`;
  range.style.setProperty("--from", pct(start));
  range.style.setProperty("--to", pct(end));
  const whole = !start && end >= d;
  $("#extract-span").textContent = whole
    ? `whole file · ${fmtTime(d)}`
    : `${fmtTime(start)} → ${fmtTime(Math.min(end, d))} · ${fmtTime(Math.min(end, d) - start)}`;
}

extract.preview.addEventListener("timeupdate", () => {
  if (!extract.duration) return;
  $("#extract-range").style.setProperty("--pos", `${(extract.preview.currentTime / extract.duration) * 100}%`);
});
$("#extract-range").addEventListener("click", (e) => {
  if (!extract.duration) return;
  const r = e.currentTarget.getBoundingClientRect();
  extract.preview.currentTime = ((e.clientX - r.left) / r.width) * extract.duration;
});

wireDrop($("#extract-drop"), $("#extract-input"), setExtractFile);
$("#extract-go").addEventListener("click", runExtract);
["#extract-start", "#extract-end", "#extract-name"].forEach((s) => $(s).addEventListener("input", refreshExtract));
document.querySelectorAll("#tab-extract [data-mark]").forEach((btn) =>
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
  try {
    await restoreSession();
  } finally {
    sessionLoaded = true;
    markSessionReady();
    refreshSplice();
    refreshExtract();
  }
})();

function restoreSettings(prefix, saved) {
  setSelect($(`#${prefix}-format`), saved.format);
  setSelect($(`#${prefix}-bitrate`), saved.bitrate);
  $(`#${prefix}-format`).dispatchEvent(new Event("change")); // re-sync the bitrate lock
  if (saved.name != null) $(`#${prefix}-name`).value = saved.name;
}

/** A stored blob can lose its backing data (site data cleared mid-session, eviction); treat that as gone. */
async function readable(blob) {
  if (!blob) return null;
  try {
    await blob.slice(0, 1).arrayBuffer();
    return blob;
  } catch {
    return null;
  }
}

async function restoreSession() {
  const [tab, sp, ex, spResult, exResult, exFile, keys] = await Promise.all([
    store.get("tab"), store.get("splice"), store.get("extract"),
    store.get("result:splice"), store.get("result:extract"), store.get("file:extract").then(readable), store.keys(),
  ]);
  if (tab) $(`.tab[data-tab="${tab}"]`)?.click();

  if (sp) {
    restoreSettings("splice", sp);
    splice.nextId = Math.max(splice.nextId, sp.nextId || 1);
    const files = await Promise.all(sp.clips.map((c) => store.get(`file:clip:${c.id}`).then(readable)));
    sp.clips.forEach((c, i) => { if (files[i]) addClip(files[i], c); });
  }
  if (spResult) showResult($("#splice-result"), $("#splice-status"), spResult);

  // Drop blobs left behind by clips that were removed before their save landed.
  const live = new Set(splice.clips.map((c) => `file:clip:${c.id}`));
  keys.filter((k) => String(k).startsWith("file:clip:") && !live.has(k)).forEach(store.del);

  if (ex) {
    restoreSettings("extract", ex);
    $("#extract-start").value = ex.start ?? "";
    $("#extract-end").value = ex.end ?? "";
  }
  if (exFile) {
    await loadExtractFile(exFile);
    if (exResult) showResult($("#extract-result"), $("#extract-status"), exResult);
  }
  if (splice.clips.length || exFile) warmUp();
}

function setHealth(state, label) {
  const pill = $("#health");
  pill.classList.remove("ok", "bad");
  if (state) pill.classList.add(state);
  $("span", pill).textContent = label;
}

/** Start downloading ffmpeg.wasm in the background once there's something to process. */
function warmUp() {
  engine.load().then(
    () => setHealth("ok", "ffmpeg.wasm · in-browser"),
    () => {}, // processLocally reports it (and falls back) when a job actually runs
  );
}

(async function health() {
  // The in-browser build does the work; the server is only a fallback.
  const [wasm, server] = await Promise.all([
    fetch(WASM_DIR + "ffmpeg-core.wasm", { method: "HEAD" }).then((r) => r.ok, () => false),
    fetch("api/health").then((r) => r.json(), () => null),
  ]);
  if (wasm) setHealth("ok", "ffmpeg.wasm · in-browser");
  else if (server?.ffmpeg) setHealth("ok", "server ffmpeg");
  else setHealth("bad", server ? "ffmpeg missing" : "offline");
})();
