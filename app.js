'use strict';

/* ---------- Помощни функции ---------- */

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const collator = new Intl.Collator('bg', { sensitivity: 'base', numeric: true });
const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* ignore */ }
  return null;
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

/** 'expired' | 'soon' | 'ok' и броя дни до изтичане. Лекарството е годно до края на посочения ден. */
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
  toast.t = setTimeout(() => { el.hidden = true; }, 3000);
}

function showMsg(el, text, isError = true) {
  el.textContent = text || '';
  el.hidden = !text;
  el.classList.toggle('error', isError);
}

/** Превежда най-честите грешки от сървъра на разбираем език. */
function humanError(err) {
  const m = String((err && (err.message || err.error_description)) || err || '');
  if (/Invalid login credentials/i.test(m)) return 'Грешен имейл или парола.';
  if (/Email not confirmed/i.test(m)) return 'Имейлът още не е потвърден. Отворете писмото, което получихте, и натиснете линка.';
  if (/User already registered/i.test(m)) return 'Вече има профил с този имейл. Изберете „Вход“.';
  if (/Password should be at least/i.test(m)) return 'Паролата трябва да е поне 6 знака.';
  if (/rate limit|too many/i.test(m)) return 'Твърде много опити. Изчакайте малко и опитайте пак.';
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return 'Няма връзка с интернет.';
  return m || 'Неизвестна грешка';
}

/** Смалява снимката, за да се качва бързо и да не пълни паметта. */
function resizeImage(file, maxSide = 1200, quality = 0.8) {
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
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Снимката не може да се обработи'))), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Снимката не може да се отвори')); };
    img.src = url;
  });
}

/* ---------- Настройки на устройството ---------- */

const SETTINGS_KEY = 'apteka-settings';
const settings = Object.assign({ warnDays: 30 }, store(SETTINGS_KEY) || {});
const saveSettings = () => store(SETTINGS_KEY, settings);

/* ---------- Връзка със сървъра ---------- */

const cfg = window.APP_CONFIG || {};
const PHOTO_BUCKET = 'medicine-photos';
let sb = null;

let user = null;       // вписан потребител
let family = null;     // { id, name, invite_code }
let me = null;         // моят запис в family_members
let members = [];
let medicines = [];
let photoUrls = {};    // photo_path -> временен адрес за показване
let channel = null;

function showScreen(id) {
  for (const s of ['loading', 'setup', 'auth', 'family', 'main']) {
    $('#screen-' + s).hidden = s !== id;
  }
  if (id === 'main') updateHeaderHeight();
}

async function loadFamily() {
  const { data, error } = await sb.from('family_members')
    .select('user_id, display_name, family:families(id, name, invite_code)')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;
  me = data;
  family = data ? data.family : null;
}

async function route() {
  if (!user) {
    stopRealtime();
    family = null; medicines = [];
    showScreen('auth');
    return;
  }
  try {
    await loadFamily();
    store('apteka-family', family);
  } catch (err) {
    // Без интернет: показваме последното запазено
    family = store('apteka-family');
    if (!family) { showScreen('family'); showMsg($('#fam-msg'), humanError(err)); return; }
  }
  if (!family) {
    $('#fam-display').value = (user.user_metadata && user.user_metadata.display_name) || '';
    showScreen('family');
    return;
  }
  $('#family-title').textContent = family.name;
  showScreen('main');
  await reload();
  startRealtime();
}

/* ---------- Вход / регистрация ---------- */

let authMode = 'login';

$$('[data-auth-tab]').forEach(tab => tab.addEventListener('click', () => {
  authMode = tab.dataset.authTab;
  $$('[data-auth-tab]').forEach(t => t.classList.toggle('active', t === tab));
  $('#auth-name-field').hidden = authMode !== 'signup';
  $('#auth-submit').textContent = authMode === 'signup' ? 'Създай профил' : 'Вход';
  $('#auth-password').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
  showMsg($('#auth-msg'), '');
}));

$('#form-auth').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const btn = $('#auth-submit');
  btn.disabled = true;
  showMsg($('#auth-msg'), '');
  try {
    if (authMode === 'signup') {
      const display_name = $('#auth-name').value.trim();
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { display_name } } });
      if (error) throw error;
      if (!data.session) {
        showMsg($('#auth-msg'), 'Профилът е създаден. Проверете имейла си, натиснете линка за потвърждение и след това влезте тук.', false);
        $('[data-auth-tab="login"]').click();
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    showMsg($('#auth-msg'), humanError(err));
  } finally {
    btn.disabled = false;
  }
});

