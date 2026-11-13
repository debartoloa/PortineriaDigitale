/**
 * app.js - Core Application Logic per Portineria Digitale Scolastica (PWA)
 *
 * Architettura:
 * - StorageDB: Persistenza su IndexedDB (con fallback trasparente su localStorage)
 *   e migrazione automatica dei dati legacy.
 * - Sicurezza PIN: Hashing SHA-256 tramite Web Crypto API (crypto.subtle.digest).
 * - OCR Engine: Singolo Tesseract.createWorker('ita') riutilizzabile + parser
 *   dedicato per Fronte Documento e Retro MRZ (CIE TD1 / Passaporto TD3).
 * - PWA: Registrazione Service Worker, gestione beforeinstallprompt, istruzioni iOS
 *   e indicatore stato Online/Offline/Installata.
 */

'use strict';

/* ==========================================================================
   COSTANTI & STATO GLOBALE
   ========================================================================== */
const LEGACY_KEYS = {
  RECORDS: 'portineria_iis_records_v1',
  SCHOOL: 'portineria_school_config_v1',
  PIN: 'portineria_security_pin_v1',
  VISITOR_SEARCH: 'portineria_enable_visitor_search_v1'
};

const DB_NAME = 'portineria_db_v1';
const DB_VERSION = 1;
const STORE_RECORDS = 'records';
const STORE_SETTINGS = 'settings';

let records = [];
let mediaStream = null;
let currentStudentAction = 'ENTRARE';
let guideCurrentScale = 1.0;
let currentCameraFacing = 'environment';
let ocrScanMode = 'front'; // 'front' | 'mrz'
let activeOcrTarget = 'student'; // 'student' | 'visitor'

// Stato sicurezza PIN & Modalità Staff
let isOperatorUnlocked = false;
let currentEnteredPin = '';
let pendingProtectedAction = null;
let autoLockTimer = null;
let storedPinHash = '';
let storedPinLength = 4;
let visitorSearchEnabled = false;

// Storico multi-giorno (default: oggi)
let selectedRegisterDate = '';

// Stato PWA & Connessione
let deferredInstallPrompt = null;

// Worker Tesseract.js riutilizzabile
let tesseractWorkerPromise = null;
let ocrStatusCallback = null;

let schoolConfig = {
  nomeScuola: '',
  citta: '',
  indirizzi: []
};

let tempCoursesList = [];

const signaturePads = {
  visitor: { canvas: null, ctx: null, isDrawing: false, hasContent: false },
  student: { canvas: null, ctx: null, isDrawing: false, hasContent: false }
};

/* ==========================================================================
   1. WRAPPER INDEXEDDB CON FALLBACK LOCALSTORAGE
   ========================================================================== */
const StorageDB = {
  db: null,
  useFallback: false,

  async init() {
    if (!('indexedDB' in window)) {
      this.useFallback = true;
      return;
    }

    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(STORE_RECORDS)) {
            const recStore = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
            recStore.createIndex('dataOraIngresso', 'dataOraIngresso', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
            db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('IndexedDB non disponibile, attivo fallback localStorage:', err);
      this.useFallback = true;
    }
  },

  async getSetting(key, defaultValue = null) {
    if (this.useFallback || !this.db) {
      try {
        const raw = localStorage.getItem(`pdb_setting_${key}`);
        return raw !== null ? JSON.parse(raw) : defaultValue;
      } catch {
        return defaultValue;
      }
    }

    return new Promise((resolve) => {
      const tx = this.db.transaction(STORE_SETTINGS, 'readonly');
      const store = tx.objectStore(STORE_SETTINGS);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
      req.onerror = () => resolve(defaultValue);
    });
  },

  async setSetting(key, value) {
    if (this.useFallback || !this.db) {
      try {
        localStorage.setItem(`pdb_setting_${key}`, JSON.stringify(value));
      } catch (err) {
        console.error('Errore salvataggio fallback setting:', err);
      }
      return;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_SETTINGS, 'readwrite');
      const store = tx.objectStore(STORE_SETTINGS);
      store.put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async getAllRecords() {
    if (this.useFallback || !this.db) {
      try {
        const raw = localStorage.getItem(LEGACY_KEYS.RECORDS);
        return raw ? JSON.parse(raw) : [];
      } catch {
        return [];
      }
    }

    return new Promise((resolve) => {
      const tx = this.db.transaction(STORE_RECORDS, 'readonly');
      const store = tx.objectStore(STORE_RECORDS);
      const req = store.getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });
  },

  async putRecord(record) {
    if (this.useFallback || !this.db) {
      this._saveFallbackRecords();
      return;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_RECORDS, 'readwrite');
      tx.objectStore(STORE_RECORDS).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async replaceAllRecords(newRecords) {
    if (this.useFallback || !this.db) {
      this._saveFallbackRecords(newRecords);
      return;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_RECORDS, 'readwrite');
      const store = tx.objectStore(STORE_RECORDS);
      store.clear();
      newRecords.forEach((rec) => store.put(rec));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async clearAllData() {
    if (this.useFallback || !this.db) {
      Object.values(LEGACY_KEYS).forEach((k) => localStorage.removeItem(k));
      localStorage.removeItem('pdb_setting_schoolConfig');
      localStorage.removeItem('pdb_setting_pinHash');
      localStorage.removeItem('pdb_setting_pinLength');
      localStorage.removeItem('pdb_setting_visitorSearchEnabled');
      return;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_RECORDS, STORE_SETTINGS], 'readwrite');
      tx.objectStore(STORE_RECORDS).clear();
      tx.objectStore(STORE_SETTINGS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  _saveFallbackRecords(list = records) {
    try {
      localStorage.setItem(LEGACY_KEYS.RECORDS, JSON.stringify(list));
    } catch (err) {
      console.error('Errore salvataggio localStorage:', err);
      showToast('Memoria locale piena! Esporta un backup JSON.', 'error');
    }
  }
};

/* ==========================================================================
   2. SICUREZZA PIN CON HASHING SHA-256 (WEB CRYPTO API + FALLBACK)
   ========================================================================== */
async function hashPin(pinText) {
  const normalized = String(pinText || '').trim();
  const data = new TextEncoder().encode(`portineria_salt_v1:${normalized}`);

  if (window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function') {
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback SHA-256 puro JS per contesti non-HTTPS (es. test su IP LAN locale)
  return sha256Fallback(data);
}

function sha256Fallback(bytes) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const l = bytes.length;
  const paddedLen = Math.ceil((l + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[l] = 0x80;
  const bitLen = l * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);

  const W = new Uint32Array(64);
  const rotr = (n, x) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(7, W[i - 15]) ^ rotr(18, W[i - 15]) ^ (W[i - 15] >>> 3);
      const s1 = rotr(17, W[i - 2]) ^ rotr(19, W[i - 2]) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return Array.from(H).map((x) => x.toString(16).padStart(8, '0')).join('');
}

async function setStoredPin(pin) {
  const cleanPin = String(pin).trim();
  const digest = await hashPin(cleanPin);
  storedPinHash = digest;
  storedPinLength = cleanPin.length;
  await StorageDB.setSetting('pinHash', digest);
  await StorageDB.setSetting('pinLength', storedPinLength);
}

async function verifyPin(inputPin) {
  const digest = await hashPin(inputPin);
  return digest === storedPinHash;
}

/* ==========================================================================
   3. MIGRAZIONE DATI LEGACY DA LOCALSTORAGE -> INDEXEDDB
   ========================================================================== */
async function migrateLegacyLocalStorage() {
  const migrated = await StorageDB.getSetting('legacyMigrated', false);
  if (migrated) return;

  try {
    const legacyRecordsRaw = localStorage.getItem(LEGACY_KEYS.RECORDS);
    if (legacyRecordsRaw) {
      const parsedRecords = JSON.parse(legacyRecordsRaw);
      if (Array.isArray(parsedRecords) && parsedRecords.length > 0) {
        await StorageDB.replaceAllRecords(parsedRecords);
      }
    }

    const legacySchoolRaw = localStorage.getItem(LEGACY_KEYS.SCHOOL);
    if (legacySchoolRaw) {
      const parsedSchool = JSON.parse(legacySchoolRaw);
      if (parsedSchool && parsedSchool.nomeScuola) {
        await StorageDB.setSetting('schoolConfig', parsedSchool);
      }
    }

    const legacyPin = localStorage.getItem(LEGACY_KEYS.PIN);
    if (legacyPin && legacyPin.trim().length >= 4) {
      await setStoredPin(legacyPin.trim());
      localStorage.removeItem(LEGACY_KEYS.PIN); // Rimuove il PIN in chiaro legacy
    }

    const legacySearch = localStorage.getItem(LEGACY_KEYS.VISITOR_SEARCH);
    if (legacySearch !== null) {
      await StorageDB.setSetting('visitorSearchEnabled', legacySearch === 'true');
    }

    await StorageDB.setSetting('legacyMigrated', true);
  } catch (err) {
    console.warn('Migrazione legacy parziale:', err);
  }
}

/* ==========================================================================
   4. PWA: SERVICE WORKER, INSTALLAZIONE E STATO CONNESSIONE
   ========================================================================== */
function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Registrazione Service Worker non riuscita:', err);
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updateInstallButtonVisibility();
    updateConnectionStatusUI();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updateInstallButtonVisibility();
    updateConnectionStatusUI();
    showToast('App installata con successo! Ora puoi avviarla dalla schermata Home.', 'success');
  });

  window.addEventListener('online', updateConnectionStatusUI);
  window.addEventListener('offline', () => {
    updateConnectionStatusUI();
    showToast('Modalità Offline attiva: i dati continuano a essere salvati in locale.', 'info');
  });

  updateInstallButtonVisibility();
  updateConnectionStatusUI();
}

function isStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIosDevice() {
  const ua = window.navigator.userAgent || '';
  const isAppleTouch = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return isAppleTouch && !window.MSStream;
}

function updateInstallButtonVisibility() {
  const btn = document.getElementById('btnInstallApp');
  if (!btn) return;

  if (isStandaloneMode()) {
    btn.style.display = 'none';
    return;
  }

  if (deferredInstallPrompt || isIosDevice()) {
    btn.style.display = 'inline-flex';
  } else {
    btn.style.display = 'none';
  }
}

async function handleInstallClick() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      deferredInstallPrompt = null;
      updateInstallButtonVisibility();
    }
    return;
  }

  if (isIosDevice() && !isStandaloneMode()) {
    openModal('modalIosInstall');
    return;
  }

  showToast('Usa il menu del browser ("Installa app" o "Aggiungi a schermata Home").', 'info');
}

function updateConnectionStatusUI() {
  const pill = document.getElementById('connectionStatusPill');
  const text = document.getElementById('connectionStatusText');
  if (!pill || !text) return;

  const online = navigator.onLine;
  pill.classList.toggle('is-offline', !online);
  pill.classList.toggle('is-pwa-ready', Boolean(deferredInstallPrompt) && !isStandaloneMode());

  if (!online) {
    text.textContent = 'Offline (Locale)';
  } else if (isStandaloneMode()) {
    text.textContent = 'Online · PWA';
  } else if (deferredInstallPrompt) {
    text.textContent = 'Online · Installabile';
  } else {
    text.textContent = 'Online';
  }
}

/* ==========================================================================
   5. INIZIALIZZAZIONE APPLICAZIONE & NAVIGAZIONE SCHERMATE
   ========================================================================== */
function showScreen(screen) {
  const wizard = document.getElementById('screenWizard');
  const dashboard = document.getElementById('screenDashboard');

  if (screen === 'wizard') {
    wizard.style.display = 'flex';
    dashboard.style.display = 'none';
  } else {
    wizard.style.display = 'none';
    dashboard.style.display = 'flex';
  }
  window.scrollTo(0, 0);
}

