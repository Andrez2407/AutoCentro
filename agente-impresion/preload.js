// Puente IPC entre el renderer (test_impresora.html) y el proceso principal (main.js).
// El renderer NUNCA tiene acceso directo a Node/fs/child_process: todo pasa por acá,
// que es la única superficie que exponemos con contextBridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agenteImpresion', {
  // --- Acciones que dispara el renderer (Renderer -> Main) ---

  // Abre el diálogo nativo de archivos para elegir un PDF de prueba.
  // Devuelve la ruta local del archivo elegido, o null si el usuario canceló.
  seleccionarPdf: () => ipcRenderer.invoke('pdf:seleccionar'),

  // Pide la lista de impresoras disponibles (via webContents.getPrintersAsync()).
  listarImpresoras: () => ipcRenderer.invoke('impresoras:listar'),

  // Dispara el flujo completo: construir comando SumatraPDF + ejecutarlo + polling al spooler.
  // opciones: { rutaPdf, nombreImpresora, copias, color, duplex }
  //   color: boolean (true = color, false = monochrome)
  //   duplex: 'simplex' | 'duplex' | 'duplexlong' | 'duplexshort'
  imprimir: (opciones) => ipcRenderer.invoke('print:iniciar', opciones),

  // --- Eventos que emite el main process (Main -> Renderer) ---
  // callback recibe (payload). Devuelve una función para des-suscribirse.
  onEventoImpresion: (callback) => {
    const canales = [
      'print-job:sent',
      'print-job:printing',
      'print-job:success',
      'print-job:error',
    ];
    const listeners = canales.map((canal) => {
      const listener = (_event, payload) => callback({ tipo: canal, ...payload });
      ipcRenderer.on(canal, listener);
      return { canal, listener };
    });
    return () => {
      listeners.forEach(({ canal, listener }) => ipcRenderer.removeListener(canal, listener));
    };
  },
});
