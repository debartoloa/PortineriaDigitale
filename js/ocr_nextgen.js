/**
 * js/ocr_nextgen.js - Motore OCR AI Pro (Next-Gen) parallelo a Tesseract:
 * 1. PaddleOCR (DBNet PP-OCRv4 + Latin PP-OCRv5) eseguito in browser su ONNX Runtime Web
 * 2. MRZ dedicato con modello leggero OCRB.traineddata.gz (77 KB) + fallback PaddleOCR
 *    e validazione matematica Check-Digit ICAO 9303 (7-3-1)
 * 3. Quality Gate live su frame video (Varianza del Laplaciano + Glare Detection)
 * 4. Raddrizzamento prospettico opzionale con OpenCV.js WASM (warpPerspective su ID-1)
 */

import {
  parseCieFrontLines,
  parseMrzText,
  cropCanvasRegion,
  preprocessCardImage,
  preprocessMrzImage,
  prepareOcrCanvas
} from './api.js';

const ORT_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js';
const ORT_WASM_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const ESEARCH_OCR_ESM_URL = 'https://cdn.jsdelivr.net/npm/esearch-ocr@8.5.2/dist/esearch-ocr.js';
const DET_MODEL_URL = 'https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@1.4.2/assets/ch_PP-OCRv4_det_infer.onnx';
const REC_MODEL_URL = 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/latin/rec.onnx';
const REC_DICT_URL = 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/latin/dict.txt';
const OCRB_LANG_PATH = 'https://cdn.jsdelivr.net/gh/DaanVanVugt/tesseract-mrz@master/lang';
const OPENCV_SCRIPT_URL = 'https://docs.opencv.org/4.x/opencv.js';

let ortPromise = null;
let paddleEnginePromise = null;
let ocrbWorkerPromise = null;
let openCvPromise = null;

function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Errore caricamento script: ${src}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.addEventListener('load', () => {
      script.dataset.loaded = '1';
      resolve();
    }, { once: true });
    script.addEventListener('error', () => reject(new Error(`Errore rete script: ${src}`)), { once: true });
    document.head.appendChild(script);
  });
}

/* ==========================================================================
   1. LOADER LAZY ONNX RUNTIME WEB + PADDLEOCR (esearch-ocr)
   ========================================================================== */
export async function ensureOnnxRuntime(onStatus) {
  if (window.ort && window.ort.InferenceSession) {
    return window.ort;
  }
  if (!ortPromise) {
    ortPromise = (async () => {
      if (onStatus) onStatus('📥 Caricamento ONNX Runtime Web (WASM)...');
      await loadExternalScript(ORT_SCRIPT_URL);
      if (!window.ort) {
        throw new Error('ONNX Runtime Web non inizializzato');
      }
      window.ort.env.wasm.wasmPaths = ORT_WASM_PATH;
      window.ort.env.wasm.numThreads = 1;
      return window.ort;
    })().catch((err) => {
      ortPromise = null;
      throw err;
    });
  }
  return ortPromise;
}

export async function getPaddleOcrEngine(onStatus) {
  if (!paddleEnginePromise) {
    paddleEnginePromise = (async () => {
      const ort = await ensureOnnxRuntime(onStatus);
      if (onStatus) onStatus('📥 Download dizionario e modelli neurali PaddleOCR (~12 MB, 1ª volta)...');

      const [esearch, dictText] = await Promise.all([
        import(ESEARCH_OCR_ESM_URL),
        fetch(REC_DICT_URL).then((r) => {
          if (!r.ok) throw new Error(`Download dict.txt fallito (${r.status})`);
          return r.text();
        })
      ]);

      if (typeof esearch.setOCREnv === 'function') {
        esearch.setOCREnv({
          canvas: (w, h) => {
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            return c;
          }
        });
      }

      if (onStatus) onStatus('⚙️ Inizializzazione sessioni DBNet + SVTR Latin...');
      const instance = await esearch.init({
        ort,
        ortOption: { executionProviders: ['wasm'] },
        det: {
          input: DET_MODEL_URL,
          ratio: 1
        },
        rec: {
          input: REC_MODEL_URL,
          decodeDic: dictText,
          imgh: 48,
          optimize: { space: true }
        }
      });

      return instance;
    })().catch((err) => {
      paddleEnginePromise = null;
      throw err;
    });
  }
  return paddleEnginePromise;
}

