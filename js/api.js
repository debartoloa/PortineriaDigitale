/**
 * js/api.js - Motore OCR client-side (Tesseract.js Worker riutilizzabile),
 * pre-elaborazione immagine Bradley-Roth + Sharpening, ritaglio per zone (ROI)
 * e parser con validazione matematica Check-Digit ICAO 9303 (7-3-1).
 */

let tesseractWorkerPromise = null;
let ocrStatusCallback = null;

export function setOcrStatusCallback(cb) {
  ocrStatusCallback = cb;
}

/**
 * Restituisce un'istanza singola e riutilizzabile del Worker Tesseract ('ita').
 */
export async function getOcrWorker() {
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

/**
 * Calcola le coordinate di ritaglio 1:1 tra il flusso video e la cornice guida a schermo.
 */
export function getGuideCropCoordinates(video, guide) {
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

/**
 * Ritaglia una sotto-regione normalizzata { x, y, w, h } da un canvas,
 * aggiunge padding bianco intorno ai caratteri e garantisce un'altezza minima
 * per migliorare il riconoscimento LSTM di Tesseract.
 */
export function cropCanvasRegion(sourceCanvas, normRect, padPx = 12) {
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;

  const sx = Math.max(0, Math.floor((normRect.x || 0) * srcW));
  const sy = Math.max(0, Math.floor((normRect.y || 0) * srcH));
  const sw = Math.max(1, Math.min(srcW - sx, Math.ceil((normRect.w || 1) * srcW)));
  const sh = Math.max(1, Math.min(srcH - sy, Math.ceil((normRect.h || 1) * srcH)));

  const minHeight = 140;
  const scale = sh < minHeight ? minHeight / sh : 1;
  const dstW = Math.round(sw * scale);
  const dstH = Math.round(sh * scale);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = dstW + padPx * 2;
  outCanvas.height = dstH + padPx * 2;

  const ctx = outCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outCanvas.width, outCanvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, padPx, padPx, dstW, dstH);

  return outCanvas;
}

/**
 * Pre-elaborazione avanzata immagine:
 * 1. Scala di grigi + stretching di contrasto (percentili 2%-98%)
 * 2. Filtro di Sharpening 3x3 (1.8 * centro - 0.2 * vicini cardinali)
 * 3. Binarizzazione adattiva locale di Bradley-Roth tramite Integral Image O(1)
 */
export function preprocessCardImage(sourceCanvas, options = {}) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  if (!w || !h) return sourceCanvas;

  const pCanvas = document.createElement('canvas');
  pCanvas.width = w;
  pCanvas.height = h;
  const pCtx = pCanvas.getContext('2d', { willReadFrequently: true });
  pCtx.drawImage(sourceCanvas, 0, 0);

  try {
    const imgData = pCtx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const total = w * h;

    // 1. Scala di grigi + istogramma per stretching 2% - 98%
    const gray = new Float32Array(total);
    const hist = new Int32Array(256);
    for (let p = 0, i = 0; p < total; p++, i += 4) {
      const lum = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      gray[p] = lum;
      hist[lum]++;
    }

    let minCut = 0;
    let maxCut = 255;
    let accum = 0;
    for (let i = 0; i < 256; i++) {
      accum += hist[i];
      if (accum >= total * 0.02) { minCut = i; break; }
    }
    accum = 0;
    for (let i = 255; i >= 0; i--) {
      accum += hist[i];
      if (accum >= total * 0.02) { maxCut = i; break; }
    }
    if (maxCut <= minCut) { minCut = 0; maxCut = 255; }
    const range = maxCut - minCut;

    const stretched = new Float32Array(total);
    for (let p = 0; p < total; p++) {
      const val = ((gray[p] - minCut) / range) * 255;
      stretched[p] = val < 0 ? 0 : (val > 255 ? 255 : val);
    }

    // 2. Filtro Sharpening 3x3 (Unsharp mask leggero sui bordi dei caratteri)
    const sharp = new Float32Array(total);
    for (let y = 0; y < h; y++) {
      const rowOffset = y * w;
      for (let x = 0; x < w; x++) {
        const idx = rowOffset + x;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
          sharp[idx] = stretched[idx];
          continue;
        }
        const center = stretched[idx];
        const neighbors =
          stretched[idx - 1] +
          stretched[idx + 1] +
          stretched[idx - w] +
          stretched[idx + w];
        const v = center * 1.8 - neighbors * 0.2;
        sharp[idx] = v < 0 ? 0 : (v > 255 ? 255 : v);
      }
    }

    // 3. Integral Image (dimensione (w + 1) x (h + 1) con bordo zero)
    const iw = w + 1;
    const integral = new Float64Array(iw * (h + 1));
    for (let y = 1; y <= h; y++) {
      let rowSum = 0;
      const srcRow = (y - 1) * w;
      const intRow = y * iw;
      const prevIntRow = (y - 1) * iw;
      for (let x = 1; x <= w; x++) {
        rowSum += sharp[srcRow + (x - 1)];
        integral[intRow + x] = integral[prevIntRow + x] + rowSum;
      }
    }

    // 4. Binarizzazione adattiva locale Bradley-Roth
    const r = Math.max(8, Math.round(Math.min(w, h) / 22));
    const t = typeof options.thresholdSensitivity === 'number' ? options.thresholdSensitivity : 0.14;
    const factor = 1 - t;

    for (let y = 0; y < h; y++) {
      const y1 = Math.max(0, y - r);
      const y2 = Math.min(h - 1, y + r);
      const rowY1 = y1 * iw;
      const rowY2 = (y2 + 1) * iw;
      const rowOffset = y * w;

      for (let x = 0; x < w; x++) {
        const x1 = Math.max(0, x - r);
        const x2 = Math.min(w - 1, x + r);
        const count = (x2 - x1 + 1) * (y2 - y1 + 1);
        const sum =
          integral[rowY2 + (x2 + 1)] -
          integral[rowY1 + (x2 + 1)] -
          integral[rowY2 + x1] +
          integral[rowY1 + x1];

        const idx = rowOffset + x;
        const bin = sharp[idx] * count <= sum * factor ? 0 : 255;
        const pIdx = idx * 4;
        d[pIdx] = bin;
        d[pIdx + 1] = bin;
        d[pIdx + 2] = bin;
        d[pIdx + 3] = 255;
      }
    }

    pCtx.putImageData(imgData, 0, 0);
    return pCanvas;
  } catch {
    return sourceCanvas;
  }
}

