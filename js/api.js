/**
 * js/api.js - Motore OCR client-side v2 (Tesseract.js v5 Worker riutilizzabile),
 * normalizzazione risoluzione, appiattimento illuminazione + scala di grigi morbida
 * anti-ciano per CIE italiana, estrazione layout via { blocks: true } (PSM 3 / PSM 11),
 * parser con ancore fuzzy + ancoraggio inverso, e validazione Check-Digit ICAO 9303.
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
 * Normalizza la risoluzione del canvas per garantire caratteri di altezza ideale
 * (30-45px per Tesseract LSTM) e aggiunge un bordo bianco attorno al documento.
 */
export function prepareOcrCanvas(sourceCanvas, targetLongSide = 2000, borderPx = 20) {
  const srcW = sourceCanvas.width || 1;
  const srcH = sourceCanvas.height || 1;
  const longSide = Math.max(srcW, srcH);

  let scale = 1;
  if (longSide < 1500) {
    scale = targetLongSide / longSide;
  } else if (longSide > 2200) {
    scale = 2000 / longSide;
  }

  const dstW = Math.max(1, Math.round(srcW * scale));
  const dstH = Math.max(1, Math.round(srcH * scale));

  const outCanvas = document.createElement('canvas');
  outCanvas.width = dstW + borderPx * 2;
  outCanvas.height = dstH + borderPx * 2;

  const ctx = outCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outCanvas.width, outCanvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, srcW, srcH, borderPx, borderPx, dstW, dstH);

  return outCanvas;
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
 * Pre-processing ottimizzato per Tesseract 5 LSTM su CIE italiana:
 * "Illumination Flattening + Soft Anti-Aliased Grayscale" (senza binarizzazione hard 1-bit!).
 * 1. Scala di grigi pesata anti-ciano (0.58*R + 0.34*G + 0.08*B) per attenuare guilloché azzurri.
 * 2. Stima sfondo locale via Integral Image con raggio ampio (10% del lato corto) così le lettere
 *    bold non abbassano il riferimento locale e non vengono svuotate.
 * 3. Appiattimento illuminazione: flat = (lum / localBg) * 235.
 * 4. Curva morbida anti-aliased (preserva i contorni morbidi per la rete neurale LSTM).
 */
export function preprocessCardImage(sourceCanvas, options = {}) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  if (!w || !h) return sourceCanvas;

  const whiteCut = typeof options.whiteCut === 'number' ? options.whiteCut : 205;
  const darkKnee = typeof options.darkKnee === 'number' ? options.darkKnee : 85;
  const lightOnly = Boolean(options.lightOnly);

  const pCanvas = document.createElement('canvas');
  pCanvas.width = w;
  pCanvas.height = h;
  const pCtx = pCanvas.getContext('2d', { willReadFrequently: true });
  pCtx.drawImage(sourceCanvas, 0, 0);

  try {
    const imgData = pCtx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const total = w * h;

    // 1. Scala di grigi pesata anti-ciano (Rosso/Giallo dominanti)
    const lum = new Float32Array(total);
    for (let p = 0, i = 0; p < total; p++, i += 4) {
      lum[p] = 0.58 * d[i] + 0.34 * d[i + 1] + 0.08 * d[i + 2];
    }

    if (lightOnly) {
      for (let p = 0, i = 0; p < total; p++, i += 4) {
        const v = Math.max(0, Math.min(255, Math.round(lum[p])));
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
        d[i + 3] = 255;
      }
      pCtx.putImageData(imgData, 0, 0);
      return pCanvas;
    }

    // 2. Integral Image per stima dello sfondo locale a raggio ampio
    const iw = w + 1;
    const integral = new Float64Array(iw * (h + 1));
    for (let y = 1; y <= h; y++) {
      let rowSum = 0;
      const srcRow = (y - 1) * w;
      const intRow = y * iw;
      const prevIntRow = (y - 1) * iw;
      for (let x = 1; x <= w; x++) {
        rowSum += lum[srcRow + (x - 1)];
        integral[intRow + x] = integral[prevIntRow + x] + rowSum;
      }
    }

    const r = Math.max(28, Math.round(Math.min(w, h) / 10));

    // 3. Appiattimento illuminazione + curva morbida anti-aliased
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

        const localBg = sum / count;
        const idx = rowOffset + x;
        const flat = Math.min(255, (lum[idx] / Math.max(localBg, 35)) * 235);

        let outVal;
        if (flat >= whiteCut) {
          outVal = 255;
        } else if (flat <= darkKnee) {
          outVal = Math.round((flat / darkKnee) * 45);
        } else {
          outVal = Math.round(45 + ((flat - darkKnee) / (whiteCut - darkKnee)) * 210);
        }

        const pIdx = idx * 4;
        d[pIdx] = outVal;
        d[pIdx + 1] = outVal;
        d[pIdx + 2] = outVal;
        d[pIdx + 3] = 255;
      }
    }

    pCtx.putImageData(imgData, 0, 0);
    return pCanvas;
  } catch {
    return sourceCanvas;
  }
}