/* ==========================================================================
   2. WORKER MRZ DEDICATO CON MODELLO OCRB (77 KB)
   ========================================================================== */
export async function getMrzOcrbWorker(onStatus) {
  if (!window.Tesseract || typeof window.Tesseract.createWorker !== 'function') {
    return null;
  }
  if (!ocrbWorkerPromise) {
    ocrbWorkerPromise = (async () => {
      if (onStatus) onStatus('📥 Caricamento modello dedicato OCR-B per MRZ (77 KB)...');
      const worker = await window.Tesseract.createWorker('OCRB', 1, {
        langPath: OCRB_LANG_PATH,
        gzip: true
      });
      await worker.setParameters({
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
        tessedit_pageseg_mode: '6'
      });
      return worker;
    })().catch((err) => {
      ocrbWorkerPromise = null;
      throw err;
    });
  }
  return ocrbWorkerPromise;
}

/* ==========================================================================
   3. OPENCV.JS WASM & RADDRIZZAMENTO PROSPETTICO TESSERA ID-1
   ========================================================================== */
export async function loadOpenCV(onStatus) {
  if (window.cv && typeof window.cv.Mat === 'function') {
    return window.cv;
  }
  if (!openCvPromise) {
    openCvPromise = (async () => {
      if (onStatus) onStatus('📥 Caricamento OpenCV.js (WASM) on-demand...');
      await loadExternalScript(OPENCV_SCRIPT_URL);
      if (window.cv && typeof window.cv.Mat === 'function') {
        return window.cv;
      }
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout inizializzazione OpenCV.js')), 20000);
        const checkReady = () => {
          if (window.cv && typeof window.cv.Mat === 'function') {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(checkReady, 80);
          }
        };
        if (window.cv) {
          const prev = window.cv.onRuntimeInitialized;
          window.cv.onRuntimeInitialized = () => {
            if (typeof prev === 'function') prev();
            clearTimeout(timeout);
            resolve();
          };
        }
        checkReady();
      });
      return window.cv;
    })().catch((err) => {
      openCvPromise = null;
      throw err;
    });
  }
  return openCvPromise;
}

function orderQuadPoints(pts) {
  // Ordina 4 punti [x, y] in: Top-Left, Top-Right, Bottom-Right, Bottom-Left
  const sums = pts.map((p) => p.x + p.y);
  const diffs = pts.map((p) => p.y - p.x);

  const tl = pts[sums.indexOf(Math.min(...sums))];
  const br = pts[sums.indexOf(Math.max(...sums))];
  const tr = pts[diffs.indexOf(Math.min(...diffs))];
  const bl = pts[diffs.indexOf(Math.max(...diffs))];
  return [tl, tr, br, bl];
}