/* ==========================================================================
   VALIDAZIONE MATEMATICA ICAO 9303 (7-3-1) & AUTO-RIPARAZIONE MRZ
   ========================================================================== */
const DIGIT_NORMALIZE_MAP = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', B: '8' };
const LETTER_NORMALIZE_MAP = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B' };
const AMBIGUOUS_GROUPS = [
  ['0', 'O', 'Q'],
  ['1', 'I', 'L'],
  ['2', 'Z'],
  ['5', 'S'],
  ['6', 'G'],
  ['8', 'B']
];

function toDigitChar(ch) {
  return DIGIT_NORMALIZE_MAP[ch] || ch;
}

function toLetterChar(ch) {
  return LETTER_NORMALIZE_MAP[ch] || ch;
}

/**
 * Calcola il check digit ICAO Doc 9303 modulo 10 con pesi ciclici [7, 3, 1].
 */
export function calculateMrzCheckDigit(str) {
  const weights = [7, 3, 1];
  const clean = String(str || '').toUpperCase();
  let sum = 0;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    let val = 0;
    if (ch >= '0' && ch <= '9') {
      val = ch.charCodeAt(0) - 48;
    } else if (ch >= 'A' && ch <= 'Z') {
      val = ch.charCodeAt(0) - 55;
    } else {
      val = 0; // '<' o altro filler
    }
    sum += val * weights[i % 3];
  }

  return sum % 10;
}

function getAmbiguousAlternatives(ch, allowDigits, allowLetters) {
  for (const grp of AMBIGUOUS_GROUPS) {
    if (grp.includes(ch)) {
      return grp.filter((alt) => {
        if (alt === ch) return false;
        if (alt >= '0' && alt <= '9') return allowDigits;
        if (alt >= 'A' && alt <= 'Z') return allowLetters;
        return false;
      });
    }
  }
  return [];
}

