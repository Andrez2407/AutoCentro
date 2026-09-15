# Esquema de datos — Firestore (MVP)

`centro_id` fijo en `"principal"` por ahora (una sola sede), guardado igual en todos los
documentos para no tener que migrar cuando haya una segunda máquina.

## `config_centro/{centroId}`

```
{
  centro_id: "principal",
  modo_automatico: true,
  pin_hash: "···",          // no implementado todavía — se edita a mano en la consola
  tarifas: { simple: 150, doble: 250 },
  impresora_nombre: null,   // opcional. Nombre EXACTO de la impresora tal como lo ve
                             // Windows (ver dropdown de test_impresora.html). Si no está
                             // seteado, el agente de impresión cae a buscar una que
                             // contenga "RICOH MP 501" y si no existe, a la predeterminada.
  updated_at: Timestamp
}
```

## `sesiones/{sesionId}`

`sesionId` es un ID autogenerado por Firestore (largo y aleatorio — funciona como parte del
"secreto" del link del QR, junto con `token_qr`).

```
{
  centro_id: "principal",
  token_qr: "9f7c2a1d...",   // string aleatorio, se valida contra el que viene en la URL
  estado: "idle",            // idle | esperando_archivo | configurando | pago_pendiente
                             // | pagado | imprimiendo | listo | expirada | error
  nombre_cliente: "",        // opcional. Lo escribe el celular apenas se valida la sesión,
                             // ANTES de subir ningún archivo — el popup "¿A nombre de
                             // quién es el pedido?" se muestra justo después de validar y,
                             // al confirmarlo, este campo se actualiza acá (además de en
                             // trabajos/{sesionId}, que lo completa más tarde). Así
                             // pc-app.html puede mostrar el nombre en grande en pantalla
                             // ni bien se ingresa, sin esperar a que exista el trabajo.
  created_at: Timestamp,
  updated_at: Timestamp,
  expires_at: Timestamp      // idle: ahora + 3 min. pago_pendiente usa un cooldown de 40s
                             // manejado en memoria por pc-app.html (no un campo acá).
}
```

## `trabajos/{sesionId}`

Usa el mismo ID que la sesión (relación 1 a 1), para no tener que hacer una query extra.

```
{
  sesion_id: "...",
  centro_id: "principal",
  nombre_archivo: "apunte.pdf",
  nombre_cliente: "",         // opcional, lo completa el celular (campo "¿A nombre de
                               // quién?" al principio de mobile-app.html) — para que el
                               // mostrador sepa de quién es cada trabajo
  tipo_archivo: "pdf",        // pdf | docx | pptx
  archivo_original_url: "gs://.../sesiones/{sesionId}/original.pdf",
  archivo_pdf_url: null,      // lo completa el agente de la PC tras convertir
  cantidad_paginas_total: 12, // detectado (pdf.js) o ingresado a mano (docx/pptx)
  rango_desde: 1,
  rango_hasta: 12,
  copias: 1,
  faz: "simple",              // simple | doble
  precio: 1500,               // calculado en el celular; se recalcula server-side más adelante
  estado: "pendiente",        // pendiente | procesando | listo_para_pagar | pagado | impreso | error
  error_tipo: null,           // lo completa el agente de impresión si estado=error — uno de
                               // sin_papel | atascada | offline | timeout |
                               // driver_no_soporta_opcion | desconocido (ver TIPOS_ERROR en
                               // agente-impresion/lib/impresion.js)
  error_mensaje: null         // idem, texto libre para mostrar/loguear
}
```

## `pagos/{sesionId}`

```
{
  trabajo_id: "...",
  proveedor: "mercadopago",   // a definir
  estado: "pendiente",        // pendiente | aprobado | rechazado | expirado
  referencia_externa: null,
  monto: 1500,
  created_at: Timestamp
}
```

Ver `firestore.rules` y `storage.rules` para los permisos de lectura/escritura de cada
colección — por ahora nadie del lado del cliente puede marcar una sesión/pago como pagado;
eso queda reservado al webhook (Cloud Function con Admin SDK) que todavía no existe.
