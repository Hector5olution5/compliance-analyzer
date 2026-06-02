// ── State ────────────────────────────────────────────────────────────────────
let currentTab = 1;
let components = [];
let generatedDocs = {};
let activeResultTab = null;
const TOTAL_TABS = 4;
let currentHistoryIndex = null;
const HIST_KEY        = 'ca_history_v3';
const HIST_LOCAL_LIMIT = 20;
let dashboardFilter = 'todos';

// ── Error monitoring ─────────────────────────────────────────────────────────
const _reportedErrors = new Set();

async function reportError(message, stack, source) {
  const key = `${message}|${source}`;
  if (_reportedErrors.has(key)) return;
  _reportedErrors.add(key);
  if (_reportedErrors.size > 50) _reportedErrors.clear();

  const session = (() => { try { return JSON.parse(sessionStorage.getItem('ca_session')); } catch { return null; } })();
  const payload = {
    message: String(message).slice(0, 500),
    stack:   String(stack || '').slice(0, 2000),
    source:  String(source || '').slice(0, 300),
    url:     window.location.href,
    userId:  session?.userId || 'anonymous',
    role:    session?.role   || null,
    ts:      Date.now(),
  };

  fetch('/api/log-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});

  if (typeof db !== 'undefined' && db) {
    db.collection('errors').add(payload).catch(() => {});
  }
}

window.onerror = (message, source, lineno, colno, error) => {
  reportError(message, error?.stack, `${source}:${lineno}:${colno}`);
  return false;
};

window.addEventListener('unhandledrejection', (event) => {
  const err = event.reason;
  reportError(err?.message || String(err), err?.stack, 'unhandledrejection');
});

// ── Auth ─────────────────────────────────────────────────────────────────────
const USERS_KEY = 'ca_users_v1';
const SESSION_KEY = 'ca_session';
const ROLE_LABELS = {
  admin:            'Administrador',
  analyst:          'Analista',
  viewer:           'Visor',
  coord_desarrollo: 'Coord. Desarrollo de Producto',
  coord_compliance: 'Coord. Compliance',
  gerente_nd:       'Gerente Nuevos Desarrollos',
  coord_supply:     'Coord. Supply Chain'
};
const ROLE_COLORS = {
  admin:            '#185FA5',
  analyst:          '#2E7D32',
  viewer:           '#9CA3AF',
  coord_desarrollo: '#7B3F9E',
  coord_compliance: '#B71C1C',
  gerente_nd:       '#00695C',
  coord_supply:     '#E65100'
};

let _loginSelectedUser = null;
let _loginPinBuffer = '';

function getUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); } catch { return []; }
}
function saveUsers(u) { localStorage.setItem(USERS_KEY, JSON.stringify(u)); }

function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function saveSession(s) { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function clearSession() { sessionStorage.removeItem(SESSION_KEY); }

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Firebase ──────────────────────────────────────────────────────────────────
let db = null;
try {
  if (typeof FIREBASE_CONFIG !== 'undefined') {
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
  }
} catch (err) {
  console.warn('Firebase init failed, using localStorage only:', err.message);
}

async function syncUsersFromFirestore() {
  if (!db) return getUsers();
  try {
    const snap = await db.collection('users').get();
    const users = snap.docs.map(d => d.data());
    saveUsers(users);
    return users;
  } catch (err) {
    console.warn('Firestore read failed:', err.message);
    return getUsers();
  }
}

async function fsSetUser(user) {
  if (!db) return;
  try { await db.collection('users').doc(user.id).set(user); } catch (err) { console.warn('Firestore write failed:', err.message); }
}

async function fsDeleteUser(id) {
  if (!db) return;
  try { await db.collection('users').doc(id).delete(); } catch (err) { console.warn('Firestore delete failed:', err.message); }
}

// ── Firestore — expedientes (guardado permanente cross-device) ────────────────

async function saveExpedienteToFirestore(entryOrIndex, markets) {
  if (!db) return;
  const session = getSession();
  if (!session) return;

  // Accept either a history entry object or a legacy numeric index
  let e;
  if (typeof entryOrIndex === 'number') {
    const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    e = hist[entryOrIndex];
  } else {
    e = entryOrIndex;
  }
  if (!e) return;

  const expId = e.expId || generateId();
  try {
    const fd = e.formData ? { ...e.formData } : {};
    delete fd.previews;
    await db.collection('expedientes').doc(expId).set({
      id: expId, userId: session.userId,
      nombre: e.nombre || '', categoria: e.categoria || '',
      mercados: markets, fecha: e.fecha || '',
      ts: e.ts || Date.now(), status: e.status || 'borrador',
      nota: e.nota || '', formData: fd,
    });
  } catch (err) { console.warn('Firestore expediente write failed:', err.message); }

  renderHistory();
}

async function syncExpedientesFromCloud() {
  if (!db) return [];
  const session = getSession();
  if (!session) return [];
  try {
    const snap = await db.collection('expedientes')
      .where('userId', '==', session.userId)
      .orderBy('ts', 'desc').limit(30).get();
    return snap.docs.map(d => d.data());
  } catch (e) {
    console.warn('Firestore expedientes read failed:', e.message);
    return [];
  }
}

async function mergeCloudHistory() {
  const cloud = await syncExpedientesFromCloud();
  if (!cloud.length) return;

  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const localIds  = new Set(hist.map(h => h.expId).filter(Boolean));
  const localKeys = new Set(hist.map(h => `${h.nombre}|${h.fecha}`));
  let changed = false;

  for (const c of cloud) {
    if (localIds.has(c.id)) {
      // Item already exists locally — sync docProgress and status if cloud has newer data
      const local = hist.find(h => h.expId === c.id);
      if (local) {
        if (c.docProgress && !local.docProgress) {
          local.docProgress = c.docProgress;
          changed = true;
        }
        if ((c.ts || 0) > (local.ts || 0)) {
          local.status = c.status || local.status;
          local.nota   = c.nota   ?? local.nota;
          changed = true;
        }
      }
      continue;
    }
    if (localKeys.has(`${c.nombre}|${c.fecha}`)) continue;
    hist.push({
      nombre: c.nombre, categoria: c.categoria,
      mercados: c.mercados, fecha: c.fecha, ts: c.ts,
      status: c.status || 'borrador', nota: c.nota || '',
      expId: c.id, formData: c.formData || {}, previews: {},
      docProgress: c.docProgress || null,
    });
    changed = true;
  }

  if (changed) {
    hist.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    try { localStorage.setItem(HIST_KEY, JSON.stringify(hist.slice(0, HIST_LOCAL_LIMIT))); } catch (_) {}
    renderHistory();
  }
  return changed;
}

async function regenerateExpediente(index) {
  if (getActiveRole() === 'viewer') return;
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const h = hist[index];
  if (!h?.formData || !(h.mercados || []).length) return;

  if (!confirm(`¿Regenerar expediente de "${h.nombre}"?\nSe volverá a llamar a la IA (~$0.03). Los archivos Word se generarán de nuevo.`)) return;

  closeHistory();
  const formData = h.formData;
  const markets  = h.mercados;

  document.getElementById('form-section').classList.add('hidden');
  document.getElementById('results-section').classList.add('hidden');
  showProgress(true);
  generatedDocs = {};
  currentHistoryIndex = index;

  try {
    for (let i = 0; i < markets.length; i++) {
      updateProgress(i, markets.length, markets[i]);
      generatedDocs[markets[i]] = await generateForMarket(formData, markets[i]);
    }
    updateProgress(markets.length, markets.length, '');
    await new Promise(r => setTimeout(r, 400));
    showProgress(false);
    renderResults(formData);
  } catch (err) {
    showProgress(false);
    document.getElementById('form-section').classList.remove('hidden');
    alert('Error al regenerar: ' + err.message);
  }
}

// ── Supabase — evidencias del expediente ─────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadEvidencia(expId, file) {
  if (!db) throw new Error('Firestore no disponible');
  const session = getSession();
  if (!session) throw new Error('Sin sesión activa');
  const fileId      = generateId();
  const safeName    = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
  const path        = `${expId}/${fileId}_${safeName}`;
  const contentType = file.type || 'application/octet-stream';

  const data = await fileToBase64(file);
  const res  = await fetch('/api/upload-evidencia', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, data, contentType }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Error al subir el archivo');
  }
  const { publicUrl } = await res.json();

  const ev = {
    id: fileId, expId,
    nombre: file.name,
    tipo: file.type.startsWith('image/') ? 'imagen' : 'pdf',
    url: publicUrl, storagePath: path, tamano: file.size,
    subidoPor: session.userId, subidoPorNombre: session.name,
    subidoEn: Date.now(),
    revisado: false, revisadoPor: null, revisadoPorNombre: null, revisadoEn: null,
  };
  await db.collection('expedientes').doc(expId).collection('evidencias').doc(fileId).set(ev);
  return ev;
}

async function loadEvidencias(expId) {
  if (!db) return [];
  try {
    const snap = await db.collection('expedientes').doc(expId)
      .collection('evidencias').orderBy('subidoEn', 'asc').get();
    return snap.docs.map(d => d.data());
  } catch (e) { console.warn('Load evidencias failed:', e.message); return []; }
}

async function toggleRevisado(expId, evidenciaId, currentState) {
  if (!db) return;
  const session = getSession();
  if (!session) return;
  const newState = !currentState;
  const upd = newState
    ? { revisado: true,  revisadoPor: session.userId, revisadoPorNombre: session.name, revisadoEn: Date.now() }
    : { revisado: false, revisadoPor: null, revisadoPorNombre: null, revisadoEn: null };
  await db.collection('expedientes').doc(expId).collection('evidencias').doc(evidenciaId).update(upd);
}

async function deleteEvidenciaDoc(expId, evidenciaId, storagePath) {
  await fetch('/api/upload-evidencia', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: storagePath }),
  }).catch(() => {});
  if (db) await db.collection('expedientes').doc(expId).collection('evidencias').doc(evidenciaId).delete();
}

async function renderEvidenciasPanel(expId) {
  const panel = document.getElementById('ev-list');
  if (!panel) return;
  panel.innerHTML = '<p class="ev-empty">Cargando...</p>';
  const items = await loadEvidencias(expId);
  const isAdmin = getActiveRole() === 'admin';
  const session = getSession();
  if (!items.length) {
    panel.innerHTML = '<p class="ev-empty">Sin evidencias. Sube PDFs de reportes de lab, fotos del producto o declaraciones de conformidad.</p>';
    return;
  }
  panel.innerHTML = items.map(ev => {
    const icon  = ev.tipo === 'imagen' ? '🖼' : '📄';
    const fecha = new Date(ev.subidoEn).toLocaleDateString('es-MX', { day:'2-digit', month:'short', year:'numeric' });
    const byRev = ev.revisado ? ` · ✓ ${ev.revisadoPorNombre}` : '';
    return `<div class="ev-item" id="ev-${ev.id}">
      <span class="ev-icon">${icon}</span>
      <div class="ev-info">
        <span class="ev-name" title="${escapeHtml(ev.nombre)}">${escapeHtml(ev.nombre)}</span>
        <span class="ev-meta">${escapeHtml(ev.subidoPorNombre)} · ${fecha}${byRev}</span>
      </div>
      <div class="ev-actions">
        <button class="btn-ev btn-ev-view" onclick="window.open('${ev.url}','_blank')" title="Ver">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="btn-ev btn-ev-check${ev.revisado ? ' checked' : ''}"
                onclick="handleToggleRevisado('${expId}','${ev.id}',${ev.revisado})"
                title="${ev.revisado ? 'Quitar revisión' : 'Marcar revisado'}">
          ${ev.revisado ? '✓ Revisado' : 'Revisar'}
        </button>
        ${isAdmin ? `<button class="btn-ev btn-ev-del" onclick="handleDeleteEvidencia('${expId}','${ev.id}','${ev.storagePath}')" title="Eliminar">✕</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function handleToggleRevisado(expId, evidenciaId, currentState) {
  if (getActiveRole() === 'viewer') return;
  const btn = document.querySelector(`#ev-${evidenciaId} .btn-ev-check`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    await toggleRevisado(expId, evidenciaId, currentState);
    await renderEvidenciasPanel(expId);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = currentState ? '✓ Revisado' : 'Revisar'; }
    alert('Error: ' + e.message);
  }
}

async function handleDeleteEvidencia(expId, evidenciaId, storagePath) {
  if (getActiveRole() !== 'admin') return;
  if (!confirm('¿Eliminar esta evidencia? No se puede deshacer.')) return;
  const item = document.getElementById(`ev-${evidenciaId}`);
  if (item) item.style.opacity = '0.4';
  try {
    await deleteEvidenciaDoc(expId, evidenciaId, storagePath);
    await renderEvidenciasPanel(expId);
  } catch (e) {
    if (item) item.style.opacity = '1';
    alert('Error: ' + e.message);
  }
}

const PDF_COMPRESS_THRESHOLD = 10 * 1024 * 1024; // compress PDFs over 10 MB
const PDF_COMPRESS_SCALE    = 1.2;  // render resolution
const PDF_COMPRESS_QUALITY  = 0.55; // JPEG quality — aggressive to stay under 20 MB after compress

async function compressPdf(file, onProgress) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdfDoc.numPages;

  const firstPage  = await pdfDoc.getPage(1);
  const viewport   = firstPage.getViewport({ scale: PDF_COMPRESS_SCALE });
  const isLandscape = viewport.width > viewport.height;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({
    orientation: isLandscape ? 'landscape' : 'portrait',
    unit: 'pt',
    format: [viewport.width * 0.75, viewport.height * 0.75], // px → pt
  });

  for (let i = 1; i <= numPages; i++) {
    if (i > 1) {
      const pv = (await pdfDoc.getPage(i)).getViewport({ scale: PDF_COMPRESS_SCALE });
      doc.addPage([pv.width * 0.75, pv.height * 0.75]);
    }
    const page = await pdfDoc.getPage(i);
    const pv   = page.getViewport({ scale: PDF_COMPRESS_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width  = pv.width;
    canvas.height = pv.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: pv }).promise;
    const imgData = canvas.toDataURL('image/jpeg', PDF_COMPRESS_QUALITY);
    const w = pv.width * 0.75, h = pv.height * 0.75;
    doc.addImage(imgData, 'JPEG', 0, 0, w, h);
    if (onProgress) onProgress(i, numPages);
  }

  const blob = doc.output('blob');
  return new File([blob], file.name, { type: 'application/pdf' });
}

function setupEvidenciasUpload(expId) {
  const inp = document.getElementById('ev-file-input');
  if (!inp) return;
  const fresh = inp.cloneNode(true);
  inp.parentNode.replaceChild(fresh, inp);
  fresh.addEventListener('change', async e => {
    const files = [...e.target.files];
    if (!files.length) return;
    const btn = document.getElementById('btn-ev-upload');
    if (btn) { btn.disabled = true; btn.textContent = `⏳ Subiendo (${files.length})…`; }
    let ok = 0; const errs = [];
    for (const f of files) {
      const valid = f.type === 'application/pdf' || f.type.startsWith('image/');
      if (!valid) { errs.push(`${f.name}: tipo no permitido`); continue; }
      try {
        let fileToUpload = f;
        if (f.type === 'application/pdf' && f.size > PDF_COMPRESS_THRESHOLD) {
          if (btn) btn.textContent = `⏳ Comprimiendo PDF…`;
          fileToUpload = await compressPdf(f, (page, total) => {
            if (btn) btn.textContent = `⏳ Comprimiendo ${page}/${total}…`;
          });
          if (btn) btn.textContent = `⏳ Subiendo…`;
        }
        if (fileToUpload.size > 45 * 1024 * 1024) {
          errs.push(`${f.name}: no se pudo reducir lo suficiente (${(fileToUpload.size/1024/1024).toFixed(0)} MB) — comprime el PDF manualmente en smallpdf.com`);
          continue;
        }
        await uploadEvidencia(expId, fileToUpload); ok++;
      } catch (err) {
        const msg = err.message === 'Failed to fetch'
          ? 'No se pudo conectar con el almacenamiento — el servicio puede estar pausado, intenta en un momento'
          : err.message;
        errs.push(`${f.name}: ${msg}`);
      }
    }
    fresh.value = '';
    if (btn) { btn.disabled = false; btn.textContent = '+ Subir'; }
    await renderEvidenciasPanel(expId);
    if (errs.length) alert('Errores:\n' + errs.join('\n'));
    else if (ok > 0) showToast(`✓ ${ok} evidencia${ok > 1 ? 's' : ''} subida${ok > 1 ? 's' : ''}`);
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PBKDF2_ITERATIONS   = 100_000;
const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS  = 30_000;
const LOCKOUT_KEY          = 'ca_lockout_v1';

function generateSalt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPin(pin, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS },
    key, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPinLegacy(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ca_salt_' + pin));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getLockouts() {
  try { return JSON.parse(localStorage.getItem(LOCKOUT_KEY) || '{}'); } catch { return {}; }
}

function isLockedOut(userId) {
  const entry = getLockouts()[userId];
  if (entry?.lockedUntil && Date.now() < entry.lockedUntil) return entry.lockedUntil;
  return false;
}

function recordFailedAttempt(userId) {
  const state = getLockouts();
  const entry = state[userId] || { attempts: 0 };
  entry.attempts = (entry.attempts || 0) + 1;
  if (entry.attempts >= LOCKOUT_MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    entry.attempts = 0;
  }
  state[userId] = entry;
  localStorage.setItem(LOCKOUT_KEY, JSON.stringify(state));
  // Backup to Firestore so clearing localStorage doesn't bypass lockout
  if (typeof db !== 'undefined' && db) {
    db.collection('lockouts').doc(userId).set(entry).catch(() => {});
  }
  return entry;
}

function clearFailedAttempts(userId) {
  const state = getLockouts();
  delete state[userId];
  localStorage.setItem(LOCKOUT_KEY, JSON.stringify(state));
  if (typeof db !== 'undefined' && db) {
    db.collection('lockouts').doc(userId).delete().catch(() => {});
  }
}

async function isLockedOutFirestore(userId) {
  if (typeof db === 'undefined' || !db) return false;
  try {
    const doc = await db.collection('lockouts').doc(userId).get();
    if (!doc.exists) return false;
    const data = doc.data();
    if (data?.lockedUntil && Date.now() < data.lockedUntil) return data.lockedUntil;
    return false;
  } catch { return false; }
}

async function createUser(name, role, pin) {
  const users = getUsers();
  const salt = generateSalt();
  const user = { id: generateId(), name: name.trim(), role, pin_hash: await hashPin(pin, salt), pin_salt: salt, created_at: Date.now() };
  users.push(user);
  saveUsers(users);
  await fsSetUser(user);
  return user;
}

async function updateUser(id, fields, newPin) {
  const users = getUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return null;
  Object.assign(users[idx], fields);
  if (newPin) {
    const salt = generateSalt();
    users[idx].pin_salt = salt;
    users[idx].pin_hash = await hashPin(newPin, salt);
  }
  saveUsers(users);
  await fsSetUser(users[idx]);
  return users[idx];
}

function deleteUser(id) {
  const users = getUsers();
  const target = users.find(u => u.id === id);
  if (!target) return false;
  if (target.role === 'admin' && users.filter(u => u.role === 'admin').length === 1) {
    alert('No puedes eliminar al único administrador.'); return false;
  }
  saveUsers(users.filter(u => u.id !== id));
  fsDeleteUser(id);
  return true;
}

async function verifyPin(userId, pin) {
  const user = getUsers().find(u => u.id === userId);
  if (!user) return false;
  if (user.pin_salt) {
    return user.pin_hash === await hashPin(pin, user.pin_salt);
  }
  // Legacy hash: upgrade on successful login
  const legacyHash = await hashPinLegacy(pin);
  if (user.pin_hash !== legacyHash) return false;
  const salt = generateSalt();
  await updateUser(userId, { pin_hash: await hashPin(pin, salt), pin_salt: salt });
  return true;
}

function getActiveRole() { return getSession()?.role || null; }

// ── Login UI ─────────────────────────────────────────────────────────────────

function showLoginScreen() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('welcome-screen').classList.add('hidden');
  document.getElementById('app-header').style.visibility = 'hidden';
  document.querySelector('main').style.visibility = 'hidden';

  const users = getUsers();
  if (users.length === 0) {
    showLoginStep('setup');
  } else {
    showLoginStep('users');
    renderLoginUserList(users);
  }
}

function hideLoginScreen() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-header').style.visibility = '';
  document.querySelector('main').style.visibility = '';
}

function showLoginStep(step) {
  ['users', 'pin', 'setup', 'import'].forEach(s =>
    document.getElementById(`login-step-${s}`).classList.toggle('hidden', s !== step)
  );
}

function renderLoginUserList(users) {
  document.getElementById('login-users-grid').innerHTML = users.map(u => {
    const initials = u.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    return `<button class="login-user-card" onclick="selectLoginUser('${u.id}')">
      <span class="login-user-avatar" style="background:${ROLE_COLORS[u.role]}">${initials}</span>
      <span class="login-user-name">${escapeHtml(u.name)}</span>
      <span class="login-user-role">${ROLE_LABELS[u.role]}</span>
    </button>`;
  }).join('');
}

function selectLoginUser(userId) {
  const user = getUsers().find(u => u.id === userId);
  if (!user) return;
  _loginSelectedUser = user;
  _loginPinBuffer = '';

  const initials = user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('login-pin-user-info').innerHTML = `
    <span class="login-pin-avatar" style="background:${ROLE_COLORS[user.role]}">${initials}</span>
    <div>
      <p class="login-pin-name">${escapeHtml(user.name)}</p>
      <p class="login-pin-role">${ROLE_LABELS[user.role]}</p>
    </div>`;
  updatePinDots();
  document.getElementById('pin-error').classList.add('pin-error-hidden');
  showLoginStep('pin');
}

function showLoginUserStep() {
  _loginSelectedUser = null;
  _loginPinBuffer = '';
  renderLoginUserList(getUsers());
  showLoginStep('users');
}

function updatePinDots() {
  document.querySelectorAll('#pin-dots .pin-dot').forEach((dot, i) =>
    dot.classList.toggle('pin-dot-filled', i < _loginPinBuffer.length)
  );
}

let _pinVerifying = false;

async function handlePinKey(key) {
  if (!_loginSelectedUser) return;
  if (key === 'back') {
    _loginPinBuffer = _loginPinBuffer.slice(0, -1);
  } else if (key === 'clear') {
    _loginPinBuffer = '';
  } else if (_loginPinBuffer.length < 4) {
    _loginPinBuffer += key;
  }
  updatePinDots();

  if (_loginPinBuffer.length === 4) {
    if (_pinVerifying) return;
    _pinVerifying = true;
    const errEl = document.getElementById('pin-error');
    const dots  = document.getElementById('pin-dots');

    const lockedUntil = isLockedOut(_loginSelectedUser.id) || await isLockedOutFirestore(_loginSelectedUser.id);
    if (lockedUntil) {
      const secs = Math.ceil((lockedUntil - Date.now()) / 1000);
      errEl.textContent = `Bloqueado — intenta en ${secs}s`;
      errEl.classList.remove('pin-error-hidden');
      _loginPinBuffer = '';
      updatePinDots();
      return;
    }

    try {
      const ok = await verifyPin(_loginSelectedUser.id, _loginPinBuffer);
      _loginPinBuffer = '';
      updatePinDots();
      if (ok) {
        clearFailedAttempts(_loginSelectedUser.id);
        errEl.textContent = 'PIN incorrecto — intenta de nuevo';
        finishLogin(_loginSelectedUser);
      } else {
        const entry = recordFailedAttempt(_loginSelectedUser.id);
        const remaining = LOCKOUT_MAX_ATTEMPTS - (entry.attempts || 0);
        errEl.textContent = entry.lockedUntil
          ? `Demasiados intentos — bloqueado 30s`
          : `PIN incorrecto — ${remaining} intento${remaining !== 1 ? 's' : ''} restante${remaining !== 1 ? 's' : ''}`;
        errEl.classList.remove('pin-error-hidden');
        dots.classList.add('pin-shake');
        setTimeout(() => dots.classList.remove('pin-shake'), 400);
      }
    } finally {
      _pinVerifying = false;
    }
  }
}

function finishLogin(user) {
  saveSession({ userId: user.id, name: user.name, role: user.role, loggedAt: Date.now() });
  hideLoginScreen();
  applyRoleRestrictions(user.role);
  renderUserBadge(user);
  if (user.role === 'viewer') {
    setTimeout(openHistory, 300);
  } else {
    showDashboard();
  }
}

function logout() {
  clearSession();
  location.reload();
}

function applyRoleRestrictions(role) {
  const isViewer = role === 'viewer';
  const isAdmin  = role === 'admin';

  // Only viewers can't generate
  const genSec = document.getElementById('generate-section');
  if (genSec && isViewer) genSec.style.display = 'none';

  // Only admins see settings
  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) btnSettings.style.display = isAdmin ? '' : 'none';

  // Viewers: read-only mode — dim form, hide uploads and label analysis
  if (isViewer) {
    const formSec = document.getElementById('form-section');
    if (formSec) { formSec.style.opacity = '0.55'; formSec.style.pointerEvents = 'none'; }
    ['ps-upload-area', 'upload-area', 'label-upload-zone', 'btn-run-label'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    const labelSel = document.querySelector('.label-selector-wrap');
    if (labelSel) labelSel.style.display = 'none';
  }
}

function renderUserBadge(user) {
  const badge = document.getElementById('user-badge');
  if (!badge) return;
  const initials = user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  badge.classList.remove('hidden');
  badge.innerHTML = `
    <span class="user-badge-avatar" style="background:${ROLE_COLORS[user.role]}">${initials}</span>
    <span class="user-badge-info">
      <span class="user-badge-name">${escapeHtml(user.name)}</span>
      <span class="user-badge-role">${ROLE_LABELS[user.role]}</span>
    </span>
    <button class="user-badge-pin" onclick="openChangePinModal()" title="Cambiar PIN">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    </button>
    <button class="user-badge-logout" onclick="logout()" title="Cerrar sesión">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
    </button>`;
}

// ── Export / Import ───────────────────────────────────────────────────────────

function exportUsers() {
  const users = getUsers();
  if (users.length === 0) { alert('No hay usuarios para exportar.'); return; }
  // Strip credentials — hashes must never travel in the export code
  const safe = users.map(({ id, name, role, created_at }) => ({ id, name, role, created_at }));
  const code = 'CAU:' + btoa(encodeURIComponent(JSON.stringify(safe)));
  const btn = document.getElementById('btn-export-users');

  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = '✓ Copiado';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = '↑ Exportar'; btn.disabled = false; }, 2500);
  }).catch(() => {
    prompt('Copia este código y compártelo:', code);
  });
}

async function doImportUsers() {
  const raw = document.getElementById('import-code-input').value.trim();
  const errEl = document.getElementById('import-error');

  if (!raw.startsWith('CAU:')) {
    errEl.textContent = 'Código inválido — debe comenzar con CAU:';
    errEl.classList.remove('pin-error-hidden'); return;
  }

  let users;
  try {
    users = JSON.parse(decodeURIComponent(atob(raw.slice(4))));
  } catch {
    errEl.textContent = 'Error al leer el código — verifica que esté completo y sin espacios extra.';
    errEl.classList.remove('pin-error-hidden'); return;
  }

  if (!Array.isArray(users) || users.length === 0) {
    errEl.textContent = 'El código no contiene usuarios válidos.';
    errEl.classList.remove('pin-error-hidden'); return;
  }

  const valid = users.filter(u => u.id && u.name && u.role);
  if (valid.length === 0) {
    errEl.textContent = 'El código no contiene usuarios válidos.';
    errEl.classList.remove('pin-error-hidden'); return;
  }

  const existing = getUsers();
  if (existing.length > 0 && !confirm(`Esto reemplazará los ${existing.length} usuario(s) actuales con ${valid.length} importados. ¿Continuar?`)) return;

  // Assign a random temporary PIN to each imported user (credentials not in export)
  const tempPins = [];
  const withPins = await Promise.all(valid.map(async u => {
    const existingUser = existing.find(e => e.id === u.id);
    if (existingUser?.pin_hash) return existingUser; // keep existing credentials
    const tempPin = String(Math.floor(1000 + Math.random() * 9000));
    const salt = generateSalt();
    tempPins.push({ name: u.name, pin: tempPin });
    return { ...u, pin_salt: salt, pin_hash: await hashPin(tempPin, salt) };
  }));

  saveUsers(withPins);

  // Sync imported users to Firestore (replace all)
  if (db) {
    try {
      const snap = await db.collection('users').get();
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      withPins.forEach(u => batch.set(db.collection('users').doc(u.id), u));
      await batch.commit();
    } catch (err) { console.warn('Import Firestore sync failed:', err.message); }
  }

  document.getElementById('import-code-input').value = '';
  errEl.classList.add('pin-error-hidden');

  if (tempPins.length > 0) {
    const list = tempPins.map(p => `${p.name}: PIN ${p.pin}`).join('\n');
    alert(`Usuarios importados. PINs temporales asignados (cámbialos en el primer login):\n\n${list}`);
  }

  renderLoginUserList(withPins);
  showLoginStep('users');
}

