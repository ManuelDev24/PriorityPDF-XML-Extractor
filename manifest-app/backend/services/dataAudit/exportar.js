// backend/services/dataAudit/exportar.js — Arma el Excel de auditoria con
// las hojas declaradas en hojas.js. Nunca golpea el bridge de SISCOMMATE:
// solo lee SQLite e itera la configuracion para escribir filas en un
// Workbook de exceljs.

const ExcelJS = require('exceljs');
const { construirHojas } = require('./hojas');

const COLOR_CLAVE = 'FFD9D9D9'; // gris — columnas tecnicas, no editar
const NOTA_CLAVE = 'No editar — se usa para identificar la fila al reinyectar.';
const COLOR_ESPECIAL = 'FFFFF3CD'; // amarillo suave — trae un caracter fuera de A-Z/0-9/espacio
const COLOR_FALTANTE = 'FFFFE0B2'; // naranja suave — le falta documento/direccion/telefono
const COLOR_DUPLICADO = 'FFF8D7DA'; // rojo suave — nombre parecido a otro de la misma hoja

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<import('exceljs').Workbook>}
 */
async function construirLibroAuditoria(db) {
  const workbook = new ExcelJS.Workbook();
  for (const hoja of construirHojas()) {
    const filas = await hoja.obtenerFilas({ db });
    agregarHoja(workbook, hoja, filas);
  }
  return workbook;
}

function agregarHoja(workbook, hoja, filas) {
  const worksheet = workbook.addWorksheet(hoja.nombre);
  const columnasClave = hoja.camposClave;
  // Las columnas de datos se derivan de la primera fila real (asi la hoja
  // siempre refleja TODO lo que trae el origen, incluyendo columnas
  // informativas como bls_asociados/_campos_faltantes que no estan en
  // camposEditables). Si no hay filas, se cae a camposEditables para que la
  // hoja al menos tenga encabezados.
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

  agregarFormulasEspeciales(worksheet, hoja, columnas, filas.length);
  colorearColumnaCalculada(worksheet, columnas, '_campos_faltantes', COLOR_FALTANTE);
  colorearColumnaCalculada(worksheet, columnas, '_posible_duplicado', COLOR_DUPLICADO);
}

// Formato condicional NATIVO de Excel (no una foto fija): si corriges el
// valor y ya no tiene ningun caracter fuera de A-Z/0-9/espacio, el color
// desaparece solo al recalcular, sin volver a exportar.
function agregarFormulasEspeciales(worksheet, hoja, columnas, totalFilas) {
  if (totalFilas === 0) return; // hoja vacia — nada que resaltar
  const ultimaFila = totalFilas + 1; // +1 por la fila de encabezado

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
        priority: 1,
        formulae: [formula],
        style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_ESPECIAL } } },
      }],
    });
  }
}

// _campos_faltantes y _posible_duplicado se calculan del lado Node (la
// similitud usa Levenshtein — no se puede expresar como una formula simple
// de Excel), asi que el color se aplica ya resuelto al exportar, no como
// regla viva. Si se corrige el dato hay que volver a exportar para que el
// color se actualice.
function colorearColumnaCalculada(worksheet, columnas, nombreColumna, color) {
  if (!columnas.includes(nombreColumna)) return;
  const indice = columnas.indexOf(nombreColumna) + 1;
  worksheet.getColumn(indice).eachCell({ includeEmpty: false }, (celda, numeroFila) => {
    if (numeroFila === 1) return;
    if (String(celda.value || '').trim()) {
      celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    }
  });
}

module.exports = { construirLibroAuditoria };
