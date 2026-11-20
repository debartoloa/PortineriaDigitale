/**
 * sw.js - Service Worker per Portineria Digitale Scolastica (Offline-First PWA)
 *
 * Strategie implementate:
 * - Asset locali (HTML, CSS, JS, Manifest, Icone): Network-First con fallback offline
 *   su cache locale / ./index.html per le navigazioni.
 * - Risorse esterne OCR (Tesseract.js, ONNX Runtime, PaddleOCR, OCRB):
 *   Cache-First persistente per garantire il funzionamento 100% offline in portineria
 *   dopo il primo caricamento.
 */

const CACHE_VERSION = 'v2.0.0-r3';
const STATIC_CACHE = `portineria-static-${CACHE_VERSION}`;
const OCR_CACHE = 'portineria-ocr-v2.0.0';

const LOCAL_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/api.js',
  './js/ocr_nextgen.js',
  './js/storage.js',
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

const EXTERNAL_PRECACHE = [
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
];

// Host e pattern delle risorse OCR da memorizzare in cache persistente
function isOcrResource(url) {
  const href = url.href;
  return (
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('tessdata.projectnaptha.com') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('huggingface.co') ||
    url.hostname.includes('hf.co') ||
    url.hostname.includes('docs.opencv.org') ||
    href.includes('tesseract') ||
    href.includes('traineddata') ||
    href.includes('onnxruntime') ||
    href.includes('esearch-ocr') ||
    href.includes('OCRB') ||
    href.includes('.onnx') ||
    href.includes('dict.txt') ||
    href.endsWith('.wasm')
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const staticCache = await caches.open(STATIC_CACHE);
      await staticCache.addAll(LOCAL_ASSETS);

      // Pre-cache non bloccante per la libreria Tesseract.js
      const ocrCache = await caches.open(OCR_CACHE);
      await Promise.allSettled(
        EXTERNAL_PRECACHE.map(async (resourceUrl) => {
          try {
            const req = new Request(resourceUrl, { mode: 'cors' });
            const res = await fetch(req);
            if (res && res.ok) {
              await ocrCache.put(req, res);
            }
          } catch (err) {
            // Ignora errori di rete durante il pre-cache opzionale
          }
        })
      );

      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== OCR_CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 1. Risorse locali: Network-First con fallback in cache (mostra subito gli aggiornamenti online, funziona offline)
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        try {
          const networkRes = await fetch(request);
          if (networkRes && networkRes.ok) {
            cache.put(request, networkRes.clone());
          }
          return networkRes;
        } catch (err) {
          const cached = await cache.match(request, { ignoreSearch: true });
          if (cached) return cached;

          // Fallback per navigazioni offline
          if (request.mode === 'navigate') {
            const fallback = await cache.match('./index.html');
            if (fallback) return fallback;
          }

          return new Response('Offline - Risorsa non disponibile in cache', {
            status: 503,
            statusText: 'Service Unavailable'
          });
        }
      })()
    );
    return;
  }

  // 2. Risorse esterne OCR (Tesseract, WASM, ita.traineddata.gz): Cache-First
  if (isOcrResource(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(OCR_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;

        try {
          const networkRes = await fetch(request);
          if (networkRes && (networkRes.ok || networkRes.type === 'opaque')) {
            cache.put(request, networkRes.clone());
          }
          return networkRes;
        } catch (err) {
          return new Response('', { status: 504, statusText: 'OCR Resource Offline' });
        }
      })()
    );
  }
});