// ── Change PIN ────────────────────────────────────────────────────────────────

function openChangePinModal() {
  ['pin-current','pin-new','pin-new-confirm'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('pin-change-error').classList.add('hidden');
  document.getElementById('modal-change-pin').classList.remove('hidden');
  document.getElementById('pin-current').focus();
}

function closeChangePinModal() {
  document.getElementById('modal-change-pin').classList.add('hidden');
}

async function saveChangedPin() {
  const current = document.getElementById('pin-current').value;
  const newPin  = document.getElementById('pin-new').value;
  const confirm = document.getElementById('pin-new-confirm').value;
  const errEl   = document.getElementById('pin-change-error');
  const btn     = document.getElementById('btn-save-pin');

  if (!/^\d{4}$/.test(current)) { errEl.textContent = 'Ingresa tu PIN actual.'; errEl.classList.remove('hidden'); return; }
  if (!/^\d{4}$/.test(newPin))  { errEl.textContent = 'El nuevo PIN debe tener 4 dígitos.'; errEl.classList.remove('hidden'); return; }
  if (newPin !== confirm)       { errEl.textContent = 'Los PINs nuevos no coinciden.'; errEl.classList.remove('hidden'); return; }
  if (current === newPin)       { errEl.textContent = 'El nuevo PIN debe ser diferente al actual.'; errEl.classList.remove('hidden'); return; }

  const session = getSession();
  if (!session) return;

  const ok = await verifyPin(session.userId, current);
  if (!ok) { errEl.textContent = 'PIN actual incorrecto.'; errEl.classList.remove('hidden'); return; }

  btn.textContent = 'Guardando…'; btn.disabled = true;
  try {
    await updateUser(session.userId, {}, newPin);
    closeChangePinModal();
  } catch (e) {
    errEl.textContent = 'Error al guardar el PIN. Intenta de nuevo.';
    errEl.classList.remove('hidden');
    return;
  } finally {
    btn.textContent = 'Guardar'; btn.disabled = false;
  }

  // Brief success toast
  const badge = document.getElementById('user-badge');
  const toast = document.createElement('span');
  toast.textContent = 'PIN actualizado ✓';
  toast.style.cssText = 'position:fixed;top:70px;right:20px;background:#2E7D32;color:white;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;z-index:9999;box-shadow:0 2px 12px rgba(0,0,0,.2)';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

// ── First-time Setup ──────────────────────────────────────────────────────────

function setupFirstUserForm() {
  document.getElementById('btn-import-back').addEventListener('click', () =>
    showLoginStep(getUsers().length > 0 ? 'users' : 'setup')
  );
  document.getElementById('btn-create-admin').addEventListener('click', async () => {
    const name    = document.getElementById('setup-name').value.trim();
    const pin     = document.getElementById('setup-pin').value;
    const confirm = document.getElementById('setup-pin-confirm').value;
    const errEl   = document.getElementById('setup-error');

    if (!name)               { errEl.textContent = 'Ingresa tu nombre.'; errEl.classList.remove('pin-error-hidden'); return; }
    if (!/^\d{4}$/.test(pin)) { errEl.textContent = 'El PIN debe tener exactamente 4 dígitos.'; errEl.classList.remove('pin-error-hidden'); return; }
    if (pin !== confirm)     { errEl.textContent = 'Los PINs no coinciden.'; errEl.classList.remove('pin-error-hidden'); return; }

    errEl.classList.add('pin-error-hidden');
    const user = await createUser(name, 'admin', pin);
    finishLogin(user);
  });
}

// ── User Management ───────────────────────────────────────────────────────────

function renderUsersPanel() {
  const users = getUsers();
  const countEl = document.getElementById('users-count');
  if (countEl) countEl.textContent = `${users.length} usuario${users.length !== 1 ? 's' : ''}`;

  const list = document.getElementById('users-list');
  if (!list) return;

  const adminCount = users.filter(u => u.role === 'admin').length;
  list.innerHTML = users.map(u => {
    const initials = u.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const isLastAdmin = u.role === 'admin' && adminCount === 1;
    return `<div class="user-row" id="user-row-${u.id}">
      <span class="user-row-avatar" style="background:${ROLE_COLORS[u.role]}">${initials}</span>
      <span class="user-row-name">${escapeHtml(u.name)}</span>
      <span class="user-row-role-badge" style="background:${ROLE_COLORS[u.role]}22;color:${ROLE_COLORS[u.role]}">${ROLE_LABELS[u.role]}</span>
      <div class="user-row-actions">
        <button class="btn-icon-sm" onclick="editUserInline('${u.id}')" title="Editar">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        ${!isLastAdmin ? `<button class="btn-icon-sm btn-icon-danger" onclick="confirmDeleteUser('${u.id}')" title="Eliminar">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function editUserInline(userId) {
  const user = getUsers().find(u => u.id === userId);
  if (!user) return;
  const row = document.getElementById(`user-row-${userId}`);
  const roleOptions = Object.entries(ROLE_LABELS)
    .map(([k, v]) => `<option value="${k}" ${user.role === k ? 'selected' : ''}>${v}</option>`)
    .join('');
  row.innerHTML = `<div class="user-edit-form" style="width:100%">
    <input id="edit-name-${userId}" value="${escapeHtml(user.name)}" placeholder="Nombre">
    <select id="edit-role-${userId}">${roleOptions}</select>
    <input id="edit-pin-${userId}" type="password" maxlength="4" inputmode="numeric" placeholder="Nuevo PIN (dejar vacío = sin cambio)">
    <div class="user-edit-actions">
      <button class="btn-primary btn-sm" onclick="saveUserEdit('${userId}')">Guardar</button>
      <button class="btn-secondary btn-sm" onclick="renderUsersPanel()">Cancelar</button>
    </div>
  </div>`;
}

async function saveUserEdit(userId) {
  const name = document.getElementById(`edit-name-${userId}`).value.trim();
  const role = document.getElementById(`edit-role-${userId}`).value;
  const pin  = document.getElementById(`edit-pin-${userId}`).value;

  if (!name) { alert('Ingresa un nombre.'); return; }
  if (pin && !/^\d{4}$/.test(pin)) { alert('El PIN debe tener 4 dígitos.'); return; }

  const users = getUsers();
  if (role !== 'admin') {
    const admins = users.filter(u => u.role === 'admin');
    if (admins.length === 1 && admins[0].id === userId) {
      alert('No puedes cambiar el rol del único administrador.'); return;
    }
  }

  await updateUser(userId, { name, role }, pin || null);
  renderUsersPanel();
}

function confirmDeleteUser(userId) {
  const user = getUsers().find(u => u.id === userId);
  if (!user) return;
  if (!confirm(`¿Eliminar a ${user.name}? Esta acción no se puede deshacer.`)) return;
  deleteUser(userId);
  renderUsersPanel();
}

function showAddUserForm() {
  document.getElementById('user-add-form').classList.remove('hidden');
  document.getElementById('btn-add-user').style.display = 'none';
  ['new-user-name','new-user-pin','new-user-pin-confirm'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('new-user-role').value = 'analyst';
  document.getElementById('new-user-error').classList.add('hidden');
}

async function saveNewUser() {
  const name    = document.getElementById('new-user-name').value.trim();
  const role    = document.getElementById('new-user-role').value;
  const pin     = document.getElementById('new-user-pin').value;
  const confirm = document.getElementById('new-user-pin-confirm').value;
  const errEl   = document.getElementById('new-user-error');

  if (!name)               { errEl.textContent = 'Ingresa el nombre.'; errEl.classList.remove('hidden'); return; }
  if (!/^\d{4}$/.test(pin)) { errEl.textContent = 'El PIN debe tener 4 dígitos.'; errEl.classList.remove('hidden'); return; }
  if (pin !== confirm)     { errEl.textContent = 'Los PINs no coinciden.'; errEl.classList.remove('hidden'); return; }

  await createUser(name, role, pin);
  cancelAddUser();
  renderUsersPanel();
}

function cancelAddUser() {
  document.getElementById('user-add-form').classList.add('hidden');
  document.getElementById('btn-add-user').style.display = '';
}

// ── Settings Modal ────────────────────────────────────────────────────────────

function setupSettingsModal() {
  document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('modal-settings').classList.add('hidden');
  });
}

function openSettingsModal() {
  if (getActiveRole() !== 'admin') return;
  cancelAddUser();
  syncUsersFromFirestore().then(() => renderUsersPanel());
  document.getElementById('modal-settings').classList.remove('hidden');
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if (window.location.protocol === 'file:') {
    document.getElementById('file-protocol-banner').style.display = 'block';
  }

  // Storage uploads are now handled server-side via /api/upload-evidencia

  renderCharacteristics();
  addComponentRow();
  setupTabNav();
  setupFormNav();
  setupButtons();
  setupSettingsModal();
  setupToyAnalysis();
  setupWelcome();
  renderHistory();
  setupLabelCheck();
  setupFirstUserForm();
  document.querySelectorAll('.pin-key').forEach(btn =>
    btn.addEventListener('click', () => handlePinKey(btn.dataset.key))
  );

  // Sync users from Firestore before showing login or app
  await syncUsersFromFirestore();

  const session = getSession();
  if (session) {
    const user = getUsers().find(u => u.id === session.userId);
    if (user) {
      document.getElementById('welcome-screen').classList.add('hidden');
      applyRoleRestrictions(session.role);
      renderUserBadge(user);
      if (session.role === 'viewer') {
        setTimeout(openHistory, 300);
      } else {
        showDashboard();
      }
    } else {
      clearSession();
      showLoginScreen();
    }
  } else {
    showLoginScreen();
  }
});

function apiErrorMsg(err) {
  const msg = err.message || String(err);
  if (msg.includes('Failed to fetch')) {
    return window.location.protocol === 'file:'
      ? 'Abre la app en el servidor (no como archivo local) para usar las funciones de IA.'
      : 'Error de red — verifica tu conexión a internet.';
  }
  return msg;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function showDashboard() {
  document.getElementById('form-section').classList.add('hidden');
  document.getElementById('results-section').classList.add('hidden');
  document.getElementById('progress-section').classList.add('hidden');
  document.getElementById('dashboard-section').classList.remove('hidden');
  renderDashboard();

  if (db) {
    setDashSyncState(true);
    mergeCloudHistory()
      .then(changed => { if (changed) renderDashboard(); })
      .catch(() => {})
      .finally(() => setDashSyncState(false));
  }
}

function setDashSyncState(syncing) {
  const el = document.getElementById('dash-sync-status');
  if (!el) return;
  el.textContent = syncing ? '↻ Sincronizando...' : '';
}

function hideDashboard() {
  document.getElementById('dashboard-section').classList.add('hidden');
}

function openNewExpediente() {
  hideDashboard();
  resetForm();
  document.getElementById('form-section').classList.remove('hidden');
}

function setDashFilter(filter) {
  dashboardFilter = filter;
  document.querySelectorAll('.dash-filter-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.filter === filter)
  );
  renderDashGrid();
}

function renderDashboard() {
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const countEl = document.getElementById('dash-count');
  if (countEl) countEl.textContent = hist.length;
  renderDashGrid();
}

function renderDashGrid() {
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const grid = document.getElementById('dash-grid');

  const filtered = dashboardFilter === 'todos'
    ? hist
    : hist.filter(h => (h.status || 'borrador') === dashboardFilter);

  if (!hist.length) {
    grid.innerHTML = `
      <div class="dash-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 12 15 15"/></svg>
        <p>Aún no hay expedientes.</p>
        <button class="btn-primary" onclick="openNewExpediente()">Crear primer expediente</button>
      </div>`;
    return;
  }

  if (!filtered.length) {
    grid.innerHTML = `<div class="dash-empty"><p>No hay expedientes con ese estado.</p></div>`;
    return;
  }

  grid.innerHTML = filtered.map((h, _) => {
    const realIdx = hist.indexOf(h);
    const sc = STATUS_CFG[h.status || 'borrador'];
    const docBadges = buildDocProgressBadges(h.docProgress);
    const missing = getDocProgressMissing(h.docProgress);
    const hasPreviews = h.previews && Object.keys(h.previews).length > 0;
    const hasFormData = !!h.formData && !!(h.mercados || []).length;
    const cloudIcon = h.expId
      ? `<span class="dash-cloud-icon" title="Guardado en la nube">☁</span>`
      : '';

    const docsStatus = h.docProgress
      ? (missing === 0
          ? `<div class="dash-docs-ok">✓ Documentos completos</div>`
          : `<div class="dash-docs-warn">⚠ ${missing} doc${missing !== 1 ? 's' : ''} pendiente${missing !== 1 ? 's' : ''}</div>`)
      : '';

    return `
    <div class="dash-card" onclick="openDashboardItem(${realIdx})">
      <div class="dash-card-header">
        <span class="dash-card-status ${sc.cls}">${sc.label}</span>
        ${cloudIcon}
      </div>
      <div class="dash-card-name">${escapeHtml(h.nombre)}</div>
      <div class="dash-card-meta">${escapeHtml(h.categoria || '')} · ${h.fecha}</div>
      <div class="dash-card-markets">${(h.mercados || []).map(k => (MARKETS[k]?.flag || '') + ' ' + (MARKETS[k]?.nombre || k)).join(' · ')}</div>
      ${docBadges ? `<div class="dash-doc-badges">${docBadges}</div>` : ''}
      ${docsStatus}
      <div class="dash-card-actions" onclick="event.stopPropagation()">
        ${hasPreviews ? `<button class="btn-dash-action btn-dash-view" onclick="openDashboardItem(${realIdx})">Ver expediente</button>` : ''}
        ${hasFormData ? `<button class="btn-dash-action btn-dash-regen" onclick="regenerateFromDash(${realIdx})">☁ Regenerar</button>` : ''}
        ${hasFormData ? `<button class="btn-dash-action btn-dash-template" onclick="loadAsTemplateFromDash(${realIdx})">Usar como base</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function openDashboardItem(index) {
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const h = hist[index];
  if (!h?.previews || !Object.keys(h.previews).length) {
    if (h?.formData) {
      loadAsTemplateFromDash(index);
    }
    return;
  }
  hideDashboard();
  currentHistoryIndex = index;
  generatedDocs = {};
  (h.mercados || FIXED_MARKETS).forEach(k => {
    if (h.previews[k]) generatedDocs[k] = { html: h.previews[k], blob: null };
  });
  document.getElementById('form-section').classList.add('hidden');
  renderResults({ nombre: h.nombre });
}

function regenerateFromDash(index) {
  hideDashboard();
  regenerateExpediente(index);
}

function loadAsTemplateFromDash(index) {
  hideDashboard();
  loadAsTemplate(index);
}

// ── Welcome Screen ────────────────────────────────────────────────────────────
function setupWelcome() {
  document.getElementById('btn-welcome-start').addEventListener('click', closeWelcome);
}

function closeWelcome() {
  const ws = document.getElementById('welcome-screen');
  ws.style.opacity = '0';
  ws.style.transition = 'opacity .4s ease';
  setTimeout(() => ws.classList.add('hidden'), 400);
}

function openWelcome() {
  const ws = document.getElementById('welcome-screen');
  ws.classList.remove('hidden');
  ws.style.opacity = '0';
  ws.style.transition = 'opacity .3s ease';
  requestAnimationFrame(() => { ws.style.opacity = '1'; });
}

// ── Tab Navigation ───────────────────────────────────────────────────────────
function setupTabNav() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => goToTab(parseInt(btn.dataset.tab)));
  });
}

function goToTab(n, skipValidation = false) {
  // Validate current tab before moving forward
  if (!skipValidation && n > currentTab) {
    for (let t = currentTab; t < n; t++) {
      const errors = validateTab(t);
      if (errors.length > 0) {
        showValidationErrors(errors);
        return;
      }
    }
  }
  clearValidationErrors();
  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.dot').forEach(d => d.classList.remove('active'));
  document.getElementById(`tab-${n}`).classList.remove('hidden');
  document.querySelector(`.tab-btn[data-tab="${n}"]`).classList.add('active');
  document.querySelector(`.dot[data-step="${n}"]`).classList.add('active');
  currentTab = n;
  document.getElementById('btn-prev').disabled = n === 1;
  const isLast = n === TOTAL_TABS;
  document.getElementById('btn-next').style.display = isLast ? 'none' : '';
  document.getElementById('generate-section').classList.toggle('hidden', !isLast);
}

function setupFormNav() {
  document.getElementById('btn-prev').addEventListener('click', () => goToTab(Math.max(1, currentTab - 1)));
  document.getElementById('btn-next').addEventListener('click', () => goToTab(Math.min(TOTAL_TABS, currentTab + 1)));
  document.querySelectorAll('.dot').forEach(d => {
    d.addEventListener('click', () => goToTab(parseInt(d.dataset.step)));
  });
}

// ── Validation ────────────────────────────────────────────────────────────────
function validateTab(n) {
  const errors = [];
  if (n === 1) {
    const nombre = document.getElementById('f-nombre').value.trim();
    const categoria = document.getElementById('f-categoria').value;
    if (!nombre) errors.push({ fieldId: 'f-nombre', msg: 'El nombre comercial es obligatorio.' });
    if (!categoria) errors.push({ fieldId: 'f-categoria', msg: 'Selecciona una categoría de producto.' });
  }
  if (n === 2) {
    syncComponents();
    const validos = components.filter(c => c.componente && c.material);
    if (validos.length === 0) errors.push({ tableId: 'components-body', msg: 'Agrega al menos un componente con nombre y material.' });
  }
  return errors;
}

function showValidationErrors(errors) {
  clearValidationErrors();
  const banner = document.getElementById('validation-banner');
  const msg = document.getElementById('validation-msg');
  msg.textContent = errors.map(e => e.msg).join(' ');
  banner.classList.remove('hidden');

  errors.forEach(e => {
    if (e.fieldId) {
      const field = document.getElementById(e.fieldId);
      if (field) field.closest('.field')?.classList.add('field-error');
    }
    if (e.tableId) {
      document.querySelector('.table-wrapper')?.classList.add('table-error');
    }
  });

  // Auto-hide after 4 seconds
  clearTimeout(window._validationTimer);
  window._validationTimer = setTimeout(clearValidationErrors, 4000);

  // Scroll banner into view
  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearValidationErrors() {
  document.getElementById('validation-banner').classList.add('hidden');
  document.querySelectorAll('.field-error').forEach(el => el.classList.remove('field-error'));
  document.querySelectorAll('.table-error').forEach(el => el.classList.remove('table-error'));
}

// Clear errors when user starts filling fields
['f-nombre', 'f-categoria'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', clearValidationErrors);
  document.getElementById(id)?.addEventListener('change', clearValidationErrors);
});

// ── Characteristics ──────────────────────────────────────────────────────────
const CHAR_GROUP_LABELS = {
  general:   'General',
  mecanico:  'Peligros mecánicos (EN 71-1 / ASTM F963)',
  electrico: 'Peligros eléctricos y térmicos',
  acustico:  'Peligros acústicos',
};

function renderCharacteristics() {
  const grid = document.getElementById('characteristics-grid');
  const groups = {};
  CHARACTERISTICS.forEach(c => { (groups[c.group] = groups[c.group] || []).push(c); });
  grid.innerHTML = Object.entries(groups).map(([g, items]) => `
    <div class="char-group">
      <div class="char-group-label">${CHAR_GROUP_LABELS[g] || g}</div>
      <div class="char-group-items">
        ${items.map(c => `
          <label class="char-option">
            <input type="checkbox" id="char-${c.id}" value="${c.id}">
            <span>${c.label}</span>
          </label>`).join('')}
      </div>
    </div>`).join('');
  grid.querySelectorAll('.char-option input').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.closest('.char-option').classList.toggle('selected', cb.checked);
    });
  });
}

function getCharacteristics() {
  return [...document.querySelectorAll('.char-option.selected')]
    .map(el => el.querySelector('input').value);
}

// ── PS Upload (Tab 2) ────────────────────────────────────────────────────────
document.getElementById('f-ps').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const area = document.getElementById('ps-upload-area');
  const status = document.getElementById('ps-status');
  area.className = 'ps-upload-area loading';
  status.innerHTML = '<span style="color:#185FA5">⏳ Identificando materiales con IA...</span>';
  try {
    const result = await parsePSWithClaude(file, () => {
      status.innerHTML = '<span style="color:#185FA5">⏳ PDF grande — extrayendo texto (puede tardar un momento)...</span>';
    });
    if (!result.componentes || result.componentes.length === 0) {
      status.innerHTML = '<span style="color:#856404">⚠ No se encontraron materiales en el documento.</span>';
      area.className = 'ps-upload-area';
      return;
    }
    // Clear existing rows and add extracted components
    document.getElementById('components-body').innerHTML = '';
    components = [];
    for (const comp of result.componentes) {
      addComponentRow(comp.nombre || '', comp.material || '', comp.contacto || 'Sin contacto');
    }
    syncComponents();
    const n = result.componentes.length;
    status.innerHTML = `<span style="color:#2E7D32">✓ ${n} componente${n > 1 ? 's' : ''} extraído${n > 1 ? 's' : ''}</span>`;
    area.className = 'ps-upload-area done';
  } catch (err) {
    console.error('PS parse error:', err);
    status.innerHTML = `<span style="color:#E53E3E">⚠ Error: ${apiErrorMsg(err)}</span>`;
    area.className = 'ps-upload-area';
  }
});

async function parsePSWithClaude(file, onFallback) {
  const materiales = ['ABS', 'PP', 'PS', 'PVC', 'PET', 'HDPE', 'LDPE', 'Silicona', 'Acero inoxidable', 'Aluminio', 'Metal', 'Vidrio', 'Cartón', 'Papel', 'Madera', 'Nylon', 'Policarbonato', 'Otro'];

  const prompt = `Analiza este documento de especificaciones de materiales (PS / BOM / ficha de materiales) y extrae todos los componentes y sus materiales.

Devuelve SOLO un JSON válido con esta estructura:
{
  "componentes": [
    {
      "nombre": "nombre del componente o parte",
      "material": "material principal (usa uno de: ${materiales.join(', ')})",
      "contacto": "Directo" | "Indirecto" | "Sin contacto",
      "descripcion": "descripción breve opcional del material o especificación técnica"
    }
  ]
}

Reglas:
- "contacto" = "Directo" si el componente toca directamente los alimentos o bebidas
- "contacto" = "Indirecto" si está entre el alimento y otro material sin tocarlo directamente
- "contacto" = "Sin contacto" si no tiene relación con los alimentos
- Si no puedes determinar el contacto, usa "Sin contacto"
- Incluye TODOS los materiales o partes mencionados, aunque sean accesorios`;

  const system = 'Eres un especialista en materiales de construcción de productos (BOM/PS). Responde ÚNICAMENTE con JSON válido, sin texto adicional ni markdown.';

  const MAX_DIRECT = 3 * 1024 * 1024; // 3 MB — Vercel proxy limit (~4.5 MB with base64 overhead)
  let raw;

  if (file.size <= MAX_DIRECT) {
    raw = await callClaudeWithDoc(file, prompt, { system, maxTokens: 1000 });
  } else {
    // File too large for document block → extract text with PDF.js and send as text
    if (onFallback) onFallback();
    const text = await extractPdfTextForPS(file);
    if (!text.trim()) throw new Error('El PDF no contiene texto extraíble. Intenta con un PDF más pequeño o ingresa los componentes manualmente.');
    raw = await callClaude(`${prompt}\n\nDOCUMENTO:\n${text}`, { system, maxTokens: 1000 });
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON');
  return JSON.parse(match[0]);
}

async function extractPdfTextForPS(file) {
  if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js no disponible');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  const maxPages = Math.min(pdf.numPages, 30);
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map(item => item.str).join(' ') + '\n';
    if (fullText.length > 28000) break;
  }
  return fullText;
}

// ── Components Table ─────────────────────────────────────────────────────────
const MATERIALS = ['ABS', 'PP', 'PS', 'PVC', 'PET', 'HDPE', 'LDPE', 'Silicona', 'Acero inoxidable', 'Aluminio', 'Metal', 'Vidrio', 'Cartón', 'Papel', 'Madera', 'Nylon', 'Policarbonato', 'Otro'];
const CONTACT_OPTS = ['Directo', 'Indirecto', 'Sin contacto'];

let _rowId = 0;
function addComponentRow(nombre = '', material = '', contacto = 'Sin contacto') {
  const tbody = document.getElementById('components-body');
  const id = ++_rowId;
  const row = document.createElement('tr');
  row.dataset.id = id;
  row.innerHTML = `
    <td><input type="text" placeholder="Ej: Contenedor" value="${escapeHtml(nombre)}" oninput="syncComponents()"></td>
    <td><select onchange="syncComponents()">
      ${MATERIALS.map(m => `<option ${m === material ? 'selected' : ''}>${m}</option>`).join('')}
    </select></td>
    <td><select onchange="syncComponents()">
      ${CONTACT_OPTS.map(c => `<option ${c === contacto ? 'selected' : ''}>${c}</option>`).join('')}
    </select></td>
    <td><button class="btn-remove-row" onclick="removeRow(${id})">✕</button></td>`;
  tbody.appendChild(row);
  syncComponents();
}

function removeRow(id) {
  const row = document.querySelector(`tr[data-id="${id}"]`);
  if (row) { row.remove(); syncComponents(); }
}

function syncComponents() {
  components = [...document.querySelectorAll('#components-body tr')].map(row => {
    const inputs = row.querySelectorAll('input, select');
    return { componente: inputs[0].value.trim(), material: inputs[1].value, contacto_alimento: inputs[2].value };
  }).filter(c => c.componente || c.material);
}

function renderComponents() {
  document.getElementById('components-body').innerHTML = '';
  components.forEach(c => addComponentRow(c.componente || '', c.material || '', c.contacto_alimento || 'Sin contacto'));
}

document.getElementById('btn-add-component').addEventListener('click', () => addComponentRow());

// ── PDF Text Extraction ───────────────────────────────────────────────────────
document.getElementById('f-pdf').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById('pdf-status');
  status.innerHTML = '<span style="color:#185FA5">⏳ Extrayendo texto del PDF...</span>';
  try {
    status.innerHTML = '<span style="color:#185FA5">⏳ Analizando ficha con IA...</span>';
    const f = await parsePdfFieldsWithClaude(file);
    let filled = 0;

    // ── Tab 1: Producto ──
    const setIf = (id, val) => { if (val && !document.getElementById(id).value) { document.getElementById(id).value = val; filled++; } };
    setIf('f-nombre', f.nombre_comercial);
    setIf('f-descripcion', f.descripcion);
    if (f.categoria) {
      const sel = document.getElementById('f-categoria');
      const target = f.categoria.toLowerCase();
      for (const opt of sel.options) {
        if (opt.value && opt.value.toLowerCase().split(' ').some(w => target.includes(w) || target.split(' ').some(tw => opt.value.toLowerCase().includes(tw)))) {
          sel.value = opt.value; filled++; break;
        }
      }
    }

    // ── Tab 2: Componentes ──
    if (f.componentes && Array.isArray(f.componentes) && f.componentes.length > 0 && components.filter(c => c.componente).length === 0) {
      document.getElementById('components-body').innerHTML = '';
      for (const c of f.componentes) {
        const contacto = CONTACT_OPTS.includes(c.contacto) ? c.contacto : 'Sin contacto';
        addComponentRow(c.nombre || '', c.material || '', contacto);
      }
      syncComponents();
      filled++;
    }

    // ── Tab 3: Características ──
    if (f.caracteristicas && Array.isArray(f.caracteristicas)) {
      for (const charId of f.caracteristicas) {
        const cb = document.getElementById(`char-${charId}`);
        if (cb && !cb.checked) { cb.checked = true; cb.closest('.char-option').classList.add('selected'); filled++; }
      }
    }
    setIf('f-capacidad', f.capacidad);
    if (f.edad_minima) {
      const sel = document.getElementById('f-edad');
      for (const opt of sel.options) {
        if (opt.value === f.edad_minima) { sel.value = f.edad_minima; filled++; break; }
      }
    }

    // ── Tab 5: Empresa ──
    setIf('f-empresa', f.empresa);
    setIf('f-responsable', f.responsable);
    setIf('f-cargo', f.cargo);
    setIf('f-contacto', f.contacto_email);
    setIf('f-canal', f.canal);
    setIf('f-publico', f.publico_objetivo);
    setIf('f-referencia', f.referencia_interna);

    if (filled > 0) {
      status.innerHTML = `<span style="color:#2E7D32">✓ ${filled} campo(s) autocompletado(s) en todas las pestañas — revisa y ajusta</span>`;
    } else {
      status.innerHTML = '<span style="color:#856404">⚠ La IA no encontró campos en este PDF. Completa manualmente.</span>';
    }

    // Run toy analysis automatically after PDF fill
    runToyAnalysis();

  } catch (err) {
    console.error('PDF parse error:', err);
    status.innerHTML = `<span style="color:#E53E3E">⚠ Error: ${apiErrorMsg(err)}</span>`;
  }
});