$$('.js-logout').forEach(b => b.addEventListener('click', async () => {
  $('#dlg-settings').open && $('#dlg-settings').close();
  store('apteka-family', null);
  store('apteka-cache', null);
  await sb.auth.signOut();
}));

/* ---------- Семейство ---------- */

async function familyAction(fn, args) {
  const msg = $('#fam-msg');
  showMsg(msg, '');
  $$('#screen-family button').forEach(b => { b.disabled = true; });
  try {
    const { error } = await sb.rpc(fn, args);
    if (error) throw error;
    await route();
  } catch (err) {
    showMsg(msg, humanError(err));
  } finally {
    $$('#screen-family button').forEach(b => { b.disabled = false; });
  }
}

$('#form-join').addEventListener('submit', e => {
  e.preventDefault();
  const code = $('#fam-code').value.trim();
  if (!code) { showMsg($('#fam-msg'), 'Въведете кода, който сте получили.'); return; }
  familyAction('join_family', { p_code: code, p_display_name: $('#fam-display').value.trim() });
});

$('#form-create').addEventListener('submit', e => {
  e.preventDefault();
  familyAction('create_family', { p_name: $('#fam-name').value.trim(), p_display_name: $('#fam-display').value.trim() });
});

/* ---------- Лекарства: зареждане и показване ---------- */

let filter = 'all';
let query = '';

async function reload() {
  try {
    if (navigator.onLine === false) throw new Error('offline');
    const { data, error } = await sb.from('medicines')
      .select('id, name, description, expiry, photo_path, added_by, created_at, updated_at')
      .eq('family_id', family.id)
      .abortSignal(AbortSignal.timeout(10000));
    if (error) throw error;
    medicines = data;
    store('apteka-cache', { familyId: family.id, medicines });
    $('#offline-banner').hidden = true;
    await loadPhotoUrls();
  } catch (err) {
    const cache = store('apteka-cache');
    if (cache && cache.familyId === family.id) medicines = cache.medicines;
    $('#offline-banner').hidden = false;
  }
  render();
}

async function loadPhotoUrls() {
  const missing = [...new Set(medicines.map(m => m.photo_path).filter(p => p && !photoUrls[p]))];
  if (!missing.length) return;
  const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(missing, 60 * 60 * 24);
  if (error || !data) return;
  for (const r of data) if (r.signedUrl) photoUrls[r.path] = r.signedUrl;
}

function firstLetter(name) {
  const ch = (name.trim()[0] || '#').toLocaleUpperCase('bg');
  return /[\p{L}]/u.test(ch) ? ch : '#';
}

