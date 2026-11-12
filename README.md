# 🏫 Portineria Digitale Scolastica (PWA / SPA)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Web%20%2F%20PWA-green.svg)](#)
[![Zero External Server](https://img.shields.io/badge/Server-None%20(100%25%20Client--Side)-orange.svg)](#)
[![GDPR Compliant](https://img.shields.io/badge/Privacy-100%25%20Local%20Storage-brightgreen.svg)](#)

Applicazione Web progressiva (PWA / Single Page Application in un **unico file autonomo** `index.html`) moderna, touch-friendly e offline-first per la gestione della portineria e del controllo accessi negli **Istituti Scolastici Superiori e Comprensivi**.

L'applicazione gira interamente nel browser del PC o del tablet in portineria **senza necessità di server esterni, database remoti o connessioni cloud**, salvando tutti i dati localmente nel browser (`localStorage`) nel pieno rispetto della privacy scolastica e del GDPR.

---

## 📸 Anteprima dell'Interfaccia

L'interfaccia principale è ottimizzata per l'uso immediato su tablet touch-screen da 10-12 pollici o monitor touch in portineria:

```
+--------------------------------------------------------------------------+
|  🏫 I.I.S. "E. Mattei" - Castrovillari          11:42:05  [🏛️ Dati Scuola] |
+--------------------------------------------------------------------------+
|  [ 🟢 4 Presenti ]   [ 🚪 18 Ingressi ]   [ 👨‍🎓 6 Alunni ]   [ 🏃 14 Uscite ] |
+--------------------------------------------------------------------------+
|                                                                          |
|   +-------------------------------+   +-------------------------------+  |
|   |              🚪               |   |              👨‍🎓               |  |
|   |       REGISTRA INGRESSO       |   |        GESTIONE ALUNNI        |  |
|   |      VISITATORE STANDARD      |   |  Ingresso ritardo / Uscita    |  |
|   |  Docenti · ATA · Manutentori  |   |  (Genitori o delegati autor.) |  |
|   +-------------------------------+   +-------------------------------+  |
|                                                                          |
|   +-------------------------------------------------------------------+  |
|   |             🏃  REGISTRA USCITA   ( 4 )   presenti                |  |
|   +-------------------------------------------------------------------+  |
|                                                                          |
+--------------------------------------------------------------------------+
|  📋 REGISTRO GIORNALIERO ACCESSI                   [🔍 Cerca] [🖨️ Stampa] |
+--------------------------------------------------------------------------+
```

---

## ✨ Caratteristiche Principali

### 1. 🏛️ Personalizzazione Dinamica della Scuola (Multi-Indirizzo)
- **Primo Avvio Pulito:** Al primo avvio l'applicazione si presenta vuota e richiede la configurazione iniziale guidata (Onboarding).
- **Adattabile a qualsiasi Istituto:** Inserimento del nome della scuola (es. *I.I.S. "E. Mattei"*), città/sede e lista personalizzabile degli indirizzi di studio o plessi (es. *Liceo Scientifico*, *Scienze Applicate*, *Liceo Classico*, *Liceo Artistico*, *Istituto Tecnico*, *Plesso Succursale*, ecc.).
- **Aggiornamento Continuo:** È possibile aggiungere, modificare o rimuovere indirizzi e dettagli in qualsiasi momento tramite il pulsante **"🏛️ Dati Scuola"**.
- Tutti i moduli a schermo e cartacei recepiscono istantaneamente la configurazione.

### 2. 🚪 Flusso Visitatore Standard
- Inserimento rapido di: Cognome, Nome, Recapito telefonico, Qualifica (Docente, Personale ATA, Manutentore, Fornitore, Genitore, Tirocinante, Altro) e Motivazione.
- **Firma Digitale Touch su `<canvas>`:** Disegno fluido della firma tramite dito, penna touch o mouse con gestione DPI retina e pulsante *"Pulisci firma"*.
- Salvataggio record con timestamp automatico e aggiornamento live del registro.

### 3. 👨‍🎓 Gestione Alunni (Ingresso in ritardo / Uscita anticipata)
- Selezione immediata tramite card touch: **`[ 🟢 ENTRARE ]`** o **`[ 🔴 USCIRE ]`**.
- Dati anagrafici del genitore o delegato (Cognome, Nome, Cellulare, Luogo e Data di nascita, Ruolo).
- **Fotocamera Scanner Smart CIE & Codice a Barre con BIP Audio (Web Audio API):**
  - Viewport video a tutto schermo con mirino ottico e raggio laser animato;
  - **Riconoscimento in Tempo Reale:** Inquadrando il retro della Carta d'Identità Elettronica (CIE), il sistema analizza continuamente il feed video tramite l'API nativa `BarcodeDetector` (Code 39, Code 128, QR) e contrasto ottico;
  - **Segnale Acustico (BEEP):** All'atto del riconoscimento, l'applicazione emette un **BIP acustico nitido a 1046 Hz** (simulatore hardware cassa portineria), fa lampeggiare il mirino in verde e carica automaticamente i dati del documento nel modulo;
  - **Supporto Lettori Barcode Hardware (USB / Bluetooth):** Se la scuola dispone di una pistola barcode da banco collegata via USB o Bluetooth, l'app intercetta automaticamente la scansione al volo, emette il bip e compila il modulo;
  - **Pulsante "Scansiona Ora":** Per scattare o simulare all'istante l'acquisizione anche in condizioni di luce scarsa;
- **PIANO B Fondamentale:** Se il documento è usurato, la fotocamera non è disponibile o l'operatore preferisce digitare, un chiaro pulsante *"✏️ Inserisci a mano"* sblocca immediatamente la compilazione manuale via tastiera (Tipo, Numero, Ente di rilascio, Data rilascio, Scadenza).
- **Permanenza Genitore nel Registro:** All'atto della registrazione, il genitore **risulta regolarmente presente all'interno dell'Istituto** (`oraUscita: null`) e viene registrato come uscito solo quando l'operatore preme *"Registra Uscita"*.

### 4. 🔎 Ricerca e Richiamo Automatico Persone Registrate (Controllo Esclusivo Staff)
- **Attivabile/Disattivabile dallo Staff:** Nel pannello protetto da PIN *"⚙️ Gestione Dati & Backup"*, l'operatore può scegliere se abilitare o meno la funzione con un interruttore ON/OFF (*switch*).
- **Massima Riservatezza di Default:** Nei contesti in cui il tablet è liberamente accessibile al pubblico o ai visitatori, la funzione è **disattivata di default** in modo che nessuno possa cercare o visualizzare nomi e recapiti di altri visitatori.
- **Autocompletamento Istantaneo (quando abilitato):** Nei moduli di ingresso compare il riquadro *"🔎 Persona già registrata? Cerca e richiama i dati"*. Digitando almeno 2 lettere del cognome o del cellulare, appare un menu a tendina con i visitatori o genitori registrati in precedenza: un tocco compila automaticamente tutti i campi (anagrafica, recapiti e dati documento).

### 5. 🏃 Registrazione Rapida Uscita (Filtro Solo Presenti)
- Il grande pulsante orizzontale arancione mostra in tempo reale il numero esatto di visitatori e genitori attualmente presenti nell'edificio.
- Con un tap apre l'elenco filtrato che include **esclusivamente chi non è ancora uscito**, con l'indicazione dei minuti trascorsi dall'ingresso (*es. Presente da 25 min*).
- Con un tocco sul pulsante `👉 Registra Uscita`, l'orario di uscita viene annotato all'istante e il contatore si aggiorna.

### 6. 🖨️ Stampa Documenti Ufficiali (@media print)
L'applicazione gestisce dinamicamente i fogli stile di stampa:
- **Modulo Cartaceo Autorizzazione Alunno (A4 Verticale Portrait):** Modello tipografico conforme (Times New Roman) con intestazione dell'Istituto, caselle di spunta per gli indirizzi configurati, causale, estremi del documento e **immagine della firma digitale** apposta su tablet.
- **Registro Giornaliero delle Presenze (A4 Orizzontale Landscape):** Tabella istituzionale a 10 colonne (*Data/ora | Cognome | Nome | Cellulare | Qualifica | Motivazione | Firma | Uscita | Modulo Alunno | Firma collaboratore scolastico*).

### 7. 🔒 Modalità Chiosco & Protezione PIN Personale (GDPR Compliant)
- **Scudo Privacy per i Visitatori:** Per conformità al GDPR (Regolamento UE 2016/679), chiunque si avvicini al tablet per registrarsi **non può visualizzare l'elenco dei visitatori precedenti, numeri di cellulare o dettagli degli alunni**.
- **Schermata Protetta di Default:** La tabella degli accessi odierni è coperta da una card *"Registro Presenze Riservato"*.
- **Tastierino Numerico Touch su Schermo (Numpad) & Tastiera Fisica:** Il personale scolastico tocca il pulsante *"🔑 Inserisci PIN"* o *"🔒 Accesso Staff"* e digita il proprio codice sul tastierino a schermo (o sulla tastiera del PC).
- **Funzioni Riservate Esclusivamente allo Staff:**
  - Visualizzazione e ricerca nella tabella del registro giornaliero;
  - Lista presenze per la registrazione dell'uscita rapida (`REGISTRA USCITA`);
  - Modifica delle impostazioni dell'Istituto (`Dati Scuola`);
  - Backup, ripristino, esportazione e abilitazione ricerca visitatori (`Dati & Backup`);
  - Ristampa dei moduli e azzeramento del registro.
- **PIN Predefinito:** `1234` (personalizzabile al primo avvio nel Wizard o in qualunque momento con la funzione *"🔑 Cambia PIN"*).
- **Blocco Automatico di Sicurezza:**
  - Non appena un visitatore o un genitore completa la registrazione di un ingresso, il sistema **torna automaticamente in modalità bloccata**;
  - Dopo 5 minuti di inattività dello staff il registro si ri-blocca automaticamente.

### 8. 💾 Privacy, Sicurezza & Backup Locale (Zero Cloud)
- **100% Client-Side:** Nessun dato sensibile esce dalla rete della scuola. I dati risiedono esclusivamente nel browser del dispositivo della portineria.
- **📥 Esporta JSON:** Backup completo della configurazione e di tutti i record in un clic.
- **📊 Esporta CSV:** Tabella compatibile con Microsoft Excel e Google Fogli.
- **📤 Importa Dati:** Possibilità di ripristinare o unire backup da altri dispositivi.
- **🗑️ Reset Sicuro:** Azzeramento del solo registro odierno o ripristino totale protetto da conferma.

---

## 🚀 Come Utilizzare l'Applicazione

### Metodo 1: Apertura Diretta Locale (Consigliato per Portinerie)
1. Scarica o clona questo repository:
   ```bash
   git clone https://github.com/tuo-username/portineria-digitale.git
   ```
2. Fai doppio clic sul file `index.html`.
3. L'applicazione si aprirà immediatamente nel tuo browser preferito (Google Chrome, Microsoft Edge, Safari o Firefox).
4. Al primo avvio, inserisci il nome della tua scuola e gli indirizzi di studio: sei pronto a registrare gli accessi!

### Metodo 2: Installazione come PWA (Tablet Android / iPad / PC)
- **Google Chrome / Edge:** Clicca sull'icona **"Installa applicazione"** nella barra degli indirizzi o su *Impostazioni > Installa Portineria*.
- **iPad / Safari:** Tocca il pulsante di condivisione e seleziona **"Aggiungi a schermata Home"**.
- L'app funzionerà a schermo intero senza barre del browser, proprio come un'applicazione nativa.

### Metodo 3: Pubblicazione Gratuita su GitHub Pages
1. Vai nelle impostazioni del repository su GitHub (*Settings > Pages*).
2. Seleziona il branch `main` e la cartella `/ (root)`.
3. Clicca su **Save**: l'applicazione sarà accessibile all'indirizzo `https://tuo-username.github.io/portineria-digitale/`.

---

## 📁 Struttura del Progetto

Il progetto è architettato per la massima portabilità e manutenibilità in un **unico file sorgente**:

```
Portineria2/
│
├── index.html       # Applicazione completa: HTML5 semantico, CSS3 e JavaScript
└── README.md        # Documentazione del progetto
```

Non sono richieste librerie esterne tramite npm, Node.js o connessioni a CDN remoti: l'app funziona anche se la connessione internet della scuola è temporaneamente assente.

---

## 🛠️ Tecnologie Utilizzate

- **HTML5:** Web Storage API (`localStorage`), MediaDevices API (`getUserMedia`), Canvas API per la firma autografa.
- **CSS3 Moderno:** CSS Grid, Flexbox, Custom Properties (variabili CSS), `@media print` per layout A4 Portrait/Landscape.
- **JavaScript Vanilla (ES6+):** Nessun framework pesante, caricamento istantaneo e footprint di memoria minimo su tablet datati.

---

## ⚖️ Licenza

Questo progetto è rilasciato sotto licenza [MIT](LICENSE). Libero per l'utilizzo, la modifica e la distribuzione all'interno di qualsiasi Istituto Scolastico pubblico o privato.
