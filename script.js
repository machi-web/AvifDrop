/* AvifDrop — client-side PNG/JPEG/WebP → AVIF converter */
import encode from 'https://esm.sh/@jsquash/avif/encode';
import { heicTo } from 'https://esm.sh/heic-to';

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);

const state = {
  supported: false,
  results: [],   // { originalName, originalSize, avifBlob, avifSize }
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const el = {
  browserWarning:  document.getElementById('browser-warning'),
  qualitySlider:   document.getElementById('quality-slider'),
  qualityBadge:    document.getElementById('quality-badge'),
  losslessToggle:  document.getElementById('lossless-toggle'),
  dropZone:        document.getElementById('drop-zone'),
  fileInput:       document.getElementById('file-input'),
  pickBtn:         document.getElementById('pick-btn'),
  resultsSection:  document.getElementById('results-section'),
  fileGrid:        document.getElementById('file-grid'),
  summary:         document.getElementById('summary'),
  downloadAllBtn:  document.getElementById('download-all-btn'),
  clearBtn:        document.getElementById('clear-btn'),
};

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  state.supported = await detectAvifSupport();
  if (!state.supported) {
    el.browserWarning.classList.remove('hidden');
  }
  setupListeners();
  updateSliderFill();
})();

async function detectAvifSupport() {
  return typeof WebAssembly !== 'undefined';
}

// ── Listeners ─────────────────────────────────────────────────────────────────
function setupListeners() {
  // Drop zone — drag events
  el.dropZone.addEventListener('dragenter', e => { e.preventDefault(); });
  el.dropZone.addEventListener('dragover',  e => { e.preventDefault(); el.dropZone.classList.add('dragover'); });
  el.dropZone.addEventListener('dragleave', e => {
    if (!el.dropZone.contains(e.relatedTarget)) el.dropZone.classList.remove('dragover');
  });
  el.dropZone.addEventListener('drop', e => {
    e.preventDefault();
    el.dropZone.classList.remove('dragover');
    handleFiles(Array.from(e.dataTransfer.files));
  });

  // Drop zone — click / keyboard
  el.dropZone.addEventListener('click', e => {
    if (e.target !== el.pickBtn) el.fileInput.click();
  });
  el.dropZone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
  });
  el.pickBtn.addEventListener('click', e => {
    e.stopPropagation();
    el.fileInput.click();
  });
  el.fileInput.addEventListener('change', e => {
    handleFiles(Array.from(e.target.files));
    e.target.value = '';
  });

  // Quality slider
  el.qualitySlider.addEventListener('input', () => {
    el.qualityBadge.textContent = el.qualitySlider.value;
    updateSliderFill();
  });

  // Lossless toggle
  el.losslessToggle.addEventListener('change', () => {
    const lossless = el.losslessToggle.checked;
    el.qualitySlider.disabled = lossless;
    el.qualityBadge.textContent = lossless ? '∞' : el.qualitySlider.value;
  });

  // Actions
  el.downloadAllBtn.addEventListener('click', downloadAll);
  el.clearBtn.addEventListener('click', clearAll);
}

function updateSliderFill() {
  const min = 1, max = 100;
  const val = parseInt(el.qualitySlider.value);
  const pct = ((val - min) / (max - min)) * 100;
  el.qualitySlider.style.background =
    `linear-gradient(to right, #6366f1 ${pct}%, #e5e7eb ${pct}%)`;
}

// ── File handling ─────────────────────────────────────────────────────────────
function handleFiles(files) {
  const valid = files.filter(f => ACCEPTED_TYPES.has(f.type) || /\.(heic|heif)$/i.test(f.name));
  if (valid.length === 0) return;
  if (!state.supported) {
    el.browserWarning.classList.remove('hidden');
    return;
  }
  el.resultsSection.classList.remove('hidden');
  // Process up to 4 concurrently
  batchProcess(valid, 4, convertAndRender);
}

async function batchProcess(items, concurrency, fn) {
  let i = 0;
  async function next() {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
}

async function convertAndRender(file) {
  const card = buildLoadingCard(file);
  el.fileGrid.prepend(card);

  try {
    const quality    = el.losslessToggle.checked ? 1.0 : parseInt(el.qualitySlider.value) / 100;
    const avifBlob   = await convertToAvif(file, quality);
    const result     = {
      originalName: file.name,
      originalSize: file.size,
      avifBlob,
      avifSize: avifBlob.size,
    };
    state.results.push(result);
    renderDoneCard(card, result);
    updateSummary();
  } catch (err) {
    renderErrorCard(card, err.message);
  }
}

// ── Conversion ────────────────────────────────────────────────────────────────
function isHeic(file) {
  return file.type === 'image/heic' || file.type === 'image/heif' || /\.(heic|heif)$/i.test(file.name);
}

async function heicToImageData(file) {
  // Try browser-native decode first (Safari 16.4+)
  const nativeOk = await new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload  = () => { URL.revokeObjectURL(url); resolve(true); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
    img.src = url;
  });

  const source = nativeOk
    ? file
    : await heicTo({ blob: file, type: 'image/png' });

  return imgFileToImageData(source);
}