function render() {
  const counts = { all: 0, soon: 0, expired: 0, ok: 0 };
  const q = query.trim().toLocaleLowerCase('bg');

  const searched = medicines
    .map(m => ({ ...m, st: expiryStatus(m.expiry) }))
    .filter(m => !q || m.name.toLocaleLowerCase('bg').includes(q) || (m.description || '').toLocaleLowerCase('bg').includes(q));

  for (const m of searched) { counts.all++; counts[m.st.status]++; }
  $$('[data-count]').forEach(el => { el.textContent = counts[el.dataset.count]; });

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
    list.innerHTML = '<div class="empty"><div class="big">🔍</div><p>Няма лекарства, които отговарят на търсенето или филтъра.</p></div>';
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
    const url = m.photo_path && photoUrls[m.photo_path];
    const thumb = url
      ? `<img class="thumb" src="${escapeHtml(url)}" alt="" loading="lazy">`
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
            ${m.added_by ? `<span>👤 ${escapeHtml(m.added_by)}</span>` : ''}
          </div>
        </div>
      </button>`;
  }
  html += '</div>';
  list.innerHTML = html;
}

function updateHeaderHeight() {
  const top = $('.top');
  if (top) document.documentElement.style.setProperty('--header-h', top.offsetHeight + 'px');
}

/* ---------- Обновяване на живо ---------- */

let reloadTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { if (family) reload(); }, 300);
}

function startRealtime() {
  stopRealtime();
  channel = sb.channel('medicines-' + family.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'medicines' }, scheduleReload)
    .subscribe();
}

function stopRealtime() {
  if (channel) { sb.removeChannel(channel); channel = null; }
}

/* ---------- Добавяне / редакция ---------- */

const dlgEdit = $('#dlg-edit');
let editing = null;         // лекарството, което се редактира (или null за ново)
let photoState = { blob: null, previewUrl: null, removed: false };

function setPreview(url) {
  $('#photo-preview').hidden = !url;
  $('#photo-empty').hidden = !!url;
  $('#photo-remove').hidden = !url;
  if (url) $('#photo-preview').src = url;
  else $('#photo-preview').removeAttribute('src');
}

function openEditor(med) {
  editing = med || null;
  if (photoState.previewUrl) URL.revokeObjectURL(photoState.previewUrl);
  photoState = { blob: null, previewUrl: null, removed: false };
  $('#edit-title').textContent = med ? 'Редакция' : 'Ново лекарство';
  $('#f-name').value = med ? med.name : '';
  $('#f-desc').value = med ? med.description || '' : '';
  $('#f-expiry').value = med ? med.expiry : '';
  $('#btn-delete').hidden = !med;
  $('#edit-meta').textContent = med && med.added_by ? `Добавено от ${med.added_by}` : '';
  setPreview(med && med.photo_path ? photoUrls[med.photo_path] : null);
  dlgEdit.showModal();
  dlgEdit.scrollTop = 0;
}

async function onPhotoPicked(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const blob = await resizeImage(file);
    if (photoState.previewUrl) URL.revokeObjectURL(photoState.previewUrl);
    photoState = { blob, previewUrl: URL.createObjectURL(blob), removed: false };
    setPreview(photoState.previewUrl);
  } catch (err) {
    toast(err.message);
  }
}

$('#photo-camera').addEventListener('change', onPhotoPicked);
$('#photo-gallery').addEventListener('change', onPhotoPicked);
$('#photo-remove').addEventListener('click', () => {
  photoState = { blob: null, previewUrl: null, removed: true };
  setPreview(null);
});
$('#btn-cancel').addEventListener('click', () => dlgEdit.close());
$('#btn-add').addEventListener('click', () => openEditor(null));

$('#form-edit').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#f-name').value.trim();
  const expiry = $('#f-expiry').value;
  if (!name) { toast('Въведете име на лекарството'); $('#f-name').focus(); return; }
  if (!expiry) { toast('Въведете срок на годност'); $('#f-expiry').focus(); return; }

  const btn = $('#btn-save');
  btn.disabled = true;
  btn.textContent = 'Запазване…';
  try {
    const id = editing ? editing.id : crypto.randomUUID();
    const oldPath = editing ? editing.photo_path : null;
    let photo_path = oldPath;

    if (photoState.blob) {
      photo_path = `${family.id}/${id}-${Date.now()}.jpg`;
      const { error } = await sb.storage.from(PHOTO_BUCKET).upload(photo_path, photoState.blob, { contentType: 'image/jpeg' });
      if (error) throw error;
      photoUrls[photo_path] = photoState.previewUrl;
    } else if (photoState.removed) {
      photo_path = null;
    }

    const row = { name, description: $('#f-desc').value.trim(), expiry, photo_path };
    const { error } = editing
      ? await sb.from('medicines').update(row).eq('id', id)
      : await sb.from('medicines').insert({ ...row, id, family_id: family.id, added_by: (me && me.display_name) || '' });
    if (error) throw error;

    if (oldPath && oldPath !== photo_path) sb.storage.from(PHOTO_BUCKET).remove([oldPath]);
    photoState.previewUrl = null; // вече се ползва в списъка
    dlgEdit.close();
    toast(editing ? 'Промените са запазени' : 'Лекарството е добавено');
    await reload();
  } catch (err) {
    toast('Не е запазено: ' + humanError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Запази';
  }
});

$('#list').addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (!card) return;
  const med = medicines.find(m => m.id === card.dataset.id);
  if (med) openEditor(med);
});

/* ---------- Изтриване ---------- */

function confirmDialog(title, text, yesLabel) {
  const dlg = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-yes').textContent = yesLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true }));
}

$('#btn-delete').addEventListener('click', async () => {
  const med = editing;
  if (!med) return;
  if (!(await confirmDialog('Изтриване', `Сигурни ли сте, че искате да изтриете „${med.name}“? Ще изчезне за цялото семейство.`, 'Да, изтрий'))) return;
  const { error } = await sb.from('medicines').delete().eq('id', med.id);
  if (error) { toast('Не е изтрито: ' + humanError(error)); return; }
  if (med.photo_path) sb.storage.from(PHOTO_BUCKET).remove([med.photo_path]);
  dlgEdit.close();
  toast('Лекарството е изтрито');
  await reload();
});

/* ---------- Търсене и филтри ---------- */

$('#search').addEventListener('input', e => { query = e.target.value; render(); });

$$('.chip').forEach(chip => chip.addEventListener('click', () => {
  filter = chip.dataset.filter;
  $$('.chip').forEach(c => c.classList.toggle('active', c === chip));
  render();
}));

/* ---------- Настройки ---------- */

const dlgSettings = $('#dlg-settings');

$('#btn-settings').addEventListener('click', async () => {
  $('#s-family').textContent = family.name;
  $('#s-code').textContent = family.invite_code;
  $('#s-name').value = (me && me.display_name) || '';
  $('#s-days').value = settings.warnDays;
  $('#s-account').textContent = user ? `Профил: ${user.email}` : '';
  $('#s-members').textContent = '…';
  dlgSettings.showModal();
  const { data } = await sb.from('family_members').select('display_name').eq('family_id', family.id);
  members = data || [];
  $('#s-members').textContent = members.map(m => m.display_name || 'без име').join(', ') || '—';
});

dlgSettings.addEventListener('close', async () => {
  const v = parseInt($('#s-days').value, 10);
  if (v >= 1 && v <= 365 && v !== settings.warnDays) {
    settings.warnDays = v;
    saveSettings();
    render();
  }
  const name = $('#s-name').value.trim();
  if (me && name !== (me.display_name || '')) {
    const { error } = await sb.from('family_members').update({ display_name: name }).eq('user_id', user.id);
    if (error) toast('Името не е запазено: ' + humanError(error));
    else me.display_name = name;
  }
});

$('#btn-share-code').addEventListener('click', async () => {
  const text = `Присъедини се към семейство „${family.name}“ в приложението „Домашна аптечка“ с код: ${family.invite_code}`;
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(family.invite_code); toast('Кодът е копиран'); }
  catch (err) { toast('Кодът е: ' + family.invite_code); }
});

$('#btn-leave').addEventListener('click', async () => {
  dlgSettings.close();
  if (!(await confirmDialog('Напускане', `Ще напуснете семейство „${family.name}“ и няма да виждате лекарствата му. Лекарствата остават за другите членове.`, 'Напусни'))) return;
  const { error } = await sb.rpc('leave_family');
  if (error) { toast(humanError(error)); return; }
  store('apteka-cache', null);
  store('apteka-family', null);
  stopRealtime();
  await route();
});

/* ---------- Старт ---------- */

window.addEventListener('resize', updateHeaderHeight);
window.addEventListener('online', () => { if (family && !$('#screen-main').hidden) reload(); });

// Статусите зависят от датата, а другите може да са правили промени – опресняваме при връщане в приложението
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && family && !$('#screen-main').hidden) reload();
});

(async function start() {
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase) {
    showScreen('setup');
    return;
  }
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: !isNative },
  });

  let lastUserId;
  sb.auth.onAuthStateChange((event, session) => {
    user = session ? session.user : null;
    const id = user ? user.id : null;
    if (id === lastUserId) return;   // само обновен ключ – няма нужда от ново зареждане
    lastUserId = id;
    // извън callback-а, за да не блокираме клиента
    setTimeout(() => route().catch(err => toast(humanError(err))), 0);
  });
})();

// Бутон „Назад“ на Android: първо затваря отворения прозорец
if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
  window.Capacitor.Plugins.App.addListener('backButton', () => {
    const open = [...$$('dialog')].reverse().find(d => d.open);
    if (open) open.close();
    else window.Capacitor.Plugins.App.exitApp();
  });
}

if ('serviceWorker' in navigator && !isNative && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
