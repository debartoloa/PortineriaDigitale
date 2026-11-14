/**
 * js/storage.js - Persistenza IndexedDB (con fallback localStorage),
 * migrazione dati legacy e hashing PIN SHA-256.
 */

export const LEGACY_KEYS = {
  RECORDS: 'portineria_iis_records_v1',
  SCHOOL: 'portineria_school_config_v1',
  PIN: 'portineria_security_pin_v1',
  VISITOR_SEARCH: 'portineria_enable_visitor_search_v1'
};

const DB_NAME = 'portineria_db_v1';
const DB_VERSION = 1;
const STORE_RECORDS = 'records';
const STORE_SETTINGS = 'settings';

export const StorageDB = {
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
      const req = tx.objectStore(STORE_SETTINGS).get(key);
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
      tx.objectStore(STORE_SETTINGS).put({ key, value });
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
      const req = tx.objectStore(STORE_RECORDS).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });
  },

  async putRecord(record, fallbackList = null) {
    if (this.useFallback || !this.db) {
      if (fallbackList) this._saveFallbackRecords(fallbackList);
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
      localStorage.removeItem('pdb_setting_legacyMigrated');
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

  _saveFallbackRecords(list) {
    try {
      localStorage.setItem(LEGACY_KEYS.RECORDS, JSON.stringify(list));
    } catch (err) {
      console.error('Errore salvataggio localStorage:', err);
    }
  }
};

/**
 * Calcola l'hash SHA-256 con salt applicativo tramite Web Crypto API
 * (con fallback JS puro in ambienti LAN non-HTTPS).
 */
export async function hashPin(pinText) {
  const normalized = String(pinText || '').trim();
  const data = new TextEncoder().encode(`portineria_salt_v1:${normalized}`);

  if (window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function') {
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

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

/**
 * Migra automaticamente eventuali dati salvati nella versione precedente su localStorage.
 */
export async function migrateLegacyLocalStorage() {
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
      const cleanPin = legacyPin.trim();
      const digest = await hashPin(cleanPin);
      await StorageDB.setSetting('pinHash', digest);
      await StorageDB.setSetting('pinLength', cleanPin.length);
      localStorage.removeItem(LEGACY_KEYS.PIN);
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