async function parsePdfFieldsWithClaude(file) {
  const categorias = ['Contenedor de alimentos','Vaso / Taza','Plato / Bowl','Utensilio de cocina','Envase de alimentos','Juguete con función alimentaria','Accesorio de cocina','Set de utensilios'];
  const charIds = ['juguete','ninos','food_direct','plastico','multicolor','disenio_3d','bordes_filosos','partes_pequenas','piezas_moviles','imanes','cuerdas','proyectiles','liquidos','electronico','bateria','bateria_boton','led','vapor','conectividad','internet','ruido','kit_quimico'];

  const prompt = `Analiza esta ficha técnica de producto y extrae los campos. Devuelve SOLO JSON válido.

Claves del JSON (usa null si no encuentras el valor):
- "nombre_comercial": nombre del producto
- "categoria": EXACTAMENTE una de estas: ${categorias.join(' | ')}
- "descripcion": descripción breve del producto (máx 350 chars)
- "capacidad": capacidad/volumen como string (ej: "500 ml", "16 oz") o null
- "componentes": array de {nombre, material, contacto} donde contacto = "Directo", "Indirecto" o "Sin contacto"
- "caracteristicas": array con los IDs aplicables de esta lista: ${charIds.join(', ')}
  - disenio_3d = tiene figura o diseño 3D
  - bordes_filosos = tiene bordes o puntas filosas
  - partes_pequenas = tiene partes menores a 31.7mm
  - juguete = es categoría juguete/toy
  - ninos = dirigido a niños
  - led = tiene LEDs o iluminación
  - electronico = tiene componente electrónico
  - bateria = tiene pila, batería o USB
  - vapor = genera vapor
  - multicolor = tiene pintura o múltiples colores
  - plastico = material plástico
  - food_direct = contacto directo con alimentos
- "edad_minima": una de: "0+" | "3+" | "6+" | "12+" | "18+" | null
- "empresa": nombre de la empresa o marca
- "responsable": nombre del responsable técnico o contacto
- "cargo": cargo o puesto del responsable
- "contacto_email": email o teléfono de contacto
- "canal": canal de distribución (retail, e-commerce, etc.)
- "publico_objetivo": público al que va dirigido
- "referencia_interna": código o referencia interna del producto`;

  const MAX_DIRECT_FIELDS = 3 * 1024 * 1024; // 3 MB — Vercel proxy limit
  const system = 'Eres un extractor de datos de fichas técnicas. Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown.';
  let raw;
  if (file.size <= MAX_DIRECT_FIELDS) {
    raw = await callClaudeWithDoc(file, prompt, { system, maxTokens: 1200 });
  } else {
    const text = await extractPdfTextForPS(file);
    if (!text.trim()) throw new Error('El PDF no contiene texto extraíble. Intenta con un PDF más pequeño.');
    raw = await callClaude(`${prompt}\n\nDOCUMENTO:\n${text}`, { system, maxTokens: 1200 });
  }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response');
  return JSON.parse(jsonMatch[0]);
}

// ── Toy Analysis ─────────────────────────────────────────────────────────────
function setupToyAnalysis() {
  document.getElementById('btn-analyze-toy').addEventListener('click', () => runToyAnalysis());
}

async function runToyAnalysis() {
  const btn = document.getElementById('btn-analyze-toy');
  const banner = document.getElementById('toy-analysis-banner');
  btn.disabled = true;
  btn.textContent = '⏳ Analizando...';
  banner.className = 'toy-banner hidden';

  const nombre = document.getElementById('f-nombre').value.trim() || '(sin nombre)';
  const categoria = document.getElementById('f-categoria').value || '(sin categoría)';
  const descripcion = document.getElementById('f-descripcion').value.trim() || '';
  const edad = document.getElementById('f-edad').value || '';
  const caracteristicas = getCharacteristics();
  const compList = components.map(c => `${c.componente} (${c.material})`).join(', ') || '';

  try {
    const result = await callToyAnalysisClaude({ nombre, categoria, descripcion, edad, caracteristicas, compList });
    showToyBanner(result);

    // Auto-mark characteristics if toy
    if (result.es_juguete === true) {
      ['juguete','ninos'].forEach(id => {
        const cb = document.getElementById(`char-${id}`);
        if (cb && !cb.checked) { cb.checked = true; cb.closest('.char-option').classList.add('selected'); }
      });
    }
    if (result.caracteristicas_sugeridas && Array.isArray(result.caracteristicas_sugeridas)) {
      result.caracteristicas_sugeridas.forEach(id => {
        const cb = document.getElementById(`char-${id}`);
        if (cb && !cb.checked) { cb.checked = true; cb.closest('.char-option').classList.add('selected'); }
      });
    }
  } catch (err) {
    console.error('Toy analysis error:', err);
    banner.className = 'toy-banner inconcluso';
    banner.classList.remove('hidden');
    document.getElementById('toy-banner-icon').textContent = '⚠';
    document.getElementById('toy-banner-title').textContent = 'No se pudo completar el análisis';
    document.getElementById('toy-banner-reason').textContent = 'Verifica tu conexión o API key e intenta de nuevo.';
    document.getElementById('toy-banner-confidence').textContent = '';
    document.getElementById('toy-banner-normas').innerHTML = '';
  }

  btn.disabled = false;
  btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> Volver a analizar`;
}

async function callToyAnalysisClaude({ nombre, categoria, descripcion, edad, caracteristicas, compList }) {
  const prompt = `Eres un experto en normativas internacionales de seguridad de productos, especialmente EN 71, ASTM F963, ISO 8124 y regulaciones CPSC.

Analiza si este producto puede clasificarse como JUGUETE según las definiciones regulatorias internacionales.

DATOS DEL PRODUCTO:
- Nombre: ${nombre}
- Categoría declarada: ${categoria}
- Descripción: ${descripcion}
- Edad mínima recomendada: ${edad || 'no especificada'}
- Características marcadas: ${caracteristicas.join(', ') || 'ninguna'}
- Componentes: ${compList || 'no especificados'}

DEFINICIÓN REGULATORIA: Un producto se considera juguete si está diseñado o previsto claramente para ser usado en juego por niños menores de 14 años, independientemente de si también tiene otra función (como contener alimentos).

Devuelve ÚNICAMENTE JSON con:
{
  "es_juguete": true | false | null,
  "confianza": "alta" | "media" | "baja",
  "razonamiento": "explicación breve de 1-2 oraciones",
  "normas_aplicables": ["EN 71", "ASTM F963", ...],
  "caracteristicas_sugeridas": ["juguete", "ninos", "disenio_3d", ...]
}

Posibles valores en caracteristicas_sugeridas: juguete, ninos, disenio_3d, bordes_filosos, partes_pequenas, piezas_moviles, imanes, cuerdas, proyectiles, liquidos, electronico, bateria, bateria_boton, led, vapor, ruido, plastico, multicolor, food_direct`;

  const raw = await callClaude(prompt, {
    system: 'Responde SOLO con JSON válido sin texto adicional ni markdown.',
    maxTokens: 400
  });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON');
  return JSON.parse(match[0]);
}

function showToyBanner(result) {
  const banner = document.getElementById('toy-analysis-banner');
  const icon = document.getElementById('toy-banner-icon');
  const title = document.getElementById('toy-banner-title');
  const confidence = document.getElementById('toy-banner-confidence');
  const reason = document.getElementById('toy-banner-reason');
  const normas = document.getElementById('toy-banner-normas');

  if (result.es_juguete === true) {
    banner.className = 'toy-banner es-juguete';
    icon.textContent = '🧸';
    title.textContent = 'Aplica normativa de juguete';
  } else if (result.es_juguete === false) {
    banner.className = 'toy-banner no-juguete';
    icon.textContent = '✓';
    title.textContent = 'No aplica normativa de juguete';
  } else {
    banner.className = 'toy-banner inconcluso';
    icon.textContent = '?';
    title.textContent = 'Clasificación inconclusa — requiere revisión';
  }

  const confLabels = { alta: 'Confianza alta', media: 'Confianza media', baja: 'Confianza baja' };
  confidence.textContent = confLabels[result.confianza] || '';
  reason.textContent = result.razonamiento || '';
  normas.innerHTML = (result.normas_aplicables || []).map(n => `<li>${escapeHtml(n)}</li>`).join('');
  banner.classList.remove('hidden');
}

// ── Generate Button ───────────────────────────────────────────────────────────
const COST_BASE = 0.091;    // ficha + PS + juguete + etiquetado base
const COST_PER_MARKET = 0.027; // Sonnet por mercado

function getSelectedMarkets() {
  return [...document.querySelectorAll('.market-checkbox:checked')].map(cb => cb.value);
}

function updateMarketCostHint() {
  const n = getSelectedMarkets().length;
  const total = (COST_BASE + n * COST_PER_MARKET).toFixed(2);
  const hint = document.getElementById('market-cost-hint');
  if (hint) hint.textContent = n === 0
    ? 'Selecciona al menos un mercado'
    : `Costo estimado: ~$${total} USD · ${n} mercado${n > 1 ? 's' : ''}`;
  const btn = document.getElementById('btn-generate');
  if (btn) btn.disabled = n === 0;
}

function setupButtons() {
  document.getElementById('btn-generate').addEventListener('click', startGeneration);
  document.getElementById('btn-new').addEventListener('click', showDashboard);
  document.getElementById('btn-history').addEventListener('click', openHistory);
  document.getElementById('btn-download-zip').addEventListener('click', downloadZip);
  document.querySelectorAll('.market-checkbox').forEach(cb =>
    cb.addEventListener('change', updateMarketCostHint)
  );
  updateMarketCostHint();
}

async function startGeneration() {
  if (getActiveRole() === 'viewer') return;
  syncComponents();
  const nombre = document.getElementById('f-nombre').value.trim();
  const categoria = document.getElementById('f-categoria').value;
  if (!nombre) { alert('Por favor ingresa el nombre comercial del producto.'); goToTab(1); return; }
  if (!categoria) { alert('Por favor selecciona la categoría del producto.'); goToTab(1); return; }
  if (components.filter(c => c.componente).length === 0) { alert('Agrega al menos un componente.'); goToTab(2); return; }

  const selectedMarkets = getSelectedMarkets();
  if (selectedMarkets.length === 0) { alert('Selecciona al menos un mercado para generar.'); return; }

  const formData = {
    nombre, categoria,
    descripcion: document.getElementById('f-descripcion').value.trim(),
    caracteristicas: getCharacteristics(),
    edad: document.getElementById('f-edad').value,
    capacidad: document.getElementById('f-capacidad').value.trim(),
    empresa: document.getElementById('f-empresa').value.trim(),
    responsable: document.getElementById('f-responsable').value.trim(),
    cargo: document.getElementById('f-cargo').value.trim(),
    contacto: document.getElementById('f-contacto').value.trim(),
    canal: document.getElementById('f-canal').value.trim(),
    publico: document.getElementById('f-publico').value.trim(),
    referencia: document.getElementById('f-referencia').value.trim(),
    version: document.getElementById('f-version').value.trim() || '1.0',
    fecha: new Date().toISOString().split('T')[0],
    componentes: components,
    mercados: selectedMarkets,
  };

  document.getElementById('form-section').classList.add('hidden');
  document.getElementById('results-section').classList.add('hidden');
  showProgress(true);
  generatedDocs = {};

  try {
    const total = selectedMarkets.length;
    for (let i = 0; i < selectedMarkets.length; i++) {
      const key = selectedMarkets[i];
      updateProgress(i, total, key);
      const result = await generateForMarket(formData, key);
      generatedDocs[key] = result;
    }
    updateProgress(total, total, '');
    await new Promise(r => setTimeout(r, 400));
    showProgress(false);
    renderResults(formData);
    saveToHistory(formData, selectedMarkets);
  } catch (err) {
    showProgress(false);
    document.getElementById('form-section').classList.remove('hidden');
    alert('Error: ' + err.message);
  }
}

// ── Progress ─────────────────────────────────────────────────────────────────
function showProgress(show) {
  document.getElementById('progress-section').classList.toggle('hidden', !show);
}

function updateProgress(done, total, currentKey) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  const mName = currentKey && MARKETS[currentKey] ? MARKETS[currentKey].nombre : (currentKey || '');
  document.getElementById('progress-text').textContent = done < total
    ? `Generando expediente ${mName}... (${done + 1}/${total})`
    : 'Finalizando documentos...';
  const details = document.getElementById('progress-details');
  details.innerHTML = Object.keys(generatedDocs).map(k =>
    `<span class="progress-item done">✓ ${MARKETS[k]?.nombre || k}</span>`
  ).join('') + (currentKey && !generatedDocs[currentKey]
    ? `<span class="progress-item active">⟳ ${mName}</span>` : '');
}

// ── Generate For Market ───────────────────────────────────────────────────────
async function generateForMarket(formData, mercadoKey) {
  const cfg = MARKETS[mercadoKey];
  const L = LABELS[cfg.idioma];
  const aiData = await callClaudeForMarket(formData, cfg, L);
  const html = buildHTMLPreview(formData, mercadoKey, cfg, L, aiData);
  let blob = null;
  let docxError = null;
  try {
    blob = await buildDocx(formData, mercadoKey, cfg, L, aiData);
  } catch (e) {
    console.warn('Word generation failed:', e.message);
    docxError = e.message;
  }
  return { blob, html, aiData, docxError };
}

// ── Claude API ────────────────────────────────────────────────────────────────
const CLAUDE_BASE_HEADERS = () => ({
  'anthropic-version': '2023-06-01',
  'Content-Type': 'application/json',
});

async function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function callClaudeWithDoc(pdfFile, textPrompt, { system, maxTokens = 1200, model = 'claude-haiku-4-5-20251001' } = {}) {
  const base64 = await readFileAsBase64(pdfFile);
  const body = {
    model, max_tokens: maxTokens,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: textPrompt }
    ]}]
  };
  if (system) body.system = system;
  const res = await fetch('/api/claude', {
    method: 'POST', headers: CLAUDE_BASE_HEADERS(), body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text.trim();
}

async function callClaude(prompt, { system, maxTokens = 1200, model = 'claude-haiku-4-5-20251001' } = {}) {
  const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (system) body.system = system;
  const res = await fetch('/api/claude', {
    method: 'POST', headers: CLAUDE_BASE_HEADERS(), body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text.trim();
}

async function callClaudeVision(file, textPrompt) {
  const base64 = await readFileAsBase64(file);
  const mediaType = file.type || 'image/png';
  const res = await fetch('/api/claude', {
    method: 'POST', headers: CLAUDE_BASE_HEADERS(),
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 2000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: textPrompt }
      ]}]
    })
  });
  if (!res.ok) throw new Error(`Claude Vision API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text.trim();
}

async function callClaudeForMarket(formData, cfg, L) {
  const matDirecto = formData.componentes.filter(c => c.contacto_alimento === 'Directo').map(c => `${c.componente} (${c.material})`).join(', ') || 'ninguno';
  const matAll = [...new Set(formData.componentes.map(c => c.material))].join(', ');
  const isEn = cfg.idioma === 'en';
  const isPt = cfg.idioma === 'pt';
  const lang = isEn ? 'English' : isPt ? 'Portuguese (Brazil)' : 'Spanish';
  const prio = isEn ? 'HIGH/MEDIUM/LOW' : isPt ? 'ALTO/MEDIO/BAIXO' : 'ALTO/MEDIO/BAJO';
  const prioHi = prio.split('/')[0];

  const t = (es, en, pt) => isEn ? en : isPt ? pt : es;

  // Sanitize user inputs: truncate and wrap in XML tags so Claude treats them as data, not instructions
  const safeName = String(formData.nombre || '').slice(0, 200);
  const safeDesc = String(formData.descripcion || '').slice(0, 500);

  const systemMsg = isEn
    ? 'You are a compliance expert for food-contact promotional products. Write ALL text values in English. Output valid JSON only, no markdown, no extra text.'
    : isPt
    ? 'Você é um especialista em conformidade para produtos promocionais em contato com alimentos. Escreva TODOS os valores de texto em Português do Brasil. Gere apenas JSON válido, sem markdown, sem texto extra.'
    : 'Eres un experto en cumplimiento normativo para productos promocionales en contacto con alimentos. Escribe TODOS los valores de texto en español. Genera solo JSON válido, sin markdown, sin texto extra.';

  const prompt = `${t('Mercado','Market','Mercado')}: ${cfg.nombre}. ${t('Idioma de respuesta: Español.','Response language: English.','Idioma de resposta: Português do Brasil.')}

${t('PRODUCT','PRODUCT','PRODUTO')}: <product_name>${safeName}</product_name> | ${translateCategory(formData.categoria, cfg.idioma)}
${safeDesc ? t('PROVIDED DESCRIPTION: ','PROVIDED DESCRIPTION: ','DESCRIÇÃO FORNECIDA: ') + `<description>${safeDesc}</description>` : ''}
${t('MATERIALS','MATERIALS','MATERIAIS')}: ${matAll}
${t('DIRECT FOOD CONTACT','DIRECT FOOD CONTACT','CONTATO DIRETO COM ALIMENTOS')}: ${matDirecto}
${t('CHARACTERISTICS','CHARACTERISTICS','CARACTERÍSTICAS')}: ${formData.caracteristicas.join(', ') || t('none','none','nenhuma')}
${formData.edad ? t('MINIMUM AGE: ','MINIMUM AGE: ','FAIXA ETÁRIA: ') + formData.edad : ''}
${formData.capacidad ? t('CAPACITY: ','CAPACITY: ','CAPACIDADE: ') + formData.capacidad : ''}

${t('Generate ONLY valid JSON (no markdown):','Generate ONLY valid JSON (no markdown):','Gere APENAS JSON válido (sem markdown):')}
{"descripcion_general":"${t('1 concise paragraph about the product using only declared materials','1 concise paragraph about the product using only declared materials','1 parágrafo conciso sobre o produto usando apenas materiais declarados')}${safeDesc ? t(' — improve the provided description',' — improve the provided description',' — melhore a descrição fornecida') : ''}","uso_previsto":"${t('1 clear sentence about the intended use','1 clear sentence about the intended use','1 frase clara sobre o uso pretendido')}","usos_indebidos":["${t('misuse 1','misuse 1','mau uso 1')}","${t('misuse 2','misuse 2','mau uso 2')}","${t('misuse 3','misuse 3','mau uso 3')}"],"advertencias_adicionales":["${t('product-specific warning derived from materials/characteristics — NOT generic microwave/dishwasher/sharp-edge warnings','product-specific warning derived from materials/characteristics — NOT generic microwave/dishwasher/sharp-edge warnings','aviso específico do produto derivado de materiais/características — NÃO incluir avisos genéricos sobre micro-ondas/lava-louças/bordas cortantes')}"],"no_conformidades":[{"situacion":"${t('specific non-conformity situation for this product','specific non-conformity situation for this product','situação de não conformidade específica para este produto')}","criticidad":"${prioHi}","accion":"${t('specific corrective action','specific corrective action','ação corretiva específica')}","responsable":"${t('responsible department','responsible department','departamento responsável')}","plazo":"${t('30 days','30 days','30 dias')}"}],"acciones_recomendadas":[{"prioridad":"${prioHi}","accion":"${t('specific action','specific action','ação específica')}","responsable":"${t('responsible department','responsible department','departamento responsável')}","plazo":"${t('30 days','30 days','30 dias')}"}]}

${t('IMPORTANT for advertencias_adicionales: generate 1-3 warnings SPECIFIC to this product\'s materials, category and characteristics. Do NOT repeat warnings about: microwave, dishwasher, sharp edges. Focus on material-specific risks.','IMPORTANT for advertencias_adicionales: generate 1-3 warnings SPECIFIC to this product\'s materials, category and characteristics. Do NOT repeat warnings about: microwave, dishwasher, sharp edges. Focus on material-specific risks.','IMPORTANTE para advertencias_adicionales: gere 1-3 avisos ESPECÍFICOS para os materiais, categoria e características deste produto. NÃO repita avisos sobre: micro-ondas, lava-louças, bordas cortantes. Foque em riscos específicos do material.')}`;

  try {
    const text = await callClaude(prompt, { system: systemMsg, model: 'claude-sonnet-4-6', maxTokens: 1200 });
    let clean = text;
    if (clean.includes('```')) { const parts = clean.split('```'); clean = parts[1] || parts[0]; if (clean.startsWith('json')) clean = clean.slice(4); }
    return JSON.parse(clean.trim());
  } catch (err) {
    console.warn('[callClaudeForMarket] AI call failed, using fallback data:', err);
    return {
      descripcion_general: safeDesc || `${safeName} — ${formData.categoria}`,
      uso_previsto: cfg.idioma === 'en' ? 'Intended for food storage and serving.' : cfg.idioma === 'pt' ? 'Destinado ao armazenamento e serviço de alimentos.' : 'Destinado al almacenamiento y servicio de alimentos.',
      usos_indebidos: cfg.idioma === 'en' ? ['Do not use near open flames','Do not use in microwave','Do not use as toy'] : cfg.idioma === 'pt' ? ['Não usar perto de chamas abertas','Não usar em micro-ondas','Não usar como brinquedo'] : ['No usar cerca de llamas abiertas','No usar en microondas','No usar como juguete'],
      advertencias_adicionales: [],
      no_conformidades: [{ situacion: cfg.idioma === 'en' ? 'Migration test failure' : cfg.idioma === 'pt' ? 'Falha no ensaio de migração' : 'Fallo en ensayo de migración', criticidad: cfg.idioma === 'en' ? 'CRITICAL' : 'CRÍTICO', accion: cfg.idioma === 'en' ? 'Quarantine batch and commission retest at accredited laboratory' : cfg.idioma === 'pt' ? 'Quarentena do lote e re-ensaio em laboratório acreditado' : 'Cuarentenar lote y encargar re-ensayo en laboratorio acreditado', responsable: cfg.idioma === 'en' ? 'Quality' : 'Calidad', plazo: cfg.idioma === 'en' ? '30 days' : cfg.idioma === 'pt' ? '30 dias' : '30 días' }],
      acciones_recomendadas: [{ prioridad: L.prio_alto, accion: cfg.idioma === 'en' ? 'Conduct MOCA migration tests immediately' : cfg.idioma === 'pt' ? 'Realizar ensaios de migração MOCA imediatamente' : 'Realizar ensayos de migración MOCA de inmediato', responsable: cfg.idioma === 'en' ? 'Quality department' : cfg.idioma === 'pt' ? 'Departamento de qualidade' : 'Departamento de calidad', plazo: cfg.idioma === 'en' ? 'Within 30 days' : cfg.idioma === 'pt' ? 'Nos próximos 30 dias' : 'En los próximos 30 días' }],
    };
  }
}

