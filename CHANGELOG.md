# Changelog

Tutte le modifiche rilevanti a **Portineria Digitale Scolastica** sono documentate in questo file secondo il formato [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e il [Semantic Versioning](https://semver.org/lang/it/).

## [2.0.0] - 2026-11-20

### Added
- **Architettura Dual-Engine OCR con Flag Selettore (`js/ocr_nextgen.js`, `index.html`, `js/app.js`)**:
  - Selettore persistente tra **🔵 Classico (Tesseract)** e **🚀 AI Pro (PaddleOCR)** direttamente nell'interfaccia fotocamera.
  - **PaddleOCR su ONNX Runtime Web (100% client-side, zero build step)**: DBNet (`PP-OCRv4_det`) + Riconoscimento Latino/Italiano (`latin PP-OCRv5_rec`) via `esearch-ocr` + `onnxruntime-web`.
  - **MRZ Dedicato OCR-B**: worker dedicato con `OCRB.traineddata.gz` (77 KB) + fallback PaddleOCR e validazione matematica ICAO 9303 (`7-3-1`).
  - **Quality Gate Live & Auto-Scatto Continuo**: analisi frame video in tempo reale (Varianza del Laplaciano 3×3 per nitidezza e rilevamento riflessi/glare) con cattura automatica, bip sonoro e vibrazione.
  - **Raddrizzamento Prospettico Opzionale con OpenCV.js WASM**: toggle dedicato per rilevare i 4 angoli della tessera ID-1 e applicare `warpPerspective`.
- **Service Worker (`sw.js`)**: cache aggiornata a `v2.0.0` con precaching di `js/ocr_nextgen.js` e caching persistente per modelli ONNX, OpenCV e OCR-B.

## [1.3.0] - 2026-11-20

### Fixed & Improved
- **Ricostruzione Motore OCR Fronte CIE (`js/api.js`, `js/app.js`)**:
  - Sostituita la binarizzazione hard 1-bit con **Illumination Flattening + Scala di Grigi Morbida Anti-Ciano** (`0.58*R + 0.34*G + 0.08*B` e sfondo locale a raggio ampio tramite Integral Image), preservando i contorni anti-aliased ideali per Tesseract 5 LSTM.
  - Aggiunto `prepareOcrCanvas` (upscaling dolce a 1600px sul lato lungo e bordo bianco di 16px).
  - Abilitato `{ blocks: true }` su `worker.recognize` per leggere correttamente `blocks -> paragraphs -> lines` in Tesseract.js v5 (prima `result.data.lines` era `undefined`).
  - Passaggio primario **`PSM 3` (Auto multi-colonna) senza whitelist restrittiva** sul modello `ita`, con fallback `PSM 11` e fallback scala di grigi leggera.
  - Parser CIE potenziato con ancore fuzzy (`COGNOME/SURNANE`, `NOME/NAME`), regola valore su riga sottostante, supporto date `EMISSIONE`/`SCADENZA` affiancate sulla stessa riga e **ancoraggio inverso dalla data di nascita** se le etichette corsive mancano.
  - Rimossi i vincoli `min: 1280` su `getUserMedia` per compatibilità iOS portrait e aggiunto `focusMode: 'continuous'` ove supportato.
- **Diagnostica OCR opzionale (`index.html`, `css/style.css`)**: aggiunto `<details id="ocrDebugDetails">` chiuso di default per ispezionare anteprima pre-elaborata e testo grezzo letto da Tesseract.
- **Service Worker (`sw.js`)**: incrementata la versione cache a `v1.3.0` e aggiornati i badge versione a `v1.3.0`.

## [1.2.1] - 2026-11-20

### Added
- **Indicatore Versione in UI (`index.html`, `css/style.css`, `js/app.js`)**: aggiunto badge versione (`v1.2.1`) visibile sia nell'header della Dashboard che nella schermata Wizard iniziale, sincronizzato con la costante `APP_VERSION`.

### Changed
- **Service Worker (`sw.js`)**: incrementata la versione cache a `v1.2.1`.

## [1.2.0] - 2026-11-20

### Changed
- **Pipeline OCR Fronte CIE Full-Card & Indipendente dalla Posizione (`js/api.js`, `js/app.js`, `css/style.css`)**:
  - **Ritaglio con Margine di Tolleranza (12%) & Risoluzione Nativa**: `getGuideCropCoordinates` aggiunge il 12% di padding esterno su tutti e 4 i lati e `captureAndAnalyzeDocFront` preserva la risoluzione nativa del frame video senza downscaling forzato.
  - **Pre-processing Ottimizzato per CIE Italiana**: scala di grigi pesata sui canali Rosso/Giallo (`0.50*R + 0.42*G + 0.08*B`) per attenuare il guilloché azzurro/ciano, contrasto dinamico, leggero sharpening 3×3 e binarizzazione adattiva Bradley-Roth.
  - **OCR Full-Card su `result.data.lines`**: eliminati i sub-box rigidi sul fronte; esecuzione con `PSM 6` (e fallback `PSM 11`) con whitelist italiana estesa.
  - **Parser a Ancore Semantiche (`parseCieFrontLines`)**: ancora verticale su Numero Documento, `COGNOME/SURNAME`, `NOME/NAME`, `LUOGO E DATA DI NASCITA`, `EMISSIONE/ISSUING` e `SCADENZA/EXPIRY`, pulizia caratteri spuri ed evidenziazione in giallo (`.ocr-low-confidence`) per i campi con confidenza OCR `< 70%`.
- **Service Worker (`sw.js`)**: incrementata la versione cache a `v1.2.0`.

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
