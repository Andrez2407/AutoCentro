// Módulo de impresión — corre en el proceso principal (Node con acceso total al sistema).
//
// Responsabilidades:
//   1. Construir y ejecutar el comando de SumatraPDF.
//   2. Hacer polling al spooler de Windows (Get-Printer / Get-PrintJob de PowerShell)
//      hasta saber si el trabajo salió bien, falló, o se cumplió el timeout de seguridad.
//   3. Traducir lo que ve en el spooler a la taxonomía fija de errores del proyecto.
//
// No depende de Firestore ni de nada de red: solo de child_process + el spooler local.

const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');

// --- Configuración ---------------------------------------------------------

// Ruta a SumatraPDF.exe. Por defecto busca una copia empaquetada al lado del ejecutable
// de la app (carpeta "bin/"), pero se puede pisar con la variable de entorno
// SUMATRA_PDF_PATH si se prefiere apuntar a otra instalación.
// TODO(confirmar con el usuario): nombre exacto del driver de la impresora tal como lo ve
// Windows, para guardarlo en la config en vez de tener que elegirlo cada vez a mano.
const SUMATRA_PATH =
  process.env.SUMATRA_PDF_PATH || path.join(__dirname, '..', 'bin', 'SumatraPDF.exe');

const POLL_INTERVAL_MS = 1500; // 1-2s pedido en el prompt
const TIMEOUT_MS = 75 * 1000; // dentro del rango 60-90s pedido en el prompt

// --- Taxonomía fija de errores ---------------------------------------------
// Usada tanto acá como, más adelante, por el flujo real de sesiones — no cambiar los
// valores sin actualizar también el lado que los consume.
const TIPOS_ERROR = {
  SIN_PAPEL: 'sin_papel',
  ATASCADA: 'atascada',
  OFFLINE: 'offline',
  TIMEOUT: 'timeout',
  DRIVER_NO_SOPORTA_OPCION: 'driver_no_soporta_opcion',
  DESCONOCIDO: 'desconocido',
};

// --- Banderas crudas del spooler de Windows (winspool.h) --------------------
// IMPORTANTE: Get-Printer/Get-PrintJob NO devuelven texto ("PaperOut", "Offline", etc.)
// al pasarlos por ConvertTo-Json — devuelven el valor numérico crudo del enum de flags.
// Se confirmó con datos reales de la Ricoh MP 501: PrinterStatus=64 al sacarle el papel
// (= 0x40 = PRINTER_STATUS_PAPER_PROBLEM) y JobStatus=8208/12288 mientras imprimía bien
// (= 0x2010/0x3000 = PRINTING+RETAINED / COMPLETE+RETAINED). Por eso la clasificación de
// abajo es aritmética de bits, no matching de texto.
const JOB_STATUS = {
  PAUSED: 0x00000001,
  ERROR: 0x00000002,
  DELETING: 0x00000004,
  SPOOLING: 0x00000008,
  PRINTING: 0x00000010,
  OFFLINE: 0x00000020,
  PAPEROUT: 0x00000040,
  PRINTED: 0x00000080,
  DELETED: 0x00000100,
  BLOCKED_DEVQ: 0x00000200,
  USER_INTERVENTION: 0x00000400,
};

const PRINTER_STATUS = {
  PAUSED: 0x00000001,
  ERROR: 0x00000002,
  PENDING_DELETION: 0x00000004,
  PAPER_JAM: 0x00000008,
  PAPER_OUT: 0x00000010,
  MANUAL_FEED: 0x00000020,
  PAPER_PROBLEM: 0x00000040,
  OFFLINE: 0x00000080,
  IO_ACTIVE: 0x00000100,
  BUSY: 0x00000200,
  PRINTING: 0x00000400,
  OUTPUT_BIN_FULL: 0x00000800,
  NOT_AVAILABLE: 0x00001000,
  WAITING: 0x00002000,
  PROCESSING: 0x00004000,
  INITIALIZING: 0x00008000,
  WARMING_UP: 0x00010000,
  TONER_LOW: 0x00020000,
  NO_TONER: 0x00040000,
  PAGE_PUNT: 0x00080000,
  USER_INTERVENTION: 0x00100000,
  OUT_OF_MEMORY: 0x00200000,
  DOOR_OPEN: 0x00400000,
  SERVER_UNKNOWN: 0x00800000,
  POWER_SAVE: 0x01000000,
};

