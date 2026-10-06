// services/txtVerifier.js — Revisión del TXT de Hacienda antes de entregarlo.
//
// Replica lo que la web de Hacienda PR rechaza (visto en el rechazo del lote
// 3309879): líneas que no miden 205, tamaño de contenedor en blanco, peso no
// numérico, puertos ilegibles. Un error aquí significa que Hacienda lo va a
// devolver, así que el export se bloquea y se dice cuál línea y qué campo.

const LARGO_LINEA = 205;
// Campo de peso: 7 dígitos, en centavos de kg → máximo 99,999.99 kg por línea.
const PESO_MAX_KG = 99999.99;
const MAX_ERRORES = 15;

/**
 * Revisa un TXT ya generado.
 * @param {string} txt Líneas separadas por CRLF
 * @returns {string[]} Errores legibles; vacío si el TXT está en orden
 */
function verificarTxt(txt) {
  /** @type {string[]} */
  const errores = [];
  const lineas = txt.split('\r\n');
  const agregar = (/** @type {string} */ m) => { if (errores.length < MAX_ERRORES) errores.push(m); };

  lineas.forEach((l, i) => {
    if (l.length !== LARGO_LINEA) agregar(`Línea ${i + 1} mide ${l.length} caracteres (debe ser ${LARGO_LINEA})`);
  });
  if (lineas[0] && lineas[0][0] !== '0') agregar('La primera línea no es el encabezado (tipo 0)');
  if ((lineas.length - 1) % 2 !== 0) agregar('Hay una línea de B/L sin su línea de carga (deben ir en pares)');

  for (let i = 1; i + 1 < lineas.length; i += 2) {
    const l1 = lineas[i];
    const l2 = lineas[i + 1];
    const donde = `Línea ${i + 1} (B/L ${l1.substring(1, 17).trim() || '?'}, contenedor ${l1.substring(19, 37).trim() || 'sin contenedor'})`;
    if (l1[0] !== '1' || l2[0] !== '2') { agregar(`${donde}: el par no es tipo 1 + tipo 2`); continue; }
    if (l1.length !== LARGO_LINEA || l2.length !== LARGO_LINEA) continue; // ya reportado; los campos estarían desplazados

    if (!l1.substring(1, 17).trim()) agregar(`${donde}: falta el número de B/L`);
    if (l1.substring(1, 17) !== l2.substring(1, 17)) agregar(`${donde}: el B/L de la línea de carga no coincide`);
    if (!/^\d{3}R$/.test(l1.substring(186, 190))) agregar(`${donde}: tamaño de contenedor inválido ("${l1.substring(186, 190)}", esperado p. ej. 040R)`);
    if (!/^\d{3}$/.test(l2.substring(35, 38))) agregar(`${donde}: volumen/tamaño de la línea de carga no es numérico ("${l2.substring(35, 38)}")`);
    if (l1.substring(186, 189) !== l2.substring(35, 38)) agregar(`${donde}: el tamaño de la línea 1 y el de la línea 2 no coinciden`);
    for (const [nombre, ini] of [['origen', 143], ['descarga', 146], ['destino', 149]]) {
      if (!/^[A-Z0-9]{3}$/.test(l1.substring(Number(ini), Number(ini) + 3))) agregar(`${donde}: puerto de ${nombre} inválido ("${l1.substring(Number(ini), Number(ini) + 3)}")`);
    }
    if (!/^\d{9}$/.test(l1.substring(153, 162))) agregar(`${donde}: valor FOB no numérico`);
    if (!/^\d{7}$/.test(l2.substring(28, 35))) agregar(`${donde}: peso no numérico ("${l2.substring(28, 35)}")`);

    if (!/^\d{5}$/.test(l2.substring(17, 22))) agregar(`${donde}: cantidad no numérica`);
    if (l2.substring(201, 203) !== 'KF') agregar(`${donde}: unidad de peso inválida ("${l2.substring(201, 203)}", esperado KF)`);
  }
  return errores;
}

/**
 * Pesos por línea que no caben en los 7 dígitos del campo (padZ los recortaría
 * por la derecha y quedaría un número distinto sin aviso).
 * @param {import('../types').BLRow[]} bls
 * @param {(bl: import('../types').BLRow) => number} pesoPorLinea Peso que el TXT escribirá por contenedor
 * @returns {string[]}
 */
function pesosFueraDeRango(bls, pesoPorLinea) {
  return bls
    .filter(bl => pesoPorLinea(bl) > PESO_MAX_KG)
    .map(bl => `B/L ${bl.bl_no}: ${pesoPorLinea(bl).toFixed(2)} kg por línea excede el máximo de ${PESO_MAX_KG} kg del campo de peso`);
}

module.exports = { verificarTxt, pesosFueraDeRango, LARGO_LINEA, PESO_MAX_KG };