function isSchoolConfigured() {
  return Boolean(
    schoolConfig &&
    typeof schoolConfig.nomeScuola === 'string' &&
    schoolConfig.nomeScuola.trim().length > 0 &&
    Array.isArray(schoolConfig.indirizzi) &&
    schoolConfig.indirizzi.length > 0
  );
}

async function initApp() {
  initPWA();

  await StorageDB.init();
  await migrateLegacyLocalStorage();

  // Carica impostazioni e PIN (inizializza default '1234' se assente)
  const savedHash = await StorageDB.getSetting('pinHash', null);
  const savedLen = await StorageDB.getSetting('pinLength', 4);
  if (!savedHash) {
    await setStoredPin('1234');
  } else {
    storedPinHash = savedHash;
    storedPinLength = savedLen || 4;
  }

  visitorSearchEnabled = Boolean(await StorageDB.getSetting('visitorSearchEnabled', false));
  const savedSchool = await StorageDB.getSetting('schoolConfig', null);
  if (savedSchool) schoolConfig = savedSchool;

  records = await StorageDB.getAllRecords();

  selectedRegisterDate = getTodayIsoDate();
  const dateFilterEl = document.getElementById('registerDateFilter');
  if (dateFilterEl) dateFilterEl.value = selectedRegisterDate;

  initClocks();
  initSignatures();
  setDefaultTimes();
  initCourseInputListener();
  initPinKeyboardListener();
  updateVisitorSearchVisibility();

  if (isSchoolConfigured()) {
    applySchoolConfig();
    showScreen('dashboard');
  } else {
    openSchoolConfig(true);
  }

  updateOperatorModeUI();
  renderDashboard();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

/* ==========================================================================
   6. WIZARD CONFIGURAZIONE ISTITUTO
   ========================================================================== */
function openSchoolConfig(isFirstRun = false) {
  const backBtn = document.getElementById('btnWizardBackToDashboard');
  const title = document.getElementById('wizardTitle');
  const subtitle = document.getElementById('wizardSubtitle');
  const pinInput = document.getElementById('cfgSchoolPin');

  if (isFirstRun || !isSchoolConfigured()) {
    if (backBtn) backBtn.style.display = 'none';
    if (title) title.textContent = 'Benvenuto in Portineria Digitale!';
    if (subtitle) subtitle.textContent = 'Al primo avvio, inserisci il nome del tuo Istituto e gli indirizzi di studio o plessi per iniziare.';
    document.getElementById('cfgSchoolName').value = '';
    document.getElementById('cfgSchoolCity').value = '';
    if (pinInput) pinInput.value = '1234';
    tempCoursesList = [];
  } else {
    if (backBtn) backBtn.style.display = 'inline-flex';
    if (title) title.textContent = 'Personalizzazione Istituto Scolastico';
    if (subtitle) subtitle.textContent = 'Modifica il nome della scuola e gestisci gli indirizzi di studio o plessi presenti.';
    document.getElementById('cfgSchoolName').value = schoolConfig.nomeScuola || '';
    document.getElementById('cfgSchoolCity').value = schoolConfig.citta || '';
    if (pinInput) pinInput.value = '';
    tempCoursesList = [...(schoolConfig.indirizzi || [])];
  }

  document.getElementById('cfgCourseInput').value = '';
  renderTempCoursesList();
  showScreen('wizard');
}

function cancelWizardAndReturn() {
  if (isSchoolConfigured()) {
    showScreen('dashboard');
  } else {
    showToast('Devi completare la configurazione della scuola prima di accedere!', 'error');
  }
}

function addCourseFromInput() {
  const input = document.getElementById('cfgCourseInput');
  const val = input.value.trim();
  if (!val) {
    showToast('Inserisci il nome di un indirizzo di studio!', 'error');
    input.focus();
    return;
  }
  if (tempCoursesList.includes(val)) {
    showToast('Questo indirizzo è già presente nell\'elenco!', 'info');
    input.focus();
    return;
  }

  tempCoursesList.push(val);
  input.value = '';
  input.focus();
  renderTempCoursesList();
}

function initCourseInputListener() {
  const courseInput = document.getElementById('cfgCourseInput');
  if (courseInput) {
    courseInput.onkeydown = function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        addCourseFromInput();
      }
    };
  }
}

function removeTempCourse(index) {
  tempCoursesList.splice(index, 1);
  renderTempCoursesList();
}

function renderTempCoursesList() {
  const container = document.getElementById('cfgCoursesListContainer');
  container.innerHTML = '';

  if (tempCoursesList.length === 0) {
    container.innerHTML = `<span id="cfgNoCoursesMsg" style="color:#a0aec0; font-size:0.88rem; font-style:italic;">
      Nessun indirizzo inserito. Digita un indirizzo sopra e tocca "Aggiungi".
    </span>`;
    return;
  }

  tempCoursesList.forEach((course, idx) => {
    const chip = document.createElement('div');
    chip.className = 'course-chip';
    chip.innerHTML = `
      <span>${escapeHtml(course)}</span>
      <button type="button" class="course-chip-remove" onclick="removeTempCourse(${idx})" title="Rimuovi">&times;</button>
    `;
    container.appendChild(chip);
  });
}

function fillSampleSchoolConfig() {
  document.getElementById('cfgSchoolName').value = 'I.I.S. "E. Mattei"';
  document.getElementById('cfgSchoolCity').value = 'Castrovillari (CS)';
  const pinEl = document.getElementById('cfgSchoolPin');
  if (pinEl) pinEl.value = '1234';

  tempCoursesList = [
    'Liceo Scientifico',
    'Liceo Scienze Applicate',
    'Liceo Linguistico',
    'Liceo Classico "Garibaldi"',
    'Liceo Artistico "Alfano"',
    'Liceo Scientifico Mormanno'
  ];
  renderTempCoursesList();
  showToast('Dati di esempio inseriti! Clicca su "Salva e Accedi" per confermare.', 'info');
}

async function saveSchoolConfig(e) {
  e.preventDefault();
  const schoolName = document.getElementById('cfgSchoolName').value.trim();
  const schoolCity = document.getElementById('cfgSchoolCity').value.trim();
  const pinEl = document.getElementById('cfgSchoolPin');

  if (!schoolName) {
    showToast('Inserisci il nome della scuola!', 'error');
    return;
  }

  if (tempCoursesList.length === 0) {
    showToast('Aggiungi almeno un indirizzo di studio!', 'error');
    document.getElementById('cfgCourseInput').focus();
    return;
  }

  if (pinEl && pinEl.value.trim()) {
    const pinVal = pinEl.value.trim();
    if (/^\d{4,6}$/.test(pinVal)) {
      await setStoredPin(pinVal);
    } else {
      showToast('Il PIN deve essere composto da 4 a 6 cifre numeriche!', 'error');
      pinEl.focus();
      return;
    }
  }

  schoolConfig = {
    nomeScuola: schoolName,
    citta: schoolCity,
    indirizzi: [...tempCoursesList]
  };

  try {
    await StorageDB.setSetting('schoolConfig', schoolConfig);
    applySchoolConfig();
    showScreen('dashboard');
    renderDashboard();
    showToast('Configurazione salvata con successo!', 'success');
  } catch (err) {
    console.error('Errore salvataggio scuola:', err);
    showToast('Errore nel salvataggio della configurazione!', 'error');
  }
}

function applySchoolConfig() {
  if (!schoolConfig || !schoolConfig.nomeScuola) return;

  document.getElementById('pageTitle').textContent = `Portineria Digitale - ${schoolConfig.nomeScuola}`;
  document.getElementById('headerSchoolTitle').textContent = schoolConfig.nomeScuola;

  let subtitleText = '';
  if (schoolConfig.indirizzi && schoolConfig.indirizzi.length > 0) {
    subtitleText = schoolConfig.indirizzi.join(' • ');
  }
  if (schoolConfig.citta) {
    subtitleText += (subtitleText ? ' | ' : '') + schoolConfig.citta;
  }
  document.getElementById('headerSchoolSubtitle').textContent = subtitleText || 'Portineria Digitale';

  const branchesContainer = document.getElementById('schoolBranchesContainer');
  if (branchesContainer) {
    branchesContainer.innerHTML = '';
    (schoolConfig.indirizzi || []).forEach((ind, index) => {
      const label = document.createElement('label');
      label.className = 'branch-radio-label';
      label.innerHTML = `
        <input type="radio" name="schoolBranch" value="${index}" ${index === 0 ? 'checked' : ''}>
        <span>${escapeHtml(ind)}</span>
      `;
      branchesContainer.appendChild(label);
    });
  }

  const printName = document.getElementById('p-print-school-name');
  if (printName) printName.textContent = schoolConfig.nomeScuola;

  const printBranchesList = document.getElementById('p-print-school-branches-list');
  if (printBranchesList) {
    printBranchesList.innerHTML = (schoolConfig.indirizzi || [])
      .map((ind) => `• ${escapeHtml(ind)}<br>`)
      .join('');
  }

  const printChkContainer = document.getElementById('p-school-checkboxes-container');
  if (printChkContainer) {
    printChkContainer.innerHTML = '';
    (schoolConfig.indirizzi || []).forEach((ind, index) => {
      const item = document.createElement('div');
      item.className = 'checkbox-item';
      item.innerHTML = `<input type="checkbox" id="sede-${index}"> ${escapeHtml(ind)}`;
      printChkContainer.appendChild(item);
    });
  }

  const printRegTitle = document.getElementById('p-reg-school-title');
  if (printRegTitle) {
    printRegTitle.textContent = `${schoolConfig.nomeScuola}${schoolConfig.citta ? ' - ' + schoolConfig.citta : ''}`;
  }
}

/* ==========================================================================
   7. GESTIONE PIN & PRIVACY SHIELD GDPR
   ========================================================================== */
function promptPinModal(actionType = null) {
  pendingProtectedAction = actionType || null;
  currentEnteredPin = '';
  updatePinDots();

  const pinHiddenInput = document.getElementById('pinHiddenInput');
  if (pinHiddenInput) pinHiddenInput.value = '';

  openModal('modalPinPrompt');
  setTimeout(() => {
    if (pinHiddenInput) pinHiddenInput.focus();
  }, 150);
}

function pressNumpadDigit(digit) {
  const maxLen = Math.max(4, storedPinLength);
  if (currentEnteredPin.length < maxLen) {
    currentEnteredPin += String(digit);
    updatePinDots();
  }

  if (currentEnteredPin.length === maxLen) {
    setTimeout(() => submitPinCode(), 120);
  }
}

function pressNumpadBack() {
  if (currentEnteredPin.length > 0) {
    currentEnteredPin = currentEnteredPin.slice(0, -1);
    updatePinDots();
  }
}

function updatePinDots() {
  const container = document.getElementById('pinDisplayCircles');
  if (!container) return;
  const targetLen = Math.max(4, storedPinLength);

  let dots = container.querySelectorAll('.pin-circle');
  if (dots.length !== targetLen) {
    container.innerHTML = '';
    for (let i = 0; i < targetLen; i++) {
      const d = document.createElement('div');
      d.className = 'pin-circle';
      d.id = `pinDot${i}`;
      container.appendChild(d);
    }
    dots = container.querySelectorAll('.pin-circle');
  }

  dots.forEach((dot, idx) => {
    dot.classList.toggle('filled', idx < currentEnteredPin.length);
  });
}