export function warpIdCardPerspective(sourceCanvas) {
  const cv = window.cv;
  if (!cv || typeof cv.Mat !== 'function') {
    return { canvas: sourceCanvas, warped: false };
  }

  let src = null;
  let gray = null;
  let blurred = null;
  let edges = null;
  let dilated = null;
  let kernel = null;
  let contours = null;
  let hierarchy = null;
  let bestQuad = null;
  let srcTri = null;
  let dstTri = null;
  let M = null;
  let dst = null;

  try {
    src = cv.imread(sourceCanvas);
    gray = new cv.Mat();
    blurred = new cv.Mat();
    edges = new cv.Mat();
    dilated = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 50, 150);

    kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, dilated, kernel);

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = src.rows * src.cols;
    let maxArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < frameArea * 0.18) continue;

      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

      if (approx.rows === 4 && area > maxArea) {
        const pts = [];
        for (let r = 0; r < 4; r++) {
          pts.push({ x: approx.data32S[r * 2], y: approx.data32S[r * 2 + 1] });
        }
        const [tl, tr, br, bl] = orderQuadPoints(pts);
        const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
        const wBot = Math.hypot(br.x - bl.x, br.y - bl.y);
        const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
        const hRight = Math.hypot(br.x - tr.x, br.y - tr.y);
        const avgW = (wTop + wBot) / 2;
        const avgH = Math.max(1, (hLeft + hRight) / 2);
        const aspect = Math.max(avgW, avgH) / Math.min(avgW, avgH);

        // Verifica rapporto compatibile con tessera ID-1 (85.6 x 53.98 mm -> ~1.586)
        if (aspect >= 1.20 && aspect <= 2.05) {
          maxArea = area;
          bestQuad = [tl, tr, br, bl];
        }
      }
      approx.delete();
    }

    if (!bestQuad) {
      return { canvas: sourceCanvas, warped: false };
    }

    const outW = 1600;
    const outH = 1010;
    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      bestQuad[0].x, bestQuad[0].y,
      bestQuad[1].x, bestQuad[1].y,
      bestQuad[2].x, bestQuad[2].y,
      bestQuad[3].x, bestQuad[3].y
    ]);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      outW, 0,
      outW, outH,
      0, outH
    ]);

    M = cv.getPerspectiveTransform(srcTri, dstTri);
    dst = new cv.Mat();
    cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_REPLICATE);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    cv.imshow(outCanvas, dst);

    return { canvas: outCanvas, warped: true };
  } catch (err) {
    console.warn('warpIdCardPerspective fallback su immagine originale:', err);
    return { canvas: sourceCanvas, warped: false };
  } finally {
    if (src) src.delete();
    if (gray) gray.delete();
    if (blurred) blurred.delete();
    if (edges) edges.delete();
    if (dilated) dilated.delete();
    if (kernel) kernel.delete();
    if (contours) contours.delete();
    if (hierarchy) hierarchy.delete();
    if (srcTri) srcTri.delete();
    if (dstTri) dstTri.delete();
    if (M) M.delete();
    if (dst) dst.delete();
  }
}

/* ==========================================================================
   4. QUALITY GATE VELOCE SU STREAM VIDEO (LAPLACIAN VARIANCE + GLARE)
   ========================================================================== */
let qualityEvalCanvas = null;

/**
 * Calcola nitidezza (varianza del Laplaciano 3x3) e riflessi bruciati (glare)
 * su un frame ridimensionato a 320x200 in pochi millisecondi.
 */
export function evaluateFrameQuality(sourceCanvas) {
  const targetW = 320;
  const targetH = 200;

  if (!qualityEvalCanvas) {
    qualityEvalCanvas = document.createElement('canvas');
    qualityEvalCanvas.width = targetW;
    qualityEvalCanvas.height = targetH;
  }

  const ctx = qualityEvalCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0, targetW, targetH);

  const imgData = ctx.getImageData(0, 0, targetW, targetH);
  const d = imgData.data;
  const total = targetW * targetH;
  const gray = new Float32Array(total);

  let centerPixels = 0;
  let glarePixels = 0;

  const minX = Math.floor(targetW * 0.15);
  const maxX = Math.floor(targetW * 0.85);
  const minY = Math.floor(targetH * 0.15);
  const maxY = Math.floor(targetH * 0.85);

  for (let y = 0; y < targetH; y++) {
    const row = y * targetW;
    const inCenterY = y >= minY && y <= maxY;
    for (let x = 0; x < targetW; x++) {
      const idx = row + x;
      const pIdx = idx * 4;
      const r = d[pIdx];
      const g = d[pIdx + 1];
      const b = d[pIdx + 2];
      gray[idx] = 0.299 * r + 0.587 * g + 0.114 * b;

      if (inCenterY && x >= minX && x <= maxX) {
        centerPixels++;
        if (r > 246 && g > 246 && b > 246) {
          glarePixels++;
        }
      }
    }
  }

  // Varianza del Laplaciano 3x3 [0,1,0; 1,-4,1; 0,1,0]
  let sumLap = 0;
  let sumLapSq = 0;
  let lapCount = 0;

  for (let y = 1; y < targetH - 1; y++) {
    const row = y * targetW;
    for (let x = 1; x < targetW - 1; x++) {
      const idx = row + x;
      const lap =
        gray[idx - targetW] +
        gray[idx + targetW] +
        gray[idx - 1] +
        gray[idx + 1] -
        4 * gray[idx];
      sumLap += lap;
      sumLapSq += lap * lap;
      lapCount++;
    }
  }

  const meanLap = lapCount > 0 ? sumLap / lapCount : 0;
  const sharpness = lapCount > 0 ? (sumLapSq / lapCount) - (meanLap * meanLap) : 0;
  const glareRatio = centerPixels > 0 ? glarePixels / centerPixels : 0;

  const isSharp = sharpness >= 85;
  const hasGlare = glareRatio > 0.14;
  const ok = isSharp && !hasGlare;

  let message = '✅ Nitido — Analisi automatica...';
  if (hasGlare) {
    message = '💡 Troppo riflesso: inclina leggermente la tessera';
  } else if (!isSharp) {
    message = '🔍 Metti a fuoco e tieni fermo il documento';
  }

  return {
    sharpness: Math.round(sharpness),
    glareRatio: Number(glareRatio.toFixed(3)),
    isSharp,
    hasGlare,
    ok,
    message
  };
}