// ── Risk Assessment ───────────────────────────────────────────────────────────
function getRisks(formData, L) {
  const en = L === LABELS.en;
  const pt = L === LABELS.pt;
  const c = formData.caracteristicas;
  const directo = formData.componentes.filter(x => x.contacto_alimento === 'Directo');
  const matsDirLower = directo.map(x => x.material.toLowerCase());
  const matLower = formData.componentes.map(x => x.material.toLowerCase());
  const plasticos = ['abs','pp','ps','pvc','pet','hdpe','ldpe','policarbonato','nylon'];
  const tienePlastico = c.includes('plastico') || matLower.some(m => plasticos.some(p => m.includes(p)));
  const esNinos = c.includes('ninos');
  const esJuguete = c.includes('juguete');
  const risks = [];

  // Helper: tri-lingual string
  const t = (eStr, esStr, ptStr) => en ? eStr : pt ? ptStr : esStr;
  const hi = L.nivel_alto, med = L.nivel_medio, lo = L.nivel_bajo;

  // ── 1. Migración química (MOCA) ──────────────────────────────────────────────
  if (directo.length > 0) {
    const mats = [...new Set(directo.map(x => x.material))].join(', ');
    risks.push({
      riesgo: t(
        `[EN 71-3 / Reg. (EU) 10/2011 / FDA 21 CFR] Migration of chemical substances from ${mats} to food — monomers, additives and residual substances`,
        `[EU Reg. 10/2011 / FDA 21 CFR / Codex] Migración de sustancias químicas desde ${mats} a los alimentos — monómeros, aditivos y sustancias residuales`,
        `[RDC 105/1999 ANVISA / EU Reg. 10/2011] Migração de substâncias químicas do ${mats} para os alimentos — monômeros, aditivos e substâncias residuais`),
      nivel_inicial: hi,
      medida_control: t(
        'Overall migration test (OML ≤ 10 mg/dm²) and specific migration (SML) in food simulants. Food-grade certified resins. Supplier declaration of conformity.',
        'Ensayo de migración global (LMT ≤ 10 mg/dm²) y migración específica en simulantes alimentarios. Resinas certificadas grado alimenticio. Declaración de conformidad del proveedor.',
        'Ensaio de migração global (LMT ≤ 10 mg/dm²) e migração específica em simulantes alimentares. Resinas certificadas para uso alimentar. Declaração de conformidade do fornecedor.'),
      nivel_residual: lo,
    });
  }

  // ── 2. Metales pesados en pigmentos ─────────────────────────────────────────
  if (c.includes('multicolor') || directo.length > 0) {
    risks.push({
      riesgo: t(
        '[EN 71-3:2019+A1:2021 Cat. III / ASTM F963-23 Sec. 4.3.5 / CPSIA] Migration of heavy metals in accessible parts — Sb, As, Ba, Cd, Cr, Pb, Hg, Se',
        '[EN 71-3:2019+A1:2021 Cat. III / ASTM F963-23 §4.3.5 / Codex] Migración de elementos pesados en partes accesibles — Sb, As, Ba, Cd, Cr, Pb, Hg, Se',
        '[EN 71-3:2019+A1:2021 / ABNT NBR NM 300-3 / INMETRO 563/2016] Migração de elementos pesados nas partes acessíveis — Sb, As, Ba, Cd, Cr, Pb, Hg, Se'),
      nivel_inicial: med,
      medida_control: t(
        'Element migration test in category III (dry, brittle, powder and flexible materials). Technical data sheets and declarations from pigment suppliers. Pb limit: 2 mg/kg (EN 71-3); 90 ppm in paint (16 CFR 1303).',
        'Ensayo de migración de elementos en categoría III (materiales secos, quebradizos, en polvo y flexibles). Fichas técnicas y declaraciones de proveedores de pigmentos. Límite Pb: 2 mg/kg (EN 71-3); 90 ppm en pintura (16 CFR 1303).',
        'Ensaio de migração de elementos categoria III. Fichas técnicas e declarações dos fornecedores de pigmentos. Limite Pb: 2 mg/kg (EN 71-3) / 90 ppm em tinta (CPSIA).'),
      nivel_residual: lo,
    });
  }

  // ── 3. Sustancias orgánicas / ftalatos ──────────────────────────────────────
  if (tienePlastico && (esJuguete || esNinos)) {
    risks.push({
      riesgo: t(
        '[EN 71-9:2021 / EN 71-11:2022 / 16 CFR Part 1307 (CPSIA)] Presence of restricted organic substances and phthalates in plastic materials — DEHP, DBP, BBP, DINP, DIDP (max 0.1% each)',
        '[EN 71-9:2021 / EN 71-11:2022 / 16 CFR Part 1307 (CPSIA)] Presencia de sustancias orgánicas restringidas y ftalatos en materiales plásticos — DEHP, DBP, BBP, DINP, DIDP (máx. 0.1% c/u)',
        '[EN 71-9 / EN 71-11 / ANVISA RDC 56/2012] Presença de substâncias orgânicas restritas e ftalatos em materiais plásticos — DEHP, DBP, BBP, DINP (máx. 0,1% cada)'),
      nivel_inicial: med,
      medida_control: t(
        'GC-MS analysis for phthalates and restricted organic compounds. Use of phthalate-free formulations. Supplier declaration and material certificate.',
        'Análisis GC-MS de ftalatos y compuestos orgánicos restringidos. Uso de formulaciones libres de ftalatos. Declaración del proveedor y certificado del material.',
        'Análise GC-MS de ftalatos e compostos orgânicos restritos. Formulações livres de ftalatos. Declaração do fornecedor e certificado do material.'),
      nivel_residual: lo,
    });
  }

  // ── 4. Puntas y bordes filosos ───────────────────────────────────────────────
  if (c.includes('bordes_filosos') || c.includes('disenio_3d')) {
    risks.push({
      riesgo: t(
        '[EN 71-1:2014+A1:2018 Cl. 4.7 & 4.8 / ASTM F963-23 Sec. 4.7 & 4.8 / ISO 8124-1 Cl. 5.8] Laceration or puncture hazard from accessible sharp points and edges — claws, teeth, fins or 3D design elements',
        '[EN 71-1 Cl. 4.7 & 4.8 / ASTM F963-23 §4.7 & §4.8 / ISO 8124-1 Cl. 5.8] Peligro de laceración o punción por puntas y bordes filosos accesibles — garras, dientes, aletas u otros elementos del diseño 3D',
        '[EN 71-1 Cl. 4.7 & 4.8 / ABNT NBR NM 300-1 / INMETRO 563/2016] Perigo de laceração ou perfuração por pontas e bordas cortantes acessíveis — garras, dentes, aletas ou elementos do design 3D'),
      nivel_inicial: esNinos ? hi : med,
      medida_control: t(
        'Sharp points test (sharp point tester — BS 5665) and sharp edges test (sharp edge tester). Rounding of critical edges R > 0.5 mm. Mandatory warning on label for products intended for children.',
        'Ensayo de puntas filosas (probador de puntas agudas) y ensayo de bordes filosos (probador de bordes). Redondeado de aristas críticas R > 0.5 mm. Advertencia obligatoria en etiqueta para productos dirigidos a niños.',
        'Ensaio de pontas cortantes (testador de pontas) e ensaio de bordas cortantes. Arredondamento de arestas críticas R > 0,5 mm. Advertência obrigatória no rótulo.'),
      nivel_residual: lo,
    });
  }

  // ── 5. Partes pequeñas (asfixia / ingestión) ────────────────────────────────
  if (c.includes('partes_pequenas') || esJuguete || esNinos) {
    risks.push({
      riesgo: t(
        '[EN 71-1:2014+A1:2018 Cl. 4.6 / ASTM F963-23 Sec. 4.6 / 16 CFR Part 1501] Choking and aspiration hazard from small parts for children under 3 years — parts that fit entirely in small parts cylinder (Ø 31.7 mm × 57.1 mm)',
        '[EN 71-1 Cl. 4.6 / ASTM F963-23 §4.6 / 16 CFR Part 1501] Peligro de asfixia e ingestión por partes pequeñas en niños menores de 3 años — partes que caben íntegramente en el cilindro de partes pequeñas (Ø 31.7 mm × 57.1 mm)',
        '[EN 71-1 Cl. 4.6 / ABNT NBR NM 300-1 / INMETRO 563/2016] Perigo de asfixia e ingestão de partes pequenas por crianças menores de 3 anos — partes que cabem no cilindro de partes pequenas (Ø 31,7 mm × 57,1 mm)'),
      nivel_inicial: esNinos ? hi : med,
      medida_control: t(
        'Small parts cylinder test (ASTM F963 / EN 71-1). Warning on label: "WARNING: CHOKING HAZARD — Small parts. Not for children under 3 years." Age restriction on packaging.',
        'Ensayo de cilindro de partes pequeñas (ASTM F963 / EN 71-1). Advertencia en etiqueta: "ADVERTENCIA: PELIGRO DE ASFIXIA — Partes pequeñas. No apto para menores de 3 años." Restricción de edad en empaque.',
        'Ensaio do cilindro de partes pequenas. Advertência no rótulo: "ATENÇÃO: RISCO DE ASFIXIA — Partes pequenas. Não indicado para crianças menores de 3 anos."'),
      nivel_residual: lo,
    });
  }

  // ── 6. Piezas móviles / atrapamiento ────────────────────────────────────────
  if (c.includes('piezas_moviles')) {
    risks.push({
      riesgo: t(
        '[EN 71-1:2014+A1:2018 Cl. 4.9 & 4.10 / ASTM F963-23 Sec. 4.9] Entrapment or crushing hazard from moving, folding or articulated mechanisms — fingers, hair or clothing entrapment in joints or movable parts',
        '[EN 71-1 Cl. 4.9 & 4.10 / ASTM F963-23 §4.9] Peligro de atrapamiento o aplastamiento por mecanismos móviles, plegables o articulados — atrapamiento de dedos, cabello o ropa en juntas o partes móviles',
        '[EN 71-1 Cl. 4.9 & 4.10 / ABNT NBR NM 300-1] Perigo de aprisionamento ou esmagamento por mecanismos móveis, dobráveis ou articulados — aprisionamento de dedos, cabelo ou roupa'),
      nivel_inicial: esNinos ? hi : med,
      medida_control: t(
        'Entrapment opening tests (finger, hair and clothing). Minimum gap between moving parts: < 4 mm or > 12 mm to prevent finger entrapment. Mechanism torque tests.',
        'Ensayos de aberturas de atrapamiento (dedos, cabello, ropa). Separación mínima entre partes móviles: < 4 mm o > 12 mm para evitar atrapamiento de dedos. Ensayos de par de torsión de mecanismos.',
        'Ensaios de aberturas de aprisionamento (dedos, cabelo, roupa). Separação mínima entre partes móveis: < 4 mm ou > 12 mm. Ensaios de torque dos mecanismos.'),
      nivel_residual: lo,
    });
  }

  // ── 7. Imanes ────────────────────────────────────────────────────────────────
  if (c.includes('imanes')) {
    risks.push({
      riesgo: t(
        '[EN 71-1:2014+A1:2018 Cl. 4.23 / ASTM F963-23 Sec. 4.40 / CPSC Guidance 2022] Serious internal injury hazard from ingestion of high-powered magnets — multiple magnets can attract through intestinal wall, causing necrosis, perforation or death',
        '[EN 71-1 Cl. 4.23 / ASTM F963-23 §4.40 / CPSC 2022] Peligro de lesión interna grave por ingestión de imanes de alta potencia — múltiples imanes pueden atraerse a través de la pared intestinal causando necrosis, perforación o la muerte',
        '[EN 71-1 Cl. 4.23 / ASTM F963-23 §4.40] Perigo de lesão interna grave por ingestão de imãs de alta potência — múltiplos imãs podem se atrair através da parede intestinal causando necrose ou perfuração'),
      nivel_inicial: hi,
      medida_control: t(
        'Magnetic flux index (MFI) test: MFI must be ≤ 50 kG²·mm² (EN 71-1) for accessible magnets. Secure encapsulation of magnets so they cannot be accessed. Warning on label. Age restriction ≥ 3 years.',
        'Ensayo de índice de flujo magnético (IFM): IFM debe ser ≤ 50 kG²·mm² (EN 71-1) para imanes accesibles. Encapsulado seguro de imanes para que no sean accesibles. Advertencia en etiqueta. Restricción de edad ≥ 3 años.',
        'Ensaio de índice de fluxo magnético (IFM): IFM ≤ 50 kG²·mm² (EN 71-1) para ímãs acessíveis. Encapsulamento seguro dos ímãs. Advertência no rótulo. Restrição de idade ≥ 3 anos.'),
      nivel_residual: med,
    });
  }

  // ── 8. Cuerdas y cordones ────────────────────────────────────────────────────
  if (c.includes('cuerdas')) {
    risks.push({
      riesgo: t(
        '[EN 71-1:2014+A1:2018 Cl. 4.16 & 4.17 / ASTM F963-23 Sec. 4.17] Strangulation hazard from cords, strings or elastic bands — cords > 220 mm accessible to children under 36 months create strangulation risk',
        '[EN 71-1 Cl. 4.16 & 4.17 / ASTM F963-23 §4.17] Peligro de estrangulamiento por cuerdas, cordones o elásticos — cuerdas de longitud > 220 mm accesibles a niños menores de 36 meses representan riesgo de estrangulamiento',
        '[EN 71-1 Cl. 4.16 & 4.17 / ABNT NBR NM 300-1] Perigo de estrangulamento por cordas, cordões ou elásticos — cordas com comprimento > 220 mm acessíveis a crianças menores de 36 meses'),
      nivel_inicial: esNinos ? hi : med,
      medida_control: t(
        'Cord and string length test. Maximum free cord length: 220 mm for products intended for children under 36 months. Tensile strength test of knots and cord attachment points.',
        'Ensayo de longitud de cuerdas y cordones. Longitud libre máxima de cuerda: 220 mm para productos dirigidos a menores de 36 meses. Ensayo de resistencia a la tracción de nudos y puntos de anclaje.',
        'Ensaio de comprimento de cordas e cordões. Comprimento livre máximo: 220 mm para produtos destinados a menores de 36 meses. Ensaio de resistência à tração dos nós e pontos de fixação.'),
      nivel_residual: lo,
    });
  }

  // ── 9. Proyectiles ───────────────────────────────────────────────────────────
  if (c.includes('proyectiles')) {
    risks.push({
      riesgo: t(
        '[EN 71-1:2014+A1:2018 Cl. 4.12 / ASTM F963-23 Sec. 4.12] Eye and face injury hazard from projectile toys — kinetic energy of projectile ≥ 0.08 J or impact surface < 0.5 cm² constitutes a hazard',
        '[EN 71-1 Cl. 4.12 / ASTM F963-23 §4.12] Peligro de lesión ocular y facial por juguetes lanzaproyectiles — energía cinética del proyectil ≥ 0.08 J o superficie de impacto < 0.5 cm² constituye un peligro',
        '[EN 71-1 Cl. 4.12 / ABNT NBR NM 300-1] Perigo de lesão ocular e facial por brinquedos lança-projéteis — energia cinética do projétil ≥ 0,08 J ou superfície de impacto < 0,5 cm²'),
      nivel_inicial: hi,
      medida_control: t(
        'Projectile kinetic energy test. Maximum kinetic energy: 0.08 J. Protective tip or soft projectile design. Mandatory eye protection warning on label.',
        'Ensayo de energía cinética del proyectil. Energía cinética máxima: 0.08 J. Diseño con punta protectora o proyectil blando. Advertencia obligatoria de protección ocular en etiqueta.',
        'Ensaio de energia cinética do projétil. Energia cinética máxima: 0,08 J. Design com ponta protetora ou projétil macio. Advertência obrigatória de proteção ocular no rótulo.'),
      nivel_residual: lo,
    });
  }

  // ── 10. Líquidos ─────────────────────────────────────────────────────────────
  if (c.includes('liquidos')) {
    risks.push({
      riesgo: t(
        '[EN 71-1:2014+A1:2018 Cl. 4.19 / ASTM F963-23 Sec. 4.37] Ingestion or contact hazard from liquids or gels inside product — leakage risk from sealed liquid compartments, chemical burn or toxicity from contact',
        '[EN 71-1 Cl. 4.19 / ASTM F963-23 §4.37] Peligro de ingestión o contacto con líquidos o geles contenidos en el producto — riesgo de derrame en compartimentos sellados, quemadura química o toxicidad por contacto',
        '[EN 71-1 Cl. 4.19 / ABNT NBR NM 300-1] Perigo de ingestão ou contato com líquidos ou géis dentro do produto — risco de vazamento, queimadura química ou toxicidade por contato'),
      nivel_inicial: esNinos ? hi : med,
      medida_control: t(
        'Leak resistance test of sealed compartments (pressure and drop test). Toxicological assessment of liquid contents. Warning on label.',
        'Ensayo de resistencia a fugas en compartimentos sellados (prueba de presión y caída). Evaluación toxicológica del contenido líquido. Advertencia en etiqueta.',
        'Ensaio de resistência a vazamentos em compartimentos selados (teste de pressão e queda). Avaliação toxicológica do conteúdo líquido. Advertência no rótulo.'),
      nivel_residual: lo,
    });
  }

  // ── 11. Inflamabilidad ───────────────────────────────────────────────────────
  if (tienePlastico) {
    risks.push({
      riesgo: t(
        '[EN 71-2:2020 / ASTM F963-23 Sec. 4.2 / ISO 8124-2] Flammability of materials — spread of flame rate and ignition time of plastic surfaces, fabric or hair/beard elements',
        '[EN 71-2:2020 / ASTM F963-23 §4.2 / ISO 8124-2] Inflamabilidad de materiales — tasa de propagación de llama y tiempo de ignición de superficies plásticas, textiles o elementos de cabello/barba del diseño',
        '[EN 71-2:2020 / ABNT NBR 11136 / ISO 8124-2] Inflamabilidade dos materiais — taxa de propagação de chama e tempo de ignição de superfícies plásticas, têxteis ou elementos de cabelo/barba do design'),
      nivel_inicial: esNinos ? med : lo,
      medida_control: t(
        'Flammability test per EN 71-2 / ASTM F963 Sec. 4.2. Maximum surface spread rate: 30 mm/s. UL 94 V-0 or equivalent classification for plastic substrate. Warning against exposure to naked flames.',
        'Ensayo de inflamabilidad según EN 71-2 / ASTM F963 §4.2. Tasa máxima de propagación superficial: 30 mm/s. Clasificación UL 94 V-0 o equivalente para el sustrato plástico. Advertencia de no exponer a llamas desnudas.',
        'Ensaio de inflamabilidade conforme EN 71-2 / ISO 8124-2. Taxa máxima de propagação superficial: 30 mm/s. Classificação UL 94 V-0 ou equivalente para o substrato plástico.'),
      nivel_residual: lo,
    });
  }

  // ── 12. Pilas / batería ──────────────────────────────────────────────────────
  if (c.includes('bateria') || c.includes('led') || c.includes('electronico')) {
    risks.push({
      riesgo: t(
        '[EN 71-1:2014+A1:2018 Cl. 4.24 / ASTM F963-23 Sec. 4.25 / IEC 62368-1] Electrical safety risk — overheating, short circuit, battery leakage, electric shock or thermal runaway from batteries or electronic components',
        '[EN 71-1 Cl. 4.24 / ASTM F963-23 §4.25 / IEC 62368-1] Riesgo de seguridad eléctrica — sobrecalentamiento, cortocircuito, fuga de batería, electrocución o fuga térmica derivada de baterías o componentes electrónicos',
        '[EN 71-1 Cl. 4.24 / ABNT NBR IEC 62368-1 / INMETRO] Risco de segurança elétrica — superaquecimento, curto-circuito, vazamento de bateria, eletrocussão ou fuga térmica de baterias ou componentes eletrônicos'),
      nivel_inicial: med,
      medida_control: t(
        'Electrical safety tests per IEC 62368-1 / UL 62368-1. Overcurrent and overcharge protection. Secure battery compartment with tool-only access for children\'s products. Warnings for battery replacement.',
        'Ensayos de seguridad eléctrica según IEC 62368-1 / UL 62368-1. Protección contra sobrecorriente y sobrecarga. Compartimento de batería de acceso solo con herramienta para productos infantiles. Advertencias para el cambio de batería.',
        'Ensaios de segurança elétrica conforme ABNT NBR IEC 62368-1. Proteção contra sobrecorrente e sobrecarga. Compartimento de bateria de acesso somente com ferramenta. Advertências para substituição de bateria.'),
      nivel_residual: lo,
    });
  }

  // ── 13. Pila botón ───────────────────────────────────────────────────────────
  if (c.includes('bateria_boton')) {
    risks.push({
      riesgo: t(
        '[EN 71-1:2014+A1:2018 Cl. 4.24.1 / CPSC Recess Act 2022 / EU Regulation 2023/1542] CRITICAL — Ingestion of button/coin cell batteries causes severe chemical burns to esophagus within 2 hours due to electrolysis (caustic burn). Life-threatening risk.',
        '[EN 71-1 Cl. 4.24.1 / CPSC Recess Act 2022 / UE Reg. 2023/1542] CRÍTICO — La ingestión de pilas botón/moneda provoca quemaduras químicas severas en esófago en menos de 2 horas por electrólisis (quemadura cáustica). Riesgo para la vida.',
        '[EN 71-1 Cl. 4.24.1 / CPSC Recess Act 2022 / UE Reg. 2023/1542] CRÍTICO — A ingestão de pilhas botão/moeda causa queimaduras químicas graves no esôfago em menos de 2 horas por eletrólise. Risco de vida.'),
      nivel_inicial: hi,
      medida_control: t(
        'Mandatory child-resistant battery compartment (screwdriver or coin required to open). Warning label with international button battery safety symbol. Compliance with CPSC Recess Act 2022 (USA) and EU Reg. 2023/1542 (EU). Test compartment opening force.',
        'Compartimento de batería obligatoriamente resistente a niños (requiere destornillador o moneda para abrirse). Etiqueta de advertencia con símbolo internacional de seguridad de pilas botón. Cumplimiento con CPSC Recess Act 2022 (USA) y UE Reg. 2023/1542 (UE). Ensayo de fuerza de apertura del compartimento.',
        'Compartimento de bateria obrigatoriamente resistente a crianças (requer chave de fenda para abrir). Rótulo de advertência com símbolo de segurança de pilha botão. Conformidade com Reg. UE 2023/1542. Ensaio de força de abertura do compartimento.'),
      nivel_residual: med,
    });
  }

  // ── 14. Ruido ────────────────────────────────────────────────────────────────
  if (c.includes('ruido')) {
    risks.push({
      riesgo: t(
        '[EN 71-1:2014+A1:2018 Cl. 4.11 / ASTM F963-23 Sec. 4.5 / ISO 8124-1 Cl. 5.14] Hearing damage from noise-generating toys — impulsive sound level ≥ 138 dB(C) at 50 cm (hand-held) or continuous ≥ 85 dB(A) causes permanent hearing loss in children',
        '[EN 71-1 Cl. 4.11 / ASTM F963-23 §4.5 / ISO 8124-1 Cl. 5.14] Daño auditivo por juguetes generadores de ruido — nivel de sonido impulsivo ≥ 138 dB(C) a 50 cm (sostenido en mano) o continuo ≥ 85 dB(A) causa daño auditivo permanente en niños',
        '[EN 71-1 Cl. 4.11 / ISO 8124-1 Cl. 5.14] Dano auditivo por brinquedos geradores de ruído — nível de som impulsivo ≥ 138 dB(C) a 50 cm ou contínuo ≥ 85 dB(A) causa dano auditivo permanente em crianças'),
      nivel_inicial: esNinos ? hi : med,
      medida_control: t(
        'Sound level test per EN 71-1 Cl. 4.11 / ASTM F963 Sec. 4.5. Maximum limit: 85 dB(A) continuous / 138 dB(C) impulsive at 50 cm for ear-held toys; 96 dB(A) / 140 dB(C) at 25 cm for other toys. Volume limiter if limits are exceeded.',
        'Ensayo de nivel de sonido según EN 71-1 Cl. 4.11 / ASTM F963 §4.5. Límite máximo: 85 dB(A) continuo / 138 dB(C) impulsivo a 50 cm para juguetes sostenidos en oído; 96 dB(A) / 140 dB(C) a 25 cm para otros. Limitador de volumen si se superan los límites.',
        'Ensaio de nível de ruído conforme EN 71-1 Cl. 4.11 / ISO 8124-1. Limite máximo: 85 dB(A) contínuo / 138 dB(C) impulsivo a 50 cm. Limitador de volume se os limites forem excedidos.'),
      nivel_residual: lo,
    });
  }

  // ── 15. Clasificación dual (MOCA + juguete) ──────────────────────────────────
  if (esJuguete && directo.length > 0) {
    risks.push({
      riesgo: t(
        '[Directive 2009/48/EC + Reg. (EC) 1935/2004 / CPSIA + FDA 21 CFR] Dual regulatory classification — product simultaneously subject to toy safety standards AND food contact material (FCM) regulations, generating cumulative compliance obligations',
        '[Directiva 2009/48/CE + Reg. (CE) 1935/2004 / CPSIA + FDA 21 CFR] Clasificación regulatoria dual — producto simultáneamente sujeto a normativa de seguridad de juguetes Y normativa de materiales en contacto con alimentos (MOCA), generando obligaciones de cumplimiento acumuladas',
        '[Diretiva 2009/48/CE + Reg. (CE) 1935/2004 / CPSIA + RDC ANVISA] Classificação regulatória dual — produto simultaneamente sujeito à normativa de segurança de brinquedos E à normativa de materiais em contato com alimentos (MOCA)'),
      nivel_inicial: hi,
      medida_control: t(
        'Simultaneous compliance with all toy safety clauses (EN 71-1/2/3 or ASTM F963) and FCM regulations (Reg. (EU) 10/2011 or FDA 21 CFR). Full technical file for both categories. Unambiguous declaration of intended use on label.',
        'Cumplimiento simultáneo de todas las cláusulas de seguridad de juguetes (EN 71-1/2/3 o ASTM F963) y normativa MOCA (Reg. (UE) 10/2011 o FDA 21 CFR). Expediente técnico completo para ambas categorías. Declaración inequívoca del uso previsto en etiqueta.',
        'Conformidade simultânea com todas as cláusulas de segurança de brinquedos (EN 71-1/2/3 ou ABNT NBR NM 300) e normativa MOCA (RDC ANVISA / EU Reg. 10/2011). Dossiê técnico completo para ambas as categorias.'),
      nivel_residual: med,
    });
  }

  if (risks.length === 0) {
    risks.push({
      riesgo: t(
        'General product safety — absence of specific hazards identified based on declared characteristics',
        'Seguridad general del producto — ausencia de peligros específicos identificados en base a las características declaradas',
        'Segurança geral do produto — ausência de perigos específicos identificados com base nas características declaradas'),
      nivel_inicial: lo,
      medida_control: t(
        'General conformity assessment. Periodic review of applicable regulations. Supplier declarations of conformity.',
        'Evaluación general de conformidad. Revisión periódica de la normativa aplicable. Declaraciones de conformidad de proveedores.',
        'Avaliação geral de conformidade. Revisão periódica da regulamentação aplicável. Declarações de conformidade dos fornecedores.'),
      nivel_residual: lo,
    });
  }

  return risks;
}

// ── MOCA Tests ────────────────────────────────────────────────────────────────
function getEnsayosMoca(formData, cfg) {
  const mats = [...new Set(formData.componentes
    .filter(c => c.contacto_alimento === 'Directo')
    .map(c => c.material.toLowerCase()))];
  const ensayos = [];
  const seen = new Set();
  for (const mat of mats) {
    const key = Object.keys(cfg.ensayos_moca || {}).find(k => mat.includes(k));
    if (key && cfg.ensayos_moca[key]) {
      for (const e of cfg.ensayos_moca[key]) {
        const sig = e.ensayo.substring(0, 30);
        if (!seen.has(sig)) { seen.add(sig); ensayos.push(e); }
      }
    }
  }
  return ensayos;
}

// ── Safety Tests ─────────────────────────────────────────────────────────────
function getEnsayosSeg(formData, cfg, L) {
  const chars = formData.caracteristicas;
  const esJuguete = chars.includes('juguete') || chars.includes('ninos');
  const tiereBordes = chars.includes('bordes_filosos') || chars.includes('disenio_3d');
  const ns = cfg.normas_seg;
  if (!esJuguete && !tiereBordes) return [];
  const ensayos = [];
  if (esJuguete) {
    const lng = cfg.idioma;
    ensayos.push({ ensayo: lng === 'en' ? 'Physical and mechanical properties (impact, tension, torsion)' : lng === 'pt' ? 'Propriedades físicas e mecânicas (impacto, tração, torção)' : 'Propiedades físicas y mecánicas (impacto, tracción, torsión)', norma: ns.mecanico });
    ensayos.push({ ensayo: lng === 'en' ? 'Flammability of materials' : lng === 'pt' ? 'Inflamabilidade dos materiais' : 'Inflamabilidad del material', norma: ns.inflamabilidad });
    ensayos.push({ ensayo: lng === 'en' ? 'Migration of elements in painted / coloured parts' : lng === 'pt' ? 'Migração de elementos em partes pintadas / coloridas' : 'Migración de elementos en partes pintadas / coloreadas', norma: ns.elementos });
  }
  if (tiereBordes) {
    const lng = cfg.idioma;
    ensayos.push({ ensayo: lng === 'en' ? 'Test for sharp points and edges' : lng === 'pt' ? 'Ensaio de pontas e bordas cortantes' : 'Ensayo de puntas y bordes filosos o afilados', norma: ns.bordes });
  }
  return ensayos;
}

// ── MOCA Regulatory List ──────────────────────────────────────────────────────
function getMocaReg(formData, cfg) {
  const items = [...cfg.moca_base];
  const seen = new Set(items);
  for (const c of formData.componentes) {
    if (c.contacto_alimento === 'Directo') {
      const key = Object.keys(cfg.moca_por_material).find(k => c.material.toLowerCase().includes(k));
      if (key && !seen.has(cfg.moca_por_material[key])) {
        seen.add(cfg.moca_por_material[key]);
        items.push(cfg.moca_por_material[key]);
      }
    }
  }
  return items;
}

