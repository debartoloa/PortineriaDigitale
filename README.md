# 🏫 Portineria Digitale Scolastica (PWA)

[![PWA Ready](https://img.shields.io/badge/PWA-Installabile%20%26%20Offline--First-1a365d.svg)](#)
[![Zero Backend](https://img.shields.io/badge/Backend-None%20(100%25%20Client--Side)-0f766e.svg)](#)
[![Storage](https://img.shields.io/badge/Storage-IndexedDB%20%2B%20SHA--256%20PIN-2b6cb0.svg)](#)
[![OCR](https://img.shields.io/badge/OCR-Tesseract.js%20(Fronte%20%2B%20MRZ)-d69e2e.svg)](#)

**Portineria Digitale Scolastica** è una **Progressive Web App (PWA)** modulare, installabile su tablet Android, iPadOS e PC desktop, progettata per funzionare come sistema kiosk **Offline-First** nella portineria degli Istituti Scolastici italiani.

L'applicazione opera interamente lato client (senza server esterni né database remoti) salvando accessi, firme digitali e configurazioni in **IndexedDB** nel rispetto del **GDPR**.

---

## ✨ Funzionalità Principali

### 1. 📲 Progressive Web App Reale & Offline-First
- **Installabile** su Chrome/Edge/Android tramite pulsante **"📲 Installa App"** nell'header (`beforeinstallprompt`) e su Safari iOS/iPadOS tramite guida contestuale (*Condividi → Aggiungi a schermata Home*).
- **Service Worker (`sw.js`)**: strategia *Stale-While-Revalidate* per gli asset locali e *Cache-First* persistente per `Tesseract.js`, moduli WASM e dati lingua `ita.traineddata`, per funzionare al 100% anche in assenza di connessione internet.
- **Indicatore stato connessione** live nell'header (*Online*, *Offline (Locale)*, *Online · PWA*).

### 2. 🏫 Wizard di Primo Avvio & Multi-Plesso
- Configurazione guidata di nome Istituto, città, indirizzi di studio/plessi e PIN operatore iniziale (default `1234`).
- Pulsante **"⚡ Carica Esempio"** per test immediati.
- Modificabile in qualsiasi momento dall'area protetta **"🏛️ Dati Scuola"**.

### 3. 🚪 Tre Flussi Kiosk Principali
- **Ingresso Visitatore Standard** (Docenti, Personale ATA, Manutentori, Fornitori, Genitori, Esterni):
  - Compilazione rapida con firma digitale su `<canvas>` touch/mouse e **verifica reale dei pixel disegnati** (previene tocchi accidentali).
  - **Scansione Documento opzionale (solo Cognome e Nome)**: pulsante *"📸 Scansiona Documento"* per compilare automaticamente `Cognome` e `Nome` tramite OCR (Fronte CIE/Patente o Retro MRZ) senza acquisire altri dati non necessari.
- **Gestione Alunni (Ingresso posticipato / Uscita anticipata)**:
  - Acquisizione documento d'identità (CIE, Patente, Carta Cartacea, Passaporto) via fotocamera con **cornice guida calibrabile** (`65%–135%`) o upload file.
  - Motore OCR client-side con **singolo Worker `Tesseract.createWorker('ita')` riutilizzabile**, pre-elaborazione contrasto/binarizzazione e doppia modalità:
    - **🪪 Fronte Documento**: estrae Cognome, Nome, Numero Documento e Date.
    - **📟 Retro MRZ (CIE / Passaporto)**: parser dedicato per codici MRZ (`TD1` 3×30 e `TD3` 2×44) per la massima precisione.
  - Barra di rifinitura rapida con sincronizzazione bidirezionale e **Piano B** per inserimento manuale immediato.
  - Stampa automatica del **modulo ufficiale A4 verticale** indirizzato al Dirigente Scolastico con firma digitale inclusa.
- **Registrazione Uscita Rapida**:
  - Elenco filtrato dei soli presenti attualmente nell'edificio con timer di permanenza.

### 4. 🛡️ Sicurezza GDPR, Storico & Export
- **Privacy Shield**: il registro accessi è oscurato di default ai visitatori e sbloccabile solo tramite PIN numerico con **tastierino touch a schermo** e auto-blocco dopo 5 minuti di inattività.
- **PIN cifrato con SHA-256**: il PIN non viene mai salvato in chiaro nello storage (hash tramite Web Crypto API `crypto.subtle.digest`).
- **Storico Multi-Giorno**: selettore data nel registro per consultare, stampare in **A4 orizzontale** (con firme), esportare in **CSV (Excel)** o azzerare qualsiasi giornata.
- **Ricerca rapida visitatori ricorrenti**: autocompletamento attivabile/disattivabile dallo staff nelle impostazioni.
- **Backup & Ripristino JSON**: export completo e importazione (modalità *Unisci* o *Sostituisci*), retrocompatibile anche con i backup della versione precedente.

---

## 📁 Struttura del Progetto

```text
Portineria2/
├── index.html          # Markup semantico, collegamenti PWA e modali
├── styles.css          # Stili modulari, accessibilità kiosk e layout stampa A4
├── app.js              # Core JS: IndexedDB, SHA-256 PIN, OCR Worker + MRZ, PWA
├── manifest.json       # Web App Manifest (standalone, icone maskable)
├── sw.js               # Service Worker Offline-First (asset locali + OCR cache)
├── icon-192.png        # Icona PWA 192x192 PNG
├── icon-512.png        # Icona PWA 512x512 PNG
├── generate-icons.js   # Script Node.js zero-dipendenze per rigenerare le icone PNG
├── check_ids.js        # Script di verifica integrità ID tra index.html e app.js
└── README.md           # Documentazione progetto
```

---

## 🚀 Avvio in Locale e Deploy

> **Requisito Browser:** Service Worker, installazione PWA, Web Crypto API e accesso alla fotocamera (`getUserMedia`) richiedono **`http://localhost`** oppure **`https://`**. Non aprire `index.html` direttamente via `file://`.

### Avvio rapido in locale
Clona il repository e avvia un server HTTP statico nella cartella del progetto:

```bash
# Con Python 3
python -m http.server 8080

# Oppure con Node.js
npx serve . -l 8080
```

Apri quindi il browser su `http://localhost:8080`.

### Rigenerare le icone PWA (opzionale)
Le icone `icon-192.png` e `icon-512.png` sono già incluse. Se desideri rigenerarle:
```bash
node generate-icons.js
```

### Verifica integrità DOM
```bash
node check_ids.js
```

### Deploy su Hosting Statico HTTPS
Carica tutti i file del repository su **GitHub Pages**, **Netlify**, **Cloudflare Pages**, **Vercel** o su un web server scolastico con HTTPS attivo. Tutti i percorsi sono relativi (`./`), quindi l'app funziona sia nella root del dominio che in una sottocartella (es. `https://scuola.edu.it/portineria/`).
