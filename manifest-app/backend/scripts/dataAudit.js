// backend/scripts/dataAudit.js — Auditoria SQLite + SISCOMMATE via Excel
//
// Uso:
//   node backend/scripts/dataAudit.js exportar
//   node backend/scripts/dataAudit.js reinyectar <archivo.xlsx>
//
// Ver docs/superpowers/specs/2026-09-28-data-audit-excel-design.md para el diseno completo.

const path = require('path');
const readline = require('readline');
const db = require('../db/connection');
const siscommate = require('../services/siscommateClient');
const { sincronizarClientesDesdeSiscommate } = require('../services/clientSync');
const { construirLibroAuditoria } = require('../services/dataAudit/exportar');
const { calcularPlanDeCambios, formatearVistaPrevia, aplicarCambios } = require('../services/dataAudit/reinyectar');
const { registrarCambio } = require('../services/dataAudit/log');

function marcaDeTiempo() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function preguntar(texto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(texto, respuesta => { rl.close(); resolve(respuesta); }));
}

async function exportar() {
  const destino = path.join(__dirname, '..', '..', `audit_${marcaDeTiempo()}.xlsx`);
  console.log('Sincronizando clientes desde SISCOMMATE...');
  try { await sincronizarClientesDesdeSiscommate(); }
  catch (e) { console.error('[AVISO] No se pudo sincronizar clientes:', e.message); }

  console.log('Exportando desde SQLite...');
  const workbook = await construirLibroAuditoria(db);
  await workbook.xlsx.writeFile(destino);
  console.log(`[OK] Excel generado: ${destino}`);
}

async function reinyectar(rutaExcel) {
  if (!rutaExcel) {
    console.error('Uso: node backend/scripts/dataAudit.js reinyectar <archivo.xlsx>');
    process.exitCode = 1;
    return;
  }
  console.log('Calculando cambios...');
  const plan = await calcularPlanDeCambios(rutaExcel, { db, siscommate });
  console.log(formatearVistaPrevia(plan));
  if (plan.length === 0) return;

  const respuesta = await preguntar('¿Aplicar estos cambios? (y/N) ');
  if (respuesta.trim().toLowerCase() !== 'y') {
    console.log('Cancelado — no se escribió nada.');
    return;
  }
  const resultado = await aplicarCambios(plan, { db, siscommate }, registrarCambio);
  console.log(`[OK] ${resultado.aplicados} aplicado(s), ${resultado.fallidos} con error.`);
}

async function main() {
  const [, , comando, arg] = process.argv;
  if (comando === 'exportar') await exportar();
  else if (comando === 'reinyectar') await reinyectar(arg);
  else {
    console.error('Uso: node backend/scripts/dataAudit.js exportar | reinyectar <archivo.xlsx>');
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('[ERROR]', err.message);
  process.exitCode = 1;
});
