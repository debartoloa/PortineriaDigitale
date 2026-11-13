/**
 * check_ids.js - Script di Collaudo e Verifica Integrità DOM
 * 
 * Verifica che ogni document.getElementById(...) presente nel codice JavaScript 
 * di index.html corrisponda a un id="..." effettivamente dichiarato nel DOM.
 * 
 * Utilizzo:
 *   node check_ids.js
 */

const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, 'index.html');
const jsPath = path.join(__dirname, 'app.js');

if (!fs.existsSync(htmlPath) || !fs.existsSync(jsPath)) {
  console.error('❌ File index.html o app.js non trovato nella cartella corrente!');
  process.exit(1);
}

const htmlContent = fs.readFileSync(htmlPath, 'utf8');
const jsContent = fs.readFileSync(jsPath, 'utf8');

// 1. Estrazione di tutti gli ID dichiarati nel DOM
const idRegex = /id="([^"]+)"/g;
const declaredIds = new Set();
let match;
while ((match = idRegex.exec(htmlContent)) !== null) {
  declaredIds.add(match[1]);
}

// 2. Estrazione di tutte le chiamate getElementById in app.js
const getRegex = /getElementById\(['"]([^'"]+)['"]\)/g;
const missingIds = new Set();
let totalCalls = 0;

while ((match = getRegex.exec(jsContent)) !== null) {
  totalCalls++;
  const refId = match[1];
  
  // Ignora ID creati dinamicamente a runtime (es. sede-0, sede-1 o fogli di stile dinamici)
  if (!declaredIds.has(refId) && !refId.startsWith('sede-') && refId !== 'dynamic-print-page-style') {
    missingIds.add(refId);
  }
}

console.log('====================================================');
console.log('🔍 REPORT COLLAUDO INTEGRITÀ DOM - PORTINERIA DIGITALE');
console.log('====================================================');
console.log(`• ID dichiarati nel markup HTML: ${declaredIds.size}`);
console.log(`• Chiamate getElementById analizzate: ${totalCalls}`);

if (missingIds.size === 0) {
  console.log('✅ ESITO: 100% SUCCESSO! Nessun ID mancante.');
  console.log('Tutti gli elementi richiamati dal codice esistono nel DOM.');
  process.exit(0);
} else {
  console.error('⚠️ ATTENZIONE: Trovati ID richiamati ma non presenti nel DOM:');
  missingIds.forEach(id => console.error(`  - ${id}`));
  process.exit(1);
}