async function submitPinCode() {
  const isValid = await verifyPin(currentEnteredPin);
  if (isValid) {
    isOperatorUnlocked = true;
    closeModal('modalPinPrompt');
    updateOperatorModeUI();
    resetAutoLockTimer();
    showToast('PIN corretto! Modalità Personale Scolastico sbloccata.', 'success');

    const action = pendingProtectedAction;
    pendingProtectedAction = null;
    currentEnteredPin = '';
    if (action) executeProtectedAction(action);
  } else {
    const container = document.getElementById('pinDisplayCircles');
    if (container) {
      container.classList.add('shake');
      setTimeout(() => container.classList.remove('shake'), 450);
    }
    currentEnteredPin = '';
    updatePinDots();
    showToast('PIN errato! Riprova.', 'error');
  }
}

function initPinKeyboardListener() {
  window.addEventListener('keydown', (e) => {
    const modalPrompt = document.getElementById('modalPinPrompt');
    if (!modalPrompt || !modalPrompt.classList.contains('active')) return;

    if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      pressNumpadDigit(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      pressNumpadBack();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submitPinCode();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeModal('modalPinPrompt');
    }
  });
}

function handleProtectedAction(type) {
  if (isOperatorUnlocked) {
    resetAutoLockTimer();
    executeProtectedAction(type);
  } else {
    promptPinModal(type);
  }
}

function executeProtectedAction(type) {
  switch (type) {
    case 'quick_exit':
      openQuickExitModal();
      break;
    case 'dati_scuola':
      openSchoolConfig(false);
      break;
    case 'backup':
      openBackupModal();
      break;
    case 'unlock_table':
      break;
    case 'change_pin':
      openChangePinModal();
      break;
    default:
      break;
  }
}

function toggleOperatorMode() {
  if (isOperatorUnlocked) {
    lockOperatorMode(true);
  } else {
    promptPinModal('unlock_table');
  }
}

function lockOperatorMode(notify = true) {
  isOperatorUnlocked = false;
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
  updateOperatorModeUI();
  if (notify) {
    showToast('Modalità Personale bloccata. Registro protetto da GDPR.', 'info');
  }
}

function resetAutoLockTimer() {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = setTimeout(() => {
    if (isOperatorUnlocked) lockOperatorMode(true);
  }, 5 * 60 * 1000);
}

function updateOperatorModeUI() {
  const badge = document.getElementById('operatorStatusBadge');
  const headerBtn = document.getElementById('btnHeaderOperatorMode');
  const toolbar = document.getElementById('registerToolbarUnlocked');
  const privacyBox = document.getElementById('registerLockedPrivacyBox');
  const tableContainer = document.getElementById('registerTableContainer');

  if (isOperatorUnlocked) {
    if (badge) {
      badge.textContent = '🔓 Staff Attivo (Sbloccato)';
      badge.style.background = 'var(--success)';
    }
    if (headerBtn) {
      headerBtn.innerHTML = '🔓 <span>Staff Attivo</span>';
      headerBtn.style.background = 'rgba(56, 161, 105, 0.35)';
    }
    if (toolbar) toolbar.style.display = 'flex';
    if (privacyBox) privacyBox.style.display = 'none';
    if (tableContainer) tableContainer.style.display = 'block';
  } else {
    if (badge) {
      badge.textContent = '🔒 Riservato Staff';
      badge.style.background = '#718096';
    }
    if (headerBtn) {
      headerBtn.innerHTML = '🔒 <span>Accesso Staff</span>';
      headerBtn.style.background = 'rgba(255, 255, 255, 0.18)';
    }
    if (toolbar) toolbar.style.display = 'none';
    if (privacyBox) privacyBox.style.display = 'block';
    if (tableContainer) tableContainer.style.display = 'none';
  }
}

function openChangePinModal() {
  const form = document.getElementById('formChangePin');
  if (form) form.reset();
  openModal('modalChangePin');
  setTimeout(() => {
    const inp = document.getElementById('pinOldInput');
    if (inp) inp.focus();
  }, 150);
}

async function saveNewPin(e) {
  e.preventDefault();
  const oldPin = document.getElementById('pinOldInput').value.trim();
  const newPin = document.getElementById('pinNewInput').value.trim();
  const confirmPin = document.getElementById('pinConfirmInput').value.trim();

  if (!(await verifyPin(oldPin))) {
    showToast('Il PIN attuale non è corretto!', 'error');
    document.getElementById('pinOldInput').focus();
    return;
  }

  if (newPin.length < 4 || newPin.length > 6 || !/^\d+$/.test(newPin)) {
    showToast('Il nuovo PIN deve essere composto da 4 a 6 cifre numeriche!', 'error');
    document.getElementById('pinNewInput').focus();
    return;
  }

  if (newPin !== confirmPin) {
    showToast('I due campi del nuovo PIN non coincidono!', 'error');
    document.getElementById('pinConfirmInput').focus();
    return;
  }

  await setStoredPin(newPin);
  closeModal('modalChangePin');
  showToast('PIN di sicurezza aggiornato (hash SHA-256 salvato)!', 'success');
}

/* ==========================================================================
   8. PERSISTENZA & UTILITÀ DATA/ORA
   ========================================================================== */
async function persistRecord(record) {
  await StorageDB.putRecord(record);
  renderDashboard();
}

function getTodayIsoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function formatDateIt(ymd) {
  if (!ymd) return '';
  const parts = ymd.split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : ymd;
}

function initClocks() {
  function updateClock() {
    const now = new Date();
    const timeEl = document.getElementById('clockTime');
    const dateEl = document.getElementById('clockDate');

    if (timeEl) timeEl.textContent = now.toLocaleTimeString('it-IT');
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString('it-IT', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
    }
  }
  updateClock();
  setInterval(updateClock, 1000);
}

function setDefaultTimes() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const timeInput = document.getElementById('sOrarioRichiesto');
  if (timeInput) timeInput.value = `${hh}:${mm}`;
}

/* ==========================================================================
   9. DASHBOARD STATS & REGISTRO MULTI-GIORNO
   ========================================================================== */
function onRegisterDateChange() {
  const dateFilterEl = document.getElementById('registerDateFilter');
  selectedRegisterDate = (dateFilterEl && dateFilterEl.value) ? dateFilterEl.value : getTodayIsoDate();
  resetAutoLockTimer();
  filterRegister();
}

function resetRegisterDateToday() {
  selectedRegisterDate = getTodayIsoDate();
  const dateFilterEl = document.getElementById('registerDateFilter');
  if (dateFilterEl) dateFilterEl.value = selectedRegisterDate;
  resetAutoLockTimer();
  filterRegister();
}

function updateRegisterDateBadge() {
  const badge = document.getElementById('registerDateBadge');
  if (!badge) return;
  const today = getTodayIsoDate();
  if (!selectedRegisterDate || selectedRegisterDate === today) {
    badge.textContent = 'Oggi';
    badge.style.background = 'var(--primary-light)';
  } else {
    badge.textContent = `Archivio: ${formatDateIt(selectedRegisterDate)}`;
    badge.style.background = '#dd6b20';
  }
}

function renderDashboard() {
  const today = getTodayIsoDate();
  const todayRecords = records.filter((r) => r.dataOraIngresso && r.dataOraIngresso.startsWith(today));

  const presentCount = records.filter((r) => !r.oraUscita).length;
  const totalToday = todayRecords.length;
  const studentsToday = todayRecords.filter((r) => r.isStudentFlow).length;
  const exitsToday = todayRecords.filter((r) => r.oraUscita).length;

  document.getElementById('statPresentCount').textContent = presentCount;
  document.getElementById('heroExitBadgeCount').textContent = presentCount;
  document.getElementById('statTotalToday').textContent = totalToday;
  document.getElementById('statStudentsToday').textContent = studentsToday;
  document.getElementById('statExitsToday').textContent = exitsToday;

  updateOperatorModeUI();
  filterRegister();
}

function renderRegisterTable(filteredList = null) {
  const tbody = document.getElementById('registerTableBody');
  const emptyState = document.getElementById('tableEmptyState');
  const targetDate = selectedRegisterDate || getTodayIsoDate();

  updateRegisterDateBadge();

  let list = filteredList;
  if (!list) {
    list = records.filter((r) => r.dataOraIngresso && r.dataOraIngresso.startsWith(targetDate));
  }

  list.sort((a, b) => new Date(b.dataOraIngresso) - new Date(a.dataOraIngresso));

  tbody.innerHTML = '';
  if (list.length === 0) {
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';

  list.forEach((item) => {
    const tr = document.createElement('tr');
    const isInside = !item.oraUscita;
    if (isInside) tr.classList.add('status-inside');

    const dataOra = formatDateTime(item.dataOraIngresso);
    const cellulare = item.cellulare || '-';
    const qualifica = item.qualifica || 'Visitatore';
    const motivazione = item.motivazione || '-';
    const statusHtml = isInside
      ? `<span class="status-pill inside">Presente</span>`
      : `<span class="status-pill exited">Uscito alle ${escapeHtml(item.oraUscita)}</span>`;

    const moduleStatus = item.isStudentFlow
      ? `<span style="color:#0f766e; font-weight:700;">SI (${escapeHtml(item.studentData ? item.studentData.azione : 'Alunno')})</span>`
      : `<span style="color:#a0aec0;">NO</span>`;

    const signatureHtml = item.firmaBase64
      ? `<img src="${item.firmaBase64}" class="signature-thumbnail" title="Visualizza firma" onclick="previewImage('${item.firmaBase64}')">`
      : `<span style="color:#a0aec0; font-size:0.8rem;">Non apposta</span>`;

    let actionButtons = '';
    if (isInside) {
      actionButtons += `<button type="button" class="btn-quick-exit" onclick="registerExitDirect('${item.id}')">🏃 Uscita</button> `;
    }
    if (item.isStudentFlow) {
      actionButtons += `<button type="button" class="btn-action btn-action-secondary" style="padding:4px 8px; font-size:0.78rem;" onclick="reprintStudentModule('${item.id}')" title="Ristampa Modulo">🖨️ Modulo</button>`;
    }

    tr.innerHTML = `
      <td><strong>${dataOra}</strong></td>
      <td><strong>${escapeHtml(item.cognome)}</strong></td>
      <td>${escapeHtml(item.nome)}</td>
      <td><a href="tel:${escapeHtml(cellulare)}" style="color:inherit; text-decoration:none;">${escapeHtml(cellulare)}</a></td>
      <td><span style="font-weight:600;">${escapeHtml(qualifica)}</span></td>
      <td>${escapeHtml(motivazione)}</td>
      <td style="text-align:center;">${signatureHtml}</td>
      <td>${statusHtml}</td>
      <td>${moduleStatus}</td>
      <td style="white-space:nowrap;">${actionButtons}</td>
    `;
    tbody.appendChild(tr);
  });
}

function filterRegister() {
  const searchEl = document.getElementById('searchInput');
  const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
  const targetDate = selectedRegisterDate || getTodayIsoDate();
  const dateRecords = records.filter((r) => r.dataOraIngresso && r.dataOraIngresso.startsWith(targetDate));

  if (!q) {
    renderRegisterTable(dateRecords);
    return;
  }

  const filtered = dateRecords.filter((r) => {
    const full = `${r.cognome} ${r.nome} ${r.cellulare} ${r.qualifica} ${r.motivazione} ${r.studentData ? r.studentData.alunno : ''}`.toLowerCase();
    return full.includes(q);
  });

  renderRegisterTable(filtered);
}

/* ==========================================================================
   10. MODALI & LOOKUP VISITATORI RICORRENTI
   ========================================================================== */
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('active');
    document.body.style.overflow = '';
  }
  if (modalId === 'modalStudent' || modalId === 'modalVisitor') {
    stopCamera();
    resetDocCaptureUI();
    if (modalId === 'modalVisitor') {
      const mount = document.getElementById('visitorScannerMount');
      const btn = document.getElementById('btnToggleVisitorOcr');
      if (mount) mount.style.display = 'none';
      if (btn) btn.textContent = '📸 Scansiona Documento';
    }
  }
}

