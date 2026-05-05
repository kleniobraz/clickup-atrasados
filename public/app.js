/* ─────────────────────────────────────────────────────────────────────────
   app.js — ClickUp Tarefas Atrasadas
   Fluxo:
     1. loadTasks()       → GET /api/overdue
     2. renderTasks()     → monta tabela com 3 botões por linha
     3. handleKeep()      → remove da tela (sem chamada API)
     4. handleArchive()   → PUT /api/tasks/:id/archive → remove da tela
     5. openReschedule()  → modal → PUT /api/tasks/:id/reschedule → remove da tela
───────────────────────────────────────────────────────────────────────── */

'use strict';

// ── Estado ────────────────────────────────────────────────────────────────
let allTasks = [];
let filteredTasks = [];
let pendingTaskId = null;
let savedFilters = JSON.parse(localStorage.getItem('clickup_filters') || '{}');
let selectedEmpresas = new Set(savedFilters.empresas || []);

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Restaura filtros simples
  if (savedFilters.q) $('search-input').value = savedFilters.q;
  if (savedFilters.range) $('filter-range').value = savedFilters.range;

  await checkHealth();
  await loadTasks();
  bindEvents();
});

function saveFilters() {
  const filters = {
    q: $('search-input').value,
    range: $('filter-range').value,
    assignee: $('filter-assignee').value,
    empresas: [...selectedEmpresas]
  };
  localStorage.setItem('clickup_filters', JSON.stringify(filters));
}

// ── Health check: avisa se .env não está configurado ─────────────────────
async function checkHealth() {
  try {
    const { configured } = await fetch('/api/health').then((r) => r.json());
    if (!configured) $('setup-banner').classList.remove('hidden');
  } catch {
    $('setup-banner').classList.remove('hidden');
  }
}

// ── Buscar tarefas atrasadas ──────────────────────────────────────────────
async function loadTasks() {
  showState('loading');
  $('btn-refresh').classList.add('btn--spinning');

  try {
    const res = await fetch('/api/overdue');
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);

    allTasks = await res.json();
    $('last-updated').textContent = `Atualizado às ${currentTime()}`;
    populateAssigneeFilter();
    populateEmpresaFilter();
    applyFilters();
    updateStats();
  } catch (err) {
    $('error-msg').textContent = err.message;
    showState('error');
    toast(`Erro: ${err.message}`, 'error');
  } finally {
    $('btn-refresh').classList.remove('btn--spinning');
  }
}

// ── Filtros ───────────────────────────────────────────────────────────────

/** Popula o select de responsáveis com os nomes únicos das tarefas carregadas */
function populateAssigneeFilter() {
  const sel = $('filter-assignee');
  
  // Na primeira carga, usa o filtro salvo. Depois, preserva a seleção ativa.
  let current = sel.value;
  if (savedFilters.assignee !== undefined) {
    current = savedFilters.assignee;
    delete savedFilters.assignee; // consome o valor salvo
  }

  // Coletar todos os assignees únicos (por username)
  const seen = new Map();
  allTasks.forEach((t) => {
    (t.assignees || []).forEach((a) => {
      if (!seen.has(a.username)) seen.set(a.username, a.username);
    });
  });

  // Reconstruir opções mantendo a opção padrão
  sel.innerHTML = '<option value="">Todos os responsáveis</option>';
  [...seen.keys()].sort().forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === current) opt.selected = true;
    sel.appendChild(opt);
  });
}

/** Popula o dropdown múltiplo de empresas */
function populateEmpresaFilter() {
  const container = $('dropdown-empresa');
  const seen = new Set();

  allTasks.forEach((t) => {
    if (t.empresa) seen.add(t.empresa.name);
  });

  // Mantém selecionadas apenas as que ainda existem nos resultados
  const newSelected = new Set();
  [...seen].forEach(name => {
     if (selectedEmpresas.has(name)) newSelected.add(name);
  });
  selectedEmpresas = newSelected;

  container.innerHTML = '';
  [...seen].sort().forEach((name) => {
    const lbl = document.createElement('label');
    lbl.className = 'multi-select-label';
    
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.value = name;
    chk.checked = selectedEmpresas.has(name);
    
    chk.addEventListener('change', (e) => {
      if (e.target.checked) selectedEmpresas.add(name);
      else selectedEmpresas.delete(name);
      updateEmpresaButton();
      saveFilters();
      applyFilters();
    });
    
    lbl.appendChild(chk);
    lbl.appendChild(document.createTextNode(' ' + name));
    container.appendChild(lbl);
  });
  
  updateEmpresaButton();
}

function updateEmpresaButton() {
  const btn = $('btn-empresa-filter');
  if (selectedEmpresas.size === 0) {
    btn.textContent = 'Empresas: Todas';
  } else if (selectedEmpresas.size === 1) {
    btn.textContent = `Empresa: ${[...selectedEmpresas][0]}`;
  } else {
    btn.textContent = `Empresas: ${selectedEmpresas.size} selec.`;
  }
}

