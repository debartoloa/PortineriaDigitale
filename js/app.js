/**
 * js/app.js - Modulo principale UI, Kiosk, PWA e Gestione Flussi
 * Dipendenze locali: ./storage.js e ./api.js (ES6 Modules nativi, zero build step)
 */

import { StorageDB, hashPin, migrateLegacyLocalStorage } from './storage.js';
import {
  setOcrStatusCallback,
  getGuideCropCoordinates,
  recognizeDocumentCanvas
} from './api.js';
import {
  recognizeWithNextGen,
  evaluateFrameQuality
} from './ocr_nextgen.js';

/* ==========================================================================
   STATO GLOBALE APPLICATIVO
   ========================================================================== */
const APP_VERSION = 'v2.0.0';
let records = [];
let mediaStream = null;
let currentStudentAction = 'ENTRARE';
let guideCurrentScale = 1.0;
let currentCameraFacing = 'environment';
let ocrScanMode = 'front'; // 'front' | 'mrz'
let activeOcrTarget = 'student'; // 'student' | 'visitor'

// Flag Motore OCR Dual-Engine & Quality Gate Live
let ocrEngineMode = 'tesseract'; // 'tesseract' | 'paddle'
let autoCaptureEnabled = true;
let openCvWarpEnabled = false;
let liveQualityIntervalId = null;
let consecutiveGoodFrames = 0;
let isAutoOcrRunning = false;

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
   1. SICUREZZA PIN (WRAPPER SU STORAGE SHA-256)
   ========================================================================== */
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
   2. PWA: SERVICE WORKER, INSTALLAZIONE E STATO CONNESSIONE
   ========================================================================== */
function initPWA() {
  ['appVersionBadge', 'wizardVersionBadge'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = APP_VERSION;
  });

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

  btn.style.display = (deferredInstallPrompt || isIosDevice()) ? 'inline-flex' : 'none';
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
   3. INIZIALIZZAZIONE APPLICAZIONE & NAVIGAZIONE SCHERMATE
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

  const savedHash = await StorageDB.getSetting('pinHash', null);
  const savedLen = await StorageDB.getSetting('pinLength', 4);
  if (!savedHash) {
    await setStoredPin('1234');
  } else {
    storedPinHash = savedHash;
    storedPinLength = savedLen || 4;
  }

  visitorSearchEnabled = Boolean(await StorageDB.getSetting('visitorSearchEnabled', false));
  const savedEngine = await StorageDB.getSetting('ocrEngineMode', 'tesseract');
  ocrEngineMode = savedEngine === 'paddle' ? 'paddle' : 'tesseract';
  autoCaptureEnabled = Boolean(await StorageDB.getSetting('autoCaptureEnabled', true));
  openCvWarpEnabled = Boolean(await StorageDB.getSetting('openCvWarpEnabled', false));
  updateOcrEngineUI();

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
   4. WIZARD CONFIGURAZIONE ISTITUTO
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
    showToast("Questo indirizzo è già presente nell'elenco!", 'info');
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
      .map((ind) => escapeHtml(ind))
      .join(' &bull; ');
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
   5. GESTIONE PIN & PRIVACY SHIELD GDPR
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
   6. PERSISTENZA & UTILITÀ DATA/ORA
   ========================================================================== */
