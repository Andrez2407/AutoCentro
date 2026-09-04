// Proceso principal de Electron.
// Tiene acceso total al sistema (fs, child_process) — acá vive todo lo que el sandbox
// del renderer/browser no puede tocar: diálogo de archivos, lista de impresoras reales,
// ejecución de SumatraPDF y polling del spooler de Windows.
//
// Dos modos, elegidos por línea de comandos (ver package.json):
//   npm start          -> carga test_impresora.html (debug aislado, como antes)
//   npm run kiosco      -> carga public/pc-app.html (la pantalla real del centro), con el
//                          IPC de impresión real ya conectado.
// El puente IPC (preload.js) es el mismo para las dos — no le importa qué página lo usa.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { imprimir, TIPOS_ERROR } = require('./lib/impresion');
const { descargarArchivo } = require('./lib/descarga');

const MODO_KIOSCO = process.argv.includes('--kiosco');

// Nombre (parcial, sin distinguir mayúsculas) de la impresora del centro, para usar como
// fallback cuando no llega un nombre explícito de impresora (p.ej. porque config_centro
// todavía no tiene el campo `impresora_nombre` cargado). El nombre EXACTO tal como lo ve
// Windows todavía hay que confirmarlo y guardarlo en esa config — ver README.
const IMPRESORA_PREFERIDA = 'RICOH MP 501';

let ventanaPrincipal = null;