// Combinaciones de banderas que consideramos "hay un problema", para chequear con un
// solo AND bit a bit en vez de comparar campo por campo.
const PRINTER_STATUS_PROBLEMA =
  PRINTER_STATUS.ERROR |
  PRINTER_STATUS.PAPER_JAM |
  PRINTER_STATUS.PAPER_OUT |
  PRINTER_STATUS.PAPER_PROBLEM |
  PRINTER_STATUS.OFFLINE |
  PRINTER_STATUS.OUTPUT_BIN_FULL |
  PRINTER_STATUS.NOT_AVAILABLE |
  PRINTER_STATUS.NO_TONER |
  PRINTER_STATUS.DOOR_OPEN |
  PRINTER_STATUS.USER_INTERVENTION |
  PRINTER_STATUS.OUT_OF_MEMORY |
  PRINTER_STATUS.SERVER_UNKNOWN;

const JOB_STATUS_PROBLEMA =
  JOB_STATUS.ERROR | JOB_STATUS.OFFLINE | JOB_STATUS.PAPEROUT | JOB_STATUS.BLOCKED_DEVQ | JOB_STATUS.USER_INTERVENTION;

/**
 * Arma el string de -print-settings a partir de las opciones elegidas en la UI.
 * @param {{copias:number, color:boolean, duplex:string, ajustarAHoja?:boolean}} opciones
 */
function construirPrintSettings({ copias, color, duplex, ajustarAHoja }) {
  const partes = [];

  const n = Number(copias) || 1;
  if (n > 1) partes.push(`${n}x`);

  partes.push(color ? 'color' : 'monochrome');

  // duplex esperado: 'simplex' | 'duplex' | 'duplexlong' | 'duplexshort'
  if (duplex && duplex !== 'simplex') {
    partes.push(duplex);
  } else {
    partes.push('simplex');
  }

  if (ajustarAHoja) partes.push('fit');

  return partes.join(',');
}

/**
 * Ejecuta SumatraPDF.exe -print-to ... -print-settings ... -silent <pdf>
 * Devuelve una Promise que resuelve cuando SumatraPDF *entrega* el trabajo al spooler
 * (no cuando termina de imprimir físicamente — eso lo sabemos recién con el polling).
 */
function ejecutarSumatra({ rutaPdf, nombreImpresora, printSettings }) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SUMATRA_PATH)) {
      reject({
        errorType: TIPOS_ERROR.DESCONOCIDO,
        message: `No se encontró SumatraPDF.exe en "${SUMATRA_PATH}". Configurá SUMATRA_PDF_PATH o copiá el ejecutable a bin/SumatraPDF.exe.`,
      });
      return;
    }
    if (!fs.existsSync(rutaPdf)) {
      reject({
        errorType: TIPOS_ERROR.DESCONOCIDO,
        message: `El PDF a imprimir no existe en disco: ${rutaPdf}`,
      });
      return;
    }

    const args = ['-print-to', nombreImpresora, '-print-settings', printSettings, '-silent', rutaPdf];

    const proc = spawn(SUMATRA_PATH, args, { windowsHide: true });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject({
        errorType: TIPOS_ERROR.DESCONOCIDO,
        message: `No se pudo lanzar SumatraPDF: ${err.message}`,
      });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Un código de salida distinto de 0 casi siempre significa que Sumatra rechazó
        // algún flag de -print-settings (por ejemplo, el driver no soporta duplex) o que
        // el nombre de la impresora no existe.
        reject({
          errorType: TIPOS_ERROR.DRIVER_NO_SOPORTA_OPCION,
          message:
            stderr.trim() ||
            `SumatraPDF salió con código ${code}. Revisá que la impresora exista y que el driver soporte las opciones pedidas (${printSettings}).`,
        });
      }
    });
  });
}

/**
 * Corre un único query de PowerShell que devuelve, en JSON, el estado de la impresora
 * y la lista actual de trabajos en su cola. Usa los cmdlets Get-Printer / Get-PrintJob
 * (equivalentes en más alto nivel a consultar Win32_Printer / Win32_PrintJob por WMI).
 */