function applyFilters() {
  const q        = $('search-input').value.trim().toLowerCase();
  const range    = $('filter-range').value;
  const assignee = $('filter-assignee').value;

  filteredTasks = allTasks.filter((t) => {
    // filtro texto
    if (q && !t.name.toLowerCase().includes(q)) return false;
    // filtro responsável
    if (assignee && !t.assignees?.some((a) => a.username === assignee)) return false;
    // filtro empresa (múltiplo)
    if (selectedEmpresas.size > 0) {
      if (!t.empresa || !selectedEmpresas.has(t.empresa.name)) return false;
    }
    // filtro período de atraso
    if (range) {
      const d = daysLate(t.dueDate);
      if (range === 'today' && d !== 0) return false;
      if (range === 'week'  && (d < 1 || d > 7)) return false;
      if (range === 'old'   && d <= 7) return false;
    }
    return true;
  });

  renderTasks();
}

// ── Renderização ──────────────────────────────────────────────────────────
function renderTasks() {
  if (filteredTasks.length === 0) {
    showState('empty');
    return;
  }

  showState('table');
  $('result-count').textContent = plural(filteredTasks.length, 'tarefa encontrada', 'tarefas encontradas');
  $('task-tbody').innerHTML = filteredTasks.map(buildRow).join('');

  // Bind de ações
  filteredTasks.forEach(({ id, name, dueDate, url }) => {
    $(`keep-${id}`)?.addEventListener('click', () => handleKeep(id));
    $(`archive-${id}`)?.addEventListener('click', () =>
      handleArchive({ id, name })
    );
    $(`reschedule-${id}`)?.addEventListener('click', () =>
      openReschedule({ id, name })
    );
  });
}

function buildRow(t) {
  const days   = daysLate(t.dueDate);
  const badge  = badgeHtml(days);
  const due    = t.dueDate ? fmtDate(t.dueDate) : '—';
  const avs    = assigneesHtml(t.assignees);

  return `
    <tr id="row-${t.id}" class="task-row">
      <td class="col-task">
        <div class="task-name">
          <a class="task-name__link"
             href="${t.url}" target="_blank" rel="noopener"
             title="Abrir no ClickUp">
            ${esc(t.name)}
          </a>
          ${empresaHtml(t.empresa)}
        </div>
      </td>
      <td class="col-assignee">
        <div class="assignee-list">${avs}</div>
      </td>
      <td class="col-due"><span class="due-date">${due}</span></td>
      <td class="col-overdue">${badge}</td>
      <td class="col-actions">
        <div class="action-btns">
          <button id="keep-${t.id}"       class="btn btn--keep btn--sm"   title="Ocultar da lista sem alterar no ClickUp">Manter</button>
          <button id="archive-${t.id}"    class="btn btn--danger btn--sm" title="Fechar tarefa no ClickUp">Arquivar</button>
          <button id="reschedule-${t.id}" class="btn btn--warn btn--sm"   title="Definir nova data de vencimento">Reprogramar</button>
        </div>
      </td>
    </tr>`;
}

function assigneesHtml(list) {
  if (!list?.length) return '<span style="color:var(--text-dim);font-size:.8rem">—</span>';
  return list.map((a) => {
    const inner = a.profilePicture
      ? `<img src="${a.profilePicture}" alt="${esc(a.username)}" />`
      : esc(a.initials || '?');
    return `
      <div class="assignee-chip">
        <div class="assignee-avatar" style="background:${a.color||'#7B61FF'}" title="${esc(a.username)}">
          ${inner}
        </div>
        <span>${esc(a.username)}</span>
      </div>`;
  }).join('');
}

function empresaHtml(empresa) {
  if (!empresa) return '';
  // Convert hex color to rgba for background and use original hex for text to match the ClickUp look
  const bgColor = `${empresa.color}20`; // 20 hex = 12% opacity
  return `<div class="tag-list">
    <span class="tag-chip" style="background:${bgColor};color:${empresa.color};border: 1px solid ${empresa.color}40">${esc(empresa.name)}</span>
  </div>`;
}

// ── Ações ─────────────────────────────────────────────────────────────────

/** Manter: remove da tela, sem chamada ao ClickUp */
function handleKeep(id) {
  removeRow(id);
  toast('Tarefa ocultada da visualização.', 'info');
}

/** Arquivar: fecha a tarefa via PUT, depois remove da tela */
async function handleArchive({ id, name }) {
  const btn = $(`archive-${id}`);
  setDisabled(btn, true);

  try {
    const res = await fetch(`/api/tasks/${id}/archive`, { method: 'PUT' });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    removeRow(id);
    toast(`"${name}" arquivada com sucesso.`, 'ok');
  } catch (err) {
    toast(`Erro ao arquivar: ${err.message}`, 'error');
    setDisabled(btn, false);
  }
}

/** Reprogramar: abre modal com seletor de data */
function openReschedule({ id, name }) {
  pendingTaskId = id;
  $('modal-task-name').textContent = name;
  $('modal-date').value = '';
  $('modal-date').min = toDateValue(Date.now());
  $('modal-reschedule').classList.remove('hidden');
  setTimeout(() => $('modal-date').focus(), 60);
}