function crearVentana() {
  ventanaPrincipal = new BrowserWindow({
    width: 900,
    height: 800,
    title: MODO_KIOSCO ? 'AutoCentro' : 'AutoCentro — Test de impresión',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MODO_KIOSCO) {
    ventanaPrincipal.loadFile(path.join(__dirname, '..', 'public', 'pc-app.html'));
  } else {
    ventanaPrincipal.loadFile(path.join(__dirname, 'test_impresora.html'));
  }

  // Descomentar mientras se debuggea el propio agente (no la impresión en sí):
  // ventanaPrincipal.webContents.openDevTools();
}

/**
 * Devuelve el nombre exacto (tal como lo ve Windows) de la impresora a usar cuando el
 * caller no especificó una: prefiere la que contenga IMPRESORA_PREFERIDA, si no existe
 * cae a la predeterminada de Windows, y si tampoco hay eso, a la primera de la lista.
 */
async function resolverNombreImpresora(nombreSolicitado) {
  if (nombreSolicitado) return nombreSolicitado;

  const impresoras = await ventanaPrincipal.webContents.getPrintersAsync();
  const preferida = impresoras.find((p) => p.name.toUpperCase().includes(IMPRESORA_PREFERIDA));
  if (preferida) return preferida.name;

  const predeterminada = impresoras.find((p) => p.isDefault);
  if (predeterminada) return predeterminada.name;

  return impresoras[0] ? impresoras[0].name : null;
}

app.whenReady().then(() => {
  crearVentana();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC: diálogo nativo para elegir el PDF de prueba -----------------------
// A propósito NO pasa por Storage/descarga/conversión: el objetivo de esta etapa es
// aislar y probar solo el módulo de impresión con un PDF que ya está listo en disco.
ipcMain.handle('pdf:seleccionar', async () => {
  const resultado = await dialog.showOpenDialog(ventanaPrincipal, {
    title: 'Elegir PDF de prueba',
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (resultado.canceled || resultado.filePaths.length === 0) return null;
  return resultado.filePaths[0];
});

// --- IPC: listar impresoras disponibles --------------------------------------
// webContents.getPrintersAsync() ya da la lista sin invocar PowerShell aparte.
ipcMain.handle('impresoras:listar', async () => {
  const impresoras = await ventanaPrincipal.webContents.getPrintersAsync();
  return impresoras.map((p) => ({
    nombre: p.name,
    esPredeterminada: !!p.isDefault,
    estado: p.status,
  }));
});

// --- IPC: disparar el flujo completo de impresión -----------------------------
// opciones: { rutaPdf, nombreImpresora, copias, color, duplex, ajustarAHoja }
ipcMain.handle('print:iniciar', async (_event, opciones) => {
  if (!opciones || !opciones.rutaPdf || !opciones.nombreImpresora) {
    return {
      ok: false,
      errorType: TIPOS_ERROR.DESCONOCIDO,
      message: 'Faltan datos: hace falta un PDF y una impresora seleccionados.',
    };
  }

  // Todos los eventos de progreso se emiten por IPC al renderer a medida que ocurren;
  // esta llamada handle() solo confirma que el flujo arrancó.
  imprimir(opciones, (evento) => {
    const { tipo, ...payload } = evento;
    if (ventanaPrincipal && !ventanaPrincipal.isDestroyed()) {
      ventanaPrincipal.webContents.send(tipo, payload);
    }
  }).catch((err) => {
    if (ventanaPrincipal && !ventanaPrincipal.isDestroyed()) {
      ventanaPrincipal.webContents.send('print-job:error', {
        errorType: TIPOS_ERROR.DESCONOCIDO,
        message: `Error inesperado no controlado: ${err && err.message ? err.message : err}`,
      });
    }
  });

  return { ok: true };
});

// --- IPC: imprimir un trabajo REAL del flujo de sesiones (pc-app.html) --------------
// datos: {
//   sesionId, nombreArchivo, tipoArchivo ('pdf'|'docx'|'pptx'), archivoUrl (acepta tanto
//   gs://bucket/ruta -tal cual lo guarda Firestore en archivo_original_url- como una URL
//   https ya resuelta; ver lib/descarga.js:gsAHttps),
//   rangoCompleto (bool: true si el rango de páginas pedido es el documento entero),
//   copias, faz ('simple'|'doble'), nombreImpresora (opcional — si no viene, se resuelve
//   con resolverNombreImpresora())
// }
//
// LIMITACIONES A PROPÓSITO en esta etapa (ver claude/estado-frontend.md del proyecto):
//   - Solo tipoArchivo === 'pdf'. Todavía no existe el paso de conversión con LibreOffice
//     para .docx/.pptx (archivo_pdf_url en Firestore sigue sin completarse).
//   - Solo rangoCompleto === true. Sin el recorte de páginas, imprimir un rango parcial
//     terminaría sacando el documento entero — preferimos fallar explícito antes que
//     cobrar por 2 páginas e imprimir 12.
// Cuando eso exista, este handler es el que hay que tocar para sacarle estas dos
// restricciones (llamando a la conversión/recorte antes de descargarArchivo/imprimir).
ipcMain.handle('trabajo:imprimir', async (_event, datos) => {
  if (!datos || !datos.sesionId || !datos.archivoUrl) {
    return { ok: false, errorType: TIPOS_ERROR.DESCONOCIDO, message: 'Faltan datos del trabajo a imprimir.' };
  }

  if (datos.tipoArchivo !== 'pdf') {
    return {
      ok: false,
      errorType: TIPOS_ERROR.DESCONOCIDO,
      message: `Conversión de .${datos.tipoArchivo} todavía no implementada en el agente (falta el paso de LibreOffice).`,
    };
  }

  if (!datos.rangoCompleto) {
    return {
      ok: false,
      errorType: TIPOS_ERROR.DESCONOCIDO,
      message: 'El recorte de rango de páginas todavía no está implementado — no se imprime para no cobrar de más o de menos.',
    };
  }

  let nombreImpresora;
  try {
    nombreImpresora = await resolverNombreImpresora(datos.nombreImpresora);
  } catch (err) {
    return { ok: false, errorType: TIPOS_ERROR.DESCONOCIDO, message: `No se pudo resolver la impresora: ${err.message}` };
  }
  if (!nombreImpresora) {
    return { ok: false, errorType: TIPOS_ERROR.OFFLINE, message: 'No hay ninguna impresora disponible en esta PC.' };
  }

  let rutaLocal;
  try {
    rutaLocal = await descargarArchivo(datos.archivoUrl, datos.nombreArchivo);
  } catch (err) {
    return { ok: false, errorType: TIPOS_ERROR.DESCONOCIDO, message: `No se pudo descargar el archivo: ${err.message}` };
  }

  const opciones = {
    rutaPdf: rutaLocal,
    nombreImpresora,
    copias: datos.copias,
    color: false, // todavía no se ofrece impresión a color en el flujo real (ver mobile-app.html)
    duplex: datos.faz === 'doble' ? 'duplex' : 'simplex',
    ajustarAHoja: true,
  };

  imprimir(opciones, (evento) => {
    const { tipo, ...payload } = evento;
    if (ventanaPrincipal && !ventanaPrincipal.isDestroyed()) {
      ventanaPrincipal.webContents.send(tipo, { sesionId: datos.sesionId, ...payload });
    }
  }).catch((err) => {
    if (ventanaPrincipal && !ventanaPrincipal.isDestroyed()) {
      ventanaPrincipal.webContents.send('print-job:error', {
        sesionId: datos.sesionId,
        errorType: TIPOS_ERROR.DESCONOCIDO,
        message: `Error inesperado no controlado: ${err && err.message ? err.message : err}`,
      });
    }
  });

  return { ok: true, nombreImpresora };
});