/* ==========================================================================
   5. CONVERSIONE BOX PADDLEOCR -> RIGHE STRUTTURATE + PIPELINE NEXT-GEN
   ========================================================================== */
function convertPaddleItemsToLines(items, canvasWidth = 1280) {
  if (!Array.isArray(items) || items.length === 0) {
    return { lines: [], rawText: '' };
  }

  const boxes = items
    .map((item) => {
      const text = String(item.text || '').trim();
      const box = Array.isArray(item.box) ? item.box : [[0, 0], [100, 0], [100, 20], [0, 20]];
      const xs = box.map((p) => p[0]);
      const ys = box.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      const conf = typeof item.mean === 'number' ? Math.round(item.mean * 100) : 88;
      return {
        text,
        confidence: conf,
        bbox: { x0, y0, x1, y1 },
        yCenter: (y0 + y1) / 2,
        height: Math.max(10, y1 - y0)
      };
    })
    .filter((b) => b.text.length > 0)
    .sort((a, b) => a.yCenter - b.yCenter || a.bbox.x0 - b.bbox.x0);

  const maxColumnGap = Math.max(110, (canvasWidth || 1280) * 0.14);

  // Raggruppa box sulla stessa riga orizzontale rispettando la separazione tra colonne (evita di fondere ologrammi a destra con Cognome/Nome)
  const mergedLines = [];
  for (const box of boxes) {
    let targetRow = null;
    for (let i = mergedLines.length - 1; i >= 0; i--) {
      const candidate = mergedLines[i];
      if (Math.abs(box.yCenter - candidate.yCenter) > Math.max(10, candidate.height * 0.85)) {
        if (box.yCenter - candidate.yCenter > Math.max(40, candidate.height * 1.5)) break;
        continue;
      }
      const sameY = Math.abs(box.yCenter - candidate.yCenter) <= Math.max(8, Math.min(box.height, candidate.height) * 0.55);
      const hGap = Math.max(0, box.bbox.x0 - candidate.bbox.x1, candidate.bbox.x0 - box.bbox.x1);
      const allowedGap = Math.min(maxColumnGap, Math.max(Math.min(box.height, candidate.height) * 4.5, 95));
      if (sameY && hGap <= allowedGap) {
        targetRow = candidate;
        break;
      }
    }

    if (targetRow) {
      targetRow.words.push({ text: box.text, bbox: box.bbox, confidence: box.confidence });
      targetRow.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      targetRow.text = targetRow.words.map((w) => w.text).join(' ');
      targetRow.confidence = Math.round(
        targetRow.words.reduce((acc, w) => acc + w.confidence, 0) / targetRow.words.length
      );
      targetRow.bbox = {
        x0: Math.min(targetRow.bbox.x0, box.bbox.x0),
        y0: Math.min(targetRow.bbox.y0, box.bbox.y0),
        x1: Math.max(targetRow.bbox.x1, box.bbox.x1),
        y1: Math.max(targetRow.bbox.y1, box.bbox.y1)
      };
      targetRow.yCenter = (targetRow.bbox.y0 + targetRow.bbox.y1) / 2;
      targetRow.height = Math.max(targetRow.height, targetRow.bbox.y1 - targetRow.bbox.y0);
    } else {
      mergedLines.push({
        text: box.text,
        confidence: box.confidence,
        bbox: { ...box.bbox },
        words: [{ text: box.text, bbox: { ...box.bbox }, confidence: box.confidence }],
        yCenter: box.yCenter,
        height: box.height
      });
    }
  }

  const rawText = mergedLines.map((l) => l.text).join('\n');
  return { lines: mergedLines, rawText };
}

