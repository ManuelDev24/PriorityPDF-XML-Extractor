// backend/services/dataAudit/exportar.js — Arma el Excel de auditoria con
// las 11 hojas declaradas en hojas.js. No sabe nada de SQL ni de SISCOMMATE:
// solo itera la configuracion y escribe filas en un Workbook de exceljs.

const ExcelJS = require('exceljs');
const { construirHojas } = require('./hojas');

const COLOR_CLAVE = 'FFD9D9D9'; // gris — columnas tecnicas, no editar
const NOTA_CLAVE = 'No editar — se usa para identificar la fila al reinyectar.';

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
}

module.exports = { construirLibroAuditoria };