function mountOcrScanner(target) {
  activeOcrTarget = target === 'visitor' ? 'visitor' : 'student';
  const wrapper = document.getElementById('sharedOcrWrapper');
  const mountId = activeOcrTarget === 'visitor' ? 'visitorScannerMount' : 'studentScannerMount';
  const mountEl = document.getElementById(mountId);

  if (wrapper && mountEl && wrapper.parentElement !== mountEl) {
    mountEl.appendChild(wrapper);
  }
  if (wrapper) {
    wrapper.classList.toggle('ocr-mode-visitor', activeOcrTarget === 'visitor');
  }

  ['ocrQuickCognome', 'ocrQuickNome', 'ocrQuickDocNum', 'ocrQuickDataNascita'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  stopCamera();
  resetDocCaptureUI();
  setOcrScanMode('front');
}

function toggleVisitorOcrScanner() {
  const mount = document.getElementById('visitorScannerMount');
  const btn = document.getElementById('btnToggleVisitorOcr');
  if (!mount || !btn) return;

  const isVisible = mount.style.display !== 'none';
  if (isVisible) {
    stopCamera();
    resetDocCaptureUI();
    mount.style.display = 'none';
    btn.textContent = '📸 Scansiona Documento';
  } else {
    mountOcrScanner('visitor');
    mount.style.display = 'block';
    btn.textContent = '✖️ Chiudi Scanner';
  }
}

function resetDocCaptureUI() {
  const preview = document.getElementById('capturedDocPreview');
  const guide = document.getElementById('cardFrontGuide');
  const calibBar = document.getElementById('guideCalibrationToolbar');
  const badge = document.getElementById('docCapturedBadge');
  const btnsLive = document.getElementById('cameraBtnsLive');
  const btnsReview = document.getElementById('cameraBtnsReview');
  const placeholder = document.getElementById('cameraPlaceholder');
  const statusText = document.getElementById('cameraStatusText');

  if (preview) preview.style.display = 'none';
  if (guide) {
    guide.style.display = 'none';
    guide.classList.remove('captured');
  }
  if (calibBar) calibBar.style.display = 'none';
  if (badge) badge.style.display = 'none';
  if (btnsLive) btnsLive.style.display = 'flex';
  if (btnsReview) btnsReview.style.display = 'none';
  if (placeholder) placeholder.style.display = 'flex';
  if (statusText) statusText.textContent = 'Fotocamera non attiva';
}

function openVisitorModal() {
  document.getElementById('formVisitor').reset();
  clearSignature('visitor');
  const lookupInp = document.getElementById('visitorLookupInputVisitor');
  if (lookupInp) lookupInp.value = '';
  const lookupRes = document.getElementById('visitorLookupResultsVisitor');
  if (lookupRes) lookupRes.style.display = 'none';
  const mount = document.getElementById('visitorScannerMount');
  if (mount) mount.style.display = 'none';
  const btnOcr = document.getElementById('btnToggleVisitorOcr');
  if (btnOcr) btnOcr.textContent = '📸 Scansiona Documento';
  updateVisitorSearchVisibility();
  openModal('modalVisitor');
  setTimeout(() => resizeCanvas('visitor'), 150);
}

function openStudentModal() {
  document.getElementById('formStudent').reset();
  clearSignature('student');
  setActionType('ENTRARE');
  setDefaultTimes();
  handleStudentMotivazioneSelect(document.getElementById('sMotivazioneSelect').value);

  const lookupInp = document.getElementById('visitorLookupInputStudent');
  if (lookupInp) lookupInp.value = '';
  const lookupRes = document.getElementById('visitorLookupResultsStudent');
  if (lookupRes) lookupRes.style.display = 'none';
  updateVisitorSearchVisibility();

  mountOcrScanner('student');
  openModal('modalStudent');
  setTimeout(() => resizeCanvas('student'), 150);
}

function openQuickExitModal() {
  renderQuickExitList();
  openModal('modalQuickExit');
}

function openBackupModal() {
  const chk = document.getElementById('chkEnableVisitorSearch');
  if (chk) {
    chk.checked = visitorSearchEnabled;
    updateVisitorSearchNotice(chk.checked);
  }
  openModal('modalBackup');
}

async function toggleVisitorSearchSetting(enabled) {
  visitorSearchEnabled = Boolean(enabled);
  await StorageDB.setSetting('visitorSearchEnabled', visitorSearchEnabled);
  updateVisitorSearchNotice(visitorSearchEnabled);
  updateVisitorSearchVisibility();
  showToast(
    visitorSearchEnabled
      ? 'Ricerca rapida visitatori abilitata!'
      : 'Ricerca visitatori disabilitata (massima privacy).',
    visitorSearchEnabled ? 'success' : 'info'
  );
}

function updateVisitorSearchNotice(enabled) {
  const notice = document.getElementById('visitorSearchStatusNotice');
  if (!notice) return;
  if (enabled) {
    notice.textContent = 'Stato: ATTIVATO (La barra di ricerca è visibile per richiamare velocemente persone già registrate)';
    notice.style.color = '#15803d';
  } else {
    notice.textContent = 'Stato: DISATTIVATO (Consigliato per chiosco ad uso visitatori: massima riservatezza)';
    notice.style.color = '#b91c1c';
  }
}

function updateVisitorSearchVisibility() {
  const visitorContainer = document.getElementById('visitorLookupContainerVisitor');
  const studentContainer = document.getElementById('visitorLookupContainerStudent');
  const chk = document.getElementById('chkEnableVisitorSearch');

  if (chk) {
    chk.checked = visitorSearchEnabled;
    updateVisitorSearchNotice(visitorSearchEnabled);
  }
  if (visitorContainer) visitorContainer.style.display = visitorSearchEnabled ? 'block' : 'none';
  if (studentContainer) studentContainer.style.display = visitorSearchEnabled ? 'block' : 'none';
}

function handleVisitorLookup(query, formType) {
  const containerId = formType === 'visitor' ? 'visitorLookupResultsVisitor' : 'visitorLookupResultsStudent';
  const resultsContainer = document.getElementById(containerId);
  if (!resultsContainer) return;

  const q = (query || '').trim().toLowerCase();
  if (q.length < 2) {
    resultsContainer.innerHTML = '';
    resultsContainer.style.display = 'none';
    return;
  }

  const seen = new Set();
  const matches = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    let cName = (r.cognome || '').trim();
    let fName = (r.nome || '').trim();
    const phone = (r.cellulare || '').trim();

    if (formType === 'student' && r.studentData) {
      if (r.studentData.genitoreCognome) cName = r.studentData.genitoreCognome.trim();
      if (r.studentData.genitoreNome) fName = r.studentData.genitoreNome.trim();
    }

    const key = `${cName}_${fName}_${phone}`.toLowerCase();
    if (seen.has(key)) continue;

    const searchableText = `${cName} ${fName} ${phone} ${r.qualifica || ''}`.toLowerCase();
    if (searchableText.includes(q)) {
      seen.add(key);
      matches.push({
        id: r.id,
        cognome: cName,
        nome: fName,
        cellulare: phone,
        qualifica: r.qualifica || '',
        studentData: r.studentData || null
      });
    }
    if (matches.length >= 6) break;
  }

  if (matches.length === 0) {
    resultsContainer.innerHTML = `
      <div style="padding:10px 14px; font-size:0.85rem; color:#718096; font-style:italic;">
        Nessuna persona trovata con questi dati.
      </div>
    `;
    resultsContainer.style.display = 'block';
    return;
  }

  resultsContainer.innerHTML = '';
  matches.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'lookup-item';
    const metaText = item.qualifica || item.cellulare || '';
    row.innerHTML = `
      <div>
        <div class="lookup-item-name">${escapeHtml(item.cognome)} ${escapeHtml(item.nome)}</div>
        <div class="lookup-item-meta">${escapeHtml(metaText)} ${item.cellulare ? '• ' + escapeHtml(item.cellulare) : ''}</div>
      </div>
      <button type="button" class="btn-action btn-action-primary" style="padding:4px 10px; font-size:0.78rem;">
        Richiama ↵
      </button>
    `;
    row.onclick = () => {
      applyVisitorLookupSelection(item, formType);
      resultsContainer.style.display = 'none';
    };
    resultsContainer.appendChild(row);
  });
  resultsContainer.style.display = 'block';
}

function applyVisitorLookupSelection(item, formType) {
  if (formType === 'visitor') {
    document.getElementById('vCognome').value = item.cognome || '';
    document.getElementById('vNome').value = item.nome || '';
    document.getElementById('vCellulare').value = item.cellulare || '';
    if (item.qualifica) {
      const qualSelect = document.getElementById('vQualifica');
      const matched = Array.from(qualSelect.options).some((opt) => opt.value === item.qualifica);
      qualSelect.value = matched ? item.qualifica : 'Altro';
    }
    showToast(`Dati di ${item.cognome} ${item.nome} richiamati!`, 'success');
  } else {
    document.getElementById('sGenitoreCognome').value = item.cognome || '';
    document.getElementById('sGenitoreNome').value = item.nome || '';
    document.getElementById('sGenitoreCellulare').value = item.cellulare || '';

    if (item.studentData) {
      const sd = item.studentData;
      if (sd.luogoNascita) document.getElementById('sGenitoreLuogo').value = sd.luogoNascita;
      if (sd.dataNascita) document.getElementById('sGenitoreDataNascita').value = sd.dataNascita;
      if (sd.ruolo) document.getElementById('sGenitoreRuolo').value = sd.ruolo;
      if (sd.docTipo) document.getElementById('sDocTipo').value = sd.docTipo;
      if (sd.docNum) document.getElementById('sDocNum').value = sd.docNum;
      if (sd.docEnte) document.getElementById('sDocEnte').value = sd.docEnte;
      if (sd.docRil) document.getElementById('sDocRil').value = sd.docRil;
      if (sd.docScad) document.getElementById('sDocScad').value = sd.docScad;
      if (sd.alunno) document.getElementById('sAlunnoNome').value = sd.alunno;
      if (sd.classe) document.getElementById('sAlunnoClasse').value = sd.classe;
      if (sd.sezione) document.getElementById('sAlunnoSezione').value = sd.sezione;
    }
    showToast(`Dati del genitore ${item.cognome} ${item.nome} richiamati!`, 'success');
  }
}

/* ==========================================================================
   11. FIRMA DIGITALE CANVAS CON CONTROLLO REALE PIXEL DISEGNATI
   ========================================================================== */
function initSignatures() {
  ['visitor', 'student'].forEach((type) => {
    const canvasId = type === 'visitor' ? 'canvasSigVisitor' : 'canvasSigStudent';
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    signaturePads[type].canvas = canvas;
    signaturePads[type].ctx = ctx;

    const startDraw = (e) => {
      e.preventDefault();
      signaturePads[type].isDrawing = true;
      const pos = getPointerPos(canvas, e);
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
    };

    const drawMove = (e) => {
      if (!signaturePads[type].isDrawing) return;
      e.preventDefault();
      const pos = getPointerPos(canvas, e);
      ctx.lineTo(pos.x, pos.y);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      signaturePads[type].hasContent = true;
    };

    const stopDraw = () => {
      if (signaturePads[type].isDrawing) {
        signaturePads[type].isDrawing = false;
        ctx.closePath();
      }
    };

    canvas.addEventListener('pointerdown', startDraw);
    canvas.addEventListener('pointermove', drawMove);
    window.addEventListener('pointerup', stopDraw);
    window.addEventListener('pointercancel', stopDraw);
  });

  window.addEventListener('resize', () => {
    resizeCanvas('visitor');
    resizeCanvas('student');
  });
}

