/**
 * js/api.js - Motore OCR client-side (Tesseract.js Worker riutilizzabile),
 * pre-elaborazione immagine e parser per Fronte Documento e Retro MRZ (CIE/Passaporto).
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
 * Ottimizza contrasto e riduce i motivi di sicurezza (filigrana) prima dell'OCR.
 */
export function preprocessCardImage(sourceCanvas) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const pCanvas = document.createElement('canvas');
  pCanvas.width = w;
  pCanvas.height = h;
  const pCtx = pCanvas.getContext('2d');
  pCtx.drawImage(sourceCanvas, 0, 0);

  try {
    const imgData = pCtx.getImageData(0, 0, w, h);
    const d = imgData.data;

    const hist = new Int32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const lum = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      hist[lum]++;
    }

    const total = w * h;
    let minCut = 0;
    let maxCut = 255;
    let accum = 0;
    for (let i = 0; i < 256; i++) {
      accum += hist[i];
      if (accum >= total * 0.04) { minCut = i; break; }
    }
    accum = 0;
    for (let i = 255; i >= 0; i--) {
      accum += hist[i];
      if (accum >= total * 0.04) { maxCut = i; break; }
    }
    if (maxCut <= minCut) { minCut = 0; maxCut = 255; }
    const range = maxCut - minCut;

    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      let stretched = ((lum - minCut) / range) * 255;
      if (stretched > 175) {
        stretched = 255;
      } else if (stretched < 95) {
        stretched = Math.max(0, stretched * 0.6);
      }
      d[i] = stretched;
      d[i + 1] = stretched;
      d[i + 2] = stretched;
    }

    pCtx.putImageData(imgData, 0, 0);
    return pCanvas;
  } catch {
    return sourceCanvas;
  }
}

/**
 * Parser MRZ per Carte d'Identità Elettroniche (TD1: 3 righe x 30 char)
 * e Passaporti (TD3: 2 righe x 44 char).
 */
export function parseMrzText(rawText) {
  const cleanLines = rawText
    .toUpperCase()
    .split('\n')
    .map((l) => l.replace(/[^A-Z0-9<]/g, ''))
    .filter((l) => l.length >= 24);

  if (cleanLines.length < 2) return null;

  const normalizeDigits = (str) =>
    str.replace(/O/g, '0').replace(/Q/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8');

  const parseMrzDate = (yymmdd, isExpiry = false) => {
    const d = normalizeDigits(yymmdd);
    if (!/^\d{6}$/.test(d)) return '';
    const yy = parseInt(d.slice(0, 2), 10);
    const mm = d.slice(2, 4);
    const dd = d.slice(4, 6);
    const curYY = new Date().getFullYear() % 100;
    const yyyy = isExpiry
      ? (yy <= curYY + 25 ? 2000 + yy : 1900 + yy)
      : (yy <= curYY ? 2000 + yy : 1900 + yy);
    return `${yyyy}-${mm}-${dd}`;
  };

  // TD1 (CIE Italiana)
  const td1Idx = cleanLines.findIndex((l) => /^(I|C|A)[<A-Z]/.test(l) && l.length >= 26 && l.length <= 34);
  if (td1Idx !== -1 && cleanLines[td1Idx + 1] && cleanLines[td1Idx + 2]) {
    const l1 = cleanLines[td1Idx].padEnd(30, '<');
    const l2 = cleanLines[td1Idx + 1].padEnd(30, '<');
    const l3 = cleanLines[td1Idx + 2];

    const docNum = l1.slice(5, 14).replace(/</g, '').trim();
    const dataNascita = parseMrzDate(l2.slice(0, 6), false);
    const dataScadenza = parseMrzDate(l2.slice(8, 14), true);

    const nameParts = l3.split('<<');
    const cognome = (nameParts[0] || '').replace(/</g, ' ').trim();
    const nome = (nameParts[1] || '').replace(/</g, ' ').trim();

    if (cognome || docNum) {
      return {
        docTipo: 'C.I. Elettronica (CIE)',
        docNum,
        cognome,
        nome,
        dataNascita,
        dataScadenza,
        ente: "Ministero dell'Interno"
      };
    }
  }

  // TD3 (Passaporto)
  const td3Idx = cleanLines.findIndex((l) => /^P[<A-Z]/.test(l) && l.length >= 38);
  if (td3Idx !== -1 && cleanLines[td3Idx + 1]) {
    const l1 = cleanLines[td3Idx];
    const l2 = cleanLines[td3Idx + 1].padEnd(44, '<');

    const nameParts = l1.slice(5).split('<<');
    const cognome = (nameParts[0] || '').replace(/</g, ' ').trim();
    const nome = (nameParts[1] || '').replace(/</g, ' ').trim();

    const docNum = l2.slice(0, 9).replace(/</g, '').trim();
    const dataNascita = parseMrzDate(l2.slice(13, 19), false);
    const dataScadenza = parseMrzDate(l2.slice(21, 27), true);

    if (cognome || docNum) {
      return {
        docTipo: 'Passaporto',
        docNum,
        cognome,
        nome,
        dataNascita,
        dataScadenza,
        ente: 'Questura'
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
    const cieM = l.match(/\b([A-Z]{2})\s?([0-9OIlS]{5})\s?([A-Z]{2})\b/i);
    if (cieM) {
      const prefix = cieM[1].toUpperCase();
      const mid = cieM[2].toUpperCase().replace(/O/g, '0').replace(/[Il]/g, '1').replace(/S/g, '5');
      const suffix = cieM[3].toUpperCase();
      docNum = prefix + mid + suffix;
      tipoDoc = 'C.I. Elettronica (CIE)';
      break;
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
      const next = lines[i + 1].replace(/[^A-Z\s]/g, '').trim();
      if (next && next.length > 1 && !next.includes('NOME')) cognome = next;
    }
    if ((line.includes('NOME') || line.includes('NAME')) && !line.includes('COGNOME') && i + 1 < lines.length) {
      const next = lines[i + 1].replace(/[^A-Z\s]/g, '').trim();
      if (next && next.length > 1 && !next.includes('LUOGO')) nome = next;
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