/**
 * Verifica un campo MRZ rispetto al proprio check digit ICAO e tenta di riparare
 * eventuali errori OCR su caratteri ambigui (0/O, 1/I, 2/Z, 5/S, 6/G, 8/B).
 * @param {string} rawField - Sottostringa MRZ del campo
 * @param {string} rawCheckChar - Carattere check digit adiacente
 * @param {'digits'|'docnum'} fieldType - Tipo di vincolo posizionale
 * @returns {{ value: string, verified: boolean }}
 */
export function repairMrzFieldWithCheckDigit(rawField, rawCheckChar, fieldType = 'docnum') {
  const original = String(rawField || '').toUpperCase();
  const normCheckChar = toDigitChar(String(rawCheckChar || '').toUpperCase());

  if (!/^\d$/.test(normCheckChar)) {
    // Check digit illeggibile: applica sola normalizzazione posizionale
    if (fieldType === 'digits') {
      return { value: original.split('').map(toDigitChar).join(''), verified: false };
    }
    return { value: original, verified: false };
  }

  const expectedCheck = parseInt(normCheckChar, 10);

  // 1. Verifica immediata sul campo grezzo
  if (calculateMrzCheckDigit(original) === expectedCheck) {
    if (fieldType !== 'digits' || /^\d+$/.test(original)) {
      return { value: original, verified: true };
    }
  }

  // 2. Normalizzazione posizionale
  const chars = original.split('');
  const isItalianCieShape = fieldType === 'docnum' && chars.length === 9 &&
    ((chars[0] >= 'A' && chars[0] <= 'Z') || chars[0] in LETTER_NORMALIZE_MAP) &&
    ((chars[1] >= 'A' && chars[1] <= 'Z') || chars[1] in LETTER_NORMALIZE_MAP);

  const normalizedChars = chars.map((ch, idx) => {
    if (ch === '<') return ch;
    if (fieldType === 'digits') return toDigitChar(ch);
    if (isItalianCieShape) {
      if (idx < 2 || idx >= 7) return toLetterChar(ch);
      return toDigitChar(ch);
    }
    return ch;
  });

  const normalizedStr = normalizedChars.join('');
  if (calculateMrzCheckDigit(normalizedStr) === expectedCheck) {
    if (fieldType !== 'digits' || /^\d+$/.test(normalizedStr)) {
      return { value: normalizedStr, verified: true };
    }
  }

  // 3. Ricerca riparazione a singolo carattere sugli ambigui
  for (let i = 0; i < normalizedChars.length; i++) {
    const cur = normalizedChars[i];
    if (cur === '<') continue;

    let allowDigits = true;
    let allowLetters = fieldType !== 'digits';
    if (isItalianCieShape) {
      if (i < 2 || i >= 7) {
        allowDigits = false;
        allowLetters = true;
      } else {
        allowDigits = true;
        allowLetters = false;
      }
    }

    const alts = getAmbiguousAlternatives(cur, allowDigits, allowLetters);
    for (const alt of alts) {
      const candidate = normalizedChars.slice();
      candidate[i] = alt;
      const candStr = candidate.join('');
      if (calculateMrzCheckDigit(candStr) === expectedCheck) {
        return { value: candStr, verified: true };
      }
    }
  }

  // 4. Se nessun match esatto, tenta anche permutazioni su 2 posizioni per campi brevi (<= 9 char)
  for (let i = 0; i < normalizedChars.length; i++) {
    for (let j = i + 1; j < normalizedChars.length; j++) {
      const altsI = getAmbiguousAlternatives(
        normalizedChars[i],
        fieldType === 'digits' || (isItalianCieShape && i >= 2 && i < 7) || !isItalianCieShape,
        fieldType !== 'digits' && (!isItalianCieShape || i < 2 || i >= 7)
      );
      const altsJ = getAmbiguousAlternatives(
        normalizedChars[j],
        fieldType === 'digits' || (isItalianCieShape && j >= 2 && j < 7) || !isItalianCieShape,
        fieldType !== 'digits' && (!isItalianCieShape || j < 2 || j >= 7)
      );
      for (const aI of altsI) {
        for (const aJ of altsJ) {
          const candidate = normalizedChars.slice();
          candidate[i] = aI;
          candidate[j] = aJ;
          const candStr = candidate.join('');
          if (calculateMrzCheckDigit(candStr) === expectedCheck) {
            return { value: candStr, verified: true };
          }
        }
      }
    }
  }

  return { value: normalizedStr, verified: false };
}