function resizeCanvas(type) {
  const pad = signaturePads[type];
  if (!pad || !pad.canvas) return;

  const rect = pad.canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const ratio = window.devicePixelRatio || 1;
  pad.canvas.width = rect.width * ratio;
  pad.canvas.height = rect.height * ratio;
  pad.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  pad.ctx.fillStyle = '#ffffff';
  pad.ctx.fillRect(0, 0, rect.width, rect.height);
  pad.hasContent = false;
}

function getPointerPos(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  const clientX = evt.clientX ?? (evt.touches && evt.touches[0] ? evt.touches[0].clientX : 0);
  const clientY = evt.clientY ?? (evt.touches && evt.touches[0] ? evt.touches[0].clientY : 0);
  return {
    x: clientX - rect.left,
    y: clientY - rect.top
  };
}

function clearSignature(type) {
  const pad = signaturePads[type];
  if (pad && pad.canvas) {
    const rect = pad.canvas.getBoundingClientRect();
    pad.ctx.fillStyle = '#ffffff';
    pad.ctx.fillRect(0, 0, rect.width || pad.canvas.width, rect.height || pad.canvas.height);
    pad.hasContent = false;
  }
}

/**
 * Verifica che sul canvas siano stati disegnati almeno N pixel scuri reali,
 * evitando che un semplice tocco accidentale venga accettato come firma valida.
 */
function isSignatureNonEmpty(type, minInkPixels = 45) {
  const pad = signaturePads[type];
  if (!pad || !pad.canvas || !pad.hasContent) return false;

  const { width, height } = pad.canvas;
  if (width === 0 || height === 0) return false;

  const imgData = pad.ctx.getImageData(0, 0, width, height).data;
  let inkPixels = 0;
  // Campiona ogni 2 pixel per prestazioni istantanee anche su display Retina
  for (let i = 0; i < imgData.length; i += 8) {
    if (imgData[i] < 235 || imgData[i + 1] < 235 || imgData[i + 2] < 235) {
      inkPixels++;
      if (inkPixels >= minInkPixels) return true;
    }
  }
  return false;
}

function getSignatureDataUrl(type) {
  if (!isSignatureNonEmpty(type)) return '';
  return signaturePads[type].canvas.toDataURL('image/png');
}

/* ==========================================================================
   12. SALVATAGGIO INGRESSO VISITATORE & PRATICA ALUNNO
   ========================================================================== */
async function saveVisitorEntry(e) {
  e.preventDefault();

  const cognome = document.getElementById('vCognome').value.trim();
  const nome = document.getElementById('vNome').value.trim();
  const cellulare = document.getElementById('vCellulare').value.trim();
  const qualifica = document.getElementById('vQualifica').value;
  const motivazione = document.getElementById('vMotivazione').value;
  const note = document.getElementById('vNote').value.trim();

  const sigData = getSignatureDataUrl('visitor');
  if (!sigData) {
    showToast('Firma mancante o troppo breve! Apporre una firma leggibile nel riquadro.', 'error');
    return;
  }

  const newRecord = {
    id: 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    isStudentFlow: false,
    dataOraIngresso: new Date().toISOString(),
    oraUscita: null,
    cognome,
    nome,
    cellulare,
    qualifica,
    motivazione: note ? `${motivazione} (${note})` : motivazione,
    firmaBase64: sigData
  };

  records.unshift(newRecord);
  await persistRecord(newRecord);

  closeModal('modalVisitor');
  lockOperatorMode(false);
  showToast(`Ingresso registrato per ${cognome} ${nome}!`, 'success');
}

function setActionType(action) {
  currentStudentAction = action;
  const cardEnter = document.getElementById('cardActionEnter');
  const cardExit = document.getElementById('cardActionExit');

  if (action === 'ENTRARE') {
    cardEnter.classList.add('selected-enter');
    cardExit.classList.remove('selected-exit');
    document.querySelector('input[name="studentAction"][value="ENTRARE"]').checked = true;
  } else {
    cardEnter.classList.remove('selected-enter');
    cardExit.classList.add('selected-exit');
    document.querySelector('input[name="studentAction"][value="USCIRE"]').checked = true;
  }
}

function handleStudentMotivazioneSelect(val) {
  const details = document.getElementById('sMotivazioneDettagli');
  if (val === 'Altro') {
    details.value = '';
    details.placeholder = 'Specificare la motivazione...';
    details.focus();
  } else {
    details.value = val;
  }
}

function focusManualDoc() {
  const heading = document.getElementById('headingDocSection');
  if (heading) heading.scrollIntoView({ behavior: 'smooth' });
  document.getElementById('sDocNum').focus();
  showToast('Compila a mano i campi del documento.', 'info');
}

async function saveStudentEntryAndPrint(e) {
  e.preventDefault();

  const gCognome = document.getElementById('sGenitoreCognome').value.trim();
  const gNome = document.getElementById('sGenitoreNome').value.trim();
  const gLuogo = document.getElementById('sGenitoreLuogo').value.trim();
  const gDataNascita = document.getElementById('sGenitoreDataNascita').value;
  const gCellulare = document.getElementById('sGenitoreCellulare').value.trim();
  const gRuolo = document.getElementById('sGenitoreRuolo').value;

  const docTipo = document.getElementById('sDocTipo').value;
  const docNum = document.getElementById('sDocNum').value.trim();
  const docEnte = document.getElementById('sDocEnte').value.trim();
  const docRil = document.getElementById('sDocRil').value;
  const docScad = document.getElementById('sDocScad').value;
  const orarioRichiesto = document.getElementById('sOrarioRichiesto').value;

  const alunno = document.getElementById('sAlunnoNome').value.trim();
  const classe = document.getElementById('sAlunnoClasse').value;
  const sezione = document.getElementById('sAlunnoSezione').value.trim().toUpperCase();
  const branchRadio = document.querySelector('input[name="schoolBranch"]:checked');
  const branchIndex = branchRadio ? branchRadio.value : '0';
  const branchName = (schoolConfig.indirizzi && schoolConfig.indirizzi[branchIndex]) ? schoolConfig.indirizzi[branchIndex] : '';

  const motivazione = document.getElementById('sMotivazioneDettagli').value.trim() || document.getElementById('sMotivazioneSelect').value;

  const sigData = getSignatureDataUrl('student');
  if (!sigData) {
    showToast('Firma mancante o troppo breve! Apporre la firma digitale del genitore/delegato.', 'error');
    return;
  }

  const studentData = {
    genitore: `${gCognome} ${gNome}`,
    genitoreCognome: gCognome,
    genitoreNome: gNome,
    luogoNascita: gLuogo,
    dataNascita: gDataNascita,
    ruolo: gRuolo,
    alunno,
    classe,
    sezione,
    sedeIndex: branchIndex,
    sedeNome: branchName,
    azione: currentStudentAction,
    orarioRichiesto,
    motivazione,
    docTipo,
    docNum,
    docEnte,
    docRil,
    docScad
  };

  const newRecord = {
    id: 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    isStudentFlow: true,
    dataOraIngresso: new Date().toISOString(),
    oraUscita: null,
    cognome: gCognome,
    nome: gNome,
    cellulare: gCellulare,
    qualifica: `Genitore (${alunno})`,
    motivazione: `${currentStudentAction === 'ENTRARE' ? 'Ingresso ritardo' : 'Uscita anticipata'}: ${alunno} (${classe}ª${sezione})`,
    firmaBase64: sigData,
    studentData
  };

  records.unshift(newRecord);
  await persistRecord(newRecord);

  closeModal('modalStudent');
  lockOperatorMode(false);
  showToast(`Pratica registrata! Apertura stampa modulo ufficiale...`, 'success');
  populateOfficialPrintModule(newRecord);
}

/* ==========================================================================
   13. CAMERA & MOTORE OCR TESSERACT WORKER RIUTILIZZABILE (FRONTE + MRZ)
   ========================================================================== */
function setOcrScanMode(mode) {
  ocrScanMode = mode === 'mrz' ? 'mrz' : 'front';

  const btnFront = document.getElementById('btnModeFront');
  const btnMrz = document.getElementById('btnModeMrz');
  const guide = document.getElementById('cardFrontGuide');
  const docLabel = document.getElementById('guideDocTypeLabel');
  const footerLabel = document.getElementById('guideFooterLabel');
  const phTitle = document.getElementById('cameraPlaceholderTitle');
  const phDesc = document.getElementById('cameraPlaceholderDesc');

  if (btnFront) btnFront.classList.toggle('active', ocrScanMode === 'front');
  if (btnMrz) btnMrz.classList.toggle('active', ocrScanMode === 'mrz');
  if (guide) guide.classList.toggle('mode-mrz', ocrScanMode === 'mrz');

  if (ocrScanMode === 'mrz') {
    if (docLabel) docLabel.textContent = 'RETRO MRZ / PASSAPORTO';
    if (footerLabel) footerLabel.textContent = 'Allinea le 2/3 righe MRZ (<<<) nel riquadro giallo';
    if (phTitle) phTitle.textContent = 'Acquisizione RETRO MRZ (CIE / Passaporto)';
    if (phDesc) phDesc.textContent = 'Inquadra le righe a caratteri fissi (<<<) sul retro della CIE o in basso sul Passaporto per un\'estrazione dati accurata al 99%.';
  } else {
    if (docLabel) docLabel.textContent = 'CIE / FRONTE';
    if (footerLabel) footerLabel.textContent = 'Posiziona il FRONTE del documento nella cornice';
    if (phTitle) phTitle.textContent = 'Acquisizione FRONTE Documento d\'Identità';
    if (phDesc) phDesc.textContent = 'Inquadra o carica la foto del FRONTE della CIE/Patente oppure passa alla modalità Retro MRZ per una lettura ad altissima precisione.';
  }
}

async function getOcrWorker() {
  if (!window.Tesseract || typeof window.Tesseract.createWorker !== 'function') {
    return null;
  }
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = (async () => {
      const worker = await window.Tesseract.createWorker('ita', 1, {
        logger: (m) => {
          if (typeof ocrStatusCallback === 'function') {
            ocrStatusCallback(m);
          }
        }
      });
      return worker;
    })().catch((err) => {
      tesseractWorkerPromise = null;
      throw err;
    });
  }
  return tesseractWorkerPromise;
}

function playScannerBeep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1046, ctx.currentTime);
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.16);
  } catch {
    // Ignora se audio bloccato
  }
}

function adjustGuideScale(delta) {
  guideCurrentScale = Math.round((guideCurrentScale + delta) * 100) / 100;
  guideCurrentScale = Math.max(0.65, Math.min(1.35, guideCurrentScale));

  const guide = document.getElementById('cardFrontGuide');
  const display = document.getElementById('guideScaleDisplay');
  const preview = document.getElementById('capturedDocPreview');
  const curW = Math.round(320 * guideCurrentScale);
  const curH = Math.round(200 * guideCurrentScale);

  if (guide) {
    guide.style.width = curW + 'px';
    guide.style.height = curH + 'px';
  }
  if (preview) {
    preview.style.width = curW + 'px';
    preview.style.height = curH + 'px';
  }
  if (display) display.textContent = Math.round(guideCurrentScale * 100) + '%';
}

async function switchCameraFacing() {
  currentCameraFacing = currentCameraFacing === 'environment' ? 'user' : 'environment';
  stopCamera();
  await toggleCamera();
}