// ── Contextual Warnings ───────────────────────────────────────────────────────
function getContextualWarnings(formData, cfg, L, aiData) {
  const w = L.warning_label;
  const chars = formData.caracteristicas || [];
  const mats = (formData.componentes || []).map(c => (c.material || '').toLowerCase());
  const cat = (formData.categoria || '').toLowerCase();
  const has = id => chars.includes(id);
  const hasMat = (...keywords) => mats.some(m => keywords.some(k => m.includes(k)));

  const warnings = [];
  const add = (en, es, pt) => warnings.push(
    cfg.idioma === 'en' ? `${w}: ${en}` : cfg.idioma === 'pt' ? `${w}: ${pt}` : `${w}: ${es}`
  );

  // ── Peligros más críticos primero ──
  if (has('bateria_boton')) add(
    'Contains button/coin cell battery. Keep away from children. If swallowed, seek immediate medical attention.',
    'Contiene pila botón. Mantener fuera del alcance de niños. En caso de ingestión, acudir de inmediato a urgencias médicas.',
    'Contém pilha tipo moeda. Manter fora do alcance das crianças. Em caso de ingestão, buscar atendimento médico imediatamente.'
  );

  if (has('imanes')) add(
    'Contains strong magnets. If two or more magnets are swallowed, seek immediate medical attention — risk of serious internal injury.',
    'Contiene imanes de alta potencia. Si se ingieren dos o más piezas, acudir de inmediato a urgencias — riesgo de lesión interna grave.',
    'Contém imãs de alta potência. Se duas ou mais peças forem ingeridas, buscar atendimento médico imediato — risco de lesão interna grave.'
  );

  if (has('proyectiles')) add(
    'Projectile product. Never aim at face, eyes or people. Use only recommended projectiles.',
    'Producto con proyectiles. No apuntar hacia el rostro, ojos ni personas. Usar únicamente los proyectiles recomendados.',
    'Produto com projéteis. Não apontar para o rosto, olhos ou pessoas. Usar somente os projéteis recomendados.'
  );

  // ── Niños / juguete ──
  if (has('ninos') || has('juguete')) {
    const edad = formData.edad;
    if (has('partes_pequenas')) add(
      `CHOKING HAZARD — Small parts.${edad ? ` Not suitable for children under ${edad}.` : ' Not suitable for children under 3 years.'}`,
      `PELIGRO DE ASFIXIA — Contiene piezas pequeñas.${edad ? ` No apto para menores de ${edad}.` : ' No apto para menores de 3 años.'}`,
      `PERIGO DE ASFIXIA — Contém peças pequenas.${edad ? ` Não adequado para menores de ${edad}.` : ' Não adequado para menores de 3 anos.'}`
    );
    else add(
      `Adult supervision recommended.${edad ? ` Not suitable for children under ${edad}.` : ''}`,
      `Se recomienda supervisión de un adulto.${edad ? ` No apto para menores de ${edad}.` : ''}`,
      `Supervisão de adulto recomendada.${edad ? ` Não adequado para menores de ${edad}.` : ''}`
    );
  }

  // ── Peligros mecánicos ──
  if (has('bordes_filosos')) add(
    'Product contains sharp points or cutting edges. Handle with care to avoid cuts or injuries.',
    'El producto presenta puntos o bordes filosos. Manipular con cuidado para evitar cortes o lesiones.',
    'O produto contém pontas ou bordas cortantes. Manusear com cuidado para evitar cortes ou ferimentos.'
  );

  if (has('cuerdas')) add(
    'Product contains cords, strings or elastic bands. Risk of strangulation — keep away from children under 3 years.',
    'El producto contiene cuerdas, cordones o elásticos. Riesgo de estrangulamiento — mantener fuera del alcance de niños menores de 3 años.',
    'O produto contém cordas, cordões ou elásticos. Risco de estrangulamento — manter fora do alcance de crianças menores de 3 anos.'
  );

  if (has('piezas_moviles')) add(
    'Product has moving or articulated parts. Keep fingers and hair away from moving mechanisms.',
    'El producto tiene piezas móviles o articuladas. Mantener dedos y cabello alejados de los mecanismos en movimiento.',
    'O produto possui peças móveis ou articuladas. Manter dedos e cabelos afastados dos mecanismos em movimento.'
  );

  if (has('liquidos')) add(
    'Contains liquid or gel. In case of contact with eyes or skin, rinse thoroughly with water. Keep away from children.',
    'Contiene líquido o gel. En caso de contacto con ojos o piel, enjuagar abundantemente con agua. Mantener fuera del alcance de niños.',
    'Contém líquido ou gel. Em caso de contato com olhos ou pele, enxaguar com água. Manter fora do alcance de crianças.'
  );

  // ── Peligros eléctricos / térmicos ──
  if (has('vapor')) add(
    'Hot surface during operation. Do not touch steam outlet. Keep away from children.',
    'Superficie caliente durante el uso. No tocar la salida de vapor. Mantener fuera del alcance de niños.',
    'Superfície quente durante o uso. Não tocar a saída de vapor. Manter fora do alcance de crianças.'
  );

  if (has('electronico') || has('bateria')) add(
    'Do not expose to water, moisture or extreme temperatures. Remove batteries before cleaning.',
    'No exponer a agua, humedad ni temperaturas extremas. Retirar las baterías antes de limpiar.',
    'Não expor a água, umidade ou temperaturas extremas. Remover as pilhas antes de limpar.'
  );

  if (has('bateria') && !has('bateria_boton')) add(
    'Dispose of batteries according to local environmental regulations. Do not dispose of with household waste.',
    'Desechar las baterías conforme a la normativa ambiental local. No desechar con residuos domésticos.',
    'Descartar as pilhas conforme a regulamentação ambiental local. Não descartar com resíduos domésticos.'
  );

  if (has('led')) add(
    'Do not stare directly into LEDs when lit. May cause eye discomfort.',
    'No mirar directamente a los LEDs encendidos. Puede causar molestias oculares.',
    'Não olhar diretamente para os LEDs acesos. Pode causar desconforto ocular.'
  );

  // ── Advertencias basadas en materiales ──
  if (hasMat('melamina', 'melamine')) add(
    'Do not use in microwave oven. Not suitable for microwave heating.',
    'No usar en microondas. El producto no es apto para calentar en microondas.',
    'Não usar em micro-ondas. O produto não é adequado para aquecimento em micro-ondas.'
  );

  if (hasMat('vidrio', 'glass')) add(
    'Contains glass components. Handle with care to avoid breakage. Keep away from children.',
    'Contiene componentes de vidrio. Manipular con cuidado para evitar roturas. Mantener fuera del alcance de niños.',
    'Contém componentes de vidro. Manusear com cuidado para evitar quebras. Manter fora do alcance de crianças.'
  );

  if (hasMat('ceramic', 'cerámica', 'ceramica', 'porcelana', 'porcelain')) add(
    'Ceramic/porcelain product. Do not use in microwave if product has metallic decoration. Handle with care to avoid chipping.',
    'Producto cerámico/porcelana. No usar en microondas si el producto tiene decoración metálica. Manipular con cuidado para evitar astillado.',
    'Produto cerâmico/porcelana. Não usar em micro-ondas se o produto tiver decoração metálica. Manusear com cuidado para evitar lascamento.'
  );

  if (hasMat('madera', 'wood', 'bambú', 'bambu', 'bamboo')) add(
    'Wood/bamboo product. Do not soak in water or put in dishwasher. Wipe with a damp cloth.',
    'Producto de madera/bambú. No remojar en agua ni lavar en lavavajillas. Limpiar con paño húmedo.',
    'Produto de madeira/bambu. Não mergulhar em água nem lavar na máquina de lavar louça. Limpar com pano úmido.'
  );

  if (hasMat('metal', 'acero', 'aluminio', 'hierro', 'steel', 'iron', 'aluminum', 'aluminium')) add(
    'Metal components. Avoid prolonged exposure to moisture to prevent oxidation.',
    'Componentes metálicos. Evitar la exposición prolongada a la humedad para prevenir la oxidación.',
    'Componentes metálicos. Evitar exposição prolongada à umidade para prevenir oxidação.'
  );

  const hasPlastic = hasMat('plástico', 'plastico', 'pp', 'pe ', 'pet', 'polietileno', 'polipropileno', 'poliestireno', 'nylon', 'abs', 'plastic');
  const hasSilicone = hasMat('silicona', 'silicone');
  if (hasPlastic && !hasSilicone) add(
    'Plastic parts. Hand wash only. Not dishwasher safe — high temperatures may deform the product.',
    'Partes plásticas. Lavar a mano. No apto para lavavajillas — las altas temperaturas pueden deformar el producto.',
    'Partes plásticas. Lavar à mão. Não lavar na máquina de lavar louça — temperaturas elevadas podem deformar o produto.'
  );

  if (hasSilicone) add(
    'Silicone components. Dishwasher safe on top rack. BPA-free.',
    'Componentes de silicona. Apto para lavavajillas (bandeja superior). Libre de BPA.',
    'Componentes de silicone. Adequado para máquina de lavar louça (prateleira superior). Livre de BPA.'
  );

  if (has('multicolor')) add(
    'Painted surfaces. Paint compliant with applicable heavy metals and phthalates regulations.',
    'Superficies pintadas. Pintura conforme a la regulación aplicable de metales pesados y ftalatos.',
    'Superfícies pintadas. Tinta em conformidade com a regulamentação aplicável de metais pesados e ftalatos.'
  );

  // ── Peligros acústicos ──
  if (has('ruido')) add(
    'May produce sounds above 80 dB. Keep at a safe distance from ears. Not recommended for children under 3 years.',
    'Puede producir sonidos superiores a 80 dB. Mantener a distancia segura de los oídos. No recomendado para menores de 3 años.',
    'Pode produzir sons acima de 80 dB. Manter a distância segura dos ouvidos. Não recomendado para crianças menores de 3 anos.'
  );

  // ── Advertencias adicionales de IA ──
  (aiData.advertencias_adicionales || []).forEach(a => warnings.push(`${w}: ${a}`));

  return warnings;
}

// ── Contextual Non-conformities ───────────────────────────────────────────────
function getContextualNonConformities(formData, cfg, L) {
  const chars = formData.caracteristicas || [];
  const mats = (formData.componentes || []).map(c => (c.material || '').toLowerCase());
  const hasFC = formData.componentes.some(c => c.contacto_alimento === 'Directo');
  const has = id => chars.includes(id);
  const hasMat = (...kw) => mats.some(m => kw.some(k => m.includes(k)));
  const en = cfg.idioma === 'en', pt = cfg.idioma === 'pt';
  const CRIT = en ? 'CRITICAL' : 'CRÍTICO';
  const HIGH = en ? 'HIGH' : pt ? 'ALTO' : 'ALTO';
  const MED  = en ? 'MEDIUM' : pt ? 'MÉDIO' : 'MEDIO';
  const nc = [];

  const add = (sit_en, sit_es, sit_pt, crit, acc_en, acc_es, acc_pt, resp_en, resp_es, resp_pt, pl_en, pl_es, pl_pt) =>
    nc.push({
      situacion:   en ? sit_en  : pt ? sit_pt  : sit_es,
      criticidad:  crit,
      accion:      en ? acc_en  : pt ? acc_pt  : acc_es,
      responsable: en ? resp_en : pt ? resp_pt : resp_es,
      plazo:       en ? pl_en   : pt ? pl_pt   : pl_es,
    });

  // ── Siempre: etiquetado ──
  add(
    'Non-compliant or incomplete labelling (missing mandatory information)',
    'Etiquetado no conforme o incompleto (falta información obligatoria)',
    'Rotulagem não conforme ou incompleta (informação obrigatória ausente)',
    HIGH,
    'Halt distribution. Update label artwork and reprint. Verify against applicable requirements before release.',
    'Detener distribución. Corregir arte de etiqueta y reimprimir. Verificar cumplimiento antes de liberar.',
    'Suspender distribuição. Corrigir arte e reimprimir. Verificar conformidade antes de liberar.',
    'Regulatory / Quality', 'Regulatorio / Calidad', 'Regulatório / Qualidade',
    '20 days', '20 días', '20 dias'
  );

  // ── FCM (contacto directo con alimentos) ──
  if (hasFC) {
    add(
      'Migration test result exceeds legal limits (overall or specific)',
      'Resultado de ensayo de migración supera los límites legales (global o específica)',
      'Resultado de ensaio de migração supera os limites legais (global ou específica)',
      CRIT,
      'Immediately quarantine entire batch. Commission retest at ISO 17025 accredited laboratory. Do not release until conformity is confirmed.',
      'Cuarentenar el lote completo de inmediato. Encargar re-ensayo en laboratorio acreditado ISO 17025. No liberar hasta confirmar conformidad.',
      'Quarentena imediata do lote completo. Solicitar re-ensaio em laboratório acreditado ISO 17025. Não liberar até confirmar conformidade.',
      'Quality', 'Calidad', 'Qualidade',
      'Immediate / 30 days for retest', 'Inmediato / 30 días para re-ensayo', 'Imediato / 30 dias para re-ensaio'
    );
    add(
      'Supplier changes material without prior notification',
      'Proveedor cambia material sin notificación previa',
      'Fornecedor altera material sem notificação prévia',
      HIGH,
      'Request updated technical data sheet and migration test report for new material. Quarantine affected batches pending assessment.',
      'Solicitar ficha técnica actualizada e informe de migración del nuevo material. Cuarentenar lotes afectados en espera de evaluación.',
      'Solicitar ficha técnica atualizada e laudo de migração do novo material. Quarentena dos lotes afetados até avaliação.',
      'Procurement / Quality', 'Compras / Calidad', 'Compras / Qualidade',
      '15 days', '15 días', '15 dias'
    );
    add(
      'Missing or outdated declaration of conformity from material supplier',
      'Declaración de conformidad del proveedor ausente o desactualizada',
      'Declaração de conformidade do fornecedor ausente ou desatualizada',
      MED,
      'Request updated declaration of conformity covering applicable regulations. Block material use until document is received and validated.',
      'Solicitar declaración de conformidad actualizada conforme a la normativa aplicable. Bloquear uso del material hasta recibir y validar el documento.',
      'Solicitar declaração de conformidade atualizada conforme regulamentação aplicável. Bloquear uso do material até receber e validar o documento.',
      'Procurement', 'Compras', 'Compras',
      '10 days', '10 días', '10 dias'
    );
  }

  // ── Juguete / niños ──
  if (has('juguete') || has('ninos')) {
    add(
      'Sharp edges or points fail EN 71-1 / ASTM F963 mechanical test',
      'Bordes o puntas filosas no superan ensayo mecánico EN 71-1 / ASTM F963',
      'Bordas ou pontas cortantes não passam no ensaio mecânico EN 71-1 / ASTM F963',
      HIGH,
      'Stop production and shipment. Rework or redesign affected area. Retest at accredited laboratory before release.',
      'Detener producción y envío. Rectificar o rediseñar la zona afectada. Re-ensayar en laboratorio acreditado antes de liberar.',
      'Suspender produção e envio. Retrabalhar ou reprojetar a área afetada. Re-ensaiar em laboratório acreditado antes de liberar.',
      'Engineering / Quality', 'Ingeniería / Calidad', 'Engenharia / Qualidade',
      '30 days', '30 días', '30 dias'
    );
    if (has('partes_pequenas')) add(
      'Small parts fail bite-force or drop test — choking hazard confirmed',
      'Piezas pequeñas no superan prueba de mordida o caída — riesgo de asfixia confirmado',
      'Peças pequenas não passam no teste de mordida ou queda — risco de asfixia confirmado',
      CRIT,
      'Immediately halt distribution. Notify regulatory authorities if product is already on the market. Redesign to eliminate small parts or revise age rating.',
      'Detener distribución de inmediato. Notificar a las autoridades regulatorias si el producto ya está en el mercado. Rediseñar para eliminar piezas pequeñas o revisar rango de edad.',
      'Suspender distribuição imediatamente. Notificar autoridades regulatórias se o produto já estiver no mercado. Reprojetar para eliminar peças pequenas ou revisar faixa etária.',
      'Regulatory / Engineering', 'Regulatorio / Ingeniería', 'Regulatório / Engenharia',
      'Immediate', 'Inmediato', 'Imediato'
    );
    if (has('multicolor')) add(
      'Chemical migration from painted/coloured surfaces exceeds EN 71-3 limits',
      'Migración química de superficies pintadas/coloreadas supera límites de EN 71-3',
      'Migração química de superfícies pintadas/coloridas supera limites da EN 71-3',
      CRIT,
      'Quarantine entire batch. Commission chemical migration test at accredited laboratory. Change paint/ink formulation if confirmed.',
      'Cuarentenar el lote completo. Encargar ensayo de migración química en laboratorio acreditado. Cambiar formulación de pintura/tinta si se confirma.',
      'Quarentena do lote completo. Solicitar ensaio de migração química em laboratório acreditado. Alterar formulação de tinta se confirmado.',
      'Quality', 'Calidad', 'Qualidade',
      '45 days', '45 días', '45 dias'
    );
  }

  // ── Baterías / electrónico ──
  if (has('bateria') || has('bateria_boton') || has('electronico')) {
    add(
      'Battery leakage or swelling detected in product',
      'Fuga o abultamiento de batería detectado en el producto',
      'Vazamento ou inchaço de bateria detectado no produto',
      CRIT,
      'Immediately quarantine and recall all units. Conduct electrical safety re-evaluation. File incident report if injuries occurred.',
      'Cuarentenar y retirar todos los lotes de inmediato. Realizar re-evaluación de seguridad eléctrica. Reportar incidente si hubiera lesiones.',
      'Quarentena e recall imediato de todas as unidades. Realizar re-avaliação de segurança elétrica. Registrar incidente se houver lesões.',
      'Quality / Regulatory', 'Calidad / Regulatorio', 'Qualidade / Regulatório',
      'Immediate', 'Inmediato', 'Imediato'
    );
  }
  if (has('bateria_boton')) add(
    'Coin cell battery compartment accessible to children (not childproof)',
    'Compartimento de pila botón accesible para niños (no a prueba de niños)',
    'Compartimento de pilha tipo moeda acessível a crianças (não à prova de crianças)',
    CRIT,
    'Halt production and distribution. Redesign compartment with screw-secured cover. Retest per EN 62115 / IEC 62368.',
    'Detener producción y distribución. Rediseñar compartimento con tapa asegurada con tornillo. Re-ensayar conforme EN 62115 / IEC 62368.',
    'Suspender produção e distribuição. Reprojetar compartimento com tampa parafusada. Re-ensaiar conforme EN 62115 / IEC 62368.',
    'Engineering / Quality', 'Ingeniería / Calidad', 'Engenharia / Qualidade',
    '21 days', '21 días', '21 dias'
  );

  // ── Imanes ──
  if (has('imanes')) add(
    'Magnet flux index exceeds EN 71-1 / ASTM F963 limit — ingestion risk',
    'Índice de flujo magnético supera límite de EN 71-1 / ASTM F963 — riesgo de ingestión',
    'Índice de fluxo magnético supera limite da EN 71-1 / ASTM F963 — risco de ingestão',
    CRIT,
    'Immediately halt distribution. Redesign to secure magnets inside the product or change to weaker magnets below regulatory threshold.',
    'Detener distribución de inmediato. Rediseñar para encapsular imanes dentro del producto o cambiar a imanes más débiles por debajo del umbral regulatorio.',
    'Suspender distribuição imediatamente. Reprojetar para encapsular imãs ou substituir por imãs mais fracos abaixo do limite regulatório.',
    'Engineering / Regulatory', 'Ingeniería / Regulatorio', 'Engenharia / Regulatório',
    'Immediate / 30 days', 'Inmediato / 30 días', 'Imediato / 30 dias'
  );

  // ── Structural (always) ──
  add(
    'Product fractures under mechanical stress test (impact / drop / torsion)',
    'El producto se fractura bajo ensayo de estrés mecánico (impacto / caída / torsión)',
    'O produto fratura sob ensaio de estresse mecânico (impacto / queda / torção)',
    HIGH,
    'Quarantine affected batch. Review material specifications and wall thickness. Redesign structural area and retest.',
    'Cuarentenar el lote afectado. Revisar especificaciones de material y espesor de pared. Rediseñar zona estructural y re-ensayar.',
    'Quarentena do lote afetado. Revisar especificações de material e espessura. Reprojetar área estrutural e re-ensaiar.',
    'Engineering / Quality', 'Ingeniería / Calidad', 'Engenharia / Qualidade',
    '45 days', '45 días', '45 dias'
  );

  return nc;
}

// ── HTML Preview ──────────────────────────────────────────────────────────────
function buildHTMLPreview(formData, mercadoKey, cfg, L, aiData) {
  const risks = getRisks(formData, L);
  const ensayosMoca = getEnsayosMoca(formData, cfg);
  const ensayosSeg = getEnsayosSeg(formData, cfg, L);
  const mocaReg = getMocaReg(formData, cfg);
  const chars = formData.caracteristicas;
  const tieneElec = chars.some(c => ['led','electronico','bateria','vapor'].includes(c));
  const docsChecklist = DOCS_CHECKLIST[cfg.idioma].map(([doc, inc]) => [doc.replace('{DOC}', cfg.doc), inc]);
  const fecha = formData.fecha;
  const version = formData.version;

  const warnings = getContextualWarnings(formData, cfg, L, aiData);

  const legalNote = cfg.idioma === 'en'
    ? `LEGAL NOTE: This technical file must be retained for ${cfg.retencion} and be available to market surveillance authorities upon request. All tests must be carried out by ISO 17025 accredited laboratories.`
    : cfg.idioma === 'pt'
    ? `NOTA LEGAL: Este dossiê técnico deve ser conservado por ${cfg.retencion} e estar disponível para as autoridades de vigilância de mercado quando solicitado. Os ensaios devem ser realizados por laboratórios acreditados ISO 17025.`
    : `NOTA LEGAL: Este expediente técnico debe conservarse durante ${cfg.retencion} y estar disponible para las autoridades de vigilancia de mercado cuando sea requerido. Los ensayos deben ser realizados por laboratorios acreditados ISO 17025.`;

  const pd = L.por_definir;
  const mktName = (cfg.idioma === 'en' && cfg.nombre_en) ? cfg.nombre_en : cfg.nombre;
  const ident = [
    [L.nombre_com, formData.nombre],
    [L.tipo_prod, translateCategory(formData.categoria, cfg.idioma)],
    [L.ref_int, formData.referencia || pd],
    [L.ver_doc, version],
    [L.fecha_em, fecha],
    [L.mercado, mktName],
    [L.canal, formData.canal || pd],
    [L.publico, formData.publico || pd],
    [L.resp_tec, formData.responsable || pd],
  ];

  const componentNames = { en: 'Component', es: 'Componente', pt: 'Componente' };
  const contactNames = { en: c => c === 'Directo' ? 'Direct' : c === 'Indirecto' ? 'Indirect' : 'No contact', es: c => c, pt: c => c === 'Directo' ? 'Direto' : c === 'Indirecto' ? 'Indireto' : 'Sem contato' };
  const contactFn = contactNames[cfg.idioma];
  const contactBadge = c => {
    if (c === 'Directo') return `<span class="contact-badge contact-directo">${contactFn('Directo')}</span>`;
    if (c === 'Indirecto') return `<span class="contact-badge contact-indirecto">${contactFn('Indirecto')}</span>`;
    return `<span class="contact-badge contact-sin">${contactFn('Sin contacto')}</span>`;
  };
  const nivelClass = n => n.includes('ALT') || n === 'HIGH' ? 'nivel-alto' : n.includes('MED') || n === 'MEDIUM' || n.includes('MÉD') ? 'nivel-medio' : 'nivel-bajo';

  return `
<div class="exp-cover">
  <div class="exp-title">${L.title_doc}</div>
  <div class="exp-subtitle">${formData.nombre}</div>
  <div class="exp-meta">${L.market_label}: ${mktName} | ${L.version_label} ${version} | ${fecha}</div>
  <div class="exp-conf">${L.confidential}</div>
</div>

<div class="exp-section"><div class="exp-section-title">1. ${L.s1}</div>
<table class="exp-table"><thead><tr><th>${L.campo}</th><th>${L.detalle}</th></tr></thead><tbody>
${ident.map(([k,v]) => `<tr><td><strong>${k}</strong></td><td>${v}</td></tr>`).join('')}
</tbody></table></div>

<div class="exp-section"><div class="exp-section-title">2. ${L.s2}</div>
<div class="exp-subsection">${L.s2_1}</div>
<div class="exp-body">${escapeHtml(aiData.descripcion_general || '')}</div>
<div class="exp-subsection">${L.s2_2}</div>
<div class="exp-body">${escapeHtml(aiData.uso_previsto || '')}</div>
<div class="exp-subsection">${L.s2_3}</div>
${(aiData.usos_indebidos || []).map(u => `<div class="exp-bullet">${escapeHtml(u)}</div>`).join('')}
<div class="exp-subsection">${L.s2_4}</div>
<table class="exp-table"><thead><tr><th>${L.componente}</th><th>${L.material}</th><th>${L.contacto}</th></tr></thead><tbody>
${formData.componentes.map(c => `<tr><td>${escapeHtml(c.componente)}</td><td>${escapeHtml(c.material)}</td><td>${contactBadge(c.contacto_alimento)}</td></tr>`).join('')}
</tbody></table></div>

<div class="exp-section"><div class="exp-section-title">3. ${L.s3}</div>
<div class="exp-subsection">${L.s3_1}</div>
${mocaReg.map(n => `<div class="exp-bullet">${n}</div>`).join('')}
<div class="exp-subsection">${L.s3_2}</div>
${cfg.juguetes.map(n => `<div class="exp-bullet">${n}</div>`).join('')}
${tieneElec ? `<div class="exp-subsection">${L.s3_3}</div>${cfg.electrica.map(n => `<div class="exp-bullet">${n}</div>`).join('')}` : ''}
<div class="exp-subsection">${L.s3_4}</div>
${[...cfg.quimica_base, ...(tieneElec ? cfg.quimica_elec : [])].map(n => `<div class="exp-bullet">${n}</div>`).join('')}
</div>

<div class="exp-section"><div class="exp-section-title">4. ${L.s4}</div>
<div class="exp-note">${L.nota_riesgos}</div>
<table class="exp-table"><thead><tr><th>${L.riesgo}</th><th>${L.nivel_ini}</th><th>${L.medida}</th><th>${L.nivel_res}</th></tr></thead><tbody>
${risks.map(r => `<tr><td>${r.riesgo}</td><td class="${nivelClass(r.nivel_inicial)}">${r.nivel_inicial}</td><td>${r.medida_control}</td><td>${r.nivel_residual}</td></tr>`).join('')}
</tbody></table></div>

<div class="exp-section"><div class="exp-section-title">5. ${L.s5}</div>
<div class="exp-subsection">${L.s5_1}</div>
<div class="exp-note">${L.nota_ensayos}</div>
${ensayosMoca.length > 0 ? `<table class="exp-table"><thead><tr><th>${L.ensayo}</th><th>${L.norma}</th><th>${L.frecuencia}</th></tr></thead><tbody>
${ensayosMoca.map(e => `<tr><td>${e.ensayo}</td><td>${e.norma}</td><td>${e.frecuencia}</td></tr>`).join('')}
</tbody></table>` : ''}
${ensayosSeg.length > 0 ? `<div class="exp-subsection">${L.s5_2}</div>
<table class="exp-table"><thead><tr><th>${L.ensayo}</th><th>${L.norma}</th></tr></thead><tbody>
${ensayosSeg.map(e => `<tr><td>${e.ensayo}</td><td>${e.norma}</td></tr>`).join('')}
</tbody></table>` : ''}
${tieneElec ? `<div class="exp-subsection">${L.s5_3}</div>
<table class="exp-table"><thead><tr><th>${L.ensayo}</th><th>${L.norma}</th></tr></thead><tbody>
<tr><td>${cfg.idioma === 'en' ? 'Low voltage electrical safety' : cfg.idioma === 'pt' ? 'Segurança elétrica de baixa tensão' : 'Seguridad eléctrica baja tensión'}</td><td>${cfg.electrica[0]}</td></tr>
<tr><td>${cfg.idioma === 'en' ? 'Electromagnetic compatibility (EMC)' : cfg.idioma === 'pt' ? 'Compatibilidade eletromagnética (EMC)' : 'Compatibilidad electromagnética (EMC)'}</td><td>${cfg.electrica[1] || cfg.electrica[0]}</td></tr>
</tbody></table>` : ''}
</div>

<div class="exp-section"><div class="exp-section-title">6. ${L.s6}</div>
<table class="exp-table"><thead><tr><th>${L.doc_num}</th><th>${L.doc_doc}</th><th>${L.estado}</th></tr></thead><tbody>
${docsChecklist.map(([doc, inc], i) => `<tr><td>${i+1}</td><td>${doc}</td><td>${inc ? `<strong style="color:#2E7D32">${L.incluido}</strong>` : L.pendiente}</td></tr>`).join('')}
</tbody></table></div>

<div class="exp-section"><div class="exp-section-title">7. ${L.s7}</div>
<div class="exp-subsection">${L.s7_1}</div>
${cfg.etiquetado_base.map(e => `<div class="exp-bullet">${e}</div>`).join('')}
<div class="exp-subsection">${L.s7_2}</div>
${warnings.map(w => `<div class="exp-warning">${w}</div>`).join('')}
</div>

<div class="exp-section"><div class="exp-section-title">8. ${L.s8}</div>
<p class="exp-note">${L.nc_intro}</p>
<table class="exp-table"><thead><tr><th style="width:32%">${L.situacion}</th><th style="width:10%">${L.criticidad}</th><th style="width:30%">${L.accion_req}</th><th style="width:15%">${L.responsable}</th><th style="width:13%">${L.plazo}</th></tr></thead><tbody>
${(() => {
  const contextual = getContextualNonConformities(formData, cfg, L);
  const aiNc = (aiData.no_conformidades || []).filter(nc => nc.situacion && nc.accion);
  return [...contextual, ...aiNc].map(nc => {
    const crit = (nc.criticidad || '').toUpperCase();
    const critClass = crit.includes('CRIT') ? 'nivel-alto' : crit.includes('ALT') || crit === 'HIGH' ? 'nivel-medio' : crit.includes('MED') || crit === 'MEDIUM' || crit.includes('MÉD') ? 'nivel-bajo' : '';
    return `<tr><td>${escapeHtml(nc.situacion)}</td><td class="${critClass}">${escapeHtml(nc.criticidad || '')}</td><td>${escapeHtml(nc.accion)}</td><td>${escapeHtml(nc.responsable || '')}</td><td>${escapeHtml(nc.plazo || '')}</td></tr>`;
  }).join('');
})()}
</tbody></table></div>

<div class="exp-section"><div class="exp-section-title">9. ${L.s9}</div>
<table class="exp-table"><thead><tr><th>${L.prioridad}</th><th>${L.accion}</th><th>${L.responsable}</th><th>${L.plazo}</th></tr></thead><tbody>
${(aiData.acciones_recomendadas || []).map(a => {
  const pc = (a.prioridad || '').includes('ALT') || a.prioridad === 'HIGH' ? 'prioridad-alto' : (a.prioridad || '').includes('MED') || a.prioridad === 'MEDIUM' ? 'prioridad-medio' : 'prioridad-bajo';
  return `<tr><td class="${pc}">${escapeHtml(a.prioridad)}</td><td>${escapeHtml(a.accion)}</td><td>${escapeHtml(a.responsable)}</td><td>${escapeHtml(a.plazo)}</td></tr>`;
}).join('')}
</tbody></table></div>

<div class="exp-section"><div class="exp-section-title">10. ${L.s10}</div>
<table class="exp-table"><thead><tr><th>${L.version}</th><th>${L.fecha}</th><th>${L.autor}</th><th>${L.cambios}</th></tr></thead><tbody>
<tr><td>${version}</td><td>${fecha}</td><td>${formData.responsable || L.por_definir}</td><td>${cfg.idioma === 'en' ? 'Initial version' : cfg.idioma === 'pt' ? 'Versão inicial' : 'Versión inicial'}</td></tr>
</tbody></table></div>

<div class="exp-section"><div class="exp-section-title">11. ${L.s11}</div>
<div class="sign-block">
  <div class="sign-row"><span class="sign-label">${L.firma_nombre}</span><span class="sign-line"></span></div>
  <div class="sign-row"><span class="sign-label">${L.firma_cargo}</span><span class="sign-line"></span></div>
  <div class="sign-row"><span class="sign-label">${L.firma_empresa}</span><span class="sign-line"></span></div>
  <div class="sign-row"><span class="sign-label">${L.firma_fecha} ${fecha}</span><span class="sign-line"></span></div>
  <div class="sign-row"><span class="sign-label">${L.firma_firma}</span><span class="sign-line"></span></div>
</div>
<div class="exp-legal">${legalNote}</div>
</div>`;
}

// ── Word Document (docx.js) ───────────────────────────────────────────────────
function loadDocxFromCDN() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/docx@8.2.4/build/index.umd.js';
    s.onload = () => typeof docx !== 'undefined' ? resolve() : reject(new Error('docx no definido tras CDN'));
    s.onerror = () => reject(new Error('No se pudo cargar docx desde CDN'));
    document.head.appendChild(s);
  });
}