function consultarSpooler(nombreImpresora) {
  return new Promise((resolve, reject) => {
    const nombreEscapado = nombreImpresora.replace(/'/g, "''");
    const script =
      `$ErrorActionPreference = 'SilentlyContinue'; ` +
      `$p = Get-Printer -Name '${nombreEscapado}' | Select-Object PrinterStatus; ` +
      `$jobs = Get-PrintJob -PrinterName '${nombreEscapado}' | ` +
      `Select-Object Id,DocumentName,JobStatus,SubmittedTime; ` +
      `@{ printer = $p; jobs = @($jobs) } | ConvertTo-Json -Depth 4 -Compress`;

    exec(
      `powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`,
      { windowsHide: true, timeout: 20_000 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          const parsed = JSON.parse(stdout || '{}');
          resolve(parsed);
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

/**
 * Traduce el estado crudo del spooler a uno de los TIPOS_ERROR fijos.
 */
function clasificarError({ printerStatus, jobStatus }) {
  const p = Number(printerStatus) || 0;
  const j = Number(jobStatus) || 0;

  if ((p & PRINTER_STATUS.PAPER_OUT) || (p & PRINTER_STATUS.PAPER_PROBLEM) || (j & JOB_STATUS.PAPEROUT)) {
    return TIPOS_ERROR.SIN_PAPEL;
  }
  if (p & PRINTER_STATUS.PAPER_JAM) {
    return TIPOS_ERROR.ATASCADA;
  }
  if ((p & PRINTER_STATUS.OFFLINE) || (p & PRINTER_STATUS.SERVER_UNKNOWN) || (j & JOB_STATUS.OFFLINE)) {
    return TIPOS_ERROR.OFFLINE;
  }
  return TIPOS_ERROR.DESCONOCIDO;
}

/**
 * Flujo completo: ejecuta SumatraPDF y después hace polling al spooler hasta resolver
 * éxito / error / timeout. Reporta cada cambio de estado a través de onEvento.
 *
 * @param {object} opciones { rutaPdf, nombreImpresora, copias, color, duplex, ajustarAHoja }
 * @param {(evento: {tipo:string, [k:string]:any}) => void} onEvento
 */
async function imprimir(opciones, onEvento) {
  const printSettings = construirPrintSettings(opciones);
  const nombreDocumento = path.basename(opciones.rutaPdf);

  // Snapshot de los Ids que YA estaban en la cola antes de mandar este trabajo. Es
  // importante porque un trabajo anterior con el mismo nombre de archivo puede seguir
  // "atascado" en la cola (p.ej. uno viejo de una prueba sin papel que el usuario recién
  // destrabó poniendo papel) y confundirse con el trabajo recién enviado si solo
  // comparamos por nombre de documento — eso hacía que a veces se enganchara con el
  // trabajo equivocado. Con el snapshot, identificamos el trabajo nuestro como el primero
  // NUEVO (Id que no estaba antes) que matchee el nombre, y de ahí en más lo seguimos por
  // Id, no por nombre.
  let idsPrevios = new Set();
  try {
    const estadoInicial = await consultarSpooler(opciones.nombreImpresora);
    const jobsPrevios = Array.isArray(estadoInicial?.jobs)
      ? estadoInicial.jobs
      : estadoInicial?.jobs
      ? [estadoInicial.jobs]
      : [];
    idsPrevios = new Set(jobsPrevios.map((j) => j.Id));
  } catch (err) {
    // Si esto falla no es grave — seguimos igual, solo perdemos esta protección extra.
  }

  try {
    await ejecutarSumatra({
      rutaPdf: opciones.rutaPdf,
      nombreImpresora: opciones.nombreImpresora,
      printSettings,
    });
  } catch (fallo) {
    onEvento({ tipo: 'print-job:error', errorType: fallo.errorType, message: fallo.message });
    return;
  }

  onEvento({
    tipo: 'print-job:sent',
    message: `Comando enviado al spooler (SumatraPDF -print-to "${opciones.nombreImpresora}" -print-settings "${printSettings}").`,
  });

  const inicio = Date.now();
  let vistoEnCola = false;
  let avisoImprimiendo = false;
  let miJobId = null;

  while (true) {
    if (Date.now() - inicio > TIMEOUT_MS) {
      onEvento({
        tipo: 'print-job:error',
        errorType: TIPOS_ERROR.TIMEOUT,
        message: `No se pudo confirmar el resultado dentro de ${TIMEOUT_MS / 1000}s. El trabajo puede haber salido igual — revisar la impresora físicamente.`,
      });
      return;
    }

    let estado;
    try {
      estado = await consultarSpooler(opciones.nombreImpresora);
      console.log('[debug] estado spooler:', JSON.stringify(estado));
    } catch (err) {
      // Un fallo puntual de PowerShell no es necesariamente un error de impresión;
      // seguimos intentando hasta el timeout. Lo logueamos igual para poder diagnosticar
      // si TODAS las consultas están fallando (p.ej. timeout muy corto contra una
      // impresora de red, o el nombre de la impresora no matchea).
      console.log('[debug] fallo consultando el spooler:', err.message);
      await esperar(POLL_INTERVAL_MS);
      continue;
    }

    const printerStatus = estado?.printer?.PrinterStatus;
    const jobs = Array.isArray(estado?.jobs) ? estado.jobs : estado?.jobs ? [estado.jobs] : [];

    let jobPropio;
    if (miJobId !== null) {
      // Ya identificamos cuál trabajo es el nuestro: lo seguimos por Id, sin ambigüedad.
      jobPropio = jobs.find((j) => j.Id === miJobId);
    } else {
      // Todavía no lo identificamos: buscamos uno NUEVO (Id que no estaba en el snapshot
      // inicial) que matchee el nombre de archivo, e ignoramos cualquier trabajo viejo con
      // el mismo nombre que ya estuviera en cola de antes.
      jobPropio = jobs.find((j) => !idsPrevios.has(j.Id) && (j.DocumentName || '').includes(nombreDocumento));
      if (jobPropio) miJobId = jobPropio.Id;
    }

    const printerStatusNum = Number(printerStatus) || 0;

    if (jobPropio) {
      vistoEnCola = true;

      if (!avisoImprimiendo) {
        avisoImprimiendo = true;
        onEvento({ tipo: 'print-job:printing', message: 'El trabajo está en la cola de impresión.' });
      }

      const jobStatusNum = Number(jobPropio.JobStatus) || 0;
      if ((jobStatusNum & JOB_STATUS_PROBLEMA) || (printerStatusNum & PRINTER_STATUS_PROBLEMA)) {
        const errorType = clasificarError({ printerStatus: printerStatusNum, jobStatus: jobStatusNum });
        onEvento({
          tipo: 'print-job:error',
          errorType,
          message: `El spooler reporta un problema con el trabajo (JobStatus=${jobStatusNum}, PrinterStatus=${printerStatusNum}).`,
        });
        return;
      }
    } else if (vistoEnCola) {
      // Estaba en la cola y ya no está. OJO: esto NO es éxito automático — algunos
      // drivers (confirmado con la Ricoh MP 501) sacan el trabajo de la cola aunque haya
      // fallado (p.ej. falta de papel), y el problema solo se ve en el PrinterStatus del
      // último poll, no en el JobStatus. Por eso volvemos a chequear acá antes de avisar
      // éxito.
      if (printerStatusNum & PRINTER_STATUS_PROBLEMA) {
        const errorType = clasificarError({ printerStatus: printerStatusNum, jobStatus: 0 });
        onEvento({
          tipo: 'print-job:error',
          errorType,
          message: `El trabajo salió de la cola pero la impresora reporta un problema (PrinterStatus=${printerStatusNum}).`,
        });
        return;
      }
      onEvento({ tipo: 'print-job:success', message: 'El trabajo salió de la cola sin errores reportados.' });
      return;
    } else if (printerStatusNum & PRINTER_STATUS_PROBLEMA) {
      // Nunca llegó a aparecer en la cola y la impresora ya reporta un problema.
      onEvento({
        tipo: 'print-job:error',
        errorType: clasificarError({ printerStatus: printerStatusNum, jobStatus: 0 }),
        message: `La impresora reporta un problema antes de que el trabajo entre a la cola (PrinterStatus=${printerStatusNum}).`,
      });
      return;
    }

    await esperar(POLL_INTERVAL_MS);
  }
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  TIPOS_ERROR,
  construirPrintSettings,
  imprimir,
  SUMATRA_PATH,
};
