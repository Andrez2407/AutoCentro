# Fotocopiadora Automática — Contexto y arquitectura actualizada

## Cambio de enfoque importante

La primera versión del proyecto asumía que el usuario iba a operar el software directamente
en la PC del centro (con teclado/mouse). **Eso ya no es así.** El diseño correcto es:

- La **PC del centro NO es una interfaz que el usuario opera**. Es una pantalla de estado
  (solo salida, sin teclado/mouse/touch para el usuario) + el puente físico hacia la impresora
  (por seguridad, solo esa PC tiene acceso a la impresora, y eso no va a cambiar).
- Toda la interacción real (subir archivo, elegir copias, pagar) sucede en el **celular del
  usuario**, al que llega escaneando un QR que se muestra en la pantalla de la PC.

Este documento reemplaza cualquier supuesto anterior de "app local que el usuario usa en la PC".

## Contexto del negocio

No hay mucha demanda — esto no es un kiosco de alto tráfico. La automatización existe para
cubrir los momentos en que **no hay nadie atendiendo** el mostrador. Por eso el sistema tiene
un modo automático/manual que se puede togglear, y en el futuro habrá también un modo
"por encargo" (mandar el archivo sin estar presente, para retirar después) — no implementar
todavía, pero diseñar el flujo de sesiones pensando en que ese modo se va a agregar.

## Actores del sistema

1. **PC del centro (Windows)**
   - Browser en modo kiosco, pantalla completa, mostrando el estado de la sesión activa
     (o el QR de "iniciar sesión" cuando está en Idle).
   - Un agente/proceso local que:
     - Escucha eventos de Firebase Realtime/Firestore para su sesión activa.
     - Descarga archivos de Storage.
     - Convierte Word/PowerPoint a PDF con LibreOffice headless.
     - Cuenta páginas del PDF resultante.
     - Imprime el PDF sin diálogos, usando SumatraPDF en modo línea de comandos
       (`SumatraPDF.exe -print-to "NombreImpresora" archivo.pdf`).
   - Solo hace conexiones salientes hacia Firebase — no expone puertos ni necesita red local
     especial para el celular del usuario.

2. **Celular del usuario**
   - Web app mobile-first (no requiere instalar nada), a la que se llega escaneando el QR
     de sesión.
   - Ahí: sube el archivo, lo edita/configura (copias, color, tamaño de hoja), ve el precio
     y el QR de pago.
   - Sube directo a Firebase Storage (con URL firmada), no a través de un servidor propio.

3. **Backend (Firebase)**
   - Firestore para sesiones, trabajos y pagos.
   - Realtime (Firestore listeners) para sincronizar estado entre celular y pantalla de la PC.
   - Storage para los archivos (originales y PDFs convertidos).
   - Cloud Functions solo para lógica liviana (webhook de pago, cálculo de precio) —
     **no** para conversión de documentos (eso lo hace la PC, ver más abajo).

## Formatos soportados

Limitado a **PDF, Word (.docx) y PowerPoint (.pptx)**. Todo se convierte a PDF antes de
imprimir — nunca se manda un .docx/.pptx directo a la impresora.

- Si es imagen (si en el futuro se soportan), la compresión/resize se hace en el celular
  (canvas del browser) antes de subir — es liviano y no arriesga fidelidad.
- **No** convertir Word/PowerPoint en el celular. No hay forma liviana y fiel de hacerlo en
  browser; la conversión real la hace LibreOffice en la PC del centro.
- .docx/.pptx ya son ZIP internamente — no vale la pena comprimirlos más antes de subir.

## Motor de conversión: LibreOffice headless (en la PC, Windows)

```
soffice --headless --convert-to pdf --outdir <ruta_salida> archivo.docx
```

- Instalar de entrada fuentes compatibles con MS Office (Calibri, Cambria, Arial, etc.) para
  minimizar corrimientos de diseño por sustitución de fuentes.
- Conversión secuencial (una sesión activa a la vez) — si en el futuro hay concurrencia,
  usar `-env:UserInstallation=file:///ruta/temporal/unica` por llamada para evitar locks.
- Si la conversión falla (PDF con contraseña, Word corrupto): reportar error al backend
  **antes** de calcular precio, para que el celular muestre "no se pudo procesar el archivo"
  y nadie pague por algo que no se puede imprimir.

