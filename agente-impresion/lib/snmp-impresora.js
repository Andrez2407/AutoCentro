// Consulta el estado FÍSICO real de la impresora por SNMP (hrPrinterDetectedErrorState,
// Host Resources MIB — RFC 2790), como señal adicional/independiente del spooler de
// Windows.
//
// Por qué hace falta esto: confirmado con pruebas reales (Ricoh MP 501) que aunque el
// puerto de la impresora tenga "soporte bidireccional" habilitado en Windows,
// Get-Printer/Get-PrintJob pueden seguir devolviendo PrinterStatus=0 ("todo normal") aunque
// la impresora esté físicamente sin papel, con la luz roja prendida y pitando — el driver
// instalado no le pasa ese estado al spooler de Windows. La impresora sí expone su estado
// real por SNMP de forma estándar (no depende del driver ni de Windows), así que lo
// consultamos directo por red, en paralelo al polling del spooler.
//
// Esto es una señal EXTRA, no un reemplazo: si SNMP no está habilitado en la impresora, no
// es alcanzable por red, o falla por cualquier motivo, simplemente no tenemos esta señal y
// seguimos con lo que ya reporta el spooler — nunca tratamos "SNMP no respondió" como si
// fuera un error de impresión.

const snmp = require('net-snmp');

// hrPrinterDetectedErrorState (Host Resources MIB, RFC 2790) — .1 al final es el índice de
// dispositivo, que para una impresora simple de un solo motor casi siempre es 1. Si el
// hardware expone varios "device index" (poco común en impresoras de oficina chicas) esto
// podría no matchear — en ese caso simplemente no da señal (ver más arriba).
const OID_ESTADO_IMPRESORA = '1.3.6.1.2.1.25.3.5.1.2.1';

// Nombres y orden EXACTOS de los bits según la RFC 2790 (numerados desde el bit más
// significativo del primer byte): bit0=lowPaper ... bit7=serviceRequested. Hay bits
// adicionales (inputTrayMissing, outputFull, etc.) en un segundo byte que no nos importan
// para esta clasificación.
const NOMBRES_BANDERAS = [
  'lowPaper',
  'noPaper',
  'lowToner',
  'noToner',
  'doorOpen',
  'jammed',
  'offline',
  'serviceRequested',
];

function decodificarBanderas(valor) {
  const buffer = Buffer.isBuffer(valor) ? valor : Buffer.from(String(valor || ''), 'binary');
  if (!buffer.length) return {};
  const byte0 = buffer[0];
  const banderas = {};
  NOMBRES_BANDERAS.forEach((nombre, i) => {
    banderas[nombre] = Boolean(byte0 & (0x80 >> i));
  });
  return banderas;
}

/**
 * Consulta el estado de error detectado de la impresora por SNMP.
 * @param {string} ip
 * @param {{community?: string, timeoutMs?: number}} opciones
 * @returns {Promise<{ok:true, banderas:object, crudo:string} | {ok:false, motivo:string}>}
 *   Nunca rechaza la promesa — un fallo de SNMP se resuelve como {ok:false, motivo}, para
 *   que el caller decida tratarlo como "sin señal" y no como error de impresión.
 */
function consultarEstadoSnmp(ip, { community = 'public', timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    if (!ip) {
      resolve({ ok: false, motivo: 'No hay IP de impresora configurada (IMPRESORA_IP).' });
      return;
    }

    let session;
    try {
      session = snmp.createSession(ip, community, { timeout: timeoutMs, retries: 0 });
    } catch (err) {
      resolve({ ok: false, motivo: `No se pudo crear la sesión SNMP: ${err.message}` });
      return;
    }

    // Por si la librería nunca llama al callback ante ciertos fallos de red — nos aseguramos
    // de no dejar la Promise colgada para siempre.
    const salvavidas = setTimeout(() => {
      try { session.close(); } catch (e) { /* nada que hacer */ }
      resolve({ ok: false, motivo: 'Timeout esperando la sesión SNMP.' });
    }, timeoutMs + 1000);

    session.on('error', (err) => {
      clearTimeout(salvavidas);
      resolve({ ok: false, motivo: `Error de sesión SNMP: ${err.message}` });
    });

    session.get([OID_ESTADO_IMPRESORA], (err, varbinds) => {
      clearTimeout(salvavidas);
      try { session.close(); } catch (e) { /* nada que hacer */ }

      if (err) {
        resolve({ ok: false, motivo: `SNMP no respondió: ${err.message}` });
        return;
      }
      const vb = varbinds && varbinds[0];
      if (!vb || snmp.isVarbindError(vb)) {
        resolve({ ok: false, motivo: vb ? snmp.varbindError(vb) : 'Sin respuesta SNMP.' });
        return;
      }

      const banderas = decodificarBanderas(vb.value);
      resolve({
        ok: true,
        banderas,
        crudo: Buffer.isBuffer(vb.value) ? vb.value.toString('hex') : String(vb.value),
      });
    });
  });
}

module.exports = { consultarEstadoSnmp, decodificarBanderas, OID_ESTADO_IMPRESORA };
