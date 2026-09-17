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

## Detección de fallas por SNMP (además del spooler de Windows)

**Por qué existe esto:** confirmado con pruebas reales con la Ricoh MP 501 que el spooler de
Windows (`Get-Printer`/`Get-PrintJob`, lo único que usa `lib/impresion.js` originalmente)
puede seguir reportando `PrinterStatus=0` ("todo normal") aunque la impresora esté
físicamente sin papel, con la luz roja prendida y pitando — el driver instalado no le pasa
ese estado al spooler, y esto pasa incluso con el "soporte bidireccional" del puerto
habilitado en Windows. La impresora sí expone su estado real por **SNMP**, de forma estándar
(no depende del driver ni de Windows), así que `lib/snmp-impresora.js` la consulta directo
por red como señal extra.

**Cómo activarlo:** seteá estas variables de entorno antes de arrancar la app (`npm run
kiosco` o `npm start`) —si no están, todo sigue funcionando igual que antes, solo sin esta
señal extra:

- `IMPRESORA_IP` — la IP de la impresora en la red local (ej: `192.168.1.50`). Sin esto, no
  se hace ninguna consulta SNMP. Se puede ver en el propio panel de la impresora (Configuración
  de red / TCP-IP), en una página de configuración impresa desde el menú de la impresora, o en
  Windows: Panel de control → Dispositivos e impresoras → Propiedades → pestaña Puertos →
  "Configurar puerto" (ahí figura la IP del puerto TCP/IP).
- `IMPRESORA_SNMP_COMMUNITY` — el community string de solo lectura (default: `public`, que es
  el valor de fábrica de la gran mayoría de las impresoras — solo hace falta tocar esto si
  alguien lo cambió a propósito).

**Dónde se usa esta señal:**

1. **Antes de mandar cada trabajo** (`imprimir()` en `lib/impresion.js`): si SNMP ya reporta
   sin papel/atascada/offline, se falla al toque en vez de esperar hasta 75s a que el spooler
   (que puede no enterarse nunca) lo confirme.
2. **En cada vuelta del polling** mientras se espera el resultado de un trabajo: se consulta
   junto con el spooler, y si cualquiera de las dos señales reporta un problema, se clasifica
   como error — esto es lo que corrige el caso real donde el trabajo "salía de la cola sin
   errores" según Windows pero la impresora seguía físicamente sin papel.
3. **En segundo plano, todo el tiempo** (`monitorearImpresoraEnSegundoPlano()` en `main.js`,
   solo en modo kiosco): cada 15s, independiente de que haya algo imprimiéndose. Si detecta un
   problema, `pc-app.html` muestra un aviso fijo arriba de toda la pantalla (rojo, con el
   mensaje correspondiente) hasta que se resuelva — así el problema se ve ANTES de que alguien
   intente imprimir, no recién cuando falla un trabajo.

**Limitaciones a tener en cuenta:**

- Necesita que la impresora tenga SNMP habilitado (viene así de fábrica en casi todos los
  casos) y sea alcanzable por UDP/161 desde esta PC — si el firewall de la red de la
  universidad bloquea ese puerto entre la PC y la impresora, esto simplemente no da señal
  (no rompe nada, solo no suma la protección extra).
- Usa el OID estándar `hrPrinterDetectedErrorState` (Host Resources MIB, RFC 2790) con índice
  de dispositivo `.1`, que es lo correcto para una impresora simple de un solo motor. Si en
  algún momento se cambia de impresora por un equipo multifunción con varios "device index",
  puede hacer falta ajustar el OID en `lib/snmp-impresora.js`.
- Un fallo o timeout de SNMP nunca se trata como error de impresión — si no responde,
  simplemente no aporta esta señal extra y todo sigue dependiendo del spooler como antes.

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
├── main.js              # proceso principal: ventana + handlers IPC + monitoreo SNMP de fondo
├── preload.js            # puente IPC (contextBridge) entre main y renderer
├── test_impresora.html   # página de test (selector de PDF, impresora, opciones, log)
├── lib/
│   ├── impresion.js      # el módulo de impresión en sí: SumatraPDF + polling + taxonomía
│   ├── descarga.js        # baja el PDF de Storage antes de imprimirlo (flujo real)
│   └── snmp-impresora.js  # consulta el estado real de la impresora por SNMP (ver arriba)
└── bin/
    └── SumatraPDF.exe    # (no incluido — copiarlo acá o usar SUMATRA_PDF_PATH)
```

Nota sobre `npm install`: como `net-snmp` ahora es una dependencia del proyecto (para la
sección de SNMP de arriba), después de bajar los últimos cambios con `git pull` hace falta
correr `npm install` de nuevo en `agente-impresion/` para que se instale — si ya lo tenías
corriendo y solo hiciste `git pull`, `npm start`/`npm run kiosco` va a fallar con "Cannot find
module 'net-snmp'" hasta que corras `npm install` una vez.