// ── Modal ─────────────────────────────────────────────────────────────────
$('modal-confirm').addEventListener('click', async () => {
  const dateVal = $('modal-date').value;
  if (!dateVal) { toast('Escolha uma data.', 'info'); return; }

  // noon local time → timestamp ms
  const due_date = new Date(dateVal + 'T12:00:00').getTime();
  const id = pendingTaskId;

  setDisabled($('modal-confirm'), true);
  try {
    const res = await fetch(`/api/tasks/${id}/reschedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ due_date }),
    });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    closeModal();
    removeRow(id);
    toast(`Reagendada para ${fmtDate(due_date)}.`, 'ok');
  } catch (err) {
    toast(`Erro ao reprogramar: ${err.message}`, 'error');
  } finally {
    setDisabled($('modal-confirm'), false);
  }
});

function closeModal() {
  $('modal-reschedule').classList.add('hidden');
  pendingTaskId = null;
}

$('modal-close').addEventListener('click', closeModal);
$('modal-cancel').addEventListener('click', closeModal);
$('modal-reschedule').addEventListener('click', (e) => {
  if (e.target === $('modal-reschedule')) closeModal();
});

// Preset buttons (+N dias)
document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const d = new Date();
    d.setDate(d.getDate() + parseInt(btn.dataset.days, 10));
    $('modal-date').value = toDateValue(d.getTime());
  });
});

// ── Eventos globais ───────────────────────────────────────────────────────
function bindEvents() {
  const onFilterChange = () => {
    saveFilters();
    applyFilters();
  };

  $('btn-refresh').addEventListener('click', loadTasks);
  $('search-input').addEventListener('input', debounce(onFilterChange, 220));
  $('filter-range').addEventListener('change', onFilterChange);
  $('filter-assignee').addEventListener('change', onFilterChange);
  
  // Custom dropdown toggle
  $('btn-empresa-filter').addEventListener('click', (e) => {
    e.stopPropagation(); // Evita que o evento de clique vaze para o document
    $('dropdown-empresa').classList.toggle('hidden');
  });

  // Fechar dropdown ao clicar fora dele
  document.addEventListener('click', (e) => {
    const container = $('empresa-filter-container');
    const dropdown = $('dropdown-empresa');
    if (container && !container.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });

  $('btn-clear').addEventListener('click', () => {
    $('search-input').value = '';
    $('filter-range').value = '';
    $('filter-assignee').value = '';
    
    // Limpa a seleção múltipla
    selectedEmpresas.clear();
    document.querySelectorAll('#dropdown-empresa input[type="checkbox"]').forEach(chk => chk.checked = false);
    updateEmpresaButton();
    
    saveFilters();
    applyFilters();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────
function updateStats() {
  const dl = (t) => daysLate(t.dueDate);
  $('stat-total').textContent = allTasks.length;
  $('stat-today').textContent = allTasks.filter((t) => dl(t) === 0).length;
  $('stat-week').textContent  = allTasks.filter((t) => dl(t) >= 1 && dl(t) <= 7).length;
  $('stat-old').textContent   = allTasks.filter((t) => dl(t) > 7).length;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function removeRow(id) {
  const row = $(`row-${id}`);
  if (!row) return;
  row.classList.add('task-row-exit');
  row.addEventListener('animationend', () => {
    allTasks      = allTasks.filter((t) => t.id !== id);
    filteredTasks = filteredTasks.filter((t) => t.id !== id);
    row.remove();
    updateStats();
    const n = filteredTasks.length;
    $('result-count').textContent = plural(n, 'tarefa encontrada', 'tarefas encontradas');
    if (n === 0) showState('empty');
  }, { once: true });
}

function showState(state) {
  $('state-loading').classList.toggle('hidden', state !== 'loading');
  $('state-empty').classList.toggle('hidden',   state !== 'empty');
  $('state-error').classList.toggle('hidden',   state !== 'error');
  $('table-container').classList.toggle('hidden', state !== 'table');
}

function daysLate(ts) {
  if (!ts) return 0;
  return Math.max(0, Math.floor((Date.now() - ts) / 86_400_000));
}

function badgeHtml(days) {
  const cls   = days > 14 ? '' : days >= 8 ? 'overdue-badge--warn' : 'overdue-badge--light';
  const label = days === 0 ? 'venceu hoje' : `${days === 1 ? '1 dia' : days + ' dias'} atrasada`;
  return `<span class="overdue-badge ${cls}">${label}</span>`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function toDateValue(ts) {
  const d = new Date(ts);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function currentTime() {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function plural(n, singular, plural_) {
  return `${n} ${n === 1 ? singular : plural_}`;
}

function setDisabled(el, v) {
  if (el) { el.disabled = v; el.style.opacity = v ? '0.5' : ''; }
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const icons = { ok: '✅', error: '❌', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${esc(msg)}</span>`;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