async function buildDocx(formData, mercadoKey, cfg, L, aiData) {
  if (typeof docx === 'undefined') {
    await loadDocxFromCDN();
  }
  const { Document, Paragraph, TextRun, Table, TableRow, TableCell,
          AlignmentType, WidthType, ShadingType, BorderStyle, Packer } = docx;

  const risks = getRisks(formData, L);
  const ensayosMoca = getEnsayosMoca(formData, cfg);
  const ensayosSeg = getEnsayosSeg(formData, cfg, L);
  const mocaReg = getMocaReg(formData, cfg);
  const chars = formData.caracteristicas;
  const tieneElec = chars.some(c => ['led','electronico','bateria','vapor'].includes(c));
  const docsChecklist = DOCS_CHECKLIST[cfg.idioma].map(([doc, inc]) => [doc.replace('{DOC}', cfg.doc), inc]);
  const fecha = formData.fecha;
  const version = formData.version;

  const BLUE = '185FA5'; const NAVY = '0D1B2A'; const GRAY = '888888'; const WHITE = 'FFFFFF';
  const RED_BG = 'FCEBEB'; const AMB_BG = 'FAEEDA'; const GRN_BG = 'EAF3DE'; const HDR_BG = '0D1B2A';

  const borders = { top: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' }, bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' }, left: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' }, right: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } };
  const tableWidth = { size: 100, type: WidthType.PERCENTAGE };

  const p = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text: String(text || ''), font: 'Calibri', size: opts.size || 20, color: opts.color || '333333', bold: opts.bold || false, italics: opts.italic || false })], alignment: opts.align || AlignmentType.LEFT, spacing: { before: opts.before || 40, after: opts.after || 40 } });

  const sec = (num, title) => new Paragraph({ children: [new TextRun({ text: `${num}. ${title.toUpperCase()}`, font: 'Calibri', size: 24, color: BLUE, bold: true })], spacing: { before: 200, after: 80 }, border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: BLUE } } });

  const sub = text => new Paragraph({ children: [new TextRun({ text, font: 'Calibri', size: 22, color: '333333', bold: true })], spacing: { before: 160, after: 60 } });

  const bullet = text => new Paragraph({ children: [new TextRun({ text: String(text), font: 'Calibri', size: 20, color: '444444' })], bullet: { level: 0 }, spacing: { before: 20, after: 20 } });

  const note = text => new Paragraph({ children: [new TextRun({ text, font: 'Calibri', size: 16, color: GRAY, italics: true })], spacing: { before: 40, after: 40 } });

  const hdrCell = (text, widthPct) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, font: 'Calibri', size: 18, color: WHITE, bold: true })], spacing: { before: 60, after: 60 } })], shading: { type: ShadingType.SOLID, color: HDR_BG }, width: { size: widthPct, type: WidthType.PERCENTAGE }, borders });

  const dataCell = (text, bg, widthPct) => new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text: String(text || ''), font: 'Calibri', size: 20, color: '333333' })], spacing: { before: 60, after: 60 } })],
    ...(bg ? { shading: { type: ShadingType.SOLID, color: bg } } : {}),
    ...(widthPct ? { width: { size: widthPct, type: WidthType.PERCENTAGE } } : {}),
    borders,
  });

  const twoColTable = (hdr1, hdr2, rows) => new Table({ rows: [new TableRow({ children: [hdrCell(hdr1, 35), hdrCell(hdr2, 65)], tableHeader: true }), ...rows.map(([a, b], i) => new TableRow({ children: [dataCell(a, i % 2 ? 'F8F9FA' : null, 35), dataCell(b, i % 2 ? 'F8F9FA' : null, 65)] }))], width: tableWidth });

  const threeColTable = (h1, h2, h3, rows) => new Table({ rows: [new TableRow({ children: [hdrCell(h1, 34), hdrCell(h2, 33), hdrCell(h3, 33)], tableHeader: true }), ...rows.map(([a, b, c], i) => new TableRow({ children: [dataCell(a, i % 2 ? 'F8F9FA' : null), dataCell(b, i % 2 ? 'F8F9FA' : null), dataCell(c, i % 2 ? 'F8F9FA' : null)] }))], width: tableWidth });

  const fourColTable = (h1, h2, h3, h4, rows) => new Table({ rows: [new TableRow({ children: [hdrCell(h1, 15), hdrCell(h2, 20), hdrCell(h3, 30), hdrCell(h4, 35)], tableHeader: true }), ...rows.map(([a, b, c, d], i) => new TableRow({ children: [dataCell(a, i % 2 ? 'F8F9FA' : null, 15), dataCell(b, i % 2 ? 'F8F9FA' : null, 20), dataCell(c, i % 2 ? 'F8F9FA' : null, 30), dataCell(d, i % 2 ? 'F8F9FA' : null, 35)] }))], width: tableWidth });

  const nivelBg = n => (n.includes('ALT') || n === 'HIGH') ? RED_BG : (n.includes('MED') || n === 'MEDIUM' || n.includes('MÉD')) ? AMB_BG : GRN_BG;
  const contactFn = c => cfg.idioma === 'en' ? (c === 'Directo' ? 'Direct' : c === 'Indirecto' ? 'Indirect' : 'No contact') : cfg.idioma === 'pt' ? (c === 'Directo' ? 'Direto' : c === 'Indirecto' ? 'Indireto' : 'Sem contato') : c;

  const warnings = getContextualWarnings(formData, cfg, L, aiData);

  const legalNote = cfg.idioma === 'en'
    ? `LEGAL NOTE: This technical file must be retained for ${cfg.retencion} and be available to market surveillance authorities upon request. All tests must be carried out by ISO 17025 accredited laboratories.`
    : cfg.idioma === 'pt'
    ? `NOTA LEGAL: Este dossiê técnico deve ser conservado por ${cfg.retencion} e estar disponível para as autoridades de vigilância de mercado quando solicitado. Os ensaios devem ser realizados por laboratórios acreditados ISO 17025.`
    : `NOTA LEGAL: Este expediente técnico debe conservarse durante ${cfg.retencion} y estar disponible para las autoridades de vigilancia de mercado. Los ensayos deben ser realizados por laboratorios acreditados ISO 17025.`;

  const children = [
    // Cover
    new Paragraph({ children: [new TextRun({ text: L.title_doc, font: 'Calibri', size: 40, bold: true, color: NAVY })], alignment: AlignmentType.CENTER, spacing: { before: 0, after: 80 } }),
    new Paragraph({ children: [new TextRun({ text: formData.nombre, font: 'Calibri', size: 28, bold: true, color: BLUE })], alignment: AlignmentType.CENTER, spacing: { before: 0, after: 80 } }),
    new Paragraph({ children: [new TextRun({ text: `${L.market_label}: ${mktName}  |  ${L.version_label} ${version}  |  ${fecha}`, font: 'Calibri', size: 20, color: GRAY, italics: true })], alignment: AlignmentType.CENTER, spacing: { before: 0, after: 60 } }),
    new Paragraph({ children: [new TextRun({ text: L.confidential, font: 'Calibri', size: 18, color: GRAY, italics: true })], alignment: AlignmentType.CENTER, spacing: { before: 0, after: 200 } }),
    // Section 1
    sec(1, L.s1),
    twoColTable(L.campo, L.detalle, [[L.nombre_com, formData.nombre],[L.tipo_prod, translateCategory(formData.categoria, cfg.idioma)],[L.ref_int, formData.referencia||pd],[L.ver_doc, version],[L.fecha_em, fecha],[L.mercado, mktName],[L.canal, formData.canal||pd],[L.publico, formData.publico||pd],[L.resp_tec, formData.responsable||pd]]),
    // Section 2
    sec(2, L.s2), sub(L.s2_1), p(aiData.descripcion_general),
    sub(L.s2_2), p(aiData.uso_previsto),
    sub(L.s2_3), ...(aiData.usos_indebidos||[]).map(u => bullet(u)),
    sub(L.s2_4),
    new Table({ rows: [new TableRow({ children: [hdrCell(L.componente,34),hdrCell(L.material,33),hdrCell(L.contacto,33)], tableHeader: true }), ...formData.componentes.map((c,i) => new TableRow({ children: [dataCell(c.componente,i%2?'F8F9FA':null,34), dataCell(c.material,i%2?'F8F9FA':null,33), new TableCell({ children:[new Paragraph({children:[new TextRun({text:contactFn(c.contacto_alimento),font:'Calibri',size:20,bold:true,color:c.contacto_alimento==='Directo'?'C0392B':c.contacto_alimento==='Indirecto'?'B7770D':'2E7D32'})],spacing:{before:60,after:60}})], shading:{type:ShadingType.SOLID,color:c.contacto_alimento==='Directo'?RED_BG:c.contacto_alimento==='Indirecto'?AMB_BG:GRN_BG}, borders})] }))], width: tableWidth }),
    // Section 3
    sec(3, L.s3), sub(L.s3_1), ...mocaReg.map(n => bullet(n)),
    sub(L.s3_2), ...cfg.juguetes.map(n => bullet(n)),
    ...(tieneElec ? [sub(L.s3_3), ...cfg.electrica.map(n => bullet(n))] : []),
    sub(L.s3_4), ...[...cfg.quimica_base,...(tieneElec?cfg.quimica_elec:[])].map(n => bullet(n)),
    // Section 4
    sec(4, L.s4), note(L.nota_riesgos),
    new Table({ rows: [new TableRow({ children: [hdrCell(L.riesgo,40),hdrCell(L.nivel_ini,12),hdrCell(L.medida,36),hdrCell(L.nivel_res,12)], tableHeader:true }), ...risks.map((r,i) => new TableRow({ children: [dataCell(r.riesgo,i%2?'F8F9FA':null,40), new TableCell({children:[new Paragraph({children:[new TextRun({text:r.nivel_inicial,font:'Calibri',size:20,bold:true,color:r.nivel_inicial.includes('ALT')||r.nivel_inicial==='HIGH'?'C0392B':r.nivel_inicial.includes('MED')||r.nivel_inicial==='MEDIUM'||r.nivel_inicial.includes('MÉD')?'B7770D':'2E7D32'})],spacing:{before:60,after:60}}),], shading:{type:ShadingType.SOLID,color:nivelBg(r.nivel_inicial)},borders}), dataCell(r.medida_control,i%2?'F8F9FA':null,36), dataCell(r.nivel_residual,GRN_BG,12)] }))], width:tableWidth }),
    // Section 5
    sec(5, L.s5), sub(L.s5_1), note(L.nota_ensayos),
    ...(ensayosMoca.length>0?[threeColTable(L.ensayo,L.norma,L.frecuencia,ensayosMoca.map(e=>[e.ensayo,e.norma,e.frecuencia]))]:[] ),
    ...(ensayosSeg.length>0?[sub(L.s5_2), new Table({rows:[new TableRow({children:[hdrCell(L.ensayo,50),hdrCell(L.norma,50)],tableHeader:true}),...ensayosSeg.map((e,i)=>new TableRow({children:[dataCell(e.ensayo,i%2?'F8F9FA':null,50),dataCell(e.norma,i%2?'F8F9FA':null,50)]}))],width:tableWidth})]:[]),
    ...(tieneElec?[sub(L.s5_3),new Table({rows:[new TableRow({children:[hdrCell(L.ensayo,50),hdrCell(L.norma,50)],tableHeader:true}),new TableRow({children:[dataCell(cfg.idioma==='en'?'Low voltage electrical safety':cfg.idioma==='pt'?'Segurança elétrica de baixa tensão':'Seguridad eléctrica baja tensión',null,50),dataCell(cfg.electrica[0],null,50)]}),new TableRow({children:[dataCell(cfg.idioma==='en'?'Electromagnetic compatibility (EMC)':cfg.idioma==='pt'?'Compatibilidade eletromagnética':'Compatibilidad electromagnética','F8F9FA',50),dataCell(cfg.electrica[1]||cfg.electrica[0],'F8F9FA',50)]})],width:tableWidth})]:[]),
    // Section 6
    sec(6, L.s6),
    new Table({rows:[new TableRow({children:[hdrCell('#',8),hdrCell(L.doc_doc,72),hdrCell(L.estado,20)],tableHeader:true}),...docsChecklist.map(([doc,inc],i)=>new TableRow({children:[dataCell(String(i+1),i%2?'F8F9FA':null,8),dataCell(doc,i%2?'F8F9FA':null,72),new TableCell({children:[new Paragraph({children:[new TextRun({text:inc?L.incluido:L.pendiente,font:'Calibri',size:20,bold:inc,color:inc?'2E7D32':'888888'})],spacing:{before:60,after:60}})],shading:{type:ShadingType.SOLID,color:inc?GRN_BG:(i%2?'F8F9FA':'FFFFFF')},borders})]}))],width:tableWidth}),
    // Section 7
    sec(7, L.s7), sub(L.s7_1), ...cfg.etiquetado_base.map(e=>bullet(e)),
    sub(L.s7_2), ...warnings.map(w=>new Paragraph({children:[new TextRun({text:w,font:'Calibri',size:20,bold:true,color:'7B341E'})],spacing:{before:40,after:40}})),
    // Section 8
    sec(8, L.s8),
    new Paragraph({children:[new TextRun({text:L.nc_intro,font:'Calibri',size:18,italics:true,color:GRAY})],spacing:{before:40,after:120},border:{left:{style:BorderStyle.SINGLE,size:4,color:BLUE}},indent:{left:200}}),
    new Table({rows:[new TableRow({children:[hdrCell(L.situacion,32),hdrCell(L.criticidad,10),hdrCell(L.accion_req,30),hdrCell(L.responsable,15),hdrCell(L.plazo,13)],tableHeader:true}),...(()=>{const rows=[...getContextualNonConformities(formData,cfg,L),...(aiData.no_conformidades||[]).filter(nc=>nc.situacion&&nc.accion)];return rows.map((nc,i)=>{const crit=(nc.criticidad||'').toUpperCase();const bg=crit.includes('CRIT')?RED_BG:crit.includes('ALT')||crit==='HIGH'?AMB_BG:crit.includes('MED')||crit==='MEDIUM'||crit.includes('MÉD')?GRN_BG:(i%2?'F8F9FA':null);return new TableRow({children:[dataCell(nc.situacion,i%2?'F8F9FA':null,32),new TableCell({children:[new Paragraph({children:[new TextRun({text:nc.criticidad||'',font:'Calibri',size:18,bold:true})],spacing:{before:60,after:60}})],shading:{type:ShadingType.SOLID,color:bg||'FFFFFF'},borders}),dataCell(nc.accion,i%2?'F8F9FA':null,30),dataCell(nc.responsable||'',i%2?'F8F9FA':null,15),dataCell(nc.plazo||'',i%2?'F8F9FA':null,13)]})})})()],width:tableWidth}),
    // Section 9
    sec(9, L.s9),
    new Table({rows:[new TableRow({children:[hdrCell(L.prioridad,12),hdrCell(L.accion,40),hdrCell(L.responsable,24),hdrCell(L.plazo,24)],tableHeader:true}),...(aiData.acciones_recomendadas||[]).map((a,i)=>{const bg=a.prioridad?.includes('ALT')||a.prioridad==='HIGH'?RED_BG:a.prioridad?.includes('MED')||a.prioridad==='MEDIUM'||a.prioridad?.includes('MÉD')?AMB_BG:GRN_BG;return new TableRow({children:[new TableCell({children:[new Paragraph({children:[new TextRun({text:a.prioridad,font:'Calibri',size:20,bold:true})],spacing:{before:60,after:60}})],shading:{type:ShadingType.SOLID,color:bg},borders}),dataCell(a.accion,i%2?'F8F9FA':null,40),dataCell(a.responsable,i%2?'F8F9FA':null,24),dataCell(a.plazo,i%2?'F8F9FA':null,24)]})})],width:tableWidth}),
    // Section 10
    sec(10, L.s10),
    fourColTable(L.version,L.fecha,L.autor,L.cambios,[[version,fecha,formData.responsable||pd,cfg.idioma==='en'?'Initial version':cfg.idioma==='pt'?'Versão inicial':'Versión inicial']]),
    // Legal note
    new Paragraph({children:[new TextRun({text:legalNote,font:'Calibri',size:16,italics:true,color:GRAY})],spacing:{before:200,after:80},border:{left:{style:BorderStyle.SINGLE,size:4,color:BLUE}},indent:{left:200}}),
    // Section 11
    sec(11, L.s11),
    ...[L.firma_nombre,L.firma_cargo,L.firma_empresa,`${L.firma_fecha} ${fecha}`,L.firma_firma].map(f=>new Paragraph({children:[new TextRun({text:f,font:'Calibri',size:20,bold:true}),new TextRun({text:'  ___________________________',font:'Calibri',size:20,color:GRAY})],spacing:{before:100,after:40}})),
  ];

  const document = new Document({ sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1800, right: 1800 } } }, children }] });
  return Packer.toBlob(document);
}

// ── Render Results ────────────────────────────────────────────────────────────
function renderResults(formData) {
  document.getElementById('results-section').classList.remove('hidden');
  const _n = Object.keys(generatedDocs).length;
  document.getElementById('results-title').textContent = `${formData.nombre} — ${_n} ${_n === 1 ? 'expediente generado' : 'expedientes generados'}`;
  const keys = Object.keys(generatedDocs);
  const tabsEl = document.getElementById('results-market-tabs');
  tabsEl.innerHTML =
    keys.map(k => `<button class="result-tab" data-key="${k}" onclick="showResultTab('${k}')">${MARKETS[k]?.flag || ''} ${MARKETS[k]?.nombre || k}</button>`).join('') +
    `<button class="result-tab result-tab--label" data-key="etiquetado" onclick="showResultTab('etiquetado')">🏷 Etiquetado</button>` +
    `<button class="result-tab result-tab--ev" data-key="evidencias" onclick="showResultTab('evidencias')">📎 Evidencias</button>` +
    `<button class="result-tab result-tab--docs" data-key="documentos" onclick="showResultTab('documentos')">📋 Documentos</button>`;
  const hasBlobs = keys.some(k => generatedDocs[k].blob);
  document.getElementById('btn-download-zip').classList.toggle('hidden', keys.length < 2 || !hasBlobs);
  setupLabelCheck();
  showResultTab(keys[0]);
}

function showResultTab(key) {
  activeResultTab = key;
  document.querySelectorAll('.result-tab').forEach(t => t.classList.toggle('active', t.dataset.key === key));
  const inline = document.getElementById('label-inline-content');
  const content = document.getElementById('results-content');
  if (key === 'etiquetado') {
    content?.classList.add('hidden');
    inline?.classList.remove('hidden');
    renderLabelCtxBox();
    const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    const expId = currentHistoryIndex !== null ? hist[currentHistoryIndex]?.expId : null;
    renderLabelChecklistPanel(expId);
    return;
  }
  if (key === 'evidencias') {
    inline?.classList.add('hidden');
    content?.classList.remove('hidden');
    const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    const expId = currentHistoryIndex !== null ? hist[currentHistoryIndex]?.expId : null;
    content.innerHTML = `
      <div class="expediente-card">
        <div class="ev-panel">
          <div class="ev-header">
            <span class="ev-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              Evidencias del expediente
            </span>
            ${expId ? `
              <button id="btn-ev-upload" class="btn-ev-upload" onclick="document.getElementById('ev-file-input').click()">+ Subir</button>
              <input id="ev-file-input" type="file" accept=".pdf,image/*" multiple style="display:none">
            ` : ''}
          </div>
          <div id="ev-list" class="ev-list">
            ${expId ? '<p class="ev-empty">Cargando...</p>' : '<p class="ev-empty">Guarda el expediente primero para adjuntar evidencias.</p>'}
          </div>
        </div>
      </div>`;
    if (expId) {
      renderEvidenciasPanel(expId);
      setupEvidenciasUpload(expId);
    }
    return;
  }

  if (key === 'documentos') {
    inline?.classList.add('hidden');
    content?.classList.remove('hidden');
    const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    const hEntry = currentHistoryIndex !== null ? hist[currentHistoryIndex] : null;
    const expId    = hEntry?.expId || null;
    const formData = hEntry?.formData || {};
    const markets  = hEntry?.mercados || [];
    renderDocumentosTab(expId, formData, markets);
    return;
  }

  inline?.classList.add('hidden');
  content?.classList.remove('hidden');
  if (!generatedDocs[key]) return;
  const { blob, html } = generatedDocs[key];

  // Status bar (only when linked to a history entry)
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const hEntry = currentHistoryIndex !== null ? hist[currentHistoryIndex] : null;
  const status = hEntry?.status || 'borrador';
  const nota = hEntry?.nota || '';
  const statusBar = hEntry ? `
    <div class="exp-status-bar">
      <span class="status-label">Estado:</span>
      <div class="status-pills">
        <button class="status-pill ${status === 'borrador' ? 'active borrador' : ''}" onclick="changeStatus(${currentHistoryIndex},'borrador')">Borrador</button>
        <button class="status-pill ${status === 'en_revision' ? 'active en_revision' : ''}" onclick="changeStatus(${currentHistoryIndex},'en_revision')">En revisión</button>
        <button class="status-pill ${status === 'aprobado' ? 'active aprobado' : ''}" onclick="changeStatus(${currentHistoryIndex},'aprobado')">Aprobado</button>
      </div>
    </div>` : '';

  const { docxError } = generatedDocs[key];
  const wordBtn = blob
    ? `<button class="btn-primary" onclick="downloadDoc('${key}')">⬇ Descargar Word (.docx)</button>`
    : `<span style="font-size:12px;color:#888" title="${escapeHtml(docxError || '')}">Word no disponible en esta sesión — usa "Regenerar" en el historial${docxError ? ' ⓘ' : ''}</span>`;
  document.getElementById('results-content').innerHTML = `
    <div class="expediente-card">
      ${statusBar}
      <div class="exp-actions">
        ${wordBtn}
        <button class="btn-secondary" onclick="printPreview()">🖨 Imprimir / PDF</button>
      </div>
      <div class="exp-preview" id="preview-${key}">${html}</div>
      <div class="exp-notes no-print">
        <div class="exp-notes-header">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Notas internas <span class="no-print-hint">(no aparecen en PDF)</span>
        </div>
        <textarea class="exp-notes-area" placeholder="Anotaciones del equipo: qué falta, pendientes de validación, excepciones aplicadas..." onblur="saveNoteToHistory(${currentHistoryIndex ?? 'null'}, this.value)">${nota}</textarea>
      </div>
    </div>`;
}

function downloadDoc(key) {
  if (!generatedDocs[key]) return;
  const { blob } = generatedDocs[key];
  const ts = new Date().toISOString().split('T')[0];
  saveAs(blob, `ExpedienteTecnico_${key}_${ts}.docx`);
}

function printPreview() {
  window.print();
}

