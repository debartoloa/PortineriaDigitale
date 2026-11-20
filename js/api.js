/**
 * js/api.js - Motore OCR client-side (Tesseract.js Worker riutilizzabile),
 * pre-elaborazione immagine ottimizzata per CIE italiana (pesatura Rosso/Giallo
 * + Sharpening + Binarizzazione Adattiva Bradley-Roth), OCR Full-Card su
 * result.data.lines con ancore semantiche, e validazione Check-Digit ICAO 9303.
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
 * Calcola le coordinate di ritaglio tra il flusso video e la cornice guida a schermo,
 * aggiungendo un margine di tolleranza esterno (default 12%) su tutti e quattro i lati.
 */
export function getGuideCropCoordinates(video, guide, paddingRatio = 0.12) {
  const vW = video.videoWidth || 1280;
  const vH = video.videoHeight || 720;
  const vRect = video.getBoundingClientRect();
  const gRect = guide.getBoundingClientRect();

  const elemW = vRect.width || 1;
  const elemH = vRect.height || 1;
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

  // Margine di tolleranza del 12% (tra 10% e 15%) su tutti e quattro i lati
  const padX = sw * paddingRatio;
  const padY = sh * paddingRatio;
  sx = Math.max(0, sx - padX);
  sy = Math.max(0, sy - padY);
  sw = Math.min(vW - sx, sw + padX * 2);
  sh = Math.min(vH - sy, sh + padY * 2);

  return {
    sx: Math.round(sx),
    sy: Math.round(sy),
    sw: Math.max(1, Math.round(sw)),
    sh: Math.max(1, Math.round(sh))
  };
}

/**
 * Ritaglia una sotto-regione normalizzata { x, y, w, h } da un canvas (usata per fascia MRZ).
 */
export function cropCanvasRegion(sourceCanvas, normRect, padPx = 14) {
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;

  const sx = Math.max(0, Math.floor((normRect.x || 0) * srcW));
  const sy = Math.max(0, Math.floor((normRect.y || 0) * srcH));
  const sw = Math.max(1, Math.min(srcW - sx, Math.ceil((normRect.w || 1) * srcW)));
  const sh = Math.max(1, Math.min(srcH - sy, Math.ceil((normRect.h || 1) * srcH)));

  const minHeight = 160;
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
 * Pre-elaborazione ottimizzata per il fronte della CIE italiana:
 * 1. Scala di grigi pesata Rosso/Giallo (0.50*R + 0.42*G + 0.08*B) per attenuare
 *    le trame di sicurezza azzurro/ciano (guilloché) mantenendo scuro il testo.
 * 2. Stretching di contrasto (percentili 2%-98%).
 * 3. Leggero filtro Sharpening 3x3 per definire i caratteri piccoli.
 * 4. Binarizzazione adattiva locale (Bradley-Roth con Integral Image O(1)) in
 *    modo che le onde pastello diventino #FFFFFF e il testo #000000.
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

    // 1. Scala di grigi pesata su Rosso/Giallo per attenuare il ciano/azzurro della CIE
    const gray = new Float32Array(total);
    const hist = new Int32Array(256);
    for (let p = 0, i = 0; p < total; p++, i += 4) {
      const lum = Math.round(0.50 * d[i] + 0.42 * d[i + 1] + 0.08 * d[i + 2]);
      gray[p] = lum;
      hist[lum]++;
    }

    // 2. Stretching di contrasto dinamico (2% - 98%)
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

    // 3. Leggero Sharpening 3x3
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
        const v = center * 1.6 - neighbors * 0.15;
        sharp[idx] = v < 0 ? 0 : (v > 255 ? 255 : v);
      }
    }

    // 4. Integral Image & Binarizzazione Adattiva Locale (Bradley-Roth)
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

    const r = Math.max(10, Math.round(Math.min(w, h) / 20));
    const t = typeof options.thresholdSensitivity === 'number' ? options.thresholdSensitivity : 0.15;
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
      val = 0;
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
 * Verifica un campo MRZ rispetto al proprio check digit ICAO e ripara
 * eventuali errori OCR su caratteri ambigui (0/O, 1/I, 2/Z, 5/S, 6/G, 8/B).
 */