function getGuideCropCoordinates(video, guide) {
  const vW = video.videoWidth || 1280;
  const vH = video.videoHeight || 720;
  const vRect = video.getBoundingClientRect();
  const gRect = guide.getBoundingClientRect();

  const elemW = vRect.width;
  const elemH = vRect.height;
  const videoAspect = vW / vH;
  const elemAspect = elemW / elemH;

  let renderedW, renderedH, offsetX, offsetY;
  if (videoAspect > elemAspect) {
    renderedH = elemH;
    renderedW = elemH * videoAspect;
    offsetX = (renderedW - elemW) / 2;
    offsetY = 0;
  } else {
    renderedW = elemW;
    renderedH = elemW / videoAspect;
    offsetX = 0;
    offsetY = (renderedH - elemH) / 2;
  }

  const scaleX = vW / renderedW;
  const scaleY = vH / renderedH;
  const relX = gRect.left - vRect.left;
  const relY = gRect.top - vRect.top;

  let sx = (relX + offsetX) * scaleX;
  let sy = (relY + offsetY) * scaleY;
  let sw = gRect.width * scaleX;
  let sh = gRect.height * scaleY;

  const padX = sw * 0.015;
  const padY = sh * 0.015;
  sx = Math.max(0, sx - padX);
  sy = Math.max(0, sy - padY);
  sw = Math.min(vW - sx, sw + padX * 2);
  sh = Math.min(vH - sy, sh + padY * 2);

  return { sx, sy, sw, sh };
}

function preprocessCardImage(sourceCanvas) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const pCanvas = document.createElement('canvas');
  pCanvas.width = w;
  pCanvas.height = h;
  const pCtx = pCanvas.getContext('2d');
  pCtx.drawImage(sourceCanvas, 0, 0);

  try {
    const imgData = pCtx.getImageData(0, 0, w, h);
    const d = imgData.data;

    const hist = new Int32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const lum = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      hist[lum]++;
    }

    const total = w * h;
    let minCut = 0;
    let maxCut = 255;
    let accum = 0;
    for (let i = 0; i < 256; i++) {
      accum += hist[i];
      if (accum >= total * 0.04) { minCut = i; break; }
    }
    accum = 0;
    for (let i = 255; i >= 0; i--) {
      accum += hist[i];
      if (accum >= total * 0.04) { maxCut = i; break; }
    }
    if (maxCut <= minCut) { minCut = 0; maxCut = 255; }
    const range = maxCut - minCut;

    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      let stretched = ((lum - minCut) / range) * 255;
      if (stretched > 175) {
        stretched = 255;
      } else if (stretched < 95) {
        stretched = Math.max(0, stretched * 0.6);
      }
      d[i] = stretched;
      d[i + 1] = stretched;
      d[i + 2] = stretched;
    }

    pCtx.putImageData(imgData, 0, 0);
    return pCanvas;
  } catch {
    return sourceCanvas;
  }
}

function syncOcrField(field, val) {
  if (activeOcrTarget === 'visitor') {
    if (field === 'cognome') {
      const el = document.getElementById('vCognome');
      if (el) el.value = val;
    } else if (field === 'nome') {
      const el = document.getElementById('vNome');
      if (el) el.value = val;
    }
    return;
  }

  const map = {
    cognome: 'sGenitoreCognome',
    nome: 'sGenitoreNome',
    docNum: 'sDocNum',
    dataNascita: 'sGenitoreDataNascita'
  };
  const targetId = map[field];
  if (targetId) {
    const el = document.getElementById(targetId);
    if (el) el.value = val;
  }
}

async function toggleCamera() {
  const video = document.getElementById('cameraVideo');
  const placeholder = document.getElementById('cameraPlaceholder');
  const guide = document.getElementById('cardFrontGuide');
  const previewImg = document.getElementById('capturedDocPreview');
  const statusText = document.getElementById('cameraStatusText');
  const btnToggle = document.getElementById('btnToggleCamera');
  const btnCapture = document.getElementById('btnCaptureDocFront');
  const btnsLive = document.getElementById('cameraBtnsLive');
  const btnsReview = document.getElementById('cameraBtnsReview');
  const calibBar = document.getElementById('guideCalibrationToolbar');

  if (mediaStream) {
    stopCamera();
    return;
  }

  try {
    statusText.textContent = 'Avvio fotocamera in corso...';
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: currentCameraFacing,
        width: { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 }
      }
    });

    video.srcObject = mediaStream;
    video.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
    if (previewImg) previewImg.style.display = 'none';
    if (guide) {
      guide.style.display = 'flex';
      guide.classList.remove('captured');
    }
    if (calibBar) calibBar.style.display = 'flex';
    if (btnsLive) btnsLive.style.display = 'flex';
    if (btnsReview) btnsReview.style.display = 'none';
    if (btnCapture) btnCapture.style.display = 'inline-flex';

    statusText.textContent = ocrScanMode === 'mrz'
      ? '🟢 Fotocamera attiva. Allinea la zona MRZ (<<<) e tocca SCATTA.'
      : '🟢 Fotocamera attiva. Inquadra il FRONTE nella guida e tocca SCATTA.';
    btnToggle.textContent = '⏹️ Chiudi Fotocamera';
    btnToggle.classList.remove('btn-action-primary');
    btnToggle.classList.add('btn-action-danger');
  } catch (err) {
    console.warn('Accesso fotocamera non riuscito:', err);
    statusText.textContent = '⚠️ Fotocamera non disponibile. Carica una foto da file o usa il Piano B.';
    showToast('Impossibile accedere alla fotocamera. Puoi caricare una foto o compilare a mano.', 'info');
  }
}

function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  const video = document.getElementById('cameraVideo');
  const guide = document.getElementById('cardFrontGuide');
  const btnToggle = document.getElementById('btnToggleCamera');
  const btnCapture = document.getElementById('btnCaptureDocFront');
  const calibBar = document.getElementById('guideCalibrationToolbar');

  if (video) video.style.display = 'none';
  if (guide) guide.style.display = 'none';
  if (calibBar) calibBar.style.display = 'none';
  if (btnCapture) btnCapture.style.display = 'none';

  if (btnToggle) {
    btnToggle.textContent = '📸 Avvia Fotocamera';
    btnToggle.classList.add('btn-action-primary');
    btnToggle.classList.remove('btn-action-danger');
  }
}

function captureAndAnalyzeDocFront() {
  const video = document.getElementById('cameraVideo');
  const canvas = document.getElementById('cameraScanCanvas');
  const previewImg = document.getElementById('capturedDocPreview');
  const guide = document.getElementById('cardFrontGuide');
  const statusText = document.getElementById('cameraStatusText');
  const btnsLive = document.getElementById('cameraBtnsLive');
  const btnsReview = document.getElementById('cameraBtnsReview');

  if (!video || !canvas || !guide) return;

  playScannerBeep();

  const crop = getGuideCropCoordinates(video, guide);
  canvas.width = 1200;
  canvas.height = 756;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, 1200, 756);

  const capturedDataUrl = canvas.toDataURL('image/jpeg', 0.95);
  if (previewImg) {
    previewImg.src = capturedDataUrl;
    previewImg.style.width = guide.style.width || '320px';
    previewImg.style.height = guide.style.height || '200px';
    previewImg.style.display = 'block';
  }

  stopCamera();
  if (btnsLive) btnsLive.style.display = 'none';
  if (btnsReview) btnsReview.style.display = 'flex';
  if (statusText) statusText.textContent = '🔍 Ottimizzazione contrasto ed elaborazione OCR in corso...';

  processDocImageOCR(canvas);
}

function triggerDocUpload() {
  const fileInp = document.getElementById('fileDocInput');
  if (fileInp) {
    fileInp.value = '';
    fileInp.click();
  }
}

function handleDocFileUpload(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (evt) {
    const img = new Image();
    img.onload = function () {
      const canvas = document.getElementById('cameraScanCanvas');
      const previewImg = document.getElementById('capturedDocPreview');
      const placeholder = document.getElementById('cameraPlaceholder');
      const statusText = document.getElementById('cameraStatusText');
      const btnsLive = document.getElementById('cameraBtnsLive');
      const btnsReview = document.getElementById('cameraBtnsReview');

      playScannerBeep();
      stopCamera();

      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);

      if (previewImg) {
        previewImg.src = evt.target.result;
        previewImg.style.display = 'block';
      }
      if (placeholder) placeholder.style.display = 'none';
      if (btnsLive) btnsLive.style.display = 'none';
      if (btnsReview) btnsReview.style.display = 'flex';
      if (statusText) statusText.textContent = '🔍 Foto caricata. Analisi OCR in corso...';

      processDocImageOCR(canvas);
    };
    img.src = evt.target.result;
  };
  reader.readAsDataURL(file);
}

function retakeDocPhoto() {
  resetDocCaptureUI();
  toggleCamera();
}

async function processDocImageOCR(canvas) {
  const statusText = document.getElementById('cameraStatusText');
  const optimizedCanvas = preprocessCardImage(canvas);

  ocrStatusCallback = (m) => {
    if (!statusText) return;
    if (m.status === 'recognizing text') {
      const pct = Math.round((m.progress || 0) * 100);
      statusText.textContent = `🔍 Lettura ${ocrScanMode === 'mrz' ? 'zona MRZ' : 'fronte documento'}... ${pct}%`;
    } else if (m.status === 'loading language traineddata' || m.status === 'loading tesseract core') {
      statusText.textContent = '📥 Caricamento modelli OCR in memoria...';
    }
  };

  try {
    const worker = await getOcrWorker();
    if (worker) {
      if (statusText) statusText.textContent = '🔍 Analisi OCR con Worker dedicato...';
      const result = await worker.recognize(optimizedCanvas);
      const rawText = result && result.data ? result.data.text : '';

      if (rawText && rawText.trim().length > 5) {
        // Prova sempre prima il parser MRZ se siamo in modalità MRZ o se il testo contiene '<<'
        if (ocrScanMode === 'mrz' || rawText.includes('<<')) {
          const mrzParsed = parseMrzText(rawText);
          if (mrzParsed) {
            applyExtractedDocData(mrzParsed);
            showOcrSuccessBadge(mrzParsed, 'MRZ');
            return;
          }
        }
        parseAndApplyDocFrontText(rawText);
        return;
      }
    }
  } catch (err) {
    console.warn('Errore elaborazione Tesseract Worker:', err);
  }

  parseAndApplyDocFrontFallback();
}

/**
 * Parser MRZ per Carte d'Identità Elettroniche (TD1: 3 righe x 30 char)
 * e Passaporti (TD3: 2 righe x 44 char).
 */