async function imgFileToImageData(source) {
  const img = await loadImage(source);
  const canvas = document.createElement('canvas');
  canvas.width  = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

async function fileToImageData(file) {
  if (isHeic(file)) return heicToImageData(file);
  return imgFileToImageData(file);
}

async function convertToAvif(file, quality) {
  const imageData = await fileToImageData(file);
  const q = Math.round(quality * 100); // quality is 0.0–1.0; @jsquash/avif expects 0–100
  const buffer = await encode(imageData, { quality: q });
  const blob = new Blob([buffer], { type: 'image/avif' });
  if (!blob || blob.size === 0) throw new Error('変換に失敗しました');
  return blob;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}

function toBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

// ── Card builders ─────────────────────────────────────────────────────────────
function buildLoadingCard(file) {
  const previewUrl = URL.createObjectURL(file);
  const card = document.createElement('div');
  card.className = 'file-card loading';
  card.innerHTML = `
    <div class="card-preview">
      <img class="preview-img" src="${previewUrl}" alt=""
           onload="URL.revokeObjectURL(this.src)" onerror="URL.revokeObjectURL(this.src)">
      <div class="loading-overlay"><div class="spinner"></div></div>
    </div>
    <div class="card-info">
      <div class="card-filename" title="${esc(file.name)}">${esc(truncate(file.name, 30))}</div>
      <div class="card-sizes">
        <span class="size-original">${fmtSize(file.size)}</span>
        <span class="size-arrow">→</span>
        <span class="size-converted">変換中…</span>
      </div>
    </div>
    <div class="card-actions">
      <button class="card-dl-btn" disabled>ダウンロード</button>
    </div>`;
  return card;
}

function renderDoneCard(card, result) {
  card.classList.remove('loading');

  card.querySelector('.loading-overlay')?.remove();

  const savings = (1 - result.avifSize / result.originalSize) * 100;
  const smaller = result.avifSize < result.originalSize;

  card.querySelector('.size-converted').textContent = fmtSize(result.avifSize);

  const savingsEl = document.createElement('div');
  savingsEl.className = 'card-savings';
  savingsEl.innerHTML = smaller
    ? `<span class="savings-good">▼ ${savings.toFixed(1)}% 削減</span>`
    : `<span class="savings-warn">▲ ${Math.abs(savings).toFixed(1)}% 増加</span>`;
  card.querySelector('.card-sizes').after(savingsEl);

  const btn = card.querySelector('.card-dl-btn');
  btn.disabled = false;
  btn.addEventListener('click', () =>
    triggerDownload(result.avifBlob, toAvifName(result.originalName))
  );
}

function renderErrorCard(card, message) {
  card.classList.remove('loading');
  card.classList.add('error');
  card.querySelector('.loading-overlay')?.remove();

  const errEl = document.createElement('div');
  errEl.className = 'card-error-msg';
  errEl.textContent = `⚠ ${message}`;
  card.querySelector('.card-sizes').after(errEl);

  card.querySelector('.card-dl-btn').remove();
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function downloadAll() {
  const done = state.results;
  if (done.length === 0) return;

  if (done.length === 1) {
    triggerDownload(done[0].avifBlob, toAvifName(done[0].originalName));
    return;
  }

  const origLabel = el.downloadAllBtn.innerHTML;
  el.downloadAllBtn.disabled = true;
  el.downloadAllBtn.textContent = '準備中…';

  try {
    const zip = new JSZip();
    done.forEach(r => zip.file(toAvifName(r.originalName), r.avifBlob));
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    triggerDownload(zipBlob, 'avif-images.zip');
  } finally {
    el.downloadAllBtn.disabled = false;
    el.downloadAllBtn.innerHTML = origLabel;
  }
}

function clearAll() {
  state.results = [];
  el.fileGrid.innerHTML = '';
  el.resultsSection.classList.add('hidden');
  el.summary.textContent = '';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function updateSummary() {
  const done = state.results;
  if (done.length === 0) { el.summary.textContent = ''; return; }
  const origTotal = done.reduce((s, r) => s + r.originalSize, 0);
  const avifTotal = done.reduce((s, r) => s + r.avifSize, 0);
  const pct       = ((1 - avifTotal / origTotal) * 100).toFixed(1);
  el.summary.textContent =
    `${done.length}件  ${fmtSize(origTotal)} → ${fmtSize(avifTotal)}（${pct > 0 ? '▼' : '▲'} ${Math.abs(pct)}%）`;
}

function toAvifName(filename) {
  return filename.replace(/\.(png|jpe?g|webp)$/i, '') + '.avif';
}

function fmtSize(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function truncate(str, max) {
  if (str.length <= max) return str;
  const dot = str.lastIndexOf('.');
  if (dot > 0 && str.length - dot <= 7) {
    const ext  = str.slice(dot);
    const base = str.slice(0, dot);
    return base.slice(0, max - 3 - ext.length) + '…' + ext;
  }
  return str.slice(0, max - 1) + '…';
}

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
