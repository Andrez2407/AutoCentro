// Proceso principal de Electron.
// Tiene acceso total al sistema (fs, child_process) — acá vive todo lo que el sandbox
// del renderer/browser no puede tocar: diálogo de archivos, lista de impresoras reales,
// ejecución de SumatraPDF y polling del spooler de Windows.
//
// Etapa actual: SOLO la página de test (test_impresora.html). No hay integración con
// Firestore ni con el flujo de sesión del usuario todavía — a propósito.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { imprimir, TIPOS_ERROR } = require('./lib/impresion');

let ventanaPrincipal = null;

function crearVentana() {
  ventanaPrincipal = new BrowserWindow({
    width: 900,
    height: 800,
    title: 'AutoCentro — Test de impresión',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  ventanaPrincipal.loadFile(path.join(__dirname, 'test_impresora.html'));

  // Descomentar mientras se debuggea el propio agente (no la impresión en sí):
  // ventanaPrincipal.webContents.openDevTools();
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