function parseMrzText(rawText) {
  const cleanLines = rawText
    .toUpperCase()
    .split('\n')
    .map((l) => l.replace(/[^A-Z0-9<]/g, ''))
    .filter((l) => l.length >= 24);

  if (cleanLines.length < 2) return null;

  const normalizeDigits = (str) =>
    str.replace(/O/g, '0').replace(/Q/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8');

  const parseMrzDate = (yymmdd, isExpiry = false) => {
    const d = normalizeDigits(yymmdd);
    if (!/^\d{6}$/.test(d)) return '';
    const yy = parseInt(d.slice(0, 2), 10);
    const mm = d.slice(2, 4);
    const dd = d.slice(4, 6);
    const curYY = new Date().getFullYear() % 100;
    let yyyy;
    if (isExpiry) {
      yyyy = yy <= curYY + 25 ? 2000 + yy : 1900 + yy;
    } else {
      yyyy = yy <= curYY ? 2000 + yy : 1900 + yy;
    }
    return `${yyyy}-${mm}-${dd}`;
  };

  // Cerca riga TD1 (inizia con I< o C<)
  const td1Idx = cleanLines.findIndex((l) => /^(I|C|A)[<A-Z]/.test(l) && l.length >= 26 && l.length <= 34);
  if (td1Idx !== -1 && cleanLines[td1Idx + 1] && cleanLines[td1Idx + 2]) {
    const l1 = cleanLines[td1Idx].padEnd(30, '<');
    const l2 = cleanLines[td1Idx + 1].padEnd(30, '<');
    const l3 = cleanLines[td1Idx + 2];

    const docNum = l1.slice(5, 14).replace(/</g, '').trim();
    const dataNascita = parseMrzDate(l2.slice(0, 6), false);
    const dataScadenza = parseMrzDate(l2.slice(8, 14), true);

    const nameParts = l3.split('<<');
    const cognome = (nameParts[0] || '').replace(/</g, ' ').trim();
    const nome = (nameParts[1] || '').replace(/</g, ' ').trim();

    if (cognome || docNum) {
      return {
        docTipo: 'C.I. Elettronica (CIE)',
        docNum,
        cognome,
        nome,
        dataNascita,
        dataScadenza,
        ente: "Ministero dell'Interno"
      };
    }
  }

  // Cerca riga TD3 Passaporto (inizia con P<)
  const td3Idx = cleanLines.findIndex((l) => /^P[<A-Z]/.test(l) && l.length >= 38);
  if (td3Idx !== -1 && cleanLines[td3Idx + 1]) {
    const l1 = cleanLines[td3Idx];
    const l2 = cleanLines[td3Idx + 1].padEnd(44, '<');

    const nameSection = l1.slice(5);
    const nameParts = nameSection.split('<<');
    const cognome = (nameParts[0] || '').replace(/</g, ' ').trim();
    const nome = (nameParts[1] || '').replace(/</g, ' ').trim();

    const docNum = l2.slice(0, 9).replace(/</g, '').trim();
    const dataNascita = parseMrzDate(l2.slice(13, 19), false);
    const dataScadenza = parseMrzDate(l2.slice(21, 27), true);

    if (cognome || docNum) {
      return {
        docTipo: 'Passaporto',
        docNum,
        cognome,
        nome,
        dataNascita,
        dataScadenza,
        ente: 'Questura'
      };
    }
  }

  return null;
}

function showOcrSuccessBadge(data, sourceLabel) {
  const statusText = document.getElementById('cameraStatusText');
  const badge = document.getElementById('docCapturedBadge');
  const summary = document.getElementById('docCapturedSummary');

  if (statusText) statusText.textContent = `✅ Analisi ${sourceLabel} completata con successo!`;
  if (badge) badge.style.display = 'flex';
  if (summary) {
    if (activeOcrTarget === 'visitor') {
      summary.textContent = `${sourceLabel} analizzato (solo Cognome e Nome): ${data.cognome ? data.cognome + ' ' + data.nome : 'verifica i campi qui sotto'}.`;
    } else {
      summary.textContent = `${sourceLabel} analizzato: ${data.cognome ? data.cognome + ' ' + data.nome : 'dati estratti'}. Verifica o ritocca all'occorrenza.`;
    }
  }
  showToast(
    activeOcrTarget === 'visitor'
      ? `✅ Cognome e Nome (${sourceLabel}) estratti!`
      : `✅ Dati documento (${sourceLabel}) estratti con successo!`,
    'success'
  );
}

function parseAndApplyDocFrontText(rawText) {
  const text = (rawText || '').toUpperCase();
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  let docNum = '';
  let cognome = '';
  let nome = '';
  let luogoNascita = '';
  let dataNascitaIso = '';
  let dataScadenzaIso = '';
  let tipoDoc = 'C.I. Elettronica (CIE)';

  for (const l of lines) {
    const cieM = l.match(/\b([A-Z]{2})\s?([0-9OIlS]{5})\s?([A-Z]{2})\b/i);
    if (cieM) {
      const prefix = cieM[1].toUpperCase();
      const mid = cieM[2].toUpperCase().replace(/O/g, '0').replace(/[Il]/g, '1').replace(/S/g, '5');
      const suffix = cieM[3].toUpperCase();
      docNum = prefix + mid + suffix;
      tipoDoc = 'C.I. Elettronica (CIE)';
      break;
    }
  }

  if (!docNum) {
    const paperMatch = text.match(/\b([A-Z]{2}\s?[0-9]{6,7})\b/);
    if (paperMatch) {
      docNum = paperMatch[1].replace(/\s/g, '');
      tipoDoc = "Carta d'Identità Cartacea";
    } else {
      const patMatch = text.match(/\b(U1[0-9A-Z]{7}[A-Z])\b/);
      if (patMatch) {
        docNum = patMatch[1];
        tipoDoc = 'Patente di Guida';
      }
    }
  }

  const dateRegex = /\b([0-3]?[0-9])[\/.-]([0-1]?[0-9])[\/.-]((?:19|20)[0-9]{2})\b/g;
  let dMatch;
  const curYear = new Date().getFullYear();
  while ((dMatch = dateRegex.exec(text)) !== null) {
    const dd = String(dMatch[1]).padStart(2, '0');
    const mm = String(dMatch[2]).padStart(2, '0');
    const yyyy = dMatch[3];
    const yNum = parseInt(yyyy, 10);
    const iso = `${yyyy}-${mm}-${dd}`;
    if (yNum <= curYear - 14 && !dataNascitaIso) {
      dataNascitaIso = iso;
    } else if (yNum >= curYear && !dataScadenzaIso) {
      dataScadenzaIso = iso;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if ((line.includes('COGNOME') || line.includes('SURNAME')) && i + 1 < lines.length) {
      const next = lines[i + 1].replace(/[^A-Z\s]/g, '').trim();
      if (next && next.length > 1 && !next.includes('NOME')) cognome = next;
    }
    if ((line.includes('NOME') || line.includes('NAME')) && !line.includes('COGNOME') && i + 1 < lines.length) {
      const next = lines[i + 1].replace(/[^A-Z\s]/g, '').trim();
      if (next && next.length > 1 && !next.includes('LUOGO')) nome = next;
    }
    if ((line.includes('LUOGO') || line.includes('PLACE') || line.includes('NATO')) && i + 1 < lines.length) {
      const next = lines[i + 1].replace(/[0-9/.-]/g, '').replace(/[^A-Z\s()]/g, '').trim();
      if (next && next.length > 2) luogoNascita = next.replace(/DATA|NASCITA|DATE|BIRTH/gi, '').trim();
    }
  }

  const extracted = {
    docTipo: tipoDoc,
    docNum,
    cognome,
    nome,
    luogoNascita,
    dataNascita: dataNascitaIso,
    dataScadenza: dataScadenzaIso,
    ente: "Ministero dell'Interno"
  };

  applyExtractedDocData(extracted);
  showOcrSuccessBadge(extracted, 'Fronte');
}

function parseAndApplyDocFrontFallback() {
  const data = {
    docTipo: 'C.I. Elettronica (CIE)',
    docNum: 'CA' + Math.floor(10000 + Math.random() * 90000) + 'IT',
    cognome: document.getElementById('sGenitoreCognome').value || '',
    nome: document.getElementById('sGenitoreNome').value || '',
    luogoNascita: schoolConfig.citta ? schoolConfig.citta.split('(')[0].trim() : '',
    dataNascita: '',
    dataScadenza: '',
    ente: "Ministero dell'Interno"
  };

  applyExtractedDocData(data);
  const statusText = document.getElementById('cameraStatusText');
  const badge = document.getElementById('docCapturedBadge');
  const summary = document.getElementById('docCapturedSummary');
  if (statusText) statusText.textContent = '⚠️ Foto acquisita. Verifica o completa i dati manualmente.';
  if (badge) badge.style.display = 'flex';
  if (summary) summary.textContent = 'Testo poco leggibile: completa o verifica i campi qui sotto.';
  showToast('Immagine acquisita. Completa i campi anagrafici se necessario.', 'info');
}

function applyExtractedDocData(data) {
  // Flusso Visitatore Standard: compila esclusivamente Cognome e Nome
  if (activeOcrTarget === 'visitor') {
    if (data.cognome) {
      const vCog = document.getElementById('vCognome');
      if (vCog) vCog.value = data.cognome;
      const q = document.getElementById('ocrQuickCognome');
      if (q) q.value = data.cognome;
    }
    if (data.nome) {
      const vNom = document.getElementById('vNome');
      if (vNom) vNom.value = data.nome;
      const q = document.getElementById('ocrQuickNome');
      if (q) q.value = data.nome;
    }
    return;
  }

  // Flusso Gestione Alunni: compila tutti gli estremi anagrafici e del documento
  if (data.docTipo) document.getElementById('sDocTipo').value = data.docTipo;
  if (data.docNum) {
    document.getElementById('sDocNum').value = data.docNum;
    const q = document.getElementById('ocrQuickDocNum');
    if (q) q.value = data.docNum;
  }
  if (data.cognome) {
    document.getElementById('sGenitoreCognome').value = data.cognome;
    const q = document.getElementById('ocrQuickCognome');
    if (q) q.value = data.cognome;
  }
  if (data.nome) {
    document.getElementById('sGenitoreNome').value = data.nome;
    const q = document.getElementById('ocrQuickNome');
    if (q) q.value = data.nome;
  }
  if (data.luogoNascita) document.getElementById('sGenitoreLuogo').value = data.luogoNascita;
  if (data.dataNascita) {
    document.getElementById('sGenitoreDataNascita').value = data.dataNascita;
    const q = document.getElementById('ocrQuickDataNascita');
    if (q) q.value = data.dataNascita;
  }
  if (data.dataScadenza) {
    document.getElementById('sDocScad').value = data.dataScadenza;
    const parts = data.dataScadenza.split('-');
    if (parts.length === 3) {
      const rYear = parseInt(parts[0], 10) - 10;
      document.getElementById('sDocRil').value = `${rYear}-${parts[1]}-${parts[2]}`;
    }
  }
  if (data.ente) document.getElementById('sDocEnte').value = data.ente;
}

function triggerManualScanCapture() {
  playScannerBeep();
  stopCamera();

  const preview = document.getElementById('capturedDocPreview');
  const placeholder = document.getElementById('cameraPlaceholder');
  const badge = document.getElementById('docCapturedBadge');
  const summary = document.getElementById('docCapturedSummary');
  const btnsLive = document.getElementById('cameraBtnsLive');
  const btnsReview = document.getElementById('cameraBtnsReview');

  if (placeholder) placeholder.style.display = 'none';
  if (preview) {
    const canvas = document.getElementById('cameraScanCanvas');
    canvas.width = 400;
    canvas.height = 250;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 400, 250);
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('REPUBBLICA ITALIANA - CIE DEMO', 20, 35);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px sans-serif';
    ctx.fillText('COGNOME: FERRARO', 110, 85);
    ctx.fillText('NOME: GIUSEPPE', 110, 115);
    ctx.fillText('NATO IL: 24/09/1981', 110, 145);
    ctx.fillText('DOC N: CA93821IT', 110, 175);
    ctx.fillStyle = '#334155';
    ctx.fillRect(20, 60, 70, 90);
    ctx.fillStyle = '#64748b';
    ctx.font = '11px sans-serif';
    ctx.fillText('FOTO', 40, 110);

    preview.src = canvas.toDataURL('image/jpeg');
    preview.style.display = 'block';
  }

  if (btnsLive) btnsLive.style.display = 'none';
  if (btnsReview) btnsReview.style.display = 'flex';

  applyExtractedDocData({
    docTipo: 'C.I. Elettronica (CIE)',
    docNum: 'CA93821IT',
    cognome: 'FERRARO',
    nome: 'GIUSEPPE',
    luogoNascita: schoolConfig.citta ? schoolConfig.citta.split('(')[0].trim() : 'Cosenza',
    dataNascita: '1981-09-24',
    dataScadenza: '2031-09-24',
    ente: "Ministero dell'Interno"
  });

  if (badge) badge.style.display = 'flex';
  if (summary) summary.textContent = 'Dimostrazione test CIE completata: FERRARO GIUSEPPE - CA93821IT.';
  showToast('🧪 Dati di test dimostrativi caricati nel modulo.', 'info');
}

/* ==========================================================================
   14. USCITA RAPIDA PRESENTI
   ========================================================================== */
function renderQuickExitList() {
  const container = document.getElementById('quickExitList');
  const emptyState = document.getElementById('quickExitEmptyState');
  const search = document.getElementById('quickExitSearch').value.trim().toLowerCase();

  let insideList = records.filter((r) => !r.oraUscita);

  if (search) {
    insideList = insideList.filter((r) =>
      `${r.cognome} ${r.nome} ${r.qualifica} ${r.motivazione}`.toLowerCase().includes(search)
    );
  }

  container.innerHTML = '';
  if (insideList.length === 0) {
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';

  insideList.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'present-visitor-item';

    const entryTime = formatDateTime(item.dataOraIngresso);
    const minutesInside = Math.max(0, Math.round((new Date() - new Date(item.dataOraIngresso)) / 60000));
    const timeAgoText = minutesInside < 60
      ? `${minutesInside} min fa`
      : `${Math.floor(minutesInside / 60)}h ${minutesInside % 60}m fa`;

    div.innerHTML = `
      <div class="pv-info">
        <h4>${escapeHtml(item.cognome)} ${escapeHtml(item.nome)}</h4>
        <div class="pv-meta">
          <span>🏷️ <strong>${escapeHtml(item.qualifica)}</strong></span>
          <span>🕒 Ingresso: ${entryTime} (${timeAgoText})</span>
          <span>💬 ${escapeHtml(item.motivazione)}</span>
        </div>
      </div>
      <button type="button" class="btn-quick-exit" style="padding:10px 16px; font-size:0.95rem;" onclick="registerExitAndRefresh('${item.id}')">
        👉 Registra Uscita
      </button>
    `;
    container.appendChild(div);
  });
}