/**
 * Variante ad alto contrasto dedicata alla fascia MRZ (caratteri OCR-B neri su fondo bianco).
 */
export function preprocessMrzImage(sourceCanvas) {
  return preprocessCardImage(sourceCanvas, { whiteCut: 185, darkKnee: 110 });
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
   PARSING FRONTE CIE CON ANCORE FUZZY, REGEX E ANCORAGGIO INVERSO
   ========================================================================== */
const CIE_LABEL_STOPWORDS = [
  'REPUBBLICA', 'ITALIANA', 'MINISTERO', 'DELL', 'INTERNO', 'CARTA', 'IDENTITA',
  'IDENTITY', 'CARD', 'COMUNE', 'MUNICIPALITY', 'COGNOME', 'SURNAME', 'SURNANE',
  'NOME', 'NAME', 'LUOGO', 'PLACE', 'NASCITA', 'BIRTH', 'SESSO', 'SEX',
  'STATURA', 'HEIGHT', 'CITTADINANZA', 'NATIONALITY', 'EMISSIONE', 'ISSUING',
  'SCADENZA', 'EXPIRY', 'FIRMA', 'TITOLARE', 'HOLDER', 'SIGNATURE',
  'NON', 'VALIDA', 'ESPATRIO', 'FACSIMILE', 'SIGNATURE'
];

function cleanOcrLineText(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[|_*~^=«»[\]{}\\"]/g, ' ')
    .replace(/(^|\s)[.,;:-]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPureLabelOrNoiseLine(txt) {
  const cleaned = txt.replace(/[^A-ZÀÈÉÌÒÙ\s]/g, ' ').trim();
  if (!cleaned || cleaned.length < 2) return true;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((tok) =>
    tok.length <= 1 ||
    CIE_LABEL_STOPWORDS.some((sw) => tok === sw || (tok.length >= 4 && (sw.includes(tok) || tok.includes(sw))))
  );
}

function isCognomeLabel(txt) {
  return /(?:^|\b)(C[O0Q]GN[O0Q][MN]E?|SURNA[MN]E)(?:\b|$)/.test(txt);
}

function isNomeLabel(txt) {
  if (isCognomeLabel(txt)) return false;
  return /(?:^|\b)(N[O0Q][MN]E|NA[MN]E)(?:\b|$)/.test(txt);
}

function isBirthLabel(txt) {
  return /(?:^|\b)(LU[O0]G[O0]|NASCITA|PLACE|BIRTH)(?:\b|$)/.test(txt);
}

function isIssuingLabel(txt) {
  return /(?:^|\b)(EMISS[I1][O0Q]NE|EMIS[A-Z0-9]{2,4}NE|[IL1]SSUING)(?:\b|$)/.test(txt);
}

function isExpiryLabel(txt) {
  return /(?:^|\b)(SCADENZA|EXPIRY)(?:\b|$)/.test(txt);
}

function isAnyFieldAnchor(txt) {
  return isCognomeLabel(txt) || isNomeLabel(txt) || isBirthLabel(txt) || isIssuingLabel(txt) || isExpiryLabel(txt);
}

function normalizeDateToken(rawDate) {
  const parts = String(rawDate || '').trim().split(/\s*[./-]\s*/);
  if (parts.length !== 3) return null;
  const dStr = parts[0].split('').map(toDigitChar).join('').padStart(2, '0');
  const mStr = parts[1].split('').map(toDigitChar).join('').padStart(2, '0');
  const yStr = parts[2].split('').map(toDigitChar).join('');
  if (!/^\d{2}$/.test(dStr) || !/^\d{2}$/.test(mStr) || !/^\d{4}$/.test(yStr)) return null;

  const dNum = parseInt(dStr, 10);
  const mNum = parseInt(mStr, 10);
  const yNum = parseInt(yStr, 10);
  if (dNum < 1 || dNum > 31 || mNum < 1 || mNum > 12 || yNum < 1900 || yNum > 2099) return null;
  return { iso: `${yStr}-${mStr}-${dStr}`, year: yNum };
}

function extractDatesFromText(txt) {
  const results = [];
  const seenOffsets = new Set();

  // Formato standard DD.MM.YYYY (anche con spazi attorno ai punti o O/I/l nelle cifre)
  const fullRx = /\b([0-3OIl][0-9OIl])\s*[./-]\s*([0-1OIl][0-9OIl])\s*[./-]\s*((?:19|20|1O|2O)[0-9OIl]{2})\b/g;
  let m;
  while ((m = fullRx.exec(txt)) !== null) {
    const parsed = normalizeDateToken(`${m[1]}.${m[2]}.${m[3]}`);
    if (parsed) {
      seenOffsets.add(m.index);
      results.push({ ...parsed, index: m.index, rawLength: m[0].length });
    }
  }

  // Formato parziale DD/MMYYYY (quando il secondo punto separatore è coperto da un timbro/riflesso, es. 30/052022)
  const partialRx = /\b([0-3OIl][0-9OIl])\s*[./-]\s*([0-1OIl][0-9OIl])\s*((?:19|20|1O|2O)[0-9OIl]{2})\b/g;
  while ((m = partialRx.exec(txt)) !== null) {
    if (seenOffsets.has(m.index)) continue;
    const parsed = normalizeDateToken(`${m[1]}.${m[2]}.${m[3]}`);
    if (parsed) {
      results.push({ ...parsed, index: m.index, rawLength: m[0].length });
    }
  }

  return results.sort((a, b) => a.index - b.index);
}

function cleanPersonNameValue(raw) {
  return String(raw || '')
    .replace(/[^A-ZÀÈÉÌÒÙ\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Rimuove eventuali singole lettere spurie finali (es. "BIANCA N" da filigrana) o iniziali non D/L
    .replace(/(?:\s+[A-Z])+$/g, '')
    .replace(/^(?![DL]\s)[A-Z]\s+/g, '')
    .trim();
}

function rebuildLineTextExcludingLeftOf(line, minX, maxStartX = Infinity, canvasWidth = 0, stopOnColumnGap = true) {
  if (!line || !Array.isArray(line.words) || line.words.length === 0) {
    return line ? line.text : '';
  }

  let kept = line.words
    .filter((w) => {
      const wx1 = w.bbox ? w.bbox.x1 : 99999;
      return !minX || wx1 >= minX;
    })
    .sort((a, b) => (a.bbox ? a.bbox.x0 : 0) - (b.bbox ? b.bbox.x0 : 0));

  if (kept.length === 0) return '';

  if (Number.isFinite(maxStartX)) {
    const startIdx = kept.findIndex((w) => (w.bbox ? w.bbox.x0 : 0) <= maxStartX);
    if (startIdx === -1) return '';
    kept = kept.slice(startIdx);
  }

  // Interrompe eventuali salti orizzontali ampi (es. ologramma/sigillo a destra della riga Cognome/Nome)
  let finalWords = kept;
  if (stopOnColumnGap) {
    const maxGap = Math.max((line.height || 16) * 4.5, (canvasWidth || 1000) * 0.14);
    const contiguous = [kept[0]];
    for (let i = 1; i < kept.length; i++) {
      const prev = contiguous[contiguous.length - 1];
      const cur = kept[i];
      if (prev.bbox && cur.bbox && (cur.bbox.x0 - prev.bbox.x1) > maxGap) {
        break;
      }
      contiguous.push(cur);
    }
    finalWords = contiguous;
  }

  const joined = cleanOcrLineText(finalWords.map((w) => w.text || '').join(' '));
  return joined;
}

/**
 * Estrae i dati dal fronte della CIE italiana usando l'array strutturato
 * di Tesseract.js v5 (`lines` con testo, confidenza, bbox e `words`).
 */
export function parseCieFrontLines(rawLines = [], rawText = '', canvasHeight = 0, canvasWidth = 0) {
  const hasRealLines = Array.isArray(rawLines) && rawLines.length > 0;
  const fallbackWidth = canvasWidth > 0 ? canvasWidth : 1000;
  const normalizedLines = (hasRealLines
    ? rawLines
    : String(rawText || '').split('\n').map((t, idx) => ({
      text: t,
      confidence: 80,
      bbox: { x0: 0, y0: idx * 30, x1: fallbackWidth, y1: idx * 30 + 24 },
      words: []
    }))
  )
    .map((l, idx) => {
      const text = cleanOcrLineText(l.text);
      const bbox = l.bbox || { x0: 0, y0: idx * 30, x1: fallbackWidth, y1: idx * 30 + 24 };
      return {
        text,
        confidence: typeof l.confidence === 'number' ? l.confidence : 80,
        bbox,
        words: Array.isArray(l.words) ? l.words : [],
        yCenter: (bbox.y0 + bbox.y1) / 2,
        height: Math.max(12, bbox.y1 - bbox.y0)
      };
    })
    .filter((l) => {
      if (!l.text) return false;
      if (hasRealLines && canvasWidth > 0 && l.bbox && l.bbox.x1 > 0 && l.bbox.x1 < canvasWidth * 0.22) {
        if (!/\d{2}[./-]\d{2}[./-]\d{4}/.test(l.text) && !/[A-Z]{2}\d{5}[A-Z]{2}/.test(l.text)) {
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => a.yCenter - b.yCenter || (a.bbox.x0 - b.bbox.x0));

  let docNum = '';
  let cognome = '';
  let nome = '';
  let luogoNascita = '';
  let dataNascitaIso = '';
  let dataEmissioneIso = '';
  let dataScadenzaIso = '';
  let tipoDoc = 'C.I. Elettronica (CIE)';

  const confidences = {};

  // 1. Numero Documento CIE (2 lettere + 5 cifre + 2 lettere)
  for (let lineIdx = 0; lineIdx < normalizedLines.length; lineIdx++) {
    const line = normalizedLines[lineIdx];
    const inTopBand = (hasRealLines && canvasHeight > 0)
      ? line.yCenter <= canvasHeight * 0.25
      : lineIdx <= 2;
    const tokens = line.text.match(/\b([A-Z0-9]{2})\s?([A-Z0-9]{5})\s?([A-Z0-9]{2})\b/g) || [];
    for (const tok of tokens) {
      const compact = tok.replace(/\s+/g, '');
      if (compact.length !== 9) continue;
      if (CIE_LABEL_STOPWORDS.includes(compact)) continue;
      const midRaw = compact.slice(2, 7);
      const realDigitsCount = (midRaw.match(/\d/g) || []).length;
      const allDigitLike = /^[0-9OQLISZBG]{5}$/.test(midRaw);
      if (realDigitsCount < 3 && !(inTopBand && allDigitLike)) continue;

      const prefix = compact.slice(0, 2).split('').map(toLetterChar).join('');
      const mid = midRaw.split('').map(toDigitChar).join('');
      const suffix = compact.slice(7, 9).split('').map(toLetterChar).join('');
      const candidate = prefix + mid + suffix;

      if (/^[A-Z]{2}\d{5}[A-Z]{2}$/.test(candidate)) {
        docNum = candidate;
        tipoDoc = 'C.I. Elettronica (CIE)';
        confidences.docNum = line.confidence;
        break;
      }
    }
    if (docNum) break;
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

  // Helper: trova la prima riga pulita subito sotto l'etichetta nella stessa colonna verticale (esclude fototessera a sinistra e ologrammi a destra)
  const extractNextValueLine = (anchorIdx, allowDigits = false) => {
    const anchor = normalizedLines[anchorIdx];
    const minWordX = (anchor.bbox && anchor.bbox.x0 > canvasWidth * 0.25) ? (anchor.bbox.x0 - 45) : 0;
    const colMargin = Math.max(70, canvasWidth * 0.10);
    const hasColBounds = Boolean(
      !allowDigits &&
      hasRealLines &&
      anchor.bbox &&
      canvasWidth > 0 &&
      (anchor.bbox.x1 - anchor.bbox.x0) < canvasWidth * 0.75
    );
    const maxStartX = hasColBounds ? (anchor.bbox.x1 + colMargin) : Infinity;

    for (let offset = 1; offset <= 4; offset++) {
      const next = normalizedLines[anchorIdx + offset];
      if (!next) break;
      const gap = next.yCenter - anchor.yCenter;
      if (gap > anchor.height * 4.5) break;
      if (hasColBounds && next.bbox && (next.bbox.x0 > anchor.bbox.x1 + colMargin || next.bbox.x1 < anchor.bbox.x0 - colMargin)) {
        continue;
      }
      if (isAnyFieldAnchor(next.text)) break;

      const filteredText = rebuildLineTextExcludingLeftOf(next, minWordX, maxStartX, canvasWidth, !allowDigits) || (hasColBounds ? '' : next.text);
      if (!filteredText || isPureLabelOrNoiseLine(filteredText)) continue;
      if (!allowDigits && /^\d+$/.test(filteredText.replace(/\s/g, ''))) continue;
      return { text: filteredText, confidence: next.confidence, index: anchorIdx + offset };
    }
    return null;
  };

  // 2. Ancora COGNOME / SURNAME
  let cognomeLineIdx = -1;
  for (let i = 0; i < normalizedLines.length; i++) {
    if (isCognomeLabel(normalizedLines[i].text)) {
      const val = extractNextValueLine(i, false);
      if (val) {
        const cleaned = cleanPersonNameValue(val.text);
        if (cleaned.length >= 2 && !isPureLabelOrNoiseLine(cleaned)) {
          cognome = cleaned;
          confidences.cognome = val.confidence;
          cognomeLineIdx = val.index;
          break;
        }
      }
    }
  }

  // 3. Ancora NOME / NAME
  for (let i = 0; i < normalizedLines.length; i++) {
    if (isNomeLabel(normalizedLines[i].text)) {
      const val = extractNextValueLine(i, false);
      if (val && val.index !== cognomeLineIdx) {
        const cleaned = cleanPersonNameValue(val.text);
        if (cleaned.length >= 2 && cleaned !== cognome && !isPureLabelOrNoiseLine(cleaned)) {
          nome = cleaned;
          confidences.nome = val.confidence;
          break;
        }
      }
    }
  }

  // 4. Ancora LUOGO E DATA DI NASCITA (cerca entro 3 righe la riga che contiene effettivamente una data)
  let birthLineIdx = -1;
  for (let i = 0; i < normalizedLines.length; i++) {
    if (isBirthLabel(normalizedLines[i].text)) {
      const anchor = normalizedLines[i];
      const minWordX = (anchor.bbox && anchor.bbox.x0 > canvasWidth * 0.25) ? (anchor.bbox.x0 - 45) : 0;

      for (let offset = 1; offset <= 3; offset++) {
        const next = normalizedLines[i + offset];
        if (!next) break;
        if (isIssuingLabel(next.text) || isExpiryLabel(next.text)) break;
        const filteredText = rebuildLineTextExcludingLeftOf(next, minWordX) || next.text;
        const dates = extractDatesFromText(filteredText);
        if (dates.length > 0) {
          birthLineIdx = i + offset;
          dataNascitaIso = dates[0].iso;
          confidences.dataNascita = next.confidence;
          const beforeDate = filteredText.slice(0, dates[0].index).replace(/[^A-ZÀÈÉÌÒÙ\s'()-]/g, '').replace(/\s+/g, ' ').trim();
          if (beforeDate.length >= 2 && !isPureLabelOrNoiseLine(beforeDate)) {
            luogoNascita = beforeDate;
            confidences.luogoNascita = next.confidence;
          }
          break;
        }
      }
      if (birthLineIdx !== -1) break;
    }
  }

  // 5. Raccolta di tutte le date dal documento + gestione EMISSIONE e SCADENZA affiancate
  const allDates = [];
  for (let i = 0; i < normalizedLines.length; i++) {
    const line = normalizedLines[i];
    const lineDates = extractDatesFromText(line.text);
    for (const d of lineDates) {
      allDates.push({
        ...d,
        lineIdx: i,
        confidence: line.confidence,
        yCenter: line.yCenter,
        inLowerHalf: canvasHeight > 0 ? line.yCenter >= canvasHeight * 0.42 : true
      });
    }

    if ((isIssuingLabel(line.text) || isExpiryLabel(line.text)) && (!dataEmissioneIso || !dataScadenzaIso)) {
      const nextVal = extractNextValueLine(i, true);
      if (nextVal) {
        const nextDates = extractDatesFromText(nextVal.text).sort((a, b) => a.year - b.year || a.iso.localeCompare(b.iso));
        if (nextDates.length >= 2) {
          if (!dataEmissioneIso) {
            dataEmissioneIso = nextDates[0].iso;
            confidences.dataEmissione = nextVal.confidence;
          }
          if (!dataScadenzaIso) {
            dataScadenzaIso = nextDates[nextDates.length - 1].iso;
            confidences.dataScadenza = nextVal.confidence;
          }
        } else if (nextDates.length === 1) {
          if (isExpiryLabel(line.text) && !isIssuingLabel(line.text) && !dataScadenzaIso && nextDates[0].year >= new Date().getFullYear() - 1) {
            dataScadenzaIso = nextDates[0].iso;
            confidences.dataScadenza = nextVal.confidence;
          } else if (isIssuingLabel(line.text) && !isExpiryLabel(line.text) && !dataEmissioneIso) {
            dataEmissioneIso = nextDates[0].iso;
            confidences.dataEmissione = nextVal.confidence;
          }
        }
      }
    }
  }

  // Classificazione cronologica di tutte le date trovate
  if (allDates.length > 0) {
    const sorted = allDates.slice().sort((a, b) => a.year - b.year || a.iso.localeCompare(b.iso));
    const curYear = new Date().getFullYear();

    if (!dataNascitaIso) {
      const oldestBirth = sorted.find((d) => d.year <= curYear - 14);
      if (oldestBirth) {
        dataNascitaIso = oldestBirth.iso;
        confidences.dataNascita = oldestBirth.confidence;
        birthLineIdx = oldestBirth.lineIdx;
        if (!luogoNascita) {
          const lineTxt = normalizedLines[oldestBirth.lineIdx].text;
          const beforeDate = lineTxt.slice(0, oldestBirth.index).replace(/[^A-ZÀÈÉÌÒÙ\s'()-]/g, '').replace(/\s+/g, ' ').trim();
          if (beforeDate.length >= 2 && !isPureLabelOrNoiseLine(beforeDate)) {
            luogoNascita = beforeDate;
            confidences.luogoNascita = oldestBirth.confidence;
          }
        }
      }
    }

    const nonBirthDates = sorted.filter((d) => d.iso !== dataNascitaIso);
    if (!dataScadenzaIso && nonBirthDates.length > 0) {
      const future = nonBirthDates.slice().reverse().find((d) => d.year >= curYear) || nonBirthDates[nonBirthDates.length - 1];
      if (future) {
        dataScadenzaIso = future.iso;
        confidences.dataScadenza = future.confidence;
      }
    }

    if (!dataEmissioneIso && nonBirthDates.length > 0) {
      const intermediate = nonBirthDates.find((d) => d.iso !== dataScadenzaIso && d.year <= curYear);
      if (intermediate) {
        dataEmissioneIso = intermediate.iso;
        confidences.dataEmissione = intermediate.confidence;
      }
    }
  }

  // 6. Ancoraggio Inverso dalla Riga di Nascita (solo per i campi ancora vuoti)
  if ((!cognome || !nome) && birthLineIdx > 0) {
    const candidateNames = [];
    for (let i = birthLineIdx - 1; i >= 0 && candidateNames.length < 2; i--) {
      if (isAnyFieldAnchor(normalizedLines[i].text)) continue;
      if (/\d/.test(normalizedLines[i].text)) continue;
      const cand = cleanPersonNameValue(normalizedLines[i].text);
      if (!cand || cand.length < 2) continue;
      if (isPureLabelOrNoiseLine(cand)) continue;
      if (docNum && cand.replace(/\s+/g, '').includes(docNum)) continue;
      candidateNames.unshift({ text: cand, confidence: normalizedLines[i].confidence });
    }
    if (candidateNames.length === 2) {
      if (!cognome && candidateNames[0].text !== nome) {
        cognome = candidateNames[0].text;
        confidences.cognome = candidateNames[0].confidence;
      }
      if (!nome && candidateNames[1].text !== cognome) {
        nome = candidateNames[1].text;
        confidences.nome = candidateNames[1].confidence;
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
  return parseCieFrontLines([], rawText, 0, 0);
}

/* ==========================================================================
   ESTRAZIONE LAYOUT TESSERACT.JS v5 ({ blocks: true })
   ========================================================================== */
function extractLinesFromTesseractData(data) {
  if (!data) return [];
  if (Array.isArray(data.lines) && data.lines.length > 0) {
    return data.lines;
  }
  const flattened = [];
  if (Array.isArray(data.blocks)) {
    for (const block of data.blocks) {
      const paragraphs = Array.isArray(block.paragraphs) ? block.paragraphs : [];
      for (const para of paragraphs) {
        const lines = Array.isArray(para.lines) ? para.lines : [];
        for (const line of lines) {
          flattened.push(line);
        }
      }
    }
  }
  return flattened;
}

async function recognizeWithLayout(worker, canvas, params) {
  await worker.setParameters(params);
  const result = await worker.recognize(canvas, {}, { blocks: true });
  const data = (result && result.data) ? result.data : {};
  return {
    text: data.text || '',
    lines: extractLinesFromTesseractData(data)
  };
}

function chooseBestNameCandidate(valuesWithMeta) {
  const valid = valuesWithMeta.filter((v) => v && v.val && v.val.length >= 2);
  if (valid.length === 0) return { val: '', conf: undefined };
  if (valid.length === 1) return valid[0];

  // Se un candidato è estensione di un altro (es. "ROSSI" contiene "ROSS") o non ha spazzatura, preferisci il più completo
  let best = valid[0];
  let bestScore = -1;
  for (const item of valid) {
    const cleanLen = item.val.replace(/\s+/g, '').length;
    const isPrefixOfLonger = valid.some((other) => other !== item && other.val.startsWith(item.val) && other.val.length > item.val.length);
    const freq = valid.filter((other) => other.val === item.val).length;
    const conf = typeof item.conf === 'number' ? item.conf : 75;
    const score = (freq * 30) + conf + (cleanLen * 2) - (isPrefixOfLonger ? 50 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

function mergeParsedPasses(passes) {
  const pickField = (key) => {
    for (const p of passes) {
      if (p[key]) return { val: p[key], conf: p.confidences ? p.confidences[key] : undefined };
    }
    return { val: '', conf: undefined };
  };

  const bestCognome = chooseBestNameCandidate(passes.map((p) => ({ val: p.cognome, conf: p.confidences?.cognome })));
  const bestNome = chooseBestNameCandidate(
    passes
      .map((p) => ({ val: p.nome, conf: p.confidences?.nome }))
      .filter((item) => item.val !== bestCognome.val)
  );

  // Per luogoNascita preferisci il candidato che include la provincia "(XX)" ed è più completo
  const birthPlaces = passes
    .filter((p) => p.luogoNascita)
    .map((p) => ({
      val: p.luogoNascita,
      conf: p.confidences?.luogoNascita,
      score: (/\([A-Z]{2}\)/.test(p.luogoNascita) ? 40 : 0) + p.luogoNascita.length
    }))
    .sort((a, b) => b.score - a.score);

  const docNumPick = pickField('docNum');
  const birthPick = pickField('dataNascita');
  const issuePick = pickField('dataEmissione');
  const expiryPick = pickField('dataScadenza');
  const placePick = birthPlaces.length > 0 ? birthPlaces[0] : { val: '', conf: undefined };

  return {
    docTipo: passes[0]?.docTipo || 'C.I. Elettronica (CIE)',
    docNum: docNumPick.val,
    cognome: bestCognome.val,
    nome: bestNome.val,
    luogoNascita: placePick.val,
    dataNascita: birthPick.val,
    dataEmissione: issuePick.val,
    dataScadenza: expiryPick.val,
    ente: "Ministero dell'Interno",
    confidences: {
      docNum: docNumPick.conf,
      cognome: bestCognome.conf,
      nome: bestNome.conf,
      luogoNascita: placePick.conf,
      dataNascita: birthPick.conf,
      dataEmissione: issuePick.conf,
      dataScadenza: expiryPick.conf
    }
  };
}

/**
 * Esegue il riconoscimento ottimizzato su un canvas sorgente:
 * - mode === 'mrz': fascia inferiore MRZ + whitelist ICAO + PSM 6 + validazione 7-3-1
 * - mode === 'front': normalizzazione risoluzione + pre-processing CIE morbido +
 *   OCR Full-Card PSM 3 / PSM 6 / PSM 11 su `blocks` con fusione intelligente.
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

      const mrzCrop = cropCanvasRegion(sourceCanvas, { x: 0.02, y: 0.54, w: 0.96, h: 0.44 }, 16);
      const mrzProcessed = preprocessMrzImage(mrzCrop);
      const mrzRes = await recognizeWithLayout(worker, mrzProcessed, mrzParams);
      const parsedCrop = parseMrzText(mrzRes.text);
      if (parsedCrop) {
        return {
          data: parsedCrop,
          sourceLabel: parsedCrop.mrzVerified ? 'MRZ (Checksum ICAO OK)' : 'MRZ',
          debug: {
            rawText: mrzRes.text,
            preprocessedDataUrl: mrzProcessed.toDataURL('image/png')
          }
        };
      }

      const preparedFull = prepareOcrCanvas(sourceCanvas, 1600, 16);
      const fullProcessed = preprocessMrzImage(preparedFull);
      const fullRes = await recognizeWithLayout(worker, fullProcessed, mrzParams);
      const parsedFull = parseMrzText(fullRes.text);
      if (parsedFull) {
        return {
          data: parsedFull,
          sourceLabel: parsedFull.mrzVerified ? 'MRZ (Checksum ICAO OK)' : 'MRZ',
          debug: {
            rawText: fullRes.text,
            preprocessedDataUrl: fullProcessed.toDataURL('image/png')
          }
        };
      }

      return null;
    }

    const preparedCanvas = prepareOcrCanvas(sourceCanvas, 2000, 20);
    const processedFull = preprocessCardImage(preparedCanvas);
    const preprocessedDataUrl = processedFull.toDataURL('image/png');

    const collectedPasses = [];
    let combinedRawText = '';

    // Passaggio 1 (Primario): PSM 3 (Auto multi-colonna) senza whitelist restrittiva
    const psm3Res = await recognizeWithLayout(worker, processedFull, {
      tessedit_char_whitelist: '',
      tessedit_pageseg_mode: '3'
    });

    if (psm3Res.text.includes('<<')) {
      const autoMrz = parseMrzText(psm3Res.text);
      if (autoMrz) {
        return {
          data: autoMrz,
          sourceLabel: autoMrz.mrzVerified ? 'MRZ (Checksum ICAO OK)' : 'MRZ',
          debug: { rawText: psm3Res.text, preprocessedDataUrl }
        };
      }
    }

    combinedRawText = psm3Res.text;
    const psm3Parsed = parseCieFrontLines(psm3Res.lines, psm3Res.text, processedFull.height, processedFull.width);
    collectedPasses.push(psm3Parsed);
    let merged = mergeParsedPasses(collectedPasses);

    // Passaggio 2: PSM 6 (Blocco di testo) se manca qualsiasi campo chiave o per consolidare cognome/nome/emissione
    if (!merged.cognome || !merged.nome || !merged.dataEmissione || (target === 'student' && !merged.docNum)) {
      const psm6Res = await recognizeWithLayout(worker, processedFull, {
        tessedit_char_whitelist: '',
        tessedit_pageseg_mode: '6'
      });
      combinedRawText += `\n--- [PSM 6] ---\n${psm6Res.text}`;
      collectedPasses.push(parseCieFrontLines(psm6Res.lines, psm6Res.text, processedFull.height, processedFull.width));
      merged = mergeParsedPasses(collectedPasses);
    }

    // Passaggio 3: PSM 11 (Sparse text) se mancano ancora campi chiave
    if (!merged.cognome || !merged.nome || (target === 'student' && !merged.docNum)) {
      const psm11Res = await recognizeWithLayout(worker, processedFull, {
        tessedit_char_whitelist: '',
        tessedit_pageseg_mode: '11'
      });
      combinedRawText += `\n--- [PSM 11] ---\n${psm11Res.text}`;
      collectedPasses.push(parseCieFrontLines(psm11Res.lines, psm11Res.text, processedFull.height, processedFull.width));
      merged = mergeParsedPasses(collectedPasses);
    }

    // Passaggio 4: Scala di grigi leggera anti-ciano se mancano ancora cognome/nome/docNum
    if (!merged.cognome || !merged.nome || (target === 'student' && !merged.docNum)) {
      const lightGray = preprocessCardImage(preparedCanvas, { lightOnly: true });
      const lightRes = await recognizeWithLayout(worker, lightGray, {
        tessedit_char_whitelist: '',
        tessedit_pageseg_mode: '3'
      });
      combinedRawText += `\n--- [LIGHT GRAY] ---\n${lightRes.text}`;
      collectedPasses.push(parseCieFrontLines(lightRes.lines, lightRes.text, lightGray.height, lightGray.width));
      merged = mergeParsedPasses(collectedPasses);
    }

    if (merged.cognome || merged.nome || merged.docNum || merged.dataNascita) {
      return {
        data: merged,
        sourceLabel: 'Fronte CIE (Full-Card)',
        debug: {
          rawText: combinedRawText.trim(),
          preprocessedDataUrl
        }
      };
    }

    return {
      data: null,
      sourceLabel: 'Fronte CIE',
      debug: {
        rawText: combinedRawText.trim(),
        preprocessedDataUrl
      }
    };
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