export function repairMrzFieldWithCheckDigit(rawField, rawCheckChar, fieldType = 'docnum') {
  const original = String(rawField || '').toUpperCase();
  const normCheckChar = toDigitChar(String(rawCheckChar || '').toUpperCase());

  if (!/^\d$/.test(normCheckChar)) {
    if (fieldType === 'digits') {
      return { value: original.split('').map(toDigitChar).join(''), verified: false };
    }
    return { value: original, verified: false };
  }

  const expectedCheck = parseInt(normCheckChar, 10);

  if (calculateMrzCheckDigit(original) === expectedCheck) {
    if (fieldType !== 'digits' || /^\d+$/.test(original)) {
      return { value: original, verified: true };
    }
  }

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

/* ==========================================================================
   PARSING FRONTE CIE CON ANCORE SEMANTICHE, REGEX E CONFIDENZA PER CAMPO
   ========================================================================== */
const CIE_LABEL_STOPWORDS = [
  'REPUBBLICA', 'ITALIANA', 'MINISTERO', 'INTERNO', 'CARTA', 'IDENTITA',
  'IDENTITY', 'CARD', 'COMUNE', 'MUNICIPALITY', 'COGNOME', 'SURNAME',
  'NOME', 'NAME', 'LUOGO', 'PLACE', 'NASCITA', 'BIRTH', 'SESSO', 'SEX',
  'STATURA', 'HEIGHT', 'CITTADINANZA', 'NATIONALITY', 'EMISSIONE', 'ISSUING',
  'SCADENZA', 'EXPIRY', 'FIRMA', 'TITOLARE', 'HOLDER', 'SIGNATURE', 'NON VALIDA'
];

function cleanOcrLineText(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[|_*~^=«»[\]{}\\"]/g, ' ')
    .replace(/(^|\s)[.,;:-]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPureLabelLine(txt) {
  const tokens = txt.replace(/[^A-ZÀÈÉÌÒÙ\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((tok) => CIE_LABEL_STOPWORDS.some((sw) => tok === sw || (tok.length >= 4 && sw.includes(tok))));
}

function stripLabelWords(txt, regexList) {
  let out = txt;
  for (const rx of regexList) {
    out = out.replace(rx, ' ');
  }
  return out.replace(/[/\\|:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Estrae i dati dal fronte della CIE italiana usando l'array strutturato
 * `result.data.lines` (testo, confidenza, bbox) e le ancore verticali ufficiali.
 */
export function parseCieFrontLines(rawLines = [], rawText = '', canvasHeight = 0) {
  const normalizedLines = (Array.isArray(rawLines) && rawLines.length > 0
    ? rawLines
    : String(rawText || '').split('\n').map((t, idx) => ({
      text: t,
      confidence: 80,
      bbox: { x0: 0, y0: idx * 30, x1: 100, y1: idx * 30 + 24 }
    }))
  )
    .map((l, idx) => {
      const text = cleanOcrLineText(l.text);
      const bbox = l.bbox || { x0: 0, y0: idx * 30, x1: 100, y1: idx * 30 + 24 };
      return {
        text,
        confidence: typeof l.confidence === 'number' ? l.confidence : 80,
        bbox,
        yCenter: (bbox.y0 + bbox.y1) / 2,
        height: Math.max(12, bbox.y1 - bbox.y0)
      };
    })
    .filter((l) => l.text.length > 0)
    .sort((a, b) => a.yCenter - b.yCenter);

  let docNum = '';
  let cognome = '';
  let nome = '';
  let luogoNascita = '';
  let dataNascitaIso = '';
  let dataEmissioneIso = '';
  let dataScadenzaIso = '';
  let tipoDoc = 'C.I. Elettronica (CIE)';

  const confidences = {};

  // 1. Numero Documento CIE (2 lettere + 5 cifre + 2 lettere, es. CA00000AA)
  for (const line of normalizedLines) {
    const cieM = line.text.match(/\b([A-Z0-9]{2})\s?([0-9OQLISZBG]{5})\s?([A-Z0-9]{2})\b/);
    if (cieM) {
      const prefix = cieM[1].split('').map(toLetterChar).join('');
      const mid = cieM[2].split('').map(toDigitChar).join('');
      const suffix = cieM[3].split('').map(toLetterChar).join('');
      const candidate = prefix + mid + suffix;
      if (/^[A-Z]{2}\d{5}[A-Z]{2}$/.test(candidate)) {
        docNum = candidate;
        tipoDoc = 'C.I. Elettronica (CIE)';
        confidences.docNum = line.confidence;
        break;
      }
    }
  }

  const fullJoined = normalizedLines.map((l) => l.text).join('\n');
  if (!docNum) {
    const paperMatch = fullJoined.match(/\b([A-Z]{2}\s?[0-9]{6,7})\b/);
    if (paperMatch) {
      docNum = paperMatch[1].replace(/\s/g, '');
      tipoDoc = "Carta d'Identità Cartacea";
    } else {
      const patMatch = fullJoined.match(/\b(U1[0-9A-Z]{7}[A-Z])\b/);
      if (patMatch) {
        docNum = patMatch[1];
        tipoDoc = 'Patente di Guida';
      }
    }
  }

  // Helper: trova la riga valore subito sotto un'etichetta (o alla sua destra)
  const extractValueAfterAnchor = (anchorIdx, anchorStripRegexes) => {
    const anchor = normalizedLines[anchorIdx];
    const inlineRest = stripLabelWords(anchor.text, anchorStripRegexes).replace(/[^A-ZÀÈÉÌÒÙ0-9\s'().-]/g, '').trim();
    if (inlineRest && inlineRest.length >= 2 && !isPureLabelLine(inlineRest)) {
      return { text: inlineRest, confidence: anchor.confidence };
    }

    for (let offset = 1; offset <= 2; offset++) {
      const next = normalizedLines[anchorIdx + offset];
      if (!next) break;
      const gap = next.yCenter - anchor.yCenter;
      if (gap > anchor.height * 4.5) break;
      if (isPureLabelLine(next.text)) continue;
      return { text: next.text, confidence: next.confidence };
    }
    return null;
  };

  // 2. Ancora COGNOME / SURNAME
  for (let i = 0; i < normalizedLines.length; i++) {
    const t = normalizedLines[i].text;
    if (/\b(COGNOME|SURNAME)\b/.test(t)) {
      const val = extractValueAfterAnchor(i, [/\bCOGNOME\b/g, /\bSURNAME\b/g]);
      if (val) {
        const cleaned = val.text.replace(/[^A-ZÀÈÉÌÒÙ\s'-]/g, '').trim();
        if (cleaned.length >= 2) {
          cognome = cleaned;
          confidences.cognome = val.confidence;
          break;
        }
      }
    }
  }

  // 3. Ancora NOME / NAME (escludendo COGNOME / SURNAME)
  for (let i = 0; i < normalizedLines.length; i++) {
    const t = normalizedLines[i].text;
    if (/\b(NOME|NAME)\b/.test(t) && !/\b(COGNOME|SURNAME)\b/.test(t)) {
      const val = extractValueAfterAnchor(i, [/\bNOME\b/g, /\bNAME\b/g]);
      if (val) {
        const cleaned = val.text.replace(/[^A-ZÀÈÉÌÒÙ\s'-]/g, '').trim();
        if (cleaned.length >= 2 && cleaned !== cognome) {
          nome = cleaned;
          confidences.nome = val.confidence;
          break;
        }
      }
    }
  }

  // Helper parsing data GG.MM.AAAA (con tolleranza su separatori . / -)
  const parseItDateStr = (rawDate) => {
    const parts = rawDate.split(/[./-]/);
    if (parts.length !== 3) return null;
    const dd = parts[0].padStart(2, '0');
    const mm = parts[1].padStart(2, '0');
    const yyyy = parts[2];
    const dNum = parseInt(dd, 10);
    const mNum = parseInt(mm, 10);
    const yNum = parseInt(yyyy, 10);
    if (dNum < 1 || dNum > 31 || mNum < 1 || mNum > 12 || yNum < 1900 || yNum > 2099) return null;
    return { iso: `${yyyy}-${mm}-${dd}`, year: yNum };
  };

  // 4. Ancora LUOGO E DATA DI NASCITA / PLACE AND DATE OF BIRTH
  for (let i = 0; i < normalizedLines.length; i++) {
    const t = normalizedLines[i].text;
    if (/\b(LUOGO|NASCITA|PLACE|BIRTH)\b/.test(t)) {
      const val = extractValueAfterAnchor(i, [
        /\bLUOGO\s+E\s+DATA\s+DI\s+NASCITA\b/g,
        /\bPLACE\s+AND\s+DATE\s+OF\s+BIRTH\b/g,
        /\bLUOGO\b/g, /\bDATA\b/g, /\bDI\b/g, /\bNASCITA\b/g,
        /\bPLACE\b/g, /\bAND\b/g, /\bDATE\b/g, /\bOF\b/g, /\bBIRTH\b/g
      ]);
      if (val) {
        const dateM = val.text.match(/\b(\d{2}[./-]\d{2}[./-]\d{4})\b/);
        if (dateM) {
          const parsedD = parseItDateStr(dateM[1]);
          if (parsedD) {
            dataNascitaIso = parsedD.iso;
            confidences.dataNascita = val.confidence;
          }
          const beforeDate = val.text.slice(0, dateM.index).replace(/[^A-ZÀÈÉÌÒÙ\s'()-]/g, '').trim();
          if (beforeDate.length >= 2) {
            luogoNascita = beforeDate;
            confidences.luogoNascita = val.confidence;
          }
        } else {
          const onlyPlace = val.text.replace(/[^A-ZÀÈÉÌÒÙ\s'()-]/g, '').trim();
          if (onlyPlace.length >= 2) {
            luogoNascita = onlyPlace;
            confidences.luogoNascita = val.confidence;
          }
        }
        break;
      }
    }
  }

  // 5. Ancore EMISSIONE / ISSUING e SCADENZA / EXPIRY + raccolta tutte le date GG.MM.AAAA
  const allDates = [];
  const dateGlobalRegex = /\b(\d{2}[./-]\d{2}[./-]\d{4})\b/g;

  for (let i = 0; i < normalizedLines.length; i++) {
    const line = normalizedLines[i];
    let m;
    dateGlobalRegex.lastIndex = 0;
    while ((m = dateGlobalRegex.exec(line.text)) !== null) {
      const parsedD = parseItDateStr(m[1]);
      if (parsedD) {
        allDates.push({
          ...parsedD,
          confidence: line.confidence,
          yCenter: line.yCenter,
          inLowerHalf: canvasHeight > 0 ? line.yCenter >= canvasHeight * 0.42 : true
        });
      }
    }

    if (/\b(EMISSIONE|ISSUING)\b/.test(line.text) && !dataEmissioneIso) {
      const val = extractValueAfterAnchor(i, [/\bEMISSIONE\b/g, /\bISSUING\b/g]);
      if (val) {
        const dm = val.text.match(/\b(\d{2}[./-]\d{2}[./-]\d{4})\b/);
        if (dm) {
          const parsedD = parseItDateStr(dm[1]);
          if (parsedD) {
            dataEmissioneIso = parsedD.iso;
            confidences.dataEmissione = val.confidence;
          }
        }
      }
    }

    if (/\b(SCADENZA|EXPIRY)\b/.test(line.text) && !dataScadenzaIso) {
      const val = extractValueAfterAnchor(i, [/\bSCADENZA\b/g, /\bEXPIRY\b/g]);
      if (val) {
        const dm = val.text.match(/\b(\d{2}[./-]\d{2}[./-]\d{4})\b/);
        if (dm) {
          const parsedD = parseItDateStr(dm[1]);
          if (parsedD) {
            dataScadenzaIso = parsedD.iso;
            confidences.dataScadenza = val.confidence;
          }
        }
      }
    }
  }

  // Classificazione cronologica di fallback sulle date rilevate nella metà inferiore
  if (allDates.length > 0) {
    const lowerDates = allDates.filter((d) => d.inLowerHalf);
    const pool = (lowerDates.length > 0 ? lowerDates : allDates).slice().sort((a, b) => a.year - b.year || a.iso.localeCompare(b.iso));
    const curYear = new Date().getFullYear();

    if (!dataNascitaIso) {
      const oldest = pool.find((d) => d.year <= curYear - 14);
      if (oldest) {
        dataNascitaIso = oldest.iso;
        confidences.dataNascita = oldest.confidence;
      }
    }

    if (!dataScadenzaIso) {
      const future = pool.slice().reverse().find((d) => d.year >= curYear);
      if (future) {
        dataScadenzaIso = future.iso;
        confidences.dataScadenza = future.confidence;
      }
    }

    if (!dataEmissioneIso) {
      const middle = pool.find((d) => d.iso !== dataNascitaIso && d.iso !== dataScadenzaIso && d.year <= curYear);
      if (middle) {
        dataEmissioneIso = middle.iso;
        confidences.dataEmissione = middle.confidence;
      }
    }
  }

  return {
    docTipo: tipoDoc,
    docNum,
    cognome,
    nome,
    luogoNascita,
    dataNascita: dataNascitaIso,
    dataEmissione: dataEmissioneIso,
    dataScadenza: dataScadenzaIso,
    ente: "Ministero dell'Interno",
    confidences
  };
}

/**
 * Wrapper retrocompatibile per testo grezzo suddiviso per righe.
 */
export function parseDocFrontText(rawText) {
  return parseCieFrontLines([], rawText, 0);
}

/* ==========================================================================
   PIPELINE OCR FULL-CARD (FRONTE) + RETRO MRZ CON PARAMETRI DINAMICI
   ========================================================================== */
async function recognizeWithParams(worker, canvas, params) {
  await worker.setParameters(params);
  const result = await worker.recognize(canvas);
  const data = (result && result.data) ? result.data : {};
  return {
    text: data.text || '',
    lines: Array.isArray(data.lines) ? data.lines : []
  };
}

/**
 * Esegue il riconoscimento ottimizzato su un canvas sorgente:
 * - mode === 'mrz': ritaglia fascia inferiore MRZ + whitelist ICAO + PSM 6 + validazione 7-3-1
 * - mode === 'front': OCR Full-Card su immagine pre-elaborata per CIE (PSM 6, fallback PSM 11)
 *   leggendo result.data.lines con ancore semantiche e livelli di confidenza.
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

      const mrzCrop = cropCanvasRegion(sourceCanvas, { x: 0.02, y: 0.54, w: 0.96, h: 0.44 }, 14);
      const mrzProcessed = preprocessCardImage(mrzCrop, { thresholdSensitivity: 0.13 });
      const mrzRes = await recognizeWithParams(worker, mrzProcessed, mrzParams);
      const parsedCrop = parseMrzText(mrzRes.text);
      if (parsedCrop) {
        return { data: parsedCrop, sourceLabel: parsedCrop.mrzVerified ? 'MRZ (Checksum ICAO OK)' : 'MRZ' };
      }

      const fullProcessed = preprocessCardImage(sourceCanvas, { thresholdSensitivity: 0.13 });
      const fullRes = await recognizeWithParams(worker, fullProcessed, mrzParams);
      const parsedFull = parseMrzText(fullRes.text);
      if (parsedFull) {
        return { data: parsedFull, sourceLabel: parsedFull.mrzVerified ? 'MRZ (Checksum ICAO OK)' : 'MRZ' };
      }

      return null;
    }

    // Modalità 'front': Full-Card OCR sull'intera immagine pre-elaborata (indipendente da sub-box rigidi)
    const processedFull = preprocessCardImage(sourceCanvas, { thresholdSensitivity: 0.15 });
    const frontWhitelist = "ABCDEFGHIJKLMNOPQRSTUVWXYZÀÈÉÌÒÙ0123456789./- ()'";

    const psm6Res = await recognizeWithParams(worker, processedFull, {
      tessedit_char_whitelist: frontWhitelist,
      tessedit_pageseg_mode: '6'
    });

    if (psm6Res.text.includes('<<')) {
      const autoMrz = parseMrzText(psm6Res.text);
      if (autoMrz) {
        return { data: autoMrz, sourceLabel: autoMrz.mrzVerified ? 'MRZ (Checksum ICAO OK)' : 'MRZ' };
      }
    }

    let parsed = parseCieFrontLines(psm6Res.lines, psm6Res.text, processedFull.height);

    // Se PSM 6 ha mancato cognome/nome (o numero doc in flusso alunni), secondo passaggio Full-Card con PSM 11 (Sparse text)
    const needsSparsePass = !parsed.cognome || !parsed.nome || (target === 'student' && !parsed.docNum);
    if (needsSparsePass) {
      const psm11Res = await recognizeWithParams(worker, processedFull, {
        tessedit_char_whitelist: frontWhitelist,
        tessedit_pageseg_mode: '11'
      });

      const sparseParsed = parseCieFrontLines(psm11Res.lines, psm11Res.text, processedFull.height);
      const mergedConfidences = { ...sparseParsed.confidences, ...parsed.confidences };

      for (const key of ['docNum', 'cognome', 'nome', 'luogoNascita', 'dataNascita', 'dataEmissione', 'dataScadenza']) {
        if (!parsed[key] && sparseParsed[key]) {
          parsed[key] = sparseParsed[key];
          if (sparseParsed.confidences[key] !== undefined) {
            mergedConfidences[key] = sparseParsed.confidences[key];
          }
        }
      }
      parsed.confidences = mergedConfidences;
    }

    if (parsed.cognome || parsed.nome || parsed.docNum || parsed.dataNascita) {
      return { data: parsed, sourceLabel: 'Fronte CIE (Full-Card)' };
    }

    return null;
  } finally {
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