async function downloadZip() {
  const btn = document.getElementById('btn-download-zip');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Generando ZIP…';
  try {
    const zip = new JSZip();
    const ts = new Date().toISOString().split('T')[0];
    for (const [key, { blob }] of Object.entries(generatedDocs)) {
      if (blob) zip.file(`ExpedienteTecnico_${key}_${ts}.docx`, blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    saveAs(zipBlob, `Expedientes_${ts}.zip`);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// ── History ───────────────────────────────────────────────────────────────────
function saveToHistory(formData, markets) {
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const previews = {};
  markets.forEach(k => { if (generatedDocs[k]?.html) previews[k] = generatedDocs[k].html; });
  const entry = {
    expId: generateId(),
    nombre: formData.nombre,
    categoria: formData.categoria,
    mercados: markets,
    fecha: formData.fecha,
    ts: Date.now(),
    previews,
    formData: { ...formData },
    status: 'borrador',
    nota: '',
  };
  hist.unshift(entry);
  currentHistoryIndex = 0;
  // Keep last 10 — HTML previews are large
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(hist.slice(0, HIST_LOCAL_LIMIT)));
  } catch (e) {
    // localStorage full: retry without previews
    hist[0].previews = {};
    try { localStorage.setItem(HIST_KEY, JSON.stringify(hist.slice(0, HIST_LOCAL_LIMIT))); } catch (_) {}
  }
  renderHistory();

  // Save formData to Firestore in background (cross-device access)
  if (db) {
    saveExpedienteToFirestore(entry, markets)
      .then(() => showToast('☁ Expediente guardado en la nube'))
      .catch(e => console.warn('Cloud save error:', e));
  }
}

const STATUS_CFG = {
  borrador:    { label: 'Borrador',    cls: 'status-borrador' },
  en_revision: { label: 'En revisión', cls: 'status-revision' },
  aprobado:    { label: 'Aprobado',    cls: 'status-aprobado' },
};

function buildDocProgressBadges(docProgress) {
  if (!docProgress || !Object.keys(docProgress).length) return '';
  return Object.entries(docProgress).map(([m, p]) => {
    const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
    const flag = DOC_MARKET_FLAGS[m] || '';
    if (pct === 100) return `<span class="hist-doc-badge hist-doc--ok">${flag} ${DOC_MARKET_SHORT[m]} ✓</span>`;
    if (p.done > 0)  return `<span class="hist-doc-badge hist-doc--partial">${flag} ${DOC_MARKET_SHORT[m]} ${p.done}/${p.total}</span>`;
    return           `<span class="hist-doc-badge hist-doc--missing">${flag} ${DOC_MARKET_SHORT[m]} 0/${p.total}</span>`;
  }).join('');
}

function getDocProgressMissing(docProgress) {
  if (!docProgress) return 0;
  return Object.values(docProgress).reduce((acc, p) => acc + (p.total - p.done), 0);
}

function renderHistory() {
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const el = document.getElementById('history-list');
  if (!hist.length) {
    el.innerHTML = `
      <p class="empty-state">No hay expedientes generados aún.</p>
      <div style="text-align:center;margin-top:8px">
        <button class="btn-seed-demo" onclick="seedDemoHistory()">Cargar historial demo</button>
      </div>`;
    return;
  }
  el.innerHTML = hist.map((h, i) => {
    const hasPreviews = h.previews && Object.keys(h.previews).length > 0;
    const sc = STATUS_CFG[h.status || 'borrador'];
    const hasFormData = !!h.formData && !!(h.mercados || []).length;
    const hasCloud = !!h.expId;
    const cloudBadge = hasCloud
      ? `<span style="font-size:11px;color:#185FA5;font-weight:600;margin-left:6px" title="Guardado en la nube">☁</span>`
      : '';
    const docBadges = buildDocProgressBadges(h.docProgress);
    return `
    <div class="history-item">
      <div class="history-item-top">
        <div>
          <div class="history-name">${escapeHtml(h.nombre)}${cloudBadge}</div>
          <div class="history-meta">${escapeHtml(h.categoria || '')} · ${h.fecha}</div>
          <div class="history-markets">${(h.mercados || FIXED_MARKETS).map(k => (MARKETS[k]?.flag || '') + ' ' + (MARKETS[k]?.nombre || k)).join(' · ')}</div>
          ${docBadges ? `<div class="hist-doc-badges">${docBadges}</div>` : ''}
        </div>
        <span class="history-status-badge ${sc.cls}">${sc.label}</span>
      </div>
      <div class="history-item-actions">
        ${hasPreviews ? `<button class="btn-hist-action btn-hist-view" onclick="openHistoryItem(${i})">Ver expediente</button>` : ''}
        ${hasFormData ? `<button class="btn-hist-action btn-hist-template btn-hist-regen" onclick="regenerateExpediente(${i})" title="Regenerar Word con IA">☁ Regenerar</button>` : ''}
        ${hasFormData ? `<button class="btn-hist-action btn-hist-template" onclick="loadAsTemplate(${i})">Usar como base</button>` : ''}
        <button class="btn-delete-history" onclick="deleteHistoryItem(${i})" title="Eliminar">✕</button>
      </div>
    </div>`;
  }).join('');
}

function openHistoryItem(index) {
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const h = hist[index];
  if (!h?.previews || !Object.keys(h.previews).length) return;
  closeHistory();
  currentHistoryIndex = index;
  generatedDocs = {};
  (h.mercados || FIXED_MARKETS).forEach(k => {
    if (h.previews[k]) generatedDocs[k] = { html: h.previews[k], blob: null };
  });
  document.getElementById('form-section').classList.add('hidden');
  renderResults({ nombre: h.nombre });
}

function deleteHistoryItem(index) {
  if (getActiveRole() === 'viewer') return;
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const expId = hist[index]?.expId;
  hist.splice(index, 1);
  localStorage.setItem(HIST_KEY, JSON.stringify(hist));
  if (currentHistoryIndex === index) currentHistoryIndex = null;
  else if (currentHistoryIndex > index) currentHistoryIndex--;
  renderHistory();
  if (expId && db) db.collection('expedientes').doc(expId).delete().catch(() => {});
}

function seedDemoHistory() {
  const demos = [
    { nombre: 'Battle Cat 3D Container', categoria: 'Contenedor de alimentos', mercados: ['Internacional', 'LATAM', 'Mexico', 'CAM'], fecha: new Date(Date.now() - 86400000 * 3).toISOString().split('T')[0], ts: Date.now() - 86400000 * 3, status: 'en_revision', nota: 'Pendiente validar migración ABS con proveedor.' },
    { nombre: 'Happy Meal Tray Set', categoria: 'Set de utensilios', mercados: FIXED_MARKETS, fecha: new Date(Date.now() - 86400000 * 13).toISOString().split('T')[0], ts: Date.now() - 86400000 * 13, status: 'aprobado', nota: '' },
    { nombre: 'Dino Bowl Kids', categoria: 'Plato / Bowl', mercados: ['Internacional', 'LATAM', 'Mexico', 'CAM'], fecha: new Date(Date.now() - 86400000 * 17).toISOString().split('T')[0], ts: Date.now() - 86400000 * 17, status: 'borrador', nota: 'Falta confirmar edad mínima con equipo de diseño.' },
    { nombre: 'Thermo Cup Pro 500ml', categoria: 'Vaso / Taza', mercados: FIXED_MARKETS, fecha: new Date(Date.now() - 86400000 * 35).toISOString().split('T')[0], ts: Date.now() - 86400000 * 35, status: 'aprobado', nota: '' },
    { nombre: 'Kids Lunchbox Adventure', categoria: 'Contenedor de alimentos', mercados: ['Internacional', 'LATAM', 'Mexico', 'CAM'], fecha: new Date(Date.now() - 86400000 * 56).toISOString().split('T')[0], ts: Date.now() - 86400000 * 56, status: 'borrador', nota: '' },
  ];
  localStorage.setItem(HIST_KEY, JSON.stringify(demos));
  renderHistory();
}

function loadAsTemplate(index) {
  if (getActiveRole() === 'viewer') return;
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const h = hist[index];
  if (!h?.formData) return;
  const fd = h.formData;
  closeHistory();
  // Fill Tab 1
  const setVal = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
  setVal('f-nombre', fd.nombre);
  setVal('f-categoria', fd.categoria);
  setVal('f-descripcion', fd.descripcion);
  // Fill Tab 3
  setVal('f-edad', fd.edad);
  setVal('f-capacidad', fd.capacidad);
  if (fd.caracteristicas) {
    fd.caracteristicas.forEach(id => {
      const cb = document.getElementById(`char-${id}`);
      if (cb && !cb.checked) { cb.checked = true; cb.closest('.char-option').classList.add('selected'); }
    });
  }
  // Fill Tab 4
  setVal('f-empresa', fd.empresa);
  setVal('f-responsable', fd.responsable);
  setVal('f-cargo', fd.cargo);
  setVal('f-contacto', fd.contacto);
  setVal('f-canal', fd.canal);
  setVal('f-publico', fd.publico);
  setVal('f-referencia', fd.referencia);
  setVal('f-version', fd.version);
  // Fill Tab 2 components
  if (fd.componentes && fd.componentes.length) {
    components = fd.componentes.map(c => ({ ...c }));
    renderComponents();
  }
  currentHistoryIndex = null;
  goToTab(1, true);
  // Show brief toast
  showToast('Datos cargados — ajusta lo que necesites y genera el nuevo expediente.');
}

function changeStatus(index, newStatus) {
  if (getActiveRole() === 'viewer') return;
  if (index === null || index === undefined) return;
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  if (!hist[index]) return;
  if (newStatus === 'aprobado') {
    const missing = getDocProgressMissing(hist[index].docProgress);
    if (missing > 0) {
      const ok = confirm(`Faltan ${missing} documento${missing > 1 ? 's' : ''} requerido${missing > 1 ? 's' : ''} en la Ruta de Compliance.\n\n¿Marcar como Aprobado de todas formas?`);
      if (!ok) return;
    }
  }
  hist[index].status = newStatus;
  localStorage.setItem(HIST_KEY, JSON.stringify(hist));
  if (db && hist[index].expId) {
    db.collection('expedientes').doc(hist[index].expId).update({ status: newStatus }).catch(() => {});
  }
  renderHistory();
  if (activeResultTab) showResultTab(activeResultTab);
}

function saveNoteToHistory(index, text) {
  if (index === null || index === undefined) return;
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  if (!hist[index]) return;
  hist[index].nota = text;
  try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch (e) {}
  if (db && hist[index].expId) {
    db.collection('expedientes').doc(hist[index].expId).update({ nota: text }).catch(() => {});
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg) {
  let t = document.getElementById('app-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'app-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('visible');
  setTimeout(() => t.classList.remove('visible'), 3500);
}

function openHistory() {
  document.getElementById('history-overlay').classList.remove('hidden');
  document.getElementById('history-drawer').classList.add('open');
  mergeCloudHistory().catch(() => {});
}

function closeHistory() {
  document.getElementById('history-overlay').classList.add('hidden');
  document.getElementById('history-drawer').classList.remove('open');
}

// ── Reset Form ────────────────────────────────────────────────────────────────
function resetForm() {
  // ── Tab 1 ──
  ['f-nombre','f-descripcion'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const cat = document.getElementById('f-categoria'); if (cat) cat.value = '';
  document.getElementById('pdf-status').innerHTML = '';
  document.getElementById('upload-area').className = 'upload-area';

  // ── Tab 2 ──
  document.getElementById('components-body').innerHTML = '';
  components = [];
  addComponentRow();
  document.getElementById('ps-status').innerHTML = '';
  document.getElementById('ps-upload-area').className = 'ps-upload-area';
  const psInput = document.getElementById('f-ps'); if (psInput) psInput.value = '';
  const pdfInput = document.getElementById('f-pdf'); if (pdfInput) pdfInput.value = '';

  // ── Tab 3 ──
  document.querySelectorAll('.char-option input').forEach(cb => { cb.checked = false; cb.closest('.char-option').classList.remove('selected'); });
  ['f-edad','f-capacidad'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const banner = document.getElementById('toy-analysis-banner');
  if (banner) banner.className = 'toy-banner hidden';
  const toyBtn = document.getElementById('btn-analyze-toy');
  if (toyBtn) toyBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> Analizar si aplica normativa de juguete';

  // ── Tab 4 ──
  ['f-empresa','f-responsable','f-cargo','f-contacto','f-canal','f-publico','f-referencia'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const ver = document.getElementById('f-version'); if (ver) ver.value = '1.0';

  // ── Label panel ──
  labelPdfText = '';
  labelFile = null;
  labelFileReady = false;
  labelChecklistDraft = {};
  const fn = document.getElementById('label-file-name'); if (fn) { fn.textContent = ''; fn.classList.add('hidden'); }
  const ls = document.getElementById('label-status'); if (ls) { ls.classList.add('hidden'); ls.textContent = ''; }
  const lr = document.getElementById('label-results'); if (lr) { lr.classList.add('hidden'); lr.innerHTML = ''; }
  const lcs = document.getElementById('label-country-select'); if (lcs) lcs.value = '';
  updateLabelRunButton();

  // ── State ──
  generatedDocs = {};
  currentHistoryIndex = null;
  document.getElementById('results-section').classList.add('hidden');
  document.getElementById('form-section').classList.remove('hidden');
  goToTab(1, true);
}

// ── Label Check Panel ─────────────────────────────────────────────────────────
let labelPdfText = '';
let labelChecklistDraft = {};

function renderLabelCtxBox() {
  const box = document.getElementById('label-ctx-box');
  if (!box) return;
  const ctx = buildLabelContext();

  if (!ctx.nombre) {
    box.innerHTML = `<div class="label-ctx-warn">
      ⚠ El formulario del producto no está llenado. Llena las 4 tabs primero para que el sistema sepa qué advertencias aplican a este producto.
      <br><span style="font-size:11px;opacity:.8">Sin datos del formulario se mostrarán <strong>todos</strong> los requisitos posibles.</span>
    </div>`;
    return;
  }

  const flags = [];
  if (ctx.hasFood)          flags.push('🍽 Contacto alimentos');
  if (ctx.hasChildren)      flags.push('👶 Para niños');
  if (ctx.hasToy)           flags.push('🧸 Juguete');
  if (ctx.hasElec)          flags.push('⚡ Electrónico');
  if (ctx.hasBattery)       flags.push('🔋 Batería');
  if (ctx.hasButtonBattery) flags.push('🔘 Batería botón');
  if (ctx.hasSteam)         flags.push('♨ Vapor');
  if (ctx.hasNoise)         flags.push('🔊 Ruido');
  if (ctx.hasStrings)       flags.push('〰 Cuerdas');
  if (ctx.hasMagnets)       flags.push('🧲 Imanes');
  if (ctx.hasMelamine)      flags.push('🍶 Melamina');
  if (ctx.hasPVC)           flags.push('🧪 PVC');
  if (ctx.hasGlass)         flags.push('🪟 Vidrio');
  if (ctx.hasWood)          flags.push('🪵 Madera/Bambú');

  const flagsHtml = flags.length
    ? flags.map(f => `<span class="label-ctx-tag">${f}</span>`).join('')
    : '<span class="label-ctx-tag label-ctx-tag--none">Sin características especiales</span>';

  box.innerHTML = `<div class="label-ctx-ok">
    <div class="label-ctx-product">📦 <strong>${ctx.nombre}</strong>${ctx.categoria ? ` · ${ctx.categoria}` : ''}</div>
    <div class="label-ctx-flags">${flagsHtml}</div>
    <div class="label-ctx-note">Solo se verificarán los requisitos aplicables a este producto.</div>
  </div>`;
}

let labelCheckSetup = false;
function setupLabelCheck() {
  if (labelCheckSetup) return;
  labelCheckSetup = true;
  const zone = document.getElementById('label-upload-zone');
  const input = document.getElementById('label-file-input');
  if (!zone || !input) return;
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragover'); const f = e.dataTransfer.files[0]; if (f) handleLabelFile(f); });
  input.addEventListener('change', e => { if (e.target.files[0]) handleLabelFile(e.target.files[0]); });
}

let labelFileReady = false;
let labelFile = null; // PDF File object when using native PDF; null for images
let _labelToken = 0;  // increments on each new file drop to cancel stale async ops

function updateLabelRunButton() {
  const sel = document.getElementById('label-country-select')?.value;
  document.getElementById('btn-run-label').disabled = !(labelFileReady && sel);
}

async function handleLabelFile(file) {
  const myToken = ++_labelToken;
  const nameEl = document.getElementById('label-file-name');
  const status = document.getElementById('label-status');
  const isImage = file.type.startsWith('image/');
  nameEl.textContent = (isImage ? '🖼 ' : '📄 ') + file.name;
  nameEl.classList.remove('hidden');
  status.classList.remove('hidden');
  labelFileReady = false;
  labelFile = null;
  labelPdfText = '';
  updateLabelRunButton();
  try {
    if (isImage) {
      status.textContent = '⏳ Leyendo imagen con IA (visión)...';
      const extracted = await extractTextFromImageLabel(file);
      if (myToken !== _labelToken) return; // another file was dropped — discard
      labelPdfText = extracted;
      if (!labelPdfText || labelPdfText.trim().length < 30) {
        status.textContent = '⚠ Poco texto extraído. El análisis usará lo disponible.';
      } else {
        status.textContent = `✓ ${labelPdfText.length} caracteres extraídos (vía visión IA). Selecciona el país o región para continuar.`;
      }
    } else {
      // Native PDF — Claude reads it directly, no text extraction needed
      labelFile = file;
      status.textContent = `✓ PDF listo (${(file.size / 1024).toFixed(0)} KB). Selecciona el país o región para continuar.`;
    }
    if (myToken !== _labelToken) return; // stale check before committing ready state
    labelFileReady = true;
    updateLabelRunButton();
  } catch(e) {
    if (myToken !== _labelToken) return;
    status.textContent = '⚠ Error al leer el archivo: ' + e.message;
  }
}

async function extractTextFromImageLabel(file) {
  return callClaudeVision(file, `Extract ALL text visible in this product label or packaging image.
Include every word, number, warning text, batch code, address, URL, and legal notice.

Also detect and note any compliance symbols or marks visible as graphics (even if no text):
- CE mark → add line "[CE MARK VISIBLE]"
- WEEE crossed-out bin symbol → add "[WEEE SYMBOL VISIBLE]"
- Fork + glass (food contact / FCM) symbol → add "[FCM SYMBOL VISIBLE]"
- INMETRO seal → add "[INMETRO SEAL VISIBLE]"
- Barcode/QR code → include the number if readable
- Recycling triangle symbol → add "[RECYCLING SYMBOL VISIBLE]"
- Any other certification seal or logo → add "[SEAL: description]"

Return only the extracted text and symbol notes, preserving layout structure. No explanations.`);
}

async function runLabelAnalysis() {
  const btn = document.getElementById('btn-run-label');
  const status = document.getElementById('label-status');
  const results = document.getElementById('label-results');

  if (!labelFile && !labelPdfText.trim()) {
    status.textContent = '⚠ No hay archivo cargado. Sube una imagen o PDF de la etiqueta primero.';
    status.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  results.classList.add('hidden');
  results.innerHTML = '';

  const ctx = buildLabelContext();
  const selection = document.getElementById('label-country-select')?.value || '';

  // Resolve which groups/countries to analyze from the selection
  let groupsToAnalyze = []; // [{ groupKey, groupCfg, countries }]
  if (selection.startsWith('group:')) {
    const groupKey = selection.slice(6);
    const groupCfg = LABEL_GROUPS[groupKey];
    if (groupCfg) groupsToAnalyze = [{ groupKey, groupCfg, countries: groupCfg.countries }];
  } else {
    // Single country — find which group it belongs to
    for (const [gk, gc] of Object.entries(LABEL_GROUPS)) {
      if (gc.countries.includes(selection)) {
        groupsToAnalyze = [{ groupKey: gk, groupCfg: gc, countries: [selection] }];
        break;
      }
    }
  }

  if (!groupsToAnalyze.length) {
    status.textContent = '⚠ Selecciona un país o región válido.';
    btn.disabled = false;
    return;
  }

  const label = groupsToAnalyze.length === 1 && groupsToAnalyze[0].countries.length === 1
    ? (LABEL_REQUIREMENTS[selection]?.nombre || selection)
    : groupsToAnalyze[0].groupCfg.label;
  status.textContent = `⏳ Analizando ${label}...`;

  const allResults = {};
  const groupPromises = groupsToAnalyze.map(({ groupKey, groupCfg, countries }) =>
    callClaudeForLabelGroup(labelFile || labelPdfText, groupKey, countries, ctx)
      .catch(() => {
        const fallback = {};
        countries.forEach(c => { fallback[c] = []; });
        return fallback;
      })
  );
  const groupResults = await Promise.all(groupPromises);
  groupResults.forEach(res => Object.assign(allResults, res));

  status.textContent = '✓ Análisis completado.';
  btn.disabled = false;
  renderLabelResults(allResults, ctx, groupsToAnalyze);
  results.classList.remove('hidden');
}

function buildLabelContext() {
  const nombre    = document.getElementById('f-nombre')?.value || '';
  const categoria = document.getElementById('f-categoria')?.value || '';
  const chars     = getCharacteristics();
  syncComponents();
  const comps     = components;
  const hasChar   = id => chars.includes(id);
  const hasMat    = kw => comps.some(c => c.material?.toLowerCase().includes(kw.toLowerCase()));
  return {
    nombre, categoria, chars, comps,
    hasFood:          comps.some(c => c.contacto_alimento === 'Directo'),
    hasChildren:      hasChar('ninos') || hasChar('juguete'),
    hasToy:           hasChar('juguete'),
    hasElec:          ['electronico','bateria','bateria_boton','led','vapor'].some(hasChar),
    hasBattery:       hasChar('bateria') || hasChar('bateria_boton') || hasChar('electronico'),
    hasButtonBattery: hasChar('bateria_boton'),
    hasSteam:         hasChar('vapor'),
    hasLed:           hasChar('led'),
    hasLiquids:       hasChar('liquidos'),
    hasMagnets:       hasChar('imanes'),
    hasNoise:         hasChar('ruido'),
    hasStrings:       hasChar('cuerdas'),
    hasMelamine:      hasMat('melamina') || hasMat('melamine'),
    hasPVC:           hasMat('pvc'),
    hasGlass:         hasMat('vidrio') || hasMat('glass'),
    hasWood:          hasMat('madera') || hasMat('bambú') || hasMat('bambu') || hasMat('wood'),
  };
}

function isReqApplicable(r, ctx) {
  const all = !ctx.nombre; // no product context → show everything
  switch (r.cond) {
    case 'always':         return true;
    case 'food':           return ctx.hasFood || all;
    case 'children':       return ctx.hasChildren || all;
    case 'toy':            return ctx.hasToy || all;
    case 'elec':           return ctx.hasElec || all;
    case 'battery':        return ctx.hasBattery || all;
    case 'button_battery': return ctx.hasButtonBattery || all;
    case 'steam':          return ctx.hasSteam || all;
    case 'led':            return ctx.hasLed || all;
    case 'liquids':        return ctx.hasLiquids || all;
    case 'magnets':        return ctx.hasMagnets || all;
    case 'noise':          return ctx.hasNoise || all;
    case 'strings':        return ctx.hasStrings || all;
    case 'melamine':       return ctx.hasMelamine || all;
    case 'pvc':            return ctx.hasPVC || all;
    case 'glass':          return ctx.hasGlass || all;
    case 'wood':           return ctx.hasWood || all;
    default:               return true;
  }
}

// Search hints per requirement ID: what text/pattern to look for in extracted text
const LABEL_SEARCH_HINTS = {
  ce_mark:        { hint:'Look for "CE" mark text or "CE marking" or "Conformité Européenne". May be a graphic only.', visual:true },
  fcm_symbol:     { hint:'Look for "FCM", "food contact material", tenedor+vaso symbol text, "apto para contacto con alimentos", "food safe", "suitable for food contact".', visual:true },
  country_origin: { hint:'Look for "Made in", "Fabricado en", "Fabricado em", "Country of origin", "Origen:", "Hecho en", "Fabriqué en", "País de origen".', visual:false },
  manufacturer:   { hint:'Look for company name, address, "Fabricante:", "Manufacturer:", "Importador:", "Importer:", "Distributed by", street/city/country info.', visual:false },
  batch:          { hint:'Look for "Lot", "Lote", "Batch", "REF", "Ref.", item number, catalog number, date code.', visual:false },
  age_warning:    { hint:'Look for age numbers like "3+", "3 años", "Ages 3+", "Not suitable for children under", "No apto para menores de", "Para mayores de", "Edad mínima".', visual:false },
  choking:        { hint:'Look for "CHOKING HAZARD", "Peligro de asfixia", "Riesgo de asfixia", "Small parts", "Piezas pequeñas", "Not for children under 3".', visual:false },
  weee:           { hint:'Look for "WEEE", recycling symbol text, "Do not dispose as household waste", "Recycle electronics", crossed-out bin symbol mention.', visual:true },
  suffocation:    { hint:'Look for "Suffocation warning", "Keep away from children", "Advertencia de asfixia", "Peligro de asfixia bolsa plástica", "WARNING: To avoid danger of suffocation".', visual:false },
  language:       { hint:'Check if warnings and instructions appear in the required language (English/Spanish/Portuguese). Look for full text blocks in that language.', visual:false },
  cpsia_tracking: { hint:'Look for tracking label info: manufacturer name, location, date of manufacture, model/item number. Usually printed on product AND packaging.', visual:false },
  prop65:         { hint:'Look for "WARNING:", "California Prop 65", "This product contains chemicals known to the State of California", "ADVERTENCIA:", Prop 65 text.', visual:false },
  fda_food:       { hint:'Look for "FDA", "food grade", "BPA free", "food safe", "21 CFR", "FDA compliant", "food contact compliant".', visual:false },
  barcode:        { hint:'Look for UPC/EAN number digits (12-13 digits), "UPC", "EAN", barcode number printed near symbol.', visual:true },
  inmetro:        { hint:'Look for "INMETRO", "Certificado INMETRO", "Portaria INMETRO", registration/certificate number, "Certificação INMETRO".', visual:true },
  anvisa:         { hint:'Look for "ANVISA", "Registro ANVISA", ANVISA registration number (CVS or equivalent), "RDC ANVISA".', visual:false },
  importer:       { hint:'Look for local importer name, address, tax ID (CNPJ, NIT, CUIT, RUC), "Importado por", "Importado por:", "Importador:", company + country.', visual:false },
  invima:         { hint:'Look for "INVIMA", INVIMA registration number, "Registro INVIMA", "NSA", Colombian health authority reference.', visual:false },
  icontec:        { hint:'Look for "ICONTEC", NTC certification, "Certificado ICONTEC", "NTC 4894".', visual:true },
  anmat:          { hint:'Look for "ANMAT", "Disp. ANMAT", ANMAT authorization number, Argentine food authority reference.', visual:false },
  iram:           { hint:'Look for "IRAM", "IRAM-ISO", IRAM certification number.', visual:true },
  digesa:         { hint:'Look for "DIGESA", "Registro Sanitario", DIGESA registration number, Peruvian health authority reference.', visual:false },
  rtca_toys:        { hint:'Look for "RTCA", "RTCA 71.03.47", safety declaration text for toys, Central American technical regulation reference.', visual:false },
  battery_disposal: { hint:'Look for battery recycling text: "RBRC", "Call2Recycle", "do not dispose in household waste", "no tirar pilas a la basura", "Pilas: depositar en punto limpio", "CONAMA", disposal/collection point instruction, battery recycling symbol text.', visual:true },
  button_battery_warn: { hint:'Look for button battery/coin cell warning: "KEEP AWAY FROM CHILDREN", "coin cell", "button cell", "pila botón", "CR2032", "danger of swallowing", "ingestion", "batterie bouton", choking/ingestion hazard text specific to button batteries.', visual:false },
  fcc_id:           { hint:'Look for "FCC ID" followed by alphanumeric code (e.g. "FCC ID: XXXXXX"), FCC identifier on product or packaging.', visual:false },
  rohs_compliance:  { hint:'Look for "RoHS", "RoHS compliant", "RoHS2", "conforme RoHS", "free of hazardous substances", "restriction of hazardous substances", RoHS declaration.', visual:false },
  melamine_temp_limit: { hint:'Look for temperature limit text: "max 70°C", "max 120°C", "NOT microwave safe", "no apto para microondas", "no calentar", "no lavavajillas", "microwave safe", temperature restriction for melamine use.', visual:false },
  reach_pvc:        { hint:'Look for "REACH", "phthalate free", "sin ftalatos", "SVHC", "no contiene ftalatos", "free of restricted substances", "no phthalates", plasticizer-free declaration.', visual:false },
  steam_warning:    { hint:'Look for steam/burn warning: "hot steam", "vapor caliente", "riesgo de quemaduras", "CAUTION: HOT STEAM", "burn hazard", "keep away from children" near steam reference, steam injury warning text.', visual:false },
  noise_warning:    { hint:'Look for noise/hearing damage warning: "dB", ">80 dB", "hearing damage", "daño auditivo", "protección auditiva", "loud noise", "hearing loss", "protect hearing", decibel warning.', visual:false },
  string_warning:   { hint:'Look for strangulation/cord warning: "cord", "cuerda", "strangulation", "estrangulamiento", "cuerdas largas", cord/string length warning, "STRANGULATION HAZARD", "keep cords away".', visual:false },
  magnet_warning:   { hint:'Look for magnet/medical device warning: "pacemaker", "marcapasos", "implant", "implante magnético", "keep magnets away", "magnetic field", "dispositivos médicos", magnet safety warning.', visual:false },
};

async function callClaudeForLabelGroup(pdfInput, groupKey, countries, ctx) {
  const isPdfFile = pdfInput instanceof File;
  const reqsPerCountry = countries.map(c => {
    const cfg = LABEL_REQUIREMENTS[c];
    if (!cfg) return null;
    const applicable = cfg.reqs.filter(r => isReqApplicable(r, ctx));
    return { country: c, flag: cfg.flag, nombre: cfg.nombre, reqs: applicable };
  }).filter(Boolean);

  const reqLines = reqsPerCountry.map(c =>
    `${c.country}:\n` + c.reqs.map(r => {
      const h = LABEL_SEARCH_HINTS[r.id] || {};
      const visualNote = h.visual ? ' [VISUAL SYMBOL — check visually, not just text]' : '';
      return `  - id:"${r.id}" | ${r.label}${visualNote}\n    Look for: ${h.hint || r.label}`;
    }).join('\n')
  ).join('\n\n');

  const productNote = `PRODUCT: ${ctx.nombre ? `${ctx.nombre} | ${ctx.categoria}` : '(infer from document)'}${ctx.hasFood ? '\nNOTE: Product has direct food contact — food-contact markings are required.' : ''}${ctx.hasChildren ? '\nNOTE: Product is intended for children — children\'s safety warnings are required.' : ''}`;

  const jsonSchema = `{ ${reqsPerCountry.map(c => `"${c.country}": [${c.reqs.map(r => `{"id":"${r.id}","status":"present|missing|unclear|na","evidence":"exact quote or description of where found, or empty string"}`).join(',')}]`).join(', ')} }`;

  let prompt;
  if (isPdfFile) {
    prompt = `You are a product compliance labeling expert. Analyze the attached product label/packaging PDF directly — you can read all text AND see all visual elements (symbols, marks, seals, barcodes).

${productNote}

REQUIREMENTS TO CHECK:
${reqLines}

RULES:
1. "present" → requirement is satisfied. Be GENEROUS: mark "present" if the content or meaning is clearly there even if wording differs. You can see the full PDF including graphics.
2. "unclear" → ambiguous or partially satisfied.
3. "missing" → completely absent after thorough review of all pages and visual elements.
4. "na" → genuinely not applicable for this product type.
5. For VISUAL SYMBOL items (CE, WEEE, FCM, barcodes, seals): look for them visually in the PDF, not just as text.

Return ONLY valid JSON (no markdown):
${jsonSchema}`;
  } else {
    const excerpt = (pdfInput || '').slice(0, 24000);
    const textLength = (pdfInput || '').length;
    prompt = `You are a product compliance labeling expert. Verify which required markings appear in this extracted label/packaging text.

${productNote}

EXTRACTED TEXT FROM LABEL/PACKAGING (${textLength} chars):
---
${excerpt || '(no text — image may have been processed separately)'}
---

REQUIREMENTS TO CHECK:
${reqLines}

RULES:
1. "present" → satisfied. Be GENEROUS with wording variations.
2. "unclear" → could be present as a visual/graphic element not captured in text (CE, WEEE, FCM, barcode, seals), or text is ambiguous. DEFAULT to "unclear" for visual symbols.
3. "missing" → ONLY when certain the text-based element is completely absent.
4. "na" → not applicable for this product type.
5. When in doubt between "missing" and "unclear", choose "unclear".

Return ONLY valid JSON (no markdown):
${jsonSchema}`;
  }

  const isEnGroup = groupKey === 'Internacional';
  const labelSystemMsg = isEnGroup
    ? 'You are a product labeling and compliance expert. Respond ONLY with valid JSON. The "evidence" field must contain an exact quote from the document or a brief description of where the element was found. No markdown, no extra text.'
    : 'Eres un experto en etiquetado y cumplimiento de productos. Responde ÚNICAMENTE con JSON válido. El campo "evidence" debe contener la cita textual del documento o una descripción breve. Sin markdown, sin texto extra.';

  try {
    const raw = isPdfFile
      ? await callClaudeWithDoc(pdfInput, prompt, { system: labelSystemMsg, model: 'claude-sonnet-4-6', maxTokens: 2000 })
      : await callClaude(prompt, { system: labelSystemMsg, model: 'claude-sonnet-4-6', maxTokens: 2000 });
    let clean = raw;
    if (clean.includes('```')) { const p = clean.split('```'); clean = p[1] || p[0]; if (clean.startsWith('json')) clean = clean.slice(4); }
    return JSON.parse(clean.trim());
  } catch(e) {
    const fallback = {};
    reqsPerCountry.forEach(c => { fallback[c.country] = c.reqs.map(r => ({ id: r.id, status: 'unclear', evidence: 'Error en análisis' })); });
    return fallback;
  }
}

function renderLabelResults(allResults, ctx, groupsToAnalyze) {
  const container = document.getElementById('label-results');

  const toggleBtns = (countryKey, reqId, currentStatus) => {
    const opts = [
      { s: 'present', icon: '✅', label: 'Presente' },
      { s: 'missing', icon: '❌', label: 'Ausente' },
      { s: 'unclear', icon: '⚠',  label: 'No evaluable' },
      { s: 'na',      icon: '—',  label: 'N/A' },
    ];
    return `<div class="lc-toggle-group">${opts.map(o =>
      `<button class="lc-toggle-btn${o.s === currentStatus ? ' active lc-toggle-'+o.s : ''}" data-status="${o.s}"
        onclick="toggleLabelItem('${countryKey}','${reqId}','${o.s}')" title="${o.label}">${o.icon}</button>`
    ).join('')}</div>`;
  };

  const groupFilter = groupsToAnalyze || Object.entries(LABEL_GROUPS).map(([k,v]) => ({ groupKey:k, groupCfg:v, countries:v.countries }));

  // Populate draft with AI results
  labelChecklistDraft = {};
  let html = '';

  for (const { groupKey, groupCfg, countries } of groupFilter) {
    let countryRows = '';
    let totalOk = 0, totalFail = 0, totalWarn = 0;

    for (const countryKey of countries) {
      const cfg = LABEL_REQUIREMENTS[countryKey];
      if (!cfg) continue;
      const results = Array.isArray(allResults[countryKey]) ? allResults[countryKey] : [];
      const applicable = cfg.reqs.filter(r => isReqApplicable(r, ctx));
      if (!labelChecklistDraft[countryKey]) labelChecklistDraft[countryKey] = {};

      let ok = 0, fail = 0, warn = 0;
      const rows = applicable.map(req => {
        const res = results.find(r => r.id === req.id) || { status: 'unclear', evidence: '' };
        labelChecklistDraft[countryKey][req.id] = { status: res.status, note: res.evidence || '' };
        if (res.status === 'present') ok++;
        else if (res.status === 'missing') fail++;
        else if (res.status === 'unclear') warn++;
        totalOk += res.status === 'present' ? 1 : 0;
        totalFail += res.status === 'missing' ? 1 : 0;
        totalWarn += res.status === 'unclear' ? 1 : 0;
        return `<tr data-lc-row="${countryKey}:${req.id}">
          <td>${req.label}</td>
          <td class="lc-ref">${req.ref}</td>
          <td>${toggleBtns(countryKey, req.id, res.status)}</td>
          <td><input class="lc-note-input" value="${escapeHtml(res.evidence || '')}" placeholder="Evidencia / nota"
            oninput="updateLabelNote('${countryKey}','${req.id}',this.value)"></td>
        </tr>`;
      }).join('');

      countryRows += `<div class="lc-country">
        <div class="lc-country-header">
          <span>${cfg.flag} ${cfg.nombre}</span>
          <div class="lc-country-stats">
            ${ok   ? `<span class="lc-stat lc-stat-ok">${ok} ✅</span>` : ''}
            ${fail ? `<span class="lc-stat lc-stat-fail">${fail} ❌</span>` : ''}
            ${warn ? `<span class="lc-stat lc-stat-warn">${warn} ⚠</span>` : ''}
          </div>
        </div>
        <table class="lc-table">
          <thead><tr><th style="width:30%">Requisito</th><th style="width:20%">Referencia</th><th style="width:17%">Estado</th><th>Evidencia / nota</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }

    html += `<div class="lc-group">
      <div class="lc-group-header" onclick="this.closest('.lc-group').classList.toggle('collapsed')">
        <span>${groupCfg.label}</span>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="lc-summary">${totalOk} presentes · ${totalFail} ausentes · ${totalWarn} no evaluables</span>
          <svg class="lc-group-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="lc-group-body">${countryRows}</div>
    </div>`;
  }

  const saveBtnHtml = `<div class="lc-checklist-bar">
    <span class="lc-checklist-hint">💡 Ajusta los estados manualmente y guarda</span>
    <button id="btn-save-label-checklist" class="btn-save-lc" onclick="saveLabelChecklist()">☁ Guardar checklist</button>
  </div>`;

  container.innerHTML = saveBtnHtml + html;
}

// ── Label checklist persistence ───────────────────────────────────────────────

function toggleLabelItem(countryKey, reqId, newStatus) {
  if (!labelChecklistDraft[countryKey]) labelChecklistDraft[countryKey] = {};
  if (!labelChecklistDraft[countryKey][reqId]) labelChecklistDraft[countryKey][reqId] = {};
  labelChecklistDraft[countryKey][reqId].status = newStatus;
  const row = document.querySelector(`[data-lc-row="${countryKey}:${reqId}"]`);
  if (!row) return;
  row.querySelectorAll('.lc-toggle-btn').forEach(btn => {
    const s = btn.dataset.status;
    btn.className = `lc-toggle-btn${s === newStatus ? ' active lc-toggle-' + s : ''}`;
  });
}

function updateLabelNote(countryKey, reqId, note) {
  if (!labelChecklistDraft[countryKey]) labelChecklistDraft[countryKey] = {};
  if (!labelChecklistDraft[countryKey][reqId]) labelChecklistDraft[countryKey][reqId] = { status: 'unclear' };
  labelChecklistDraft[countryKey][reqId].note = note;
}

async function saveLabelChecklist() {
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const expId = currentHistoryIndex !== null ? hist[currentHistoryIndex]?.expId : null;
  if (!expId || !db) {
    showToast('Sin expediente activo en la nube — genera el expediente primero');
    return;
  }
  const btn = document.getElementById('btn-save-label-checklist');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Guardando...'; }
  try {
    for (const [countryKey, items] of Object.entries(labelChecklistDraft)) {
      await db.collection('expedientes').doc(expId).collection('etiquetado').doc(countryKey).set({
        countryKey, ts: Date.now(), source: 'ai', items,
      });
    }
    showToast('☁ Checklist guardado');
    renderLabelChecklistPanel(expId);
  } catch (e) {
    showToast('Error al guardar: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '☁ Guardar checklist'; }
  }
}

async function loadLabelChecklists(expId) {
  if (!db || !expId) return {};
  try {
    const snap = await db.collection('expedientes').doc(expId).collection('etiquetado').get();
    const result = {};
    snap.docs.forEach(d => { result[d.id] = d.data(); });
    return result;
  } catch (e) { return {}; }
}

async function renderLabelChecklistPanel(expId) {
  const panel = document.getElementById('label-checklist-panel');
  if (!panel) return;
  panel.innerHTML = '';
  const checklists = await loadLabelChecklists(expId);
  if (!Object.keys(checklists).length) return;

  const rows = Object.entries(checklists).map(([countryKey, data]) => {
    const cfg = LABEL_REQUIREMENTS[countryKey];
    const name = cfg ? `${cfg.flag} ${cfg.nombre}` : countryKey;
    const items = data.items || {};
    const statuses = Object.values(items);
    const ok   = statuses.filter(s => s.status === 'present').length;
    const fail = statuses.filter(s => s.status === 'missing').length;
    const warn = statuses.filter(s => s.status === 'unclear').length;
    const date = data.ts ? new Date(data.ts).toLocaleDateString('es-MX', { day:'2-digit', month:'short' }) : '';
    return `<div class="lc-saved-row" onclick="loadSavedChecklist('${countryKey}')">
      <span class="lc-saved-country">${name}</span>
      <div class="lc-saved-stats">
        ${ok   ? `<span class="lc-stat lc-stat-ok">${ok} ✅</span>` : ''}
        ${fail ? `<span class="lc-stat lc-stat-fail">${fail} ❌</span>` : ''}
        ${warn ? `<span class="lc-stat lc-stat-warn">${warn} ⚠</span>` : ''}
      </div>
      <span class="lc-saved-date">${date}</span>
    </div>`;
  }).join('');

  panel.innerHTML = `<div class="lc-saved-panel">
    <div class="lc-saved-header">Checklists guardados <span class="lc-saved-hint">— clic para cargar y editar</span></div>
    ${rows}
  </div>`;
}

async function loadSavedChecklist(countryKey) {
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const expId = currentHistoryIndex !== null ? hist[currentHistoryIndex]?.expId : null;
  if (!expId || !db) return;
  const doc = await db.collection('expedientes').doc(expId).collection('etiquetado').doc(countryKey).get().catch(() => null);
  if (!doc?.exists) return;
  const data = doc.data();
  const items = data.items || {};

  // Restore draft
  labelChecklistDraft[countryKey] = JSON.parse(JSON.stringify(items));

  // Find the LABEL_GROUP that contains this country
  let groupKey = null, groupCfg = null;
  for (const [gk, gc] of Object.entries(LABEL_GROUPS)) {
    if (gc.countries.includes(countryKey)) { groupKey = gk; groupCfg = gc; break; }
  }
  if (!groupKey) return;

  const ctx = buildLabelContext();
  const allResults = {};
  allResults[countryKey] = Object.entries(items).map(([id, v]) => ({ id, status: v.status, evidence: v.note || '' }));
  const results = document.getElementById('label-results');
  results?.classList.remove('hidden');
  renderLabelResults(allResults, ctx, [{ groupKey, groupCfg, countries: [countryKey] }]);
  // Restore draft values post-render (renderLabelResults overwrites draft)
  labelChecklistDraft[countryKey] = JSON.parse(JSON.stringify(items));
  // Re-apply toggle states
  Object.entries(items).forEach(([reqId, v]) => toggleLabelItem(countryKey, reqId, v.status));
}

// ── Compliance Documents Module — Fase 1 ─────────────────────────────────────

const DOC_MARKET_FLAGS = { UE: '🇪🇺', USA: '🇺🇸', Australia: '🇦🇺' };
const DOC_MARKET_SHORT = { UE: 'UE', USA: 'USA', Australia: 'AU' };

function getProductAttribs(formData) {
  const c = formData.caracteristicas || [];
  const edad = parseInt(formData.edad) || 0;
  return {
    has_electronics:      c.some(x => ['electronico','led','vapor'].includes(x)),
    has_battery:          c.some(x => ['bateria','bateria_boton'].includes(x)),
    has_magnets:          c.includes('imanes'),
    has_connectivity:     c.some(x => ['electronico','conectividad'].includes(x)),
    has_liquid_media:     c.includes('liquidos'),
    has_chemical_kit:     c.includes('kit_quimico'),
    has_internet:         c.includes('internet'),
    mfg_outside_eu:       true,
    target_age_under_36m: edad > 0 && edad <= 3,
  };
}

const STANDARDS_EQUIVALENCE = {
  'astm f963':    { note: 'Cubre mecánico + flamabilidad para UE, USA y Australia en un solo reporte', markets: ['UE','USA','Australia'] },
  'en 71-1':      { note: 'Equivalente a ASTM F963 (mecánico) — válido para UE; acepta para USA con datos adicionales', markets: ['UE'] },
  'en 62115':     { note: 'Equivalente a AS/NZS 62115 para Australia — un reporte puede cubrir ambos', markets: ['UE','Australia'] },
  'iec 62115':    { note: 'Base de EN 62115 y AS/NZS 62115 — puede cubrir UE, USA y Australia', markets: ['UE','USA','Australia'] },
  'iec 62133':    { note: 'Certificación de batería aceptada en UE, USA y Australia', markets: ['UE','USA','Australia'] },
  'un 38.3':      { note: 'Transporte de baterías — requerido para los tres mercados', markets: ['UE','USA','Australia'] },
};

function getStandardHint(standard) {
  if (!standard) return '';
  const key = standard.toLowerCase().replace(/[-–—]/g, '-').trim();
  for (const [pattern, info] of Object.entries(STANDARDS_EQUIVALENCE)) {
    if (key.includes(pattern)) {
      const flags = info.markets.map(m => DOC_MARKET_FLAGS[m] || m).join(' ');
      return `<span class="doc-standard-hint">💡 ${info.note} ${flags}</span>`;
    }
  }
  return '';
}

function expandDocMarkets(markets) {
  const expanded = [...markets];
  if (markets.includes('Internacional')) expanded.push('UE', 'USA', 'Australia');
  return ['UE','USA','Australia'].filter(m => expanded.includes(m));
}

function getRequiredDocs(formData, markets) {
  const attribs = getProductAttribs(formData);
  const activeDocMarkets = expandDocMarkets(markets);
  if (!activeDocMarkets.length) return [];
  return DOCS_MASTER.filter(doc => {
    if (!doc.markets.some(m => activeDocMarkets.includes(m))) return false;
    if (doc.req === 'required') return true;
    if (doc.req === 'conditional') return !!attribs[doc.trigger];
    return false;
  });
}

async function loadDocStatuses(expId) {
  if (!db || !expId) return {};
  try {
    const snap = await db.collection('expedientes').doc(expId).collection('documentos').get();
    const out = {};
    snap.docs.forEach(d => { out[d.id] = d.data(); });
    return out;
  } catch (e) { console.warn('Load doc statuses failed:', e.message); return {}; }
}

async function saveDocStatus(expId, code, data) {
  if (!db || !expId) return;
  await db.collection('expedientes').doc(expId).collection('documentos').doc(code).set(data, { merge: true });
}

async function uploadDocumento(expId, code, file, meta = {}) {
  const session = getSession();
  if (!session) throw new Error('Sin sesión activa');
  let fileToUpload = file;
  if (file.type === 'application/pdf' && file.size > PDF_COMPRESS_THRESHOLD) {
    fileToUpload = await compressPdf(file, () => {});
  }
  const fileId      = generateId();
  const safeName    = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
  const path        = `${expId}/docs/${code}_${fileId}_${safeName}`;
  const contentType = file.type || 'application/octet-stream';
  const data        = await fileToBase64(fileToUpload);
  const res = await fetch('/api/upload-evidencia', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, data, contentType }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Error al subir'); }
  const { publicUrl } = await res.json();
  await saveDocStatus(expId, code, {
    code, status: 'uploaded',
    fileName: file.name, fileUrl: publicUrl, storagePath: path,
    uploadedBy: session.userId, uploadedByName: session.name, uploadedAt: Date.now(),
    issuedBy:   meta.issuedBy   || '',
    issuedDate: meta.issuedDate || '',
    expiryDate: meta.expiryDate || '',
    labName:    meta.labName    || '',
    labAcc:     meta.labAcc     || '',
    standard:   meta.standard   || '',
  });
}

function handleDocUpload(expId, code) {
  openDocUploadModal(expId, code);
}

function openDocUploadModal(expId, code) {
  const doc = DOCS_MASTER.find(d => d.code === code);
  if (!doc) return;
  const isTestReport = doc.cat === 2 || doc.cat === 5;
  document.getElementById('doc-upload-modal-title').textContent = doc.name;
  document.getElementById('doc-upload-modal-code').textContent = code;
  document.getElementById('doc-upload-modal-body').innerHTML = `
    <div class="doc-upload-form">
      <div class="doc-upload-file-area">
        <input type="file" id="doc-upload-file" accept=".pdf,image/*" style="display:none">
        <button class="btn-doc-file-select" onclick="document.getElementById('doc-upload-file').click()">📎 Seleccionar archivo</button>
        <span id="doc-upload-file-name" class="doc-upload-file-name">Ningún archivo seleccionado</span>
      </div>
      ${isTestReport ? `
      <div class="doc-upload-row">
        <div class="doc-upload-field">
          <label>Laboratorio</label>
          <input type="text" id="doc-meta-lab" placeholder="Nombre del laboratorio">
        </div>
        <div class="doc-upload-field">
          <label>N° acreditación</label>
          <input type="text" id="doc-meta-lab-acc" placeholder="CPSC ID / NB number...">
        </div>
      </div>
      <div class="doc-upload-field">
        <label>Norma de referencia</label>
        <input type="text" id="doc-meta-standard" placeholder="ASTM F963-23, EN 71-1:2014..." oninput="updateStandardHintInModal()">
        <div id="doc-standard-hint-modal" class="doc-standard-hint-modal"></div>
      </div>` : ''}
      <div class="doc-upload-field">
        <label>Emitido por</label>
        <input type="text" id="doc-meta-issued-by" placeholder="Persona u organismo que emite">
      </div>
      <div class="doc-upload-row">
        <div class="doc-upload-field">
          <label>Fecha de emisión</label>
          <input type="date" id="doc-meta-issued-date">
        </div>
        <div class="doc-upload-field">
          <label>Vencimiento <span class="optional-tag">opcional</span></label>
          <input type="date" id="doc-meta-expiry-date">
        </div>
      </div>
      <p id="doc-upload-error" class="form-error hidden"></p>
      <div class="modal-actions">
        <button id="btn-doc-upload-submit" class="btn-primary" onclick="submitDocUpload('${expId}','${code}')">Subir documento</button>
        <button class="btn-secondary" onclick="closeDocUploadModal()">Cancelar</button>
      </div>
    </div>`;
  document.getElementById('doc-upload-file').addEventListener('change', function () {
    document.getElementById('doc-upload-file-name').textContent = this.files[0]?.name || 'Ningún archivo seleccionado';
  });
  document.getElementById('modal-doc-upload').classList.remove('hidden');
}

function closeDocUploadModal() {
  document.getElementById('modal-doc-upload').classList.add('hidden');
}

function updateStandardHintInModal() {
  const val = document.getElementById('doc-meta-standard')?.value || '';
  const hintEl = document.getElementById('doc-standard-hint-modal');
  if (!hintEl) return;
  hintEl.innerHTML = getStandardHint(val);
}

async function submitDocUpload(expId, code) {
  const file = document.getElementById('doc-upload-file')?.files[0];
  const errEl = document.getElementById('doc-upload-error');
  if (!file) { errEl.textContent = 'Selecciona un archivo.'; errEl.classList.remove('hidden'); return; }
  const meta = {
    issuedBy:   (document.getElementById('doc-meta-issued-by')?.value  || '').trim(),
    issuedDate:  document.getElementById('doc-meta-issued-date')?.value  || '',
    expiryDate:  document.getElementById('doc-meta-expiry-date')?.value  || '',
    labName:    (document.getElementById('doc-meta-lab')?.value         || '').trim(),
    labAcc:     (document.getElementById('doc-meta-lab-acc')?.value     || '').trim(),
    standard:   (document.getElementById('doc-meta-standard')?.value    || '').trim(),
  };
  const btn = document.getElementById('btn-doc-upload-submit');
  btn.disabled = true; btn.textContent = '⏳ Subiendo…';
  errEl.classList.add('hidden');
  try {
    await uploadDocumento(expId, code, file, meta);
    closeDocUploadModal();
    showToast(`✓ ${DOCS_MASTER.find(d => d.code === code)?.name || code} subido`);
    const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    const hEntry = currentHistoryIndex !== null ? hist[currentHistoryIndex] : null;
    await renderDocumentosTab(expId, hEntry?.formData || {}, hEntry?.mercados || []);
  } catch (e) {
    errEl.textContent = 'Error: ' + e.message;
    errEl.classList.remove('hidden');
    btn.disabled = false; btn.textContent = 'Subir documento';
  }
}

async function handleDocDelete(expId, code, storagePath) {
  if (!['admin','coord_compliance'].includes(getActiveRole())) return;
  if (!confirm('¿Eliminar este documento? Esta acción no se puede deshacer.')) return;
  if (storagePath) {
    await fetch('/api/upload-evidencia', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: storagePath }),
    }).catch(() => {});
  }
  if (db && expId) {
    await db.collection('expedientes').doc(expId).collection('documentos').doc(code).delete().catch(() => {});
  }
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const hEntry = currentHistoryIndex !== null ? hist[currentHistoryIndex] : null;
  await renderDocumentosTab(expId, hEntry?.formData || {}, hEntry?.mercados || []);
  showToast('✓ Documento eliminado');
}

function getExpiryBadge(status, docMarketsList, activeDocMarkets) {
  if (!status?.expiryDate) return '';
  const expiry = new Date(status.expiryDate);
  const daysLeft = Math.round((expiry - new Date()) / 86400000);
  const threshold = docMarketsList.filter(m => activeDocMarkets.includes(m)).includes('UE') ? 180 : 90;
  if (daysLeft < 0)          return `<span class="doc-expiry-badge doc-expiry--expired">⚠ Vencido</span>`;
  if (daysLeft <= threshold) return `<span class="doc-expiry-badge doc-expiry--soon">⏰ ${daysLeft}d para vencer</span>`;
  return `<span class="doc-expiry-badge doc-expiry--ok">📅 Vence ${status.expiryDate}</span>`;
}

async function handleDocApprove(expId, code) {
  const role = getActiveRole();
  if (role !== 'admin' && role !== 'coord_compliance') return;
  const session = getSession();
  await saveDocStatus(expId, code, {
    status: 'approved',
    approvedBy: session.userId, approvedByName: session.name, approvedAt: Date.now(),
  });
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const hEntry = currentHistoryIndex !== null ? hist[currentHistoryIndex] : null;
  await renderDocumentosTab(expId, hEntry?.formData || {}, hEntry?.mercados || []);
  showToast('✓ Documento aprobado');
}

async function renderDocumentosTab(expId, formData, markets) {
  const content = document.getElementById('results-content');
  if (!content) return;

  const docMarkets = expandDocMarkets(markets);
  const required   = getRequiredDocs(formData, markets);
  const optional   = DOCS_MASTER.filter(d => d.req === 'optional' && d.markets.some(m => docMarkets.includes(m)));
  const statuses   = await loadDocStatuses(expId);

  // Progress per market
  const marketProgress = {};
  docMarkets.forEach(m => {
    const mDocs = required.filter(d => d.markets.includes(m));
    const done  = mDocs.filter(d => ['uploaded','approved'].includes(statuses[d.code]?.status));
    marketProgress[m] = { total: mDocs.length, done: done.length };
  });

  // Persist docProgress to localStorage + Firestore
  if (currentHistoryIndex !== null && Object.keys(marketProgress).length) {
    const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    if (hist[currentHistoryIndex]) {
      hist[currentHistoryIndex].docProgress = marketProgress;
      try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch (e) {}
      const expId = hist[currentHistoryIndex].expId;
      if (db && expId) {
        db.collection('expedientes').doc(expId)
          .update({ docProgress: marketProgress }).catch(() => {});
      }
    }
  }

  // Next pending required doc
  const nextDoc = required.find(d => !statuses[d.code]);

  // Group by category
  const cats = {};
  required.forEach(d => {
    if (!cats[d.cat]) cats[d.cat] = { name: d.catName, docs: [] };
    cats[d.cat].docs.push(d);
  });

  const canApprove = ['admin','coord_compliance'].includes(getActiveRole());
  const canUpload  = getActiveRole() !== 'viewer';

  const statusBadge = (code) => {
    const s = statuses[code];
    if (!s) return `<span class="doc-status doc-status--pending">⬜ Pendiente</span>`;
    if (s.status === 'approved') return `<span class="doc-status doc-status--approved">✅ Aprobado</span>`;
    return `<span class="doc-status doc-status--uploaded">📎 Subido</span>`;
  };

  const actionBtn = (expId, code) => {
    const s = statuses[code];
    const deleteBtn = s && canApprove
      ? `<button class="btn-doc-delete" title="Eliminar" onclick="handleDocDelete('${expId}','${code}','${escapeHtml(s.storagePath || '')}')">✕</button>`
      : '';
    if (!s) {
      return canUpload ? `<button class="btn-doc-upload" onclick="handleDocUpload('${expId}','${code}')">+ Subir</button>` : '';
    }
    const viewBtn = `<a class="btn-doc-view" href="${escapeHtml(s.fileUrl)}" target="_blank" rel="noopener">Ver</a>`;
    const approveBtn = s.status === 'uploaded' && canApprove
      ? `<button class="btn-doc-approve" onclick="handleDocApprove('${expId}','${code}')">Aprobar</button>`
      : '';
    return viewBtn + approveBtn + deleteBtn;
  };

  const marketBadges = (docMarkets, docMarketsList) =>
    docMarketsList.filter(m => docMarkets.includes(m))
      .map(m => `<span class="doc-mkt-badge">${DOC_MARKET_FLAGS[m]} ${DOC_MARKET_SHORT[m]}</span>`)
      .join('');

  const progressBars = docMarkets.map(m => {
    const p = marketProgress[m];
    const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
    const color = pct === 100 ? '#16a34a' : pct >= 50 ? '#d97706' : '#dc2626';
    return `
      <div class="doc-progress-market">
        <span class="doc-progress-label">${DOC_MARKET_FLAGS[m]} ${DOC_MARKET_SHORT[m]}</span>
        <div class="doc-progress-track">
          <div class="doc-progress-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <span class="doc-progress-count" style="color:${color}">${p.done}/${p.total}</span>
      </div>`;
  }).join('');

  const catBlocks = Object.values(cats).map(cat => {
    const catDone = cat.docs.filter(d => statuses[d.code]).length;
    const rows = cat.docs.map(d => {
      const s = statuses[d.code];
      const rowCls = s?.status === 'approved' ? 'doc-row--approved' : s ? 'doc-row--uploaded' : 'doc-row--pending';
      const condBadge = d.req === 'conditional' ? `<span class="doc-req-badge doc-req--cond">Condicional</span>` : '';
      const expiryBadge = getExpiryBadge(s, d.markets, docMarkets);
      const standardHint = s?.standard ? getStandardHint(s.standard) : '';
      const docHint = d.hint ? `<span class="doc-hint">ℹ ${escapeHtml(d.hint)}</span>` : '';
      const metaLine = (s && (s.issuedDate || s.labName || s.standard || s.issuedBy)) || standardHint || (!s && docHint) ? `
        <div class="doc-row-details">
          ${s?.issuedDate ? `<span>${s.issuedDate}${s.expiryDate ? ` → ${s.expiryDate}` : ''}</span>` : ''}
          ${s?.labName    ? `<span>🔬 ${escapeHtml(s.labName)}${s.labAcc ? ` · ${escapeHtml(s.labAcc)}` : ''}</span>` : ''}
          ${s?.standard   ? `<span>📐 ${escapeHtml(s.standard)}</span>` : ''}
          ${s?.issuedBy   ? `<span>✍ ${escapeHtml(s.issuedBy)}</span>` : ''}
          ${standardHint}
          ${docHint}
        </div>` : '';
      return `
        <div class="doc-row ${rowCls}" id="doc-row-${d.code}">
          <div class="doc-row-left">
            ${statusBadge(d.code)}
            <div class="doc-row-info">
              <span class="doc-name">${escapeHtml(d.name)}</span>
              <div class="doc-row-meta">
                <span class="doc-code">${d.code}</span>
                ${condBadge}
                ${marketBadges(docMarkets, d.markets)}
                ${s?.fileName ? `<span class="doc-filename" title="${escapeHtml(s.fileName)}">📄 ${escapeHtml(s.fileName.slice(0,30))}${s.fileName.length>30?'…':''}</span>` : ''}
                ${expiryBadge}
              </div>
              ${metaLine}
            </div>
          </div>
          <div class="doc-row-actions">${actionBtn(expId, d.code)}</div>
        </div>`;
    }).join('');
    return `
      <div class="doc-cat">
        <div class="doc-cat-header">
          <span class="doc-cat-name">${cat.name}</span>
          <span class="doc-cat-progress">${catDone}/${cat.docs.length}</span>
        </div>
        ${rows}
      </div>`;
  }).join('');

  const optionalRows = optional.map(d => {
    const s = statuses[d.code];
    return `
      <div class="doc-row doc-row--optional ${s ? 'doc-row--uploaded' : ''}" id="doc-row-${d.code}">
        <div class="doc-row-left">
          ${statusBadge(d.code)}
          <div class="doc-row-info">
            <span class="doc-name">${escapeHtml(d.name)}</span>
            <div class="doc-row-meta">
              <span class="doc-code">${d.code}</span>
              <span class="doc-req-badge doc-req--opt">Opcional</span>
              ${marketBadges(docMarkets, d.markets)}
            </div>
          </div>
        </div>
        <div class="doc-row-actions">${actionBtn(expId, d.code)}</div>
      </div>`;
  }).join('');

  const nextBanner = nextDoc && expId ? `
    <div class="doc-next-step">
      <span class="doc-next-label">Siguiente paso →</span>
      <span class="doc-next-name">${escapeHtml(nextDoc.name)}</span>
      <span class="doc-next-code">${nextDoc.code}</span>
      ${canUpload ? `<button class="btn-doc-upload btn-doc-upload--sm" onclick="handleDocUpload('${expId}','${nextDoc.code}')">+ Subir</button>` : ''}
    </div>` : '';

  const noMarkets = docMarkets.length === 0 ? `
    <div class="doc-no-markets">
      <p>Este expediente no incluye mercados UE, USA ni Australia.</p>
      <p>El módulo de documentos aplica para: 🇪🇺 Unión Europea · 🇺🇸 Estados Unidos · 🇦🇺 Australia</p>
    </div>` : '';

  content.innerHTML = `
    <div class="expediente-card docs-tab">
      <div class="doc-header">
        <div class="doc-header-top">
          <span class="doc-header-title">📋 Ruta de Compliance</span>
          ${expId ? '' : '<span class="doc-save-note">Guarda el expediente para poder subir documentos</span>'}
        </div>
        ${docMarkets.length ? `<div class="doc-progress-row">${progressBars}</div>` : ''}
        ${nextBanner}
      </div>
      ${noMarkets}
      ${catBlocks}
      ${optionalRows ? `
        <details class="doc-optional-section">
          <summary class="doc-optional-toggle">Documentos opcionales (${optional.length})</summary>
          <div class="doc-optional-list">${optionalRows}</div>
        </details>` : ''}
    </div>`;
}
