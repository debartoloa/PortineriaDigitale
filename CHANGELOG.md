# Changelog

Tutte le modifiche rilevanti a **Portineria Digitale Scolastica** sono documentate in questo file secondo il formato [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e il [Semantic Versioning](https://semver.org/lang/it/).

## [1.1.1] - 2026-11-18

### Fixed
- **Stampa su 1 singola pagina e cambio orientamento (`css/style.css`, `index.html`, `js/app.js`)**:
  - Azzerati `min-height: 100vh` e `display: flex` su `html, body` in `@media print`, eliminando la 2ª pagina bianca generata sui driver di stampa.
  - Sostituito il `setTimeout(..., 1000)` con `afterprint` (`triggerBrowserPrint`) per mantenere integro il layout di stampa anche durante il cambio orientamento nell'anteprima del browser.
  - Compattato il Modulo Autorizzazione Alunni (checkbox sedi su griglia a 2 colonne, intestazione indirizzi su riga compatta, `break-inside: avoid`) per rientrare su una sola pagina A4 sia in verticale che in orizzontale.
  - Aggiunti `table-layout: fixed`, `overflow-wrap: break-word`, `thead { display: table-header-group; }` e `break-inside: avoid` sulle righe della tabella del Registro Giornaliero.

### Changed
- **Service Worker (`sw.js`)**: incrementata la versione cache a `v1.1.1`.

## [1.1.0] - 2026-11-18

### Added
- **Binarizzazione Adattiva Locale (Bradley-Roth) & Sharpening (`js/api.js`)**: pipeline di pre-elaborazione con *Integral Image* $O(1)$ e filtro *Unsharp Mask* 3×3 per contrastare ombre oblique e filigrane della CIE.
- **Ritaglio per Zone (ROI) & Whitelist/PSM Dinamici (`recognizeDocumentCanvas`)**:
  - Modalità **Fronte**: ROI dedicata al Numero Documento (`PSM 7`, whitelist `A-Z0-9`), ROI anagrafica destra (`PSM 6`, esclusione fototessera) e fallback tessera intera/MRZ automatico.
  - Modalità **Retro MRZ**: ritaglio della sola fascia MRZ inferiore con whitelist ICAO (`A-Z0-9<`) e `PSM 6`.
- **Validazione Matematica Check-Digit ICAO 9303 (`7-3-1`)**: funzioni `calculateMrzCheckDigit` e `repairMrzFieldWithCheckDigit` con auto-riparazione posizionale dei caratteri OCR ambigui (`0/O/Q`, `1/I/L`, `2/Z`, `5/S`, `6/G`, `8/B`) e indicatore `MRZ (Checksum ICAO OK)` nel riepilogo UI.

### Changed
- **Service Worker (`sw.js`)**: incrementata la versione cache a `v1.1.0`.

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
