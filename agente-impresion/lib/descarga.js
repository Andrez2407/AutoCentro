// Descarga un archivo por HTTPS a un directorio temporal y devuelve la ruta local.
// Se usa para bajar el PDF de Storage antes de pasárselo a SumatraPDF, que necesita un
// archivo en disco — no puede imprimir directo desde una URL.
//
// A propósito NO hace conversión (LibreOffice) ni recorte de páginas acá — eso sigue
// siendo una etapa pendiente (ver TODOs en main.js, handler 'trabajo:imprimir'). Esta
// función asume que lo que está en `url` ya es un PDF listo para imprimir tal cual.

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Convierte una URL gs://bucket/ruta (la que guarda Firestore en archivo_original_url)
 * a la URL pública de descarga de Firebase Storage. Solo funciona porque storage.rules
 * tiene "allow read: if true" para estas rutas (ver storage.rules) — si eso cambiara,
 * esta conversión dejaría de alcanzar y habría que autenticar la descarga.
 */
function gsAHttps(gsUrl) {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(gsUrl);
  if (!m) throw new Error(`URL de Storage con formato inesperado (se esperaba gs://bucket/ruta): ${gsUrl}`);
  const [, bucket, objectPath] = m;
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media`;
}

async function descargarArchivo(url, nombreSugerido) {
  const urlDescarga = url.startsWith('gs://') ? gsAHttps(url) : url;
  const res = await fetch(urlDescarga);
  if (!res.ok) {
    throw new Error(`No se pudo descargar el archivo (HTTP ${res.status} ${res.statusText})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  const nombreSeguro = (nombreSugerido || 'trabajo.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const destino = path.join(os.tmpdir(), `autocentro-${Date.now()}-${nombreSeguro}`);
  fs.writeFileSync(destino, buffer);
  return destino;
}

module.exports = { descargarArchivo, gsAHttps };
