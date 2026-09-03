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
  const texto = `${printerStatus || ''} ${jobStatus || ''}`.toLowerCase();

  if (texto.includes('paperout') || texto.includes('paper out') || texto.includes('sin papel')) {
    return TIPOS_ERROR.SIN_PAPEL;
  }
  if (texto.includes('paperjam') || texto.includes('paper jam') || texto.includes('jammed')) {
    return TIPOS_ERROR.ATASCADA;
  }
  if (texto.includes('offline') || texto.includes('not available') || texto.includes('notavailable')) {
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
    const jobPropio = jobs.find((j) => (j.DocumentName || '').includes(nombreDocumento));

    if (jobPropio) {
      vistoEnCola = true;

      if (!avisoImprimiendo) {
        avisoImprimiendo = true;
        onEvento({ tipo: 'print-job:printing', message: 'El trabajo está en la cola de impresión.' });
      }

      const jobStatusTexto = String(jobPropio.JobStatus || '');
      if (/error|blocked|paperout|paperjam|offline/i.test(jobStatusTexto)) {
        const errorType = clasificarError({ printerStatus, jobStatus: jobStatusTexto });
        onEvento({
          tipo: 'print-job:error',
          errorType,
          message: `El spooler reporta un problema con el trabajo (JobStatus="${jobStatusTexto}", PrinterStatus="${printerStatus}").`,
        });
        return;
      }
    } else if (vistoEnCola) {
      // Estaba en la cola y ya no está: se imprimió (o se descartó sin error visible).
      onEvento({ tipo: 'print-job:success', message: 'El trabajo salió de la cola sin errores reportados.' });
      return;
    } else if (printerStatus && /offline|not.?available/i.test(String(printerStatus))) {
      // Nunca llegó a aparecer en la cola y la impresora está offline.
      onEvento({
        tipo: 'print-job:error',
        errorType: TIPOS_ERROR.OFFLINE,
        message: `La impresora reporta PrinterStatus="${printerStatus}".`,
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
