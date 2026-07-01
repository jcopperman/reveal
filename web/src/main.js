import { marked } from 'marked';

const $ = (sel) => document.querySelector(sel);

const state = {
  files: [], // File[]
  current: null, // last investigation result
};

// --- provider badge ----------------------------------------------------------
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => ($('#provider-badge').textContent = `provider: ${h.provider}`))
  .catch(() => ($('#provider-badge').textContent = 'provider: offline'));

// --- file upload (click + drag/drop) ----------------------------------------
const fileInput = $('#file-input');
const dropzone = $('#dropzone');

fileInput.addEventListener('change', () => addFiles(fileInput.files));

['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
  }),
);
dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

function addFiles(fileList) {
  for (const f of fileList) {
    if (!state.files.some((x) => x.name === f.name && x.size === f.size)) {
      state.files.push(f);
    }
  }
  renderFileList();
  refreshInvestigateEnabled();
}

function renderFileList() {
  const ul = $('#file-list');
  ul.innerHTML = '';
  state.files.forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>📄 ${escapeHtml(f.name)} <small>(${fmtSize(f.size)})</small></span>`;
    const rm = document.createElement('button');
    rm.textContent = '✕';
    rm.className = 'rm';
    rm.onclick = () => {
      state.files.splice(i, 1);
      renderFileList();
      refreshInvestigateEnabled();
    };
    li.appendChild(rm);
    ul.appendChild(li);
  });
}

// --- prompt + investigate ----------------------------------------------------
$('#prompt').addEventListener('input', refreshInvestigateEnabled);

function refreshInvestigateEnabled() {
  const ready = state.files.length > 0 && $('#prompt').value.trim().length > 0;
  $('#investigate').disabled = !ready;
}

$('#investigate').addEventListener('click', runInvestigation);

async function runInvestigation() {
  const btn = $('#investigate');
  btn.disabled = true;
  setStatus('Parsing logs and consulting the model…', 'busy');

  const fd = new FormData();
  fd.append('prompt', $('#prompt').value.trim());
  for (const f of state.files) fd.append('files', f);

  try {
    const res = await fetch('/api/investigate', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Investigation failed.');
    state.current = data;
    renderReport(data);
    renderEvidence(data);
    setStatus(`Done · investigation #${data.id}`, 'ok');
    $('#export').disabled = false;
    loadHistory();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    refreshInvestigateEnabled();
  }
}

// --- rendering ---------------------------------------------------------------
function renderReport(data) {
  const md = data.reportMd;
  const html = marked.parse(md);
  const warn = data.validation?.warnings?.length
    ? `<div class="cite-banner ok-cite">✔ ${data.validation.citedIds.length} evidence citations · ${data.validation.warnings.length} citation warning(s)</div>`
    : `<div class="cite-banner ok-cite">✔ ${data.validation?.citedIds?.length || 0} evidence citations · all conclusions cite evidence or are marked speculation</div>`;
  $('#report').innerHTML = warn + `<div class="md">${html}</div>`;

  // Make evidence IDs in the report clickable to highlight the source line.
  linkifyEvidenceIds($('#report'));
}

function renderEvidence(data) {
  const box = $('#evidence');
  const sel = data.evidence?.selected || [];
  const stats = data.evidence?.stats;
  if (!sel.length) {
    box.innerHTML = '<div class="empty">No evidence selected.</div>';
    return;
  }
  const header = stats
    ? `<div class="ev-stats">Selected <b>${stats.selectedCount}</b> of ${stats.totalEntries} records · ${stats.usedChars}/${stats.charBudget} chars${stats.truncated ? ' · truncated' : ''}</div>`
    : '';
  box.innerHTML =
    header +
    sel
      .map(
        (e) => `
      <div class="ev-line" id="ev-${e.id}">
        <div class="ev-meta">
          <span class="ev-id">${e.id}</span>
          <span class="lvl lvl-${(e.level || 'INFO').toLowerCase()}">${e.level || ''}</span>
          ${e.httpStatus ? `<span class="http http-${String(e.httpStatus)[0]}xx">${e.httpStatus}</span>` : ''}
          <span class="ev-time">${e.timestamp || ''}</span>
        </div>
        <pre>${escapeHtml(e.raw)}</pre>
        <div class="ev-reasons">${(e._reasons || []).map((r) => `<span>${escapeHtml(r)}</span>`).join('')}</div>
      </div>`,
      )
      .join('');
}

function linkifyEvidenceIds(root) {
  // Replace "L123" tokens inside evidence parentheticals with anchors.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    if (/\bL\d+\b/.test(walker.currentNode.nodeValue)) targets.push(walker.currentNode);
  }
  for (const node of targets) {
    const frag = document.createDocumentFragment();
    const parts = node.nodeValue.split(/(\bL\d+\b)/);
    for (const p of parts) {
      if (/^L\d+$/.test(p)) {
        const a = document.createElement('a');
        a.href = `#ev-${p}`;
        a.className = 'evref';
        a.textContent = p;
        a.onclick = (e) => {
          e.preventDefault();
          const el = $(`#ev-${p}`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('flash');
            setTimeout(() => el.classList.remove('flash'), 1500);
          }
        };
        frag.appendChild(a);
      } else {
        frag.appendChild(document.createTextNode(p));
      }
    }
    node.parentNode.replaceChild(frag, node);
  }
}

// --- history -----------------------------------------------------------------
async function loadHistory() {
  try {
    const rows = await (await fetch('/api/investigations')).json();
    const ul = $('#history');
    ul.innerHTML = '';
    if (!rows.length) {
      ul.innerHTML = '<li class="empty">No saved investigations yet.</li>';
      return;
    }
    for (const r of rows) {
      const li = document.createElement('li');
      li.innerHTML = `<button class="hist-btn"><b>#${r.id}</b> ${escapeHtml(
        truncate(r.prompt, 48),
      )}<br><small>${escapeHtml(r.files.join(', '))} · ${new Date(
        r.created_at,
      ).toLocaleString()}</small></button>`;
      li.querySelector('button').onclick = () => openInvestigation(r.id);
      ul.appendChild(li);
    }
  } catch {
    /* ignore */
  }
}

async function openInvestigation(id) {
  setStatus(`Loading investigation #${id}…`, 'busy');
  try {
    const data = await (await fetch(`/api/investigations/${id}`)).json();
    // Normalise saved shape to the live-result shape.
    state.current = data;
    renderReport(data);
    renderEvidence(data);
    $('#export').disabled = false;
    setStatus(`Loaded investigation #${id}`, 'ok');
  } catch (err) {
    setStatus('Could not load investigation.', 'error');
  }
}

// --- export ------------------------------------------------------------------
$('#export').addEventListener('click', () => {
  if (!state.current) return;
  const id = state.current.id;
  window.location.href = `/api/investigations/${id}/export`;
});

// --- utils -------------------------------------------------------------------
function setStatus(msg, kind) {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status ${kind || ''}`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}
function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// initial load
loadHistory();