function mergeCieParsedFields(primary, secondary) {
  if (!primary) return secondary || null;
  if (!secondary) return primary;

  const merged = {
    ...primary,
    confidences: { ...(primary.confidences || {}) }
  };
  const secConf = secondary.confidences || {};

  for (const key of ['docNum', 'cognome', 'nome', 'luogoNascita', 'dataNascita', 'dataEmissione', 'dataScadenza']) {
    if (!merged[key] && secondary[key]) {
      merged[key] = secondary[key];
      if (typeof secConf[key] === 'number') {
        merged.confidences[key] = secConf[key];
      }
    }
  }
  if (!merged.docTipo && secondary.docTipo) {
    merged.docTipo = secondary.docTipo;
  }
  return merged;
}

/**
 * Motore AI Pro principale (PaddleOCR ONNX + MRZ OCR-B + OpenCV opzionale).
 */
export async function recognizeWithNextGen(sourceCanvas, options = {}) {
  const mode = options.mode === 'mrz' ? 'mrz' : 'front';
  const useOpenCv = Boolean(options.useOpenCv);
  const allowSecondPass = options.allowSecondPass !== false;
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;

  let workCanvas = sourceCanvas;
  let warped = false;

  if (useOpenCv && mode === 'front') {
    try {
      await loadOpenCV(onStatus);
      const warpRes = warpIdCardPerspective(sourceCanvas);
      workCanvas = warpRes.canvas;
      warped = warpRes.warped;
    } catch (err) {
      console.warn('OpenCV warp non riuscito, proseguo su immagine originale:', err);
    }
  }

  // Modalità MRZ: prima OCRB (77 KB), poi eventuale fallback PaddleOCR ONNX
  if (mode === 'mrz') {
    const mrzCrop = cropCanvasRegion(workCanvas, { x: 0.02, y: 0.54, w: 0.96, h: 0.44 }, 16);
    const mrzProcessed = preprocessMrzImage(mrzCrop);
    const debugPreviewUrl = mrzProcessed.toDataURL('image/png');
    let debugRaw = '';

    try {
      const ocrbWorker = await getMrzOcrbWorker(onStatus);
      if (ocrbWorker) {
        if (onStatus) onStatus('🔍 Lettura MRZ con modello dedicato OCR-B...');
        const res = await ocrbWorker.recognize(mrzProcessed);
        const rawText = res && res.data ? (res.data.text || '') : '';
        debugRaw = `[OCRB MRZ]\n${rawText}`;
        const parsed = parseMrzText(rawText);
        if (parsed && parsed.mrzVerified) {
          return {
            data: parsed,
            sourceLabel: 'AI Pro · MRZ OCR-B (Checksum ICAO OK)',
            debug: { rawText: debugRaw, preprocessedDataUrl: debugPreviewUrl }
          };
        }
      }
    } catch (err) {
      console.warn('Worker OCRB fallito, provo fallback PaddleOCR MRZ:', err);
    }

    try {
      const engine = await getPaddleOcrEngine(onStatus);
      if (onStatus) onStatus('🔍 Analisi MRZ con rete neurale PaddleOCR...');
      const paddleRes = await engine.ocr(mrzCrop);
      const { rawText } = convertPaddleItemsToLines(paddleRes && paddleRes.src);
      debugRaw += `\n--- [PaddleOCR MRZ] ---\n${rawText}`;
      const parsedPaddle = parseMrzText(rawText);
      if (parsedPaddle) {
        return {
          data: parsedPaddle,
          sourceLabel: parsedPaddle.mrzVerified ? 'AI Pro · PaddleOCR MRZ (Checksum ICAO OK)' : 'AI Pro · PaddleOCR MRZ',
          debug: { rawText: debugRaw.trim(), preprocessedDataUrl: debugPreviewUrl }
        };
      }

      // Tentativo sull'intera immagine (es. foto caricata da file non tagliata)
      const fullRes = await engine.ocr(workCanvas);
      const fullLines = convertPaddleItemsToLines(fullRes && fullRes.src);
      debugRaw += `\n--- [PaddleOCR FULL] ---\n${fullLines.rawText}`;
      const parsedFull = parseMrzText(fullLines.rawText);
      if (parsedFull) {
        return {
          data: parsedFull,
          sourceLabel: parsedFull.mrzVerified ? 'AI Pro · PaddleOCR MRZ (Checksum ICAO OK)' : 'AI Pro · PaddleOCR MRZ',
          debug: { rawText: debugRaw.trim(), preprocessedDataUrl: debugPreviewUrl }
        };
      }
    } catch (err) {
      console.warn('PaddleOCR MRZ fallito:', err);
    }

    return {
      data: null,
      sourceLabel: 'AI Pro · MRZ',
      debug: { rawText: debugRaw.trim(), preprocessedDataUrl: debugPreviewUrl }
    };
  }

  // Modalità Fronte: Pass 1 su RGB (SVTR Latin), poi eventuale Pass 2 anti-guilloché/anti-filigrana solo per campi mancanti
  const preparedCanvas = prepareOcrCanvas(workCanvas, 1280, 16);
  let debugPreviewUrl = preparedCanvas.toDataURL('image/png');

  const engine = await getPaddleOcrEngine(onStatus);
  if (onStatus) onStatus('🚀 Rilevamento & riconoscimento AI Pro (PaddleOCR ONNX)...');

  const ocrRes = await engine.ocr(preparedCanvas);
  const { lines, rawText } = convertPaddleItemsToLines(ocrRes && ocrRes.src, preparedCanvas.width);
  let combinedRaw = `[PaddleOCR RGB]\n${rawText}`;

  if (rawText.includes('<<')) {
    const autoMrz = parseMrzText(rawText);
    if (autoMrz) {
      return {
        data: autoMrz,
        sourceLabel: autoMrz.mrzVerified ? 'AI Pro · MRZ (Checksum ICAO OK)' : 'AI Pro · MRZ',
        debug: { rawText: combinedRaw, preprocessedDataUrl: debugPreviewUrl }
      };
    }
  }

  let parsed = parseCieFrontLines(lines, rawText, preparedCanvas.height, preparedCanvas.width);

  // Pass 2 mirato (solo su scatto manuale/caricamento file se manca almeno un campo chiave): filtro anti-ciano / appiattimento illuminazione
  if (allowSecondPass && (!parsed.docNum || !parsed.cognome || !parsed.nome || !parsed.dataNascita || !parsed.dataEmissione || !parsed.dataScadenza)) {
    try {
      if (onStatus) onStatus('✨ Rifinitura AI Pro su sfondo attenuato per campi residui...');
      const cleanedCanvas = preprocessCardImage(preparedCanvas, { whiteCut: 215, darkKnee: 72 });
      const resClean = await engine.ocr(cleanedCanvas);
      const cleanOut = convertPaddleItemsToLines(resClean && resClean.src, cleanedCanvas.width);
      const parsedClean = parseCieFrontLines(cleanOut.lines, cleanOut.rawText, cleanedCanvas.height, cleanedCanvas.width);
      parsed = mergeCieParsedFields(parsed, parsedClean);
      combinedRaw += `\n--- [PaddleOCR Anti-Sfondo] ---\n${cleanOut.rawText}`;
      debugPreviewUrl = cleanedCanvas.toDataURL('image/png');
    } catch (pass2Err) {
      console.warn('PaddleOCR Pass 2 fallito, mantengo Pass 1:', pass2Err);
    }
  }

  const label = `PaddleOCR AI${warped ? ' + OpenCV' : ''}`;

  if (parsed.cognome || parsed.nome || parsed.docNum || parsed.dataNascita) {
    return {
      data: parsed,
      sourceLabel: label,
      debug: { rawText: combinedRaw, preprocessedDataUrl: debugPreviewUrl }
    };
  }

  return {
    data: null,
    sourceLabel: label,
    debug: { rawText: combinedRaw, preprocessedDataUrl: debugPreviewUrl }
  };
}