/**
 * Parser MRZ per Carte d'Identità Elettroniche (TD1: 3 righe x 30 char)
 * e Passaporti (TD3: 2 righe x 44 char) con validazione Check-Digit ICAO 9303.
 */
export function parseMrzText(rawText) {
  const cleanLines = String(rawText || '')
    .toUpperCase()
    .split('\n')
    .map((l) => l.replace(/[^A-Z0-9<]/g, ''))
    .filter((l) => l.length >= 24);

  if (cleanLines.length < 2) return null;

  const formatMrzDate = (digitsStr, isExpiry = false) => {
    if (!/^\d{6}$/.test(digitsStr)) return '';
    const yy = parseInt(digitsStr.slice(0, 2), 10);
    const mm = digitsStr.slice(2, 4);
    const dd = digitsStr.slice(4, 6);
    const mmNum = parseInt(mm, 10);
    const ddNum = parseInt(dd, 10);
    if (mmNum < 1 || mmNum > 12 || ddNum < 1 || ddNum > 31) return '';

    const curYY = new Date().getFullYear() % 100;
    const yyyy = isExpiry
      ? (yy <= curYY + 25 ? 2000 + yy : 1900 + yy)
      : (yy <= curYY ? 2000 + yy : 1900 + yy);
    return `${yyyy}-${mm}-${dd}`;
  };

  // TD1 (CIE Italiana: 3 righe da 30 caratteri)
  const td1Idx = cleanLines.findIndex((l) => /^(I|C|A)[<A-Z0-9]/.test(l) && l.length >= 26 && l.length <= 34);
  if (td1Idx !== -1 && cleanLines[td1Idx + 1] && cleanLines[td1Idx + 2]) {
    const l1 = cleanLines[td1Idx].padEnd(30, '<');
    const l2 = cleanLines[td1Idx + 1].padEnd(30, '<');
    const l3 = cleanLines[td1Idx + 2];

    const docCheck = repairMrzFieldWithCheckDigit(l1.slice(5, 14), l1[14], 'docnum');
    const dobCheck = repairMrzFieldWithCheckDigit(l2.slice(0, 6), l2[6], 'digits');
    const expCheck = repairMrzFieldWithCheckDigit(l2.slice(8, 14), l2[14], 'digits');

    const docNum = docCheck.value.replace(/</g, '').trim();
    const dataNascita = formatMrzDate(dobCheck.value, false);
    const dataScadenza = formatMrzDate(expCheck.value, true);

    const nameParts = l3.split('<<');
    const cognome = (nameParts[0] || '').replace(/</g, ' ').trim();
    const nome = (nameParts[1] || '').replace(/</g, ' ').trim();

    const verifiedCount = [docCheck, dobCheck, expCheck].filter((c) => c.verified).length;

    if (cognome || docNum) {
      return {
        docTipo: 'C.I. Elettronica (CIE)',
        docNum,
        cognome,
        nome,
        dataNascita,
        dataScadenza,
        ente: "Ministero dell'Interno",
        mrzVerified: verifiedCount >= 2
      };
    }
  }

  // TD3 (Passaporto: 2 righe da 44 caratteri)
  const td3Idx = cleanLines.findIndex((l) => /^P[<A-Z]/.test(l) && l.length >= 38);
  if (td3Idx !== -1 && cleanLines[td3Idx + 1]) {
    const l1 = cleanLines[td3Idx];
    const l2 = cleanLines[td3Idx + 1].padEnd(44, '<');

    const nameParts = l1.slice(5).split('<<');
    const cognome = (nameParts[0] || '').replace(/</g, ' ').trim();
    const nome = (nameParts[1] || '').replace(/</g, ' ').trim();

    const docCheck = repairMrzFieldWithCheckDigit(l2.slice(0, 9), l2[9], 'docnum');
    const dobCheck = repairMrzFieldWithCheckDigit(l2.slice(13, 19), l2[19], 'digits');
    const expCheck = repairMrzFieldWithCheckDigit(l2.slice(21, 27), l2[27], 'digits');

    const docNum = docCheck.value.replace(/</g, '').trim();
    const dataNascita = formatMrzDate(dobCheck.value, false);
    const dataScadenza = formatMrzDate(expCheck.value, true);

    const verifiedCount = [docCheck, dobCheck, expCheck].filter((c) => c.verified).length;

    if (cognome || docNum) {
      return {
        docTipo: 'Passaporto',
        docNum,
        cognome,
        nome,
        dataNascita,
        dataScadenza,
        ente: 'Questura',
        mrzVerified: verifiedCount >= 2
      };
    }
  }

  return null;
}