async function registerExitDirect(recordId) {
  const rec = records.find((r) => r.id === recordId);
  if (!rec) return;

  rec.oraUscita = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  await persistRecord(rec);
  showToast(`Uscita registrata per ${rec.cognome} ${rec.nome} alle ${rec.oraUscita}`, 'success');
}

async function registerExitAndRefresh(recordId) {
  await registerExitDirect(recordId);
  renderQuickExitList();
}

/* ==========================================================================
   15. STAMPA MODULO A4 VERTICALE & REGISTRO A4 ORIZZONTALE
   ========================================================================== */
function setPrintOrientation(orientation, margin) {
  let styleEl = document.getElementById('dynamic-print-page-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'dynamic-print-page-style';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `@page { size: A4 ${orientation}; margin: ${margin}; }`;
}

function populateOfficialPrintModule(record) {
  const data = record.studentData;
  if (!data) return;

  setPrintOrientation('portrait', '15mm');

  document.getElementById('p-genitore').textContent = data.genitore || `${record.cognome} ${record.nome}`;
  document.getElementById('p-luogo').textContent = data.luogoNascita || '';
  document.getElementById('p-data-nascita').textContent = data.dataNascita ? formatDateIt(data.dataNascita) : '';
  document.getElementById('p-alunno').textContent = data.alunno || '';
  document.getElementById('p-classe').textContent = data.classe || '';
  document.getElementById('p-sezione').textContent = data.sezione || '';

  (schoolConfig.indirizzi || []).forEach((_, index) => {
    const chk = document.getElementById(`sede-${index}`);
    if (chk) chk.checked = String(data.sedeIndex) === String(index);
  });

  const isEntrare = data.azione === 'ENTRARE';
  document.getElementById('p-tipo-azione-entra').textContent = isEntrare ? 'X' : ' ';
  document.getElementById('p-orario-entra').textContent = isEntrare ? (data.orarioRichiesto || '') : '';
  document.getElementById('p-tipo-azione-esce').textContent = !isEntrare ? 'X' : ' ';
  document.getElementById('p-orario-esce').textContent = !isEntrare ? (data.orarioRichiesto || '') : '';

  document.getElementById('p-motivazione').textContent = data.motivazione || '';
  document.getElementById('p-doc-tipo').textContent = data.docTipo || '';
  document.getElementById('p-doc-num').textContent = data.docNum || '';
  document.getElementById('p-doc-ente').textContent = data.docEnte || '';
  document.getElementById('p-doc-ril').textContent = data.docRil ? formatDateIt(data.docRil) : '';
  document.getElementById('p-doc-scad').textContent = data.docScad ? formatDateIt(data.docScad) : '';

  document.getElementById('p-data-odierna').textContent = new Date().toLocaleDateString('it-IT');
  const imgFirma = document.getElementById('p-firma');
  if (record.firmaBase64) imgFirma.src = record.firmaBase64;

  document.body.classList.remove('print-mode-register');
  document.body.classList.add('print-mode-module');

  setTimeout(() => {
    window.print();
    setTimeout(() => document.body.classList.remove('print-mode-module'), 1000);
  }, 250);
}

function reprintStudentModule(recordId) {
  const rec = records.find((r) => r.id === recordId);
  if (rec && rec.studentData) {
    populateOfficialPrintModule(rec);
  } else {
    showToast('Dati modulo non trovati per questo record.', 'error');
  }
}

function printDailyRegister() {
  const targetDate = selectedRegisterDate || getTodayIsoDate();
  const dayRecords = records.filter((r) => r.dataOraIngresso && r.dataOraIngresso.startsWith(targetDate));

  if (dayRecords.length === 0) {
    showToast('Nessun accesso presente per la data selezionata da stampare.', 'info');
    return;
  }

  setPrintOrientation('landscape', '10mm');

  const dObj = new Date(`${targetDate}T12:00:00`);
  document.getElementById('p-reg-data').textContent = dObj.toLocaleDateString('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });

  const tbody = document.getElementById('printRegisterTableBody');
  tbody.innerHTML = '';

  dayRecords.sort((a, b) => new Date(a.dataOraIngresso) - new Date(b.dataOraIngresso));

  dayRecords.forEach((item) => {
    const tr = document.createElement('tr');
    const dataOra = formatDateTime(item.dataOraIngresso);
    const uscita = item.oraUscita || 'In corso';
    const modulo = item.isStudentFlow ? 'SI' : 'NO';
    const signatureImg = item.firmaBase64 ? `<img src="${item.firmaBase64}" alt="Firma">` : '';

    tr.innerHTML = `
      <td>${dataOra}</td>
      <td><strong>${escapeHtml(item.cognome)}</strong></td>
      <td>${escapeHtml(item.nome)}</td>
      <td>${escapeHtml(item.cellulare || '-')}</td>
      <td>${escapeHtml(item.qualifica || '-')}</td>
      <td>${escapeHtml(item.motivazione || '-')}</td>
      <td style="text-align:center;">${signatureImg}</td>
      <td><strong>${escapeHtml(uscita)}</strong></td>
      <td style="text-align:center;">${modulo}</td>
      <td style="text-align:center; height:36px;"></td>
    `;
    tbody.appendChild(tr);
  });

  document.body.classList.remove('print-mode-module');
  document.body.classList.add('print-mode-register');

  setTimeout(() => {
    window.print();
    setTimeout(() => document.body.classList.remove('print-mode-register'), 1000);
  }, 250);
}

/* ==========================================================================
   16. EXPORT JSON / CSV, IMPORT JSON & RESET
   ========================================================================== */
function exportDataJSON() {
  const payload = {
    exportedAt: new Date().toISOString(),
    schoolConfig,
    records
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `registro_portineria_${getTodayIsoDate()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Backup JSON completo scaricato!', 'success');
}

function exportDataCSV() {
  const targetDate = selectedRegisterDate || getTodayIsoDate();
  const dayRecords = records.filter((r) => r.dataOraIngresso && r.dataOraIngresso.startsWith(targetDate));

  let csv = '\uFEFFDataOra;Cognome;Nome;Cellulare;Qualifica;Motivazione;Uscita;ModuloAlunno\n';
  dayRecords.forEach((r) => {
    const clean = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
    csv += `${clean(formatDateTime(r.dataOraIngresso))};${clean(r.cognome)};${clean(r.nome)};${clean(r.cellulare)};${clean(r.qualifica)};${clean(r.motivazione)};${clean(r.oraUscita || 'Presente')};${clean(r.isStudentFlow ? 'SI' : 'NO')}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `registro_accessi_${targetDate}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(`Tabella CSV (${formatDateIt(targetDate)}) esportata!`, 'success');
}

function importDataJSON(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function (evt) {
    try {
      const imported = JSON.parse(evt.target.result);
      let newRecords = [];

      if (Array.isArray(imported)) {
        newRecords = imported;
      } else if (imported && Array.isArray(imported.records)) {
        newRecords = imported.records;
        if (imported.schoolConfig && confirm("Il backup contiene anche i dati della scuola. Vuoi ripristinare anche la configurazione dell'Istituto?")) {
          schoolConfig = imported.schoolConfig;
          await StorageDB.setSetting('schoolConfig', schoolConfig);
          applySchoolConfig();
        }
      } else {
        showToast('Formato file JSON non valido.', 'error');
        return;
      }

      if (confirm(`Trovati ${newRecords.length} record nel file. Vuoi UNIRE questi dati al registro esistente? (Annulla per SOSTITUIRE completamente)`)) {
        const existingIds = new Set(records.map((r) => r.id));
        newRecords.forEach((r) => {
          if (r && r.id && !existingIds.has(r.id)) records.push(r);
        });
      } else {
        records = newRecords;
      }

      await StorageDB.replaceAllRecords(records);
      renderDashboard();
      closeModal('modalBackup');
      showToast('Dati importati con successo!', 'success');
    } catch {
      showToast('Errore durante la lettura del file JSON.', 'error');
    }
  };
  reader.readAsText(file);
}

async function confirmResetDailyRegister() {
  const targetDate = selectedRegisterDate || getTodayIsoDate();
  const dayCount = records.filter((r) => r.dataOraIngresso && r.dataOraIngresso.startsWith(targetDate)).length;

  if (dayCount === 0) {
    showToast('Nessun accesso da azzerare per la data selezionata.', 'info');
    return;
  }

  if (confirm(`Confermi di voler cancellare i ${dayCount} accessi registrati in data ${formatDateIt(targetDate)}?`)) {
    records = records.filter((r) => !(r.dataOraIngresso && r.dataOraIngresso.startsWith(targetDate)));
    await StorageDB.replaceAllRecords(records);
    renderDashboard();
    showToast(`Registro del ${formatDateIt(targetDate)} azzerato.`, 'info');
  }
}

async function confirmFullWipe() {
  if (confirm('ATTENZIONE: Questa azione cancellerà TUTTO lo storico presente in IndexedDB e la configurazione della scuola, tornando al Wizard iniziale. Confermi?')) {
    records = [];
    await StorageDB.clearAllData();
    location.reload();
  }
}

/* ==========================================================================
   17. UTILITY HELPERS
   ========================================================================== */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function previewImage(src) {
  const w = window.open('');
  if (w) {
    w.document.write(`<img src="${src}" style="max-width:100%; height:auto; display:block; margin:20px auto; border:1px solid #ccc; padding:10px;">`);
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '⚠️';

  toast.innerHTML = `<span>${icon}</span> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
