# Agente de impresión (Electron) — etapa de test aislada

Esta carpeta es un proyecto Electron **separado** del sistema con Firebase (AutoCentro).
Por ahora **no** habla con Firestore ni con el flujo de sesión/pago — el objetivo de esta
etapa es dejar probado, de forma aislada, el módulo de impresión real (SumatraPDF + polling
del spooler de Windows).

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
