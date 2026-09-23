'use strict';

/* ---------- Съхранение (IndexedDB – данните остават на устройството) ---------- */

const DB_NAME = 'home-pharmacy';
const STORE = 'medicines';
let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const dbAll = () => tx('readonly', s => s.getAll());
const dbPut = item => tx('readwrite', s => s.put(item));
const dbDelete = id => tx('readwrite', s => s.delete(id));

/* ---------- Настройки ---------- */

const SETTINGS_KEY = 'home-pharmacy-settings';
const settings = { warnDays: 30, lastBy: '' };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* ignore */ }
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
}

/* ---------- Помощни функции ---------- */

const $ = sel => document.querySelector(sel);
const collator = new Intl.Collator('bg', { sensitivity: 'base', numeric: true });

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(iso) {
  const d = parseDate(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Връща 'expired' | 'soon' | 'ok' и броя дни до изтичане. Лекарството е годно до края на посочения ден. */
function expiryStatus(iso) {
  const days = Math.round((parseDate(iso) - todayMidnight()) / 86400000);
  if (days < 0) return { status: 'expired', days };
  if (days <= settings.warnDays) return { status: 'soon', days };
  return { status: 'ok', days };
}

function statusLabel({ status, days }) {
  if (status === 'expired') return days === -1 ? 'Изтекъл вчера' : `Изтекъл преди ${-days} дни`;
  if (status === 'soon') return days === 0 ? 'Изтича днес' : days === 1 ? 'Изтича утре' : `Изтича след ${days} дни`;
  return 'Валиден';
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2500);
}

/** Смалява снимката, за да не пълни паметта на телефона. */
function resizeImage(file, maxSide = 1000, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Снимката не може да се отвори')); };
    img.src = url;
  });
}

/* ---------- Състояние и визуализация ---------- */

let medicines = [];
let filter = 'all';
let query = '';

function firstLetter(name) {
  const ch = (name.trim()[0] || '#').toLocaleUpperCase('bg');
  return /[\p{L}]/u.test(ch) ? ch : '#';
}

function render() {
  const counts = { all: 0, soon: 0, expired: 0, ok: 0 };
  const q = query.trim().toLocaleLowerCase('bg');

  const withStatus = medicines.map(m => ({ ...m, st: expiryStatus(m.expiry) }));
  const searched = withStatus.filter(m =>
    !q || m.name.toLocaleLowerCase('bg').includes(q) || (m.description || '').toLocaleLowerCase('bg').includes(q));

  for (const m of searched) { counts.all++; counts[m.st.status]++; }
  document.querySelectorAll('[data-count]').forEach(el => { el.textContent = counts[el.dataset.count]; });

  const visible = searched
    .filter(m => filter === 'all' || m.st.status === filter)
    .sort((a, b) => collator.compare(a.name, b.name));

  const list = $('#list');
  if (!medicines.length) {
    list.innerHTML = `<div class="empty"><div class="big">💊</div>
      <p>Още няма добавени лекарства.<br>Натиснете бутона <b>＋</b> долу вдясно, за да добавите първото.</p></div>`;
    return;
  }
  if (!visible.length) {
    list.innerHTML = `<div class="empty"><div class="big">🔍</div><p>Няма лекарства, които отговарят на търсенето или филтъра.</p></div>`;
    return;
  }

  let html = '';
  let current = null;
  for (const m of visible) {
    const letter = firstLetter(m.name);
    if (letter !== current) {
      if (current !== null) html += '</div>';
      html += `<div class="letter">${escapeHtml(letter)}</div><div class="cards">`;
      current = letter;
    }
    const thumb = m.photo
      ? `<img class="thumb" src="${m.photo}" alt="" loading="lazy">`
      : '<div class="thumb">💊</div>';
    html += `
      <button class="card ${m.st.status}" data-id="${escapeHtml(m.id)}">
        ${thumb}
        <div class="card-body">
          <div class="card-name">${escapeHtml(m.name)}</div>
          ${m.description ? `<div class="card-desc">${escapeHtml(m.description)}</div>` : ''}
          <div class="card-meta">
            <span>до ${formatDate(m.expiry)}</span>
            <span class="badge ${m.st.status}">${statusLabel(m.st)}</span>
            ${m.addedBy ? `<span>👤 ${escapeHtml(m.addedBy)}</span>` : ''}
          </div>
        </div>
      </button>`;
  }
  html += '</div>';
  list.innerHTML = html;
}

async function reload() {
  medicines = await dbAll();
  render();
}

function updateHeaderHeight() {
  document.documentElement.style.setProperty('--header-h', $('.top').offsetHeight + 'px');
}

/* ---------- Добавяне / редакция ---------- */

const dlgEdit = $('#dlg-edit');
let editingId = null;
let editingPhoto = null;

function showPhoto(dataUrl) {
  editingPhoto = dataUrl || null;
  $('#photo-preview').hidden = !editingPhoto;
  $('#photo-empty').hidden = !!editingPhoto;
  $('#photo-remove').hidden = !editingPhoto;
  if (editingPhoto) $('#photo-preview').src = editingPhoto;
  else $('#photo-preview').removeAttribute('src');
}

