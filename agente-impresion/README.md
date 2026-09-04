# Agente de impresión (Electron)

Este proyecto Electron vive dentro de la carpeta de AutoCentro pero es un `package.json`
aparte. Tiene dos modos:

- **`npm start`** → carga `test_impresora.html`, la página de debug aislada (sin Firestore,
  sin flujo de sesión/pago) — para probar el módulo de impresión en sí, a mano.
- **`npm run kiosco`** → carga `../public/pc-app.html`, la pantalla real del centro, con la
  impresión real ya conectada por IPC (ver "Integración con pc-app.html" más abajo).

El módulo de impresión (`lib/impresion.js`, SumatraPDF + polling del spooler de Windows) es
el mismo para los dos modos.

## Por qué Electron y no solo el browser

El browser (aunque se sirva local) no puede tocar el sistema de archivos ni el spooler de
Windows — es una restricción del sandbox de JavaScript, no de dónde está hosteada la página.
Por eso la interfaz se empaqueta como app Electron, con dos procesos que se comunican por
IPC (instantáneo, local, sin depender de la red):

- **`main.js` + `lib/impresion.js`** (proceso principal, Node con acceso total al sistema):
  diálogo nativo de archivos, `getPrintersAsync()`, comando de SumatraPDF vía
  `child_process`, y polling al spooler de Windows (`Get-Printer` / `Get-PrintJob` de
  PowerShell — equivalente en más alto nivel a `Win32_Printer` / `Win32_PrintJob` por WMI).
- **`test_impresora.html` + `preload.js`** (proceso de renderizado): la UI de test. Se
  entera de los eventos de impresión (enviado / imprimiendo / éxito / error) por IPC, no por
  Firestore.

## Instalación (en la PC Windows del centro)

Requiere Node.js instalado.

```bash
cd agente-impresion
npm install
```

## SumatraPDF

Este proyecto **no** trae SumatraPDF.exe incluido. Hay que descargar la versión portable
oficial y copiarla a:

```
agente-impresion/bin/SumatraPDF.exe
```

(o apuntar a otra ubicación con la variable de entorno `SUMATRA_PDF_PATH` antes de arrancar
la app). Si no está en esa ruta, la página de test va a mostrar el error correspondiente en
el log en vez de fallar en silencio.

## Correrlo

```bash
npm start
```

Se abre la ventana de `test_impresora.html`.

## Cómo probarlo sin gastar papel primero

Elegí la impresora virtual **"Microsoft Print to PDF"** (viene con Windows) en el dropdown.
Esto valida que el comando de SumatraPDF y los flags de `-print-settings` estén bien
armados. **Ojo**: esa impresora abre un diálogo del sistema para elegir dónde guardar, así
que el polling al spooler no se puede validar con ella — para eso hace falta la impresora
física conectada.

## Taxonomía de errores (fija, para no romper el flujo real más adelante)

`sin_papel`, `atascada`, `offline`, `timeout`, `driver_no_soporta_opcion`, `desconocido`.

Estos son los mismos valores que va a usar el flujo real de sesiones cuando se integre, así
que si se agrega un tipo nuevo hay que hacerlo pensando en ambos lados.

## Qué NO hace esta etapa (a propósito)

- No integra con Firestore ni con el flujo de sesión del usuario.
- No descarga de Storage ni convierte con LibreOffice — el PDF de test ya tiene que venir
  listo para imprimir (elegido a mano con el selector de archivo).
- El rango de páginas no se maneja acá: el módulo de impresión asume que el PDF que recibe
  ya viene recortado a las páginas correctas desde un paso anterior.
- No hay lógica de idempotencia/reintentos ligada a sesiones.

## Qué falta confirmar antes de dar por cerrada esta etapa

1. **Nombre exacto del driver de la impresora** tal como lo ve Windows (para guardarlo en
   la config más adelante, no hardcodeado en el código).
2. **Si el driver respeta `duplex` con hardware real**, o si hay que resolver doble faz
   manualmente (imprimir pares, avisar que se dé vuelta el mazo, imprimir impares). Esto
   cambia el diseño si el dúplex de hardware no funciona bien con esa impresora — probarlo
   con el hardware físico, no alcanza con "Microsoft Print to PDF".

## Integración con pc-app.html (`npm run kiosco`)

`pc-app.html` (la pantalla del centro) corre como el renderer de esta misma app Electron en
vez de en Chrome kiosco. Cuando una sesión pasa a `pagado`, si `window.agenteImpresion`
existe (o sea, si está corriendo acá adentro y no en un browser normal), dispara la
impresión real: lee `trabajos/{sesionId}` de Firestore, arma la orden y la manda por IPC a
`main.js`, que descarga el PDF (`lib/descarga.js`, convierte el `gs://` de Storage a la URL
pública de descarga) y lo imprime con el mismo `lib/impresion.js` de siempre. Al resolver,
escribe `sesiones/{sesionId}.estado` en `listo` o `error` — reemplaza el `setTimeout` que
simulaba esto antes.

Si se abre `pc-app.html` en un browser común (Chrome, sin Electron) para desarrollo,
`window.agenteImpresion` no existe y sigue usando el `setTimeout` simulado de siempre — no
se rompió ese flujo de prueba.

**Limitaciones a propósito en esta etapa** (el handler `trabajo:imprimir` en `main.js` es el
punto exacto a tocar cuando se saquen):

- Solo imprime si `trabajos.tipo_archivo === 'pdf'`. Todavía no existe la conversión con
  LibreOffice para `.docx`/`.pptx` — esos trabajos fallan con un error explícito en vez de
  intentar imprimir el archivo original sin convertir.
- Solo imprime si el rango de páginas pedido es el documento completo
  (`rango_desde === 1 && rango_hasta === cantidad_paginas_total`). Sin el recorte de
  páginas, imprimir un rango parcial terminaría sacando el documento entero — se prefiere
  fallar explícito antes que cobrar de menos e imprimir de más.
- Nunca imprime a color (`color: false` fijo) — la tarifa actual (`tarifas.simple/doble` en
  `config_centro`) tampoco contempla color todavía.
- El nombre de la impresora sale de `config_centro.impresora_nombre` si está cargado; si no,
  cae a buscar una que contenga "RICOH MP 501" y si tampoco existe, a la predeterminada de
  Windows.

## Estructura

```
agente-impresion/
├── package.json
├── main.js              # proceso principal: ventana + handlers IPC
├── preload.js            # puente IPC (contextBridge) entre main y renderer
├── test_impresora.html   # página de test (selector de PDF, impresora, opciones, log)
├── lib/
│   └── impresion.js      # el módulo de impresión en sí: SumatraPDF + polling + taxonomía
└── bin/
    └── SumatraPDF.exe    # (no incluido — copiarlo acá o usar SUMATRA_PDF_PATH)
```