/**
 * Estrae i dati anagrafici e del documento dal testo OCR del fronte tessera.
 */
export function parseDocFrontText(rawText) {
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
    const cieM = l.match(/\b([A-Z0-9]{2})\s?([0-9OQLISZB]{5})\s?([A-Z0-9]{2})\b/i);
    if (cieM) {
      const prefix = cieM[1].toUpperCase().split('').map(toLetterChar).join('');
      const mid = cieM[2].toUpperCase().split('').map(toDigitChar).join('');
      const suffix = cieM[3].toUpperCase().split('').map(toLetterChar).join('');
      if (/^[A-Z]{2}\d{5}[A-Z]{2}$/.test(prefix + mid + suffix)) {
        docNum = prefix + mid + suffix;
        tipoDoc = 'C.I. Elettronica (CIE)';
        break;
      }
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
      const next = lines[i + 1].replace(/[^A-Z\s']/g, '').trim();
      if (next && next.length > 1 && !next.includes('NOME') && !next.includes('NAME')) cognome = next;
    }
    if ((line.includes('NOME') || line.includes('NAME')) && !line.includes('COGNOME') && !line.includes('SURNAME') && i + 1 < lines.length) {
      const next = lines[i + 1].replace(/[^A-Z\s']/g, '').trim();
      if (next && next.length > 1 && !next.includes('LUOGO') && !next.includes('PLACE')) nome = next;
    }
    if ((line.includes('LUOGO') || line.includes('PLACE') || line.includes('NATO')) && i + 1 < lines.length) {
      const next = lines[i + 1].replace(/[0-9/.-]/g, '').replace(/[^A-Z\s()]/g, '').trim();
      if (next && next.length > 2) luogoNascita = next.replace(/DATA|NASCITA|DATE|BIRTH/gi, '').trim();
    }
  }

  return {
    docTipo: tipoDoc,
    docNum,
    cognome,
    nome,
    luogoNascita,
    dataNascita: dataNascitaIso,
    dataScadenza: dataScadenzaIso,
    ente: "Ministero dell'Interno"
  };
}

/* ==========================================================================
   PIPELINE OCR MULTI-ZONA (ROI) CON PARAMETRI TESSERACT DINAMICI
   ========================================================================== */
async function recognizeWithParams(worker, canvas, params) {
  await worker.setParameters(params);
  const result = await worker.recognize(canvas);
  return result && result.data ? (result.data.text || '') : '';
}

/**
 * Esegue il riconoscimento ottimizzato su un canvas sorgente:
 * - mode === 'mrz': ritaglia fascia inferiore MRZ + whitelist ICAO + PSM 6 + validazione 7-3-1
 * - mode === 'front': ROI Numero Documento (PSM 7) + ROI Anagrafica Destra (PSM 6) + fallback tessera intera
 */
export async function recognizeDocumentCanvas(sourceCanvas, mode = 'front', target = 'student') {
  const worker = await getOcrWorker();
  if (!worker) return null;

  try {
    if (mode === 'mrz') {
      const mrzParams = {
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
        tessedit_pageseg_mode: '6'
      };

      // Tentativo 1: ritaglio dedicato fascia MRZ inferiore
      const mrzCrop = cropCanvasRegion(sourceCanvas, { x: 0.02, y: 0.54, w: 0.96, h: 0.44 }, 14);
      const mrzProcessed = preprocessCardImage(mrzCrop, { thresholdSensitivity: 0.13 });
      const mrzText = await recognizeWithParams(worker, mrzProcessed, mrzParams);
      const parsedCrop = parseMrzText(mrzText);
      if (parsedCrop) {
        return { data: parsedCrop, sourceLabel: parsedCrop.mrzVerified ? 'MRZ (Checksum ICAO OK)' : 'MRZ' };
      }

      // Tentativo 2: intera immagine pre-elaborata (es. foto caricata da file con inquadratura ampia)
      const fullProcessed = preprocessCardImage(sourceCanvas, { thresholdSensitivity: 0.13 });
      const fullText = await recognizeWithParams(worker, fullProcessed, mrzParams);
      const parsedFull = parseMrzText(fullText);
      if (parsedFull) {
        return { data: parsedFull, sourceLabel: parsedFull.mrzVerified ? 'MRZ (Checksum ICAO OK)' : 'MRZ' };
      }

      return null;
    }

    // Modalità 'front': Pipeline ROI dedicata al Fronte Documento
    let docNumFromRoi = '';
    if (target === 'student') {
      const docCrop = cropCanvasRegion(sourceCanvas, { x: 0.52, y: 0.05, w: 0.46, h: 0.19 }, 14);
      const docProcessed = preprocessCardImage(docCrop, { thresholdSensitivity: 0.14 });
      const docText = await recognizeWithParams(worker, docProcessed, {
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        tessedit_pageseg_mode: '7'
      });
      const parsedDoc = parseDocFrontText(docText);
      if (parsedDoc.docNum) docNumFromRoi = parsedDoc.docNum;
    }

    // Passaggio 2: Zona Anagrafica Destra (esclude fototessera a sinistra e banda superiore)
    const anagCrop = cropCanvasRegion(sourceCanvas, { x: 0.30, y: 0.18, w: 0.68, h: 0.70 }, 12);
    const anagProcessed = preprocessCardImage(anagCrop, { thresholdSensitivity: 0.14 });
    const anagWhitelist = target === 'visitor'
      ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ '"
      : "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/.- '()";

    const anagText = await recognizeWithParams(worker, anagProcessed, {
      tessedit_char_whitelist: anagWhitelist,
      tessedit_pageseg_mode: '6'
    });

    const parsedAnag = parseDocFrontText(anagText);
    if (docNumFromRoi && !parsedAnag.docNum) {
      parsedAnag.docNum = docNumFromRoi;
    }

    if (parsedAnag.cognome && parsedAnag.nome) {
      return { data: parsedAnag, sourceLabel: 'Fronte ROI' };
    }

    // Passaggio 3: Fallback tessera intera (es. Patente, Carta Cartacea o MRZ inquadrato per sbaglio in modalità Fronte)
    const fullProcessed = preprocessCardImage(sourceCanvas, { thresholdSensitivity: 0.14 });
    const fullText = await recognizeWithParams(worker, fullProcessed, {
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789< /.-'()",
      tessedit_pageseg_mode: '6'
    });

    if (fullText.includes('<<')) {
      const autoMrz = parseMrzText(fullText);
      if (autoMrz) {
        return { data: autoMrz, sourceLabel: autoMrz.mrzVerified ? 'MRZ (Checksum ICAO OK)' : 'MRZ' };
      }
    }

    const parsedFull = parseDocFrontText(fullText);
    const merged = {
      ...parsedFull,
      docNum: parsedAnag.docNum || docNumFromRoi || parsedFull.docNum,
      cognome: parsedAnag.cognome || parsedFull.cognome,
      nome: parsedAnag.nome || parsedFull.nome,
      luogoNascita: parsedAnag.luogoNascita || parsedFull.luogoNascita,
      dataNascita: parsedAnag.dataNascita || parsedFull.dataNascita,
      dataScadenza: parsedAnag.dataScadenza || parsedFull.dataScadenza
    };

    if (merged.cognome || merged.nome || merged.docNum || merged.dataNascita) {
      return { data: merged, sourceLabel: 'Fronte' };
    }

    return null;
  } finally {
    // Ripristina i parametri standard del worker riutilizzabile
    try {
      await worker.setParameters({
        tessedit_char_whitelist: '',
        tessedit_pageseg_mode: '3'
      });
    } catch {
      // Ignora errori durante il reset parametri
    }
  }
}