function openEditor(med) {
  editingId = med ? med.id : null;
  $('#edit-title').textContent = med ? 'Редакция' : 'Ново лекарство';
  $('#f-name').value = med ? med.name : '';
  $('#f-desc').value = med ? med.description || '' : '';
  $('#f-expiry').value = med ? med.expiry : '';
  $('#f-by').value = med ? med.addedBy || '' : settings.lastBy || '';
  $('#btn-delete').hidden = !med;
  showPhoto(med ? med.photo : null);
  dlgEdit.showModal();
  dlgEdit.scrollTop = 0;
}

async function onPhotoPicked(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    showPhoto(await resizeImage(file));
  } catch (err) {
    toast(err.message);
  }
}

$('#photo-camera').addEventListener('change', onPhotoPicked);
$('#photo-gallery').addEventListener('change', onPhotoPicked);
$('#photo-remove').addEventListener('click', () => showPhoto(null));
$('#btn-cancel').addEventListener('click', () => dlgEdit.close());
$('#btn-add').addEventListener('click', () => openEditor(null));

$('#form-edit').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#f-name').value.trim();
  const expiry = $('#f-expiry').value;
  if (!name) { toast('Въведете име на лекарството'); $('#f-name').focus(); return; }
  if (!expiry) { toast('Въведете срок на годност'); $('#f-expiry').focus(); return; }

  const existing = medicines.find(m => m.id === editingId);
  const now = new Date().toISOString();
  const item = {
    id: editingId || newId(),
    name,
    description: $('#f-desc').value.trim(),
    expiry,
    addedBy: $('#f-by').value.trim(),
    photo: editingPhoto,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  try {
    await dbPut(item);
  } catch (err) {
    toast('Грешка при запис: ' + (err && err.message || err));
    return;
  }
  if (item.addedBy) { settings.lastBy = item.addedBy; saveSettings(); }
  dlgEdit.close();
  toast(existing ? 'Промените са запазени' : 'Лекарството е добавено');
  reload();
});

$('#list').addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (!card) return;
  const med = medicines.find(m => m.id === card.dataset.id);
  if (med) openEditor(med);
});

/* ---------- Изтриване ---------- */

function confirmDialog(text) {
  const dlg = $('#dlg-confirm');
  $('#confirm-text').textContent = text;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true }));
}

$('#btn-delete').addEventListener('click', async () => {
  const med = medicines.find(m => m.id === editingId);
  if (!med) return;
  if (!(await confirmDialog(`Сигурни ли сте, че искате да изтриете „${med.name}“?`))) return;
  await dbDelete(med.id);
  dlgEdit.close();
  toast('Лекарството е изтрито');
  reload();
});

/* ---------- Търсене и филтри ---------- */

$('#search').addEventListener('input', e => { query = e.target.value; render(); });

document.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
  filter = chip.dataset.filter;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
  render();
}));

/* ---------- Настройки, резервно копие ---------- */

const dlgSettings = $('#dlg-settings');
$('#btn-settings').addEventListener('click', () => {
  $('#s-days').value = settings.warnDays;
  dlgSettings.showModal();
});
dlgSettings.addEventListener('close', () => {
  const v = parseInt($('#s-days').value, 10);
  if (v >= 1 && v <= 365 && v !== settings.warnDays) {
    settings.warnDays = v;
    saveSettings();
    render();
  }
});

$('#btn-export').addEventListener('click', async () => {
  const data = JSON.stringify({ app: 'home-pharmacy', version: 1, exportedAt: new Date().toISOString(), medicines: await dbAll() });
  const fileName = `apteka-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([data], fileName, { type: 'application/json' });
  // На телефон предпочитаме менюто „Сподели“ (Viber, имейл, Файлове…)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Домашна аптечка' }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#import-file').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.medicines;
    if (!Array.isArray(list)) throw new Error('непознат формат');
    let added = 0, updated = 0;
    const byId = new Map(medicines.map(m => [m.id, m]));
    for (const m of list) {
      if (!m || !m.id || !m.name || !/^\d{4}-\d{2}-\d{2}$/.test(m.expiry)) continue;
      const mine = byId.get(m.id);
      // При съвпадение остава по-новата версия
      if (mine && (mine.updatedAt || '') >= (m.updatedAt || '')) continue;
      await dbPut({
        id: String(m.id), name: String(m.name), description: String(m.description || ''),
        expiry: m.expiry, addedBy: String(m.addedBy || ''),
        photo: typeof m.photo === 'string' && m.photo.startsWith('data:image/') ? m.photo : null,
        createdAt: m.createdAt || new Date().toISOString(), updatedAt: m.updatedAt || new Date().toISOString(),
      });
      mine ? updated++ : added++;
    }
    await reload();
    toast(`Заредени: ${added} нови, ${updated} обновени`);
  } catch (err) {
    toast('Файлът не може да бъде зареден (' + err.message + ')');
  }
});

/* ---------- Старт ---------- */

window.addEventListener('resize', updateHeaderHeight);
updateHeaderHeight();
reload().catch(err => {
  $('#list').innerHTML = `<div class="empty"><p>Грешка при отваряне на данните: ${escapeHtml(err && err.message || err)}</p></div>`;
});

// Статусите зависят от датата – опресняваме при връщане в приложението
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
