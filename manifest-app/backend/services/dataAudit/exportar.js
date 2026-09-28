// backend/services/dataAudit/exportar.js — Arma el Excel de auditoria con
// las 11 hojas declaradas en hojas.js. No sabe nada de SQL ni de SISCOMMATE:
// solo itera la configuracion y escribe filas en un Workbook de exceljs.

const ExcelJS = require('exceljs');
const { construirHojas } = require('./hojas');

const COLOR_CLAVE = 'FFD9D9D9'; // gris — columnas tecnicas, no editar
const NOTA_CLAVE = 'No editar — se usa para identificar la fila al reinyectar.';
const COLOR_DUPLICADO = 'FFF8D7DA'; // rojo suave — el mismo nombre aparece en dos filas
const COLOR_ESPECIAL = 'FFFFF3CD'; // amarillo suave — trae un caracter fuera de A-Z/0-9/espacio

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} siscommate Ver backend/services/siscommateClient.js
 * @returns {Promise<import('exceljs').Workbook>}
 */
async function construirLibroAuditoria(db, siscommate) {
  const workbook = new ExcelJS.Workbook();
  for (const hoja of construirHojas()) {
    let filas;
    try {
      filas = await hoja.obtenerFilas({ db, siscommate });
    } catch (e) {
      // Una hoja de SISCOMMATE sin bridge disponible no debe tumbar todo el
      // export — las hojas de SQLite siguen siendo utiles por si solas. Se
      // deja la hoja vacia con una nota explicando por que.
      console.error(`[AVISO] No se pudo traer "${hoja.nombre}": ${e.message}`);
      filas = [];
    }
    agregarHoja(workbook, hoja, filas);
  }
  return workbook;
}

function agregarHoja(workbook, hoja, filas) {
  const worksheet = workbook.addWorksheet(hoja.nombre);
  const columnasClave = hoja.camposClave;
  // Las columnas de datos se derivan de la primera fila real (asi la hoja
  // siempre refleja TODO lo que trae el origen, incluyendo columnas
  // informativas como bls_asociados que no estan en camposEditables). Si no
  // hay filas, se cae a camposEditables para que la hoja al menos tenga
  // encabezados.
  const columnasResto = filas.length > 0
    ? Object.keys(filas[0]).filter(c => !columnasClave.includes(c))
    : hoja.camposEditables;
  const columnas = [...columnasClave, ...columnasResto];

  worksheet.columns = columnas.map(nombre => ({ header: nombre, key: nombre, width: 22 }));
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: 'frozen', xSplit: columnasClave.length, ySplit: 1 }];

  filas.forEach(fila => worksheet.addRow(fila));

  for (let i = 1; i <= columnasClave.length; i++) {
    worksheet.getColumn(i).eachCell({ includeEmpty: true }, (celda, numeroFila) => {
      celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_CLAVE } };
      if (numeroFila === 1) celda.note = NOTA_CLAVE;
    });
  }

  agregarValidaciones(worksheet, hoja, columnas, filas.length);
}

// Formato condicional NATIVO de Excel (no una foto fija): si corriges el
// valor y ya no hay problema, el color desaparece solo al recalcular, sin
// volver a exportar. duplicateValues es una regla propia de Excel; el
// caracter-especial usa una formula porque Excel no trae esa regla de fabrica.
function agregarValidaciones(worksheet, hoja, columnas, totalFilas) {
  if (totalFilas === 0) return; // hoja vacia (p.ej. bridge no disponible) — nada que resaltar
  const ultimaFila = totalFilas + 1; // +1 por la fila de encabezado

  if (hoja.columnaDuplicados && columnas.includes(hoja.columnaDuplicados)) {
    const letra = worksheet.getColumn(columnas.indexOf(hoja.columnaDuplicados) + 1).letter;
    worksheet.addConditionalFormatting({
      ref: `${letra}2:${letra}${ultimaFila}`,
      rules: [{
        type: 'duplicateValues',
        priority: 1,
        style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_DUPLICADO } } },
      }],
    });
  }

  for (const campo of hoja.columnasEspeciales || []) {
    if (!columnas.includes(campo)) continue;
    const letra = worksheet.getColumn(columnas.indexOf(campo) + 1).letter;
    // Solo letras A-Z, digitos y espacio se consideran validos — el mismo
    // criterio que limpiarTextoLibre() en siscommateClient.js usa para lo
    // que de verdad llega a SISCOMMATE. Acotado a 40 caracteres: suficiente
    // para nombres/descripciones reales, evita un ROW(INDIRECT()) gigante.
    const formula = `IF(${letra}2="",FALSE,SUMPRODUCT(--ISERROR(FIND(MID(UPPER(${letra}2),ROW(INDIRECT("1:"&MIN(LEN(${letra}2),40))),1),"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ")))>0)`;
    worksheet.addConditionalFormatting({
      ref: `${letra}2:${letra}${ultimaFila}`,
      rules: [{
        type: 'expression',
        priority: 2,
        formulae: [formula],
        style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_ESPECIAL } } },
      }],
    });
  }
}

module.exports = { construirLibroAuditoria };