## Impresión (Windows, sin diálogos)

Usar SumatraPDF en modo línea de comandos para imprimir el PDF ya convertido, sin abrir
Word/PowerPoint ni mostrar UI. El PDF final ya está listo desde el paso de conversión, así
que al confirmarse el pago no hace falta volver a descargar ni convertir nada.

## Flujo completo de una sesión

```
Idle en pantalla (QR de sesión, token único, expira en 2-3 min si no se escanea)
  → Usuario escanea con el celular
  → Backend chequea: ¿modo_automatico ON?
      → NO: mensaje "hay atención manual, acercate al mostrador"
      → SÍ: continúa
  → Usuario sube archivo (PDF/Word/PowerPoint) directo a Storage (URL firmada)
  → Backend notifica a la PC: "hay archivo nuevo"
  → PC descarga, convierte a PDF si hace falta, cuenta páginas, sube PDF final, reporta conteo
  → Backend calcula precio y genera QR de pago
  → Pago confirmado (webhook, verificar firma, chequear idempotencia)
  → Backend notifica a la PC: "trabajo pago, listo para imprimir"
  → PC imprime el PDF (SumatraPDF, sin diálogo)
  → Pantalla muestra "retirá tu impresión" (o error si falló)
  → Vuelve a Idle
```

Timeout de pago: si se generó el QR de pago y pasan ~10 min sin confirmación, la sesión
expira y la PC vuelve a Idle.

## Toggle modo automático / manual

- Ícono de engranaje chico en la misma pantalla de la PC. El usuario final no puede tocarlo
  (no tiene mouse/touch), así que puede estar siempre visible sin agregar hardware.
- Al tocarlo, pide un **PIN corto** antes de togglear — por si en algún momento se conecta
  un mouse/teclado temporal o se agrega touch más adelante.
- El valor de `modo_automatico` vive en el **backend** (no en estado local del browser de la
  PC), porque el chequeo que hace el celular del usuario al escanear el QR consulta al backend.
- Cuando está en modo manual, la pantalla de Idle no muestra QR de sesión (o muestra
  "modo manual activo").

## Pagos

- Proveedor QR aún por definir en detalle (a confirmar).
- Webhook debe ser **idempotente**: chequear si la sesión ya está marcada como pagada antes
  de disparar impresión, para no imprimir dos veces si el proveedor reenvía la notificación.
- **Validar firma** del webhook — no confiar en cualquier POST que llegue a esa URL.
- Si el pago se confirmó pero la impresión falla (sin papel, atascada, etc.): registrar el
  caso para que el encargado lo gestione manualmente al principio. Reembolso automático
  por API queda para una v2.

## Modelo de datos (Firestore) — punto de partida a validar con el cowork

- `sesiones`: id, estado (idle/subiendo/configurando/pago_pendiente/pagado/imprimiendo/listo/expirada), token_qr, timestamps, centro_id.
- `trabajos`: sesion_id, archivo_original_url, archivo_pdf_url, cantidad_paginas, copias, color/bn, precio, estado.
- `pagos`: trabajo_id, proveedor, estado, referencia_externa, timestamps.
- `config_centro`: centro_id, modo_automatico (bool), pin_hash, tarifas (precio por página color/bn), horarios (para futura automatización del toggle).

Incluir `centro_id` desde ahora en todas las colecciones, aunque hoy sea un solo local —
evita un refactor grande si el día de mañana se agrega una segunda máquina.

## Storage / privacidad

- Lifecycle policy para borrar archivos (original y PDF convertido) automáticamente unas
  horas después de impreso, o de creada la sesión si nunca se pagó.
- Límite de tamaño y cantidad de archivos por sesión, para evitar abuso.

## Pendiente de definir (no bloquea el arranque, pero hay que resolverlo)

- Proveedor de pago QR específico y detalles de su webhook/firma.
- Panel de admin simple (tabla de trabajos recientes, estado, si se cobró) para debug y
  control de caja.
- Cómo se resuelven los reembolsos en la práctica (manual al principio).
- Diseño concreto del modo "por encargo" (v2) — sesiones sin chequeo de presencia física.
