# Changelog

Tutte le modifiche rilevanti a **Portineria Digitale Scolastica** sono documentate in questo file secondo il formato [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e il [Semantic Versioning](https://semver.org/lang/it/).

## [1.0.0] - 2026-11-14

### Added
- **Architettura PWA Modulare (Zero Build Step)**: separazione netta in `index.html`, `css/style.css`, moduli ES6 nativi (`js/app.js`, `js/api.js`, `js/storage.js`), `manifest.json`, `sw.js`, `assets/icons/`, `assets/img/` e `docs/`.
- **Installabilità Reale & Offline-First**: `manifest.json` con icone PNG (`192x192`, `512x512` `any maskable`), Service Worker `sw.js` (`v1.0.1`) con caching degli asset locali e delle risorse OCR (`Tesseract.js`, WASM, `ita.traineddata`), pulsante **📲 Installa App** nell'header (`beforeinstallprompt` + guida iOS/iPadOS) e indicatore stato connessione.
- **Persistenza su `IndexedDB` + Migrazione Legacy**: wrapper `StorageDB` con fallback automatico su `localStorage` e migrazione automatica dei dati della versione precedente.
- **Sicurezza PIN reale**: hashing SHA-256 tramite Web Crypto API (`crypto.subtle.digest`) con fallback JS puro in ambienti LAN non-HTTPS.
- **Motore OCR Ottimizzato (`js/api.js`)**: singolo `Tesseract.createWorker('ita')` riutilizzabile, pre-elaborazione immagine, supporto **Fronte Documento** e **Retro MRZ** (`TD1` CIE / `TD3` Passaporto).
- **OCR anche per Visitatori Standard**: scansione documento opzionale in ingresso visitatore per estrarre esclusivamente `Cognome` e `Nome`.
- **Storico Multi-Giorno & Accessibilità Kiosk**: selettore data nel registro, controllo pixel reali sulla firma digitale su canvas e rimozione di `user-scalable=no` con gestione mirata di `touch-action`.
- **Documentazione & Utility**: `README.md`, `CHANGELOG.md`, `.gitignore`, `docs/generate-icons.js` e `docs/check_ids.js`.