async function persistRecord(record) {
  await StorageDB.putRecord(record, records);
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
   7. DASHBOARD STATS & REGISTRO MULTI-GIORNO
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
   8. MODALI, SCANNER CONDIVISO & LOOKUP VISITATORI
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

  const debugImg = document.getElementById('ocrDebugPreviewImg');
  const debugRaw = document.getElementById('ocrDebugRawText');
  const debugDetails = document.getElementById('ocrDebugDetails');
  if (debugImg) debugImg.removeAttribute('src');
  if (debugRaw) debugRaw.textContent = '';
  if (debugDetails) debugDetails.open = false;
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
   9. FIRMA DIGITALE CANVAS CON CONTROLLO REALE PIXEL DISEGNATI
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

function isSignatureNonEmpty(type, minInkPixels = 45) {
  const pad = signaturePads[type];
  if (!pad || !pad.canvas || !pad.hasContent) return false;

  const { width, height } = pad.canvas;
  if (width === 0 || height === 0) return false;

  const imgData = pad.ctx.getImageData(0, 0, width, height).data;
  let inkPixels = 0;
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
   10. SALVATAGGIO INGRESSO VISITATORE & PRATICA ALUNNO
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
  showToast('Pratica registrata! Apertura stampa modulo ufficiale...', 'success');
  populateOfficialPrintModule(newRecord);
}

/* ==========================================================================
   11. CONTROLLER CAMERA & INTEGRAZIONE MODULO OCR (api.js)
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
    if (phDesc) phDesc.textContent = "Inquadra le righe a caratteri fissi (<<<) sul retro della CIE o in basso sul Passaporto per un'estrazione dati accurata al 99%.";
  } else {
    if (docLabel) docLabel.textContent = 'CIE / FRONTE';
    if (footerLabel) footerLabel.textContent = 'Posiziona il FRONTE del documento nella cornice';
    if (phTitle) phTitle.textContent = "Acquisizione FRONTE Documento d'Identità";
    if (phDesc) phDesc.textContent = 'Inquadra o carica la foto del FRONTE della CIE/Patente oppure passa alla modalità Retro MRZ per una lettura ad altissima precisione.';
  }
}

async function setOcrEngineMode(mode) {
  ocrEngineMode = mode === 'paddle' ? 'paddle' : 'tesseract';
  await StorageDB.setSetting('ocrEngineMode', ocrEngineMode);
  updateOcrEngineUI();

  if (mediaStream) {
    if (ocrEngineMode === 'paddle') {
      startLiveQualityLoop();
    } else {
      stopLiveQualityLoop();
    }
  }

  showToast(
    ocrEngineMode === 'paddle'
      ? '🚀 Motore AI Pro (PaddleOCR ONNX + Quality Gate Live) attivato!'
      : '🔵 Motore Classico (Tesseract.js) attivato!',
    'info'
  );
}

async function toggleAutoCaptureSetting(enabled) {
  autoCaptureEnabled = Boolean(enabled);
  await StorageDB.setSetting('autoCaptureEnabled', autoCaptureEnabled);
}

async function toggleOpenCvWarpSetting(enabled) {
  openCvWarpEnabled = Boolean(enabled);
  await StorageDB.setSetting('openCvWarpEnabled', openCvWarpEnabled);
}

function updateOcrEngineUI() {
  const btnTess = document.getElementById('btnEngineTesseract');
  const btnPaddle = document.getElementById('btnEnginePaddle');
  const aiBar = document.getElementById('aiProOptionsBar');
  const chkAuto = document.getElementById('chkAutoCapture');
  const chkCv = document.getElementById('chkOpenCvWarp');

  if (btnTess) btnTess.classList.toggle('active', ocrEngineMode === 'tesseract');
  if (btnPaddle) btnPaddle.classList.toggle('active', ocrEngineMode === 'paddle');
  if (aiBar) aiBar.style.display = ocrEngineMode === 'paddle' ? 'flex' : 'none';
  if (chkAuto) chkAuto.checked = autoCaptureEnabled;
  if (chkCv) chkCv.checked = openCvWarpEnabled;
}

function stopLiveQualityLoop() {
  if (liveQualityIntervalId) {
    clearInterval(liveQualityIntervalId);
    liveQualityIntervalId = null;
  }
  consecutiveGoodFrames = 0;
  isAutoOcrRunning = false;
  const qgBadge = document.getElementById('qualityGateBadge');
  if (qgBadge) {
    qgBadge.style.display = 'none';
    qgBadge.classList.remove('qg-ok', 'qg-warn');
  }
}

function isAutoResultValid(data) {
  if (!data) return false;
  if (ocrScanMode === 'mrz') {
    return Boolean(data.mrzVerified);
  }
  if (activeOcrTarget === 'visitor') {
    return Boolean(data.cognome && data.nome);
  }
  return Boolean(data.cognome && data.nome && (data.docNum || data.dataNascita));
}

function startLiveQualityLoop() {
  stopLiveQualityLoop();
  if (ocrEngineMode !== 'paddle' || !mediaStream) return;

  const video = document.getElementById('cameraVideo');
  const guide = document.getElementById('cardFrontGuide');
  const qgBadge = document.getElementById('qualityGateBadge');
  if (!video || !guide) return;

  const sampleCanvas = document.createElement('canvas');

  liveQualityIntervalId = setInterval(async () => {
    if (!mediaStream || video.readyState < 2 || isAutoOcrRunning) return;

    const crop = getGuideCropCoordinates(video, guide, 0.12);
    sampleCanvas.width = crop.sw;
    sampleCanvas.height = crop.sh;
    sampleCanvas.getContext('2d').drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);

    const q = evaluateFrameQuality(sampleCanvas);

    if (qgBadge) {
      qgBadge.style.display = 'inline-block';
      qgBadge.classList.toggle('qg-ok', q.ok);
      qgBadge.classList.toggle('qg-warn', !q.ok);
      qgBadge.textContent = `${q.message} (Nitidezza: ${q.sharpness})`;
    }

    if (q.ok) {
      consecutiveGoodFrames++;
    } else {
      consecutiveGoodFrames = 0;
    }

    if (autoCaptureEnabled && consecutiveGoodFrames >= 2) {
      isAutoOcrRunning = true;
      const statusText = document.getElementById('cameraStatusText');
      try {
        const outcome = await recognizeWithNextGen(sampleCanvas, {
          mode: ocrScanMode,
          target: activeOcrTarget,
          useOpenCv: openCvWarpEnabled,
          allowSecondPass: false,
          onStatus: (msg) => {
            if (statusText) statusText.textContent = msg;
          }
        });

        if (outcome && outcome.debug) {
          const debugImg = document.getElementById('ocrDebugPreviewImg');
          const debugRaw = document.getElementById('ocrDebugRawText');
          if (debugImg && outcome.debug.preprocessedDataUrl) debugImg.src = outcome.debug.preprocessedDataUrl;
          if (debugRaw) debugRaw.textContent = outcome.debug.rawText || '(Nessun testo rilevato)';
        }

        if (outcome && isAutoResultValid(outcome.data)) {
          playScannerBeep();
          if (navigator.vibrate) navigator.vibrate(120);

          const previewImg = document.getElementById('capturedDocPreview');
          const btnsLive = document.getElementById('cameraBtnsLive');
          const btnsReview = document.getElementById('cameraBtnsReview');
          if (previewImg) {
            previewImg.src = sampleCanvas.toDataURL('image/jpeg', 0.95);
            previewImg.style.width = guide.style.width || '320px';
            previewImg.style.height = guide.style.height || '200px';
            previewImg.style.display = 'block';
          }

          stopCamera();
          if (btnsLive) btnsLive.style.display = 'none';
          if (btnsReview) btnsReview.style.display = 'flex';

          applyExtractedDocData(outcome.data);
          showOcrSuccessBadge(outcome.data, outcome.sourceLabel);
          return;
        }
      } catch (err) {
        console.warn('Errore ciclo auto-scatto AI Pro:', err);
      } finally {
        consecutiveGoodFrames = 0;
        isAutoOcrRunning = false;
      }
    }
  }, 380);
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
    // Audio non disponibile
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

function syncOcrField(field, val) {
  if (activeOcrTarget === 'visitor') {
    if (field === 'cognome') {
      const el = document.getElementById('vCognome');
      if (el) { el.value = val; el.classList.remove('ocr-low-confidence'); }
      const q = document.getElementById('ocrQuickCognome');
      if (q) q.classList.remove('ocr-low-confidence');
    } else if (field === 'nome') {
      const el = document.getElementById('vNome');
      if (el) { el.value = val; el.classList.remove('ocr-low-confidence'); }
      const q = document.getElementById('ocrQuickNome');
      if (q) q.classList.remove('ocr-low-confidence');
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
    if (el) {
      el.value = val;
      el.classList.remove('ocr-low-confidence');
    }
  }
  const quickMap = {
    cognome: 'ocrQuickCognome',
    nome: 'ocrQuickNome',
    docNum: 'ocrQuickDocNum',
    dataNascita: 'ocrQuickDataNascita'
  };
  const quickEl = document.getElementById(quickMap[field]);
  if (quickEl) quickEl.classList.remove('ocr-low-confidence');
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
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    });

    const videoTrack = mediaStream.getVideoTracks()[0];
    if (videoTrack && typeof videoTrack.getCapabilities === 'function') {
      try {
        const caps = videoTrack.getCapabilities();
        if (caps.focusMode && caps.focusMode.includes('continuous')) {
          await videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        }
      } catch {
        // Ignora se focusMode continuous non è supportato dal dispositivo
      }
    }

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

    if (ocrEngineMode === 'paddle') {
      startLiveQualityLoop();
    }
  } catch (err) {
    console.warn('Accesso fotocamera non riuscito:', err);
    statusText.textContent = '⚠️ Fotocamera non disponibile. Carica una foto da file o compila a mano.';
    showToast('Impossibile accedere alla fotocamera. Puoi caricare una foto o compilare a mano.', 'info');
  }
}

function stopCamera() {
  stopLiveQualityLoop();
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

  const crop = getGuideCropCoordinates(video, guide, 0.12);
  canvas.width = crop.sw;
  canvas.height = crop.sh;

  canvas.getContext('2d').drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);

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
  e.target.value = '';
}

function retakeDocPhoto() {
  resetDocCaptureUI();
  toggleCamera();
}

async function processDocImageOCR(canvas) {
  const statusText = document.getElementById('cameraStatusText');

  try {
    let ocrOutcome = null;

    if (ocrEngineMode === 'paddle') {
      if (statusText) statusText.textContent = '🚀 Avvio motore AI Pro (PaddleOCR ONNX)...';
      ocrOutcome = await recognizeWithNextGen(canvas, {
        mode: ocrScanMode,
        target: activeOcrTarget,
        useOpenCv: openCvWarpEnabled,
        onStatus: (msg) => {
          if (statusText) statusText.textContent = msg;
        }
      });
    } else {
      setOcrStatusCallback((m) => {
        if (!statusText) return;
        if (m.status === 'recognizing text') {
          const pct = Math.round((m.progress || 0) * 100);
          statusText.textContent = `🔍 Lettura ${ocrScanMode === 'mrz' ? 'zona MRZ' : 'Full-Card CIE'}... ${pct}%`;
        } else if (m.status === 'loading language traineddata' || m.status === 'loading tesseract core') {
          statusText.textContent = '📥 Caricamento modelli OCR in memoria...';
        }
      });

      if (statusText) statusText.textContent = '🔍 Normalizzazione immagine & analisi OCR Full-Card...';
      ocrOutcome = await recognizeDocumentCanvas(canvas, ocrScanMode, activeOcrTarget);
    }

    if (ocrOutcome && ocrOutcome.debug) {
      const debugImg = document.getElementById('ocrDebugPreviewImg');
      const debugRaw = document.getElementById('ocrDebugRawText');
      if (debugImg && ocrOutcome.debug.preprocessedDataUrl) {
        debugImg.src = ocrOutcome.debug.preprocessedDataUrl;
      }
      if (debugRaw) {
        debugRaw.textContent = ocrOutcome.debug.rawText || '(Nessun testo rilevato)';
      }
    }

    if (ocrOutcome && ocrOutcome.data) {
      applyExtractedDocData(ocrOutcome.data);
      showOcrSuccessBadge(ocrOutcome.data, ocrOutcome.sourceLabel);
      return;
    }
  } catch (err) {
    console.warn('Errore elaborazione motore OCR:', err);
    const debugRaw = document.getElementById('ocrDebugRawText');
    if (debugRaw && !debugRaw.textContent) {
      debugRaw.textContent = `[Errore motore OCR (${ocrEngineMode})]\n${err && err.message ? err.message : String(err)}`;
    }
  }

  parseAndApplyDocFrontFallback();
}

function showOcrSuccessBadge(data, sourceLabel) {
  const statusText = document.getElementById('cameraStatusText');
  const badge = document.getElementById('docCapturedBadge');
  const summary = document.getElementById('docCapturedSummary');
  const label = (data && data.mrzVerified && !String(sourceLabel || '').includes('Checksum ICAO OK'))
    ? 'MRZ (Checksum ICAO OK)'
    : sourceLabel;

  if (statusText) statusText.textContent = `✅ Analisi ${label} completata con successo!`;
  if (badge) badge.style.display = 'flex';
  if (summary) {
    if (activeOcrTarget === 'visitor') {
      summary.textContent = `${label} analizzato (solo Cognome e Nome): ${data.cognome ? data.cognome + ' ' + data.nome : 'verifica i campi qui sotto'}.`;
    } else {
      summary.textContent = `${label} analizzato: ${data.cognome ? data.cognome + ' ' + data.nome : 'dati estratti'}. Verifica o ritocca all'occorrenza.`;
    }
  }
  showToast(
    activeOcrTarget === 'visitor'
      ? `✅ Cognome e Nome (${label}) estratti!`
      : `✅ Dati documento (${label}) estratti con successo!`,
    'success'
  );
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

function setFieldWithConfidence(elementId, value, confidence, quickId = null) {
  const el = document.getElementById(elementId);
  const qEl = quickId ? document.getElementById(quickId) : null;
  const isLow = typeof confidence === 'number' && confidence < 70;

  if (el) {
    el.classList.remove('ocr-low-confidence');
    if (value) {
      el.value = value;
      if (isLow) {
        el.classList.add('ocr-low-confidence');
        el.addEventListener('input', () => el.classList.remove('ocr-low-confidence'), { once: true });
      }
    }
  }
  if (qEl) {
    qEl.classList.remove('ocr-low-confidence');
    if (value) {
      qEl.value = value;
      if (isLow) qEl.classList.add('ocr-low-confidence');
    }
  }
}

function applyExtractedDocData(data) {
  const conf = data.confidences || {};

  // Rimuovi evidenziazioni precedenti
  [
    'vCognome', 'vNome', 'sDocNum', 'sGenitoreCognome', 'sGenitoreNome',
    'sGenitoreLuogo', 'sGenitoreDataNascita', 'sDocRil', 'sDocScad',
    'ocrQuickCognome', 'ocrQuickNome', 'ocrQuickDocNum', 'ocrQuickDataNascita'
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('ocr-low-confidence');
  });

  if (activeOcrTarget === 'visitor') {
    setFieldWithConfidence('vCognome', data.cognome, conf.cognome, 'ocrQuickCognome');
    setFieldWithConfidence('vNome', data.nome, conf.nome, 'ocrQuickNome');
    return;
  }

  if (data.docTipo) document.getElementById('sDocTipo').value = data.docTipo;
  setFieldWithConfidence('sDocNum', data.docNum, conf.docNum, 'ocrQuickDocNum');
  setFieldWithConfidence('sGenitoreCognome', data.cognome, conf.cognome, 'ocrQuickCognome');
  setFieldWithConfidence('sGenitoreNome', data.nome, conf.nome, 'ocrQuickNome');
  setFieldWithConfidence('sGenitoreLuogo', data.luogoNascita, conf.luogoNascita);
  setFieldWithConfidence('sGenitoreDataNascita', data.dataNascita, conf.dataNascita, 'ocrQuickDataNascita');

  if (data.dataEmissione) {
    setFieldWithConfidence('sDocRil', data.dataEmissione, conf.dataEmissione);
  }
  if (data.dataScadenza) {
    setFieldWithConfidence('sDocScad', data.dataScadenza, conf.dataScadenza);
    if (!data.dataEmissione) {
      const parts = data.dataScadenza.split('-');
      if (parts.length === 3) {
        const rYear = parseInt(parts[0], 10) - 10;
        document.getElementById('sDocRil').value = `${rYear}-${parts[1]}-${parts[2]}`;
      }
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
  if (summary) {
    summary.textContent = activeOcrTarget === 'visitor'
      ? 'Dimostrazione test CIE (solo Cognome e Nome): FERRARO GIUSEPPE.'
      : 'Dimostrazione test CIE completata: FERRARO GIUSEPPE - CA93821IT.';
  }
  showToast('🧪 Dati di test dimostrativi caricati nel modulo.', 'info');
}

/* ==========================================================================
   12. USCITA RAPIDA PRESENTI
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
   13. STAMPA MODULO A4 VERTICALE & REGISTRO A4 ORIZZONTALE
   ========================================================================== */
let activePrintCleanup = null;

function setPrintOrientation(orientation, margin) {
  let styleEl = document.getElementById('dynamic-print-page-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'dynamic-print-page-style';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `@page { size: A4 ${orientation}; margin: ${margin}; }`;
}

function triggerBrowserPrint(modeClass, orientation, margin) {
  setPrintOrientation(orientation, margin);

  if (activePrintCleanup) {
    window.removeEventListener('afterprint', activePrintCleanup);
    activePrintCleanup = null;
  }

  document.body.classList.remove('print-mode-module', 'print-mode-register');
  document.body.classList.add(modeClass);

  activePrintCleanup = () => {
    document.body.classList.remove('print-mode-module', 'print-mode-register');
    activePrintCleanup = null;
  };
  window.addEventListener('afterprint', activePrintCleanup, { once: true });

  requestAnimationFrame(() => {
    setTimeout(() => {
      window.print();
    }, 150);
  });
}

function populateOfficialPrintModule(record) {
  const data = record.studentData;
  if (!data) return;

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

  triggerBrowserPrint('print-mode-module', 'portrait', '10mm');
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
      <td style="text-align:center; height:28px;"></td>
    `;
    tbody.appendChild(tr);
  });

  triggerBrowserPrint('print-mode-register', 'landscape', '8mm');
}

/* ==========================================================================
   14. EXPORT JSON / CSV, IMPORT JSON & RESET
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
   15. UTILITY HELPERS & ESPOSIZIONE HANDLER GLOBALI PER IL DOM
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

// Espone gli handler richiamati dagli attributi HTML (onclick, onsubmit, oninput, onchange)
Object.assign(window, {
  fillSampleSchoolConfig,
  saveSchoolConfig,
  addCourseFromInput,
  removeTempCourse,
  cancelWizardAndReturn,
  handleProtectedAction,
  handleInstallClick,
  toggleOperatorMode,
  openVisitorModal,
  openStudentModal,
  onRegisterDateChange,
  resetRegisterDateToday,
  filterRegister,
  printDailyRegister,
  exportDataJSON,
  exportDataCSV,
  importDataJSON,
  confirmResetDailyRegister,
  confirmFullWipe,
  openChangePinModal,
  saveNewPin,
  lockOperatorMode,
  promptPinModal,
  closeModal,
  handleVisitorLookup,
  toggleVisitorOcrScanner,
  clearSignature,
  saveVisitorEntry,
  saveStudentEntryAndPrint,
  setActionType,
  setOcrScanMode,
  setOcrEngineMode,
  toggleAutoCaptureSetting,
  toggleOpenCvWarpSetting,
  toggleCamera,
  triggerDocUpload,
  handleDocFileUpload,
  adjustGuideScale,
  switchCameraFacing,
  captureAndAnalyzeDocFront,
  retakeDocPhoto,
  triggerManualScanCapture,
  syncOcrField,
  focusManualDoc,
  handleStudentMotivazioneSelect,
  renderQuickExitList,
  toggleVisitorSearchSetting,
  pressNumpadDigit,
  pressNumpadBack,
  submitPinCode,
  registerExitDirect,
  registerExitAndRefresh,
  reprintStudentModule,
  previewImage
});
