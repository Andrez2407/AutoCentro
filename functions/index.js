// Cloud Functions para AutoCentro.
//
// - crearPreferenciaMP: Checkout Pro (link de pago). Es lo que está en uso hoy.
// - listarCajasMP: función de SOLO LECTURA para confirmar, una vez activado
//   "Cobrar con código QR" en la cuenta de Mercado Pago, cuál es el store_id y
//   external_pos_id de la caja — datos que va a necesitar la próxima función
//   (generar QR dinámico "en persona") para cobrar montos específicos.
// - crearLocalYCajaMP: hace el alta de sucursal + caja en un solo llamado
//   (según https://www.mercadopago.com.ar/developers/es/docs/qr-code/create-store-and-pos),
//   pensada para usarse una sola vez desde public/setup_caja.html.
// - crearOrdenQrMP: asocia un monto pendiente al QR ESTÁTICO de la caja (ya
//   creada). Se llama una vez por pedido, justo antes de mostrar el QR en
//   pc-app.html, para que el próximo pago que reciba esa caja sea por ese monto.
// - webhookMP: recibe el aviso de Mercado Pago cuando un pago se acredita (o se
//   cancela/vence), confirma el dato consultando la API de MP (nunca confía
//   ciegamente en el body del webhook) y actualiza sesiones/{sesionId} y
//   pagos/{sesionId} en Firestore. Reemplaza el atajo de teclado "P" de testing.
//
// Todo esto necesita el Access Token de Mercado Pago, que es secreto — nunca
// puede ir en el celular ni en la pantalla de la PC, por eso vive acá.
//
// Configuración necesaria antes de deployar:
//   firebase functions:secrets:set MP_ACCESS_TOKEN
//
// Deploy:
//   cd functions && npm install
//   firebase deploy --only functions

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const MP_ACCESS_TOKEN = defineSecret("MP_ACCESS_TOKEN");

// URL pública de webhookMP (ver definición más abajo), para que Mercado Pago
// sepa adónde avisar cuando se acredite un pago. Si al deployar te da una URL
// distinta (formato *.run.app en vez de *.cloudfunctions.net), avisale a
// Claude para actualizar esta constante.
const WEBHOOK_URL = "https://southamerica-east1-autocentro-14a94.cloudfunctions.net/webhookMP";

exports.crearPreferenciaMP = onRequest(
  { secrets: [MP_ACCESS_TOKEN], cors: true, region: "southamerica-east1" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Usá POST" });
      return;
    }

    const { monto, descripcion, referencia } = req.body || {};

    if (typeof monto !== "number" || !isFinite(monto) || monto <= 0) {
      res.status(400).json({ error: "Falta 'monto' (tiene que ser un número mayor a 0)" });
      return;
    }

    try {
      const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${MP_ACCESS_TOKEN.value()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: [
            {
              title: descripcion || "Fotocopias — Centro de Estudiantes",
              quantity: 1,
              unit_price: monto,
              currency_id: "ARS",
            },
          ],
          external_reference: referencia || null,
        }),
      });

      const data = await mpRes.json();

      if (!mpRes.ok) {
        logger.error("Mercado Pago devolvió un error", data);
        res.status(mpRes.status).json({ error: "Error de Mercado Pago", detalle: data });
        return;
      }

      res.status(200).json({
        id: data.id,
        init_point: data.init_point,
        sandbox_init_point: data.sandbox_init_point,
      });
    } catch (err) {
      logger.error("Error creando la preferencia", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Solo lectura — no crea ni modifica nada en la cuenta de Mercado Pago.
// Sirve para, una vez activado "Cobrar con código QR" desde la app de MP,
// confirmar el store_id y external_pos_id de la caja que se dio de alta.
exports.listarCajasMP = onRequest(
  { secrets: [MP_ACCESS_TOKEN], cors: true, region: "southamerica-east1" },
  async (req, res) => {
    try {
      const mpRes = await fetch("https://api.mercadopago.com/pos", {
        method: "GET",
        headers: { "Authorization": `Bearer ${MP_ACCESS_TOKEN.value()}` },
      });
      const data = await mpRes.json();

      if (!mpRes.ok) {
        logger.error("Mercado Pago devolvió un error", data);
        res.status(mpRes.status).json({ error: "Error de Mercado Pago", detalle: data });
        return;
      }

      res.status(200).json(data);
    } catch (err) {
      logger.error("Error consultando las cajas", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Da de alta la sucursal (store) y la caja (POS) en un solo llamado. Pensada
// para usarse UNA VEZ desde public/setup_caja.html. No hace falta correrla de
// nuevo salvo que se quiera dar de alta otra sucursal/caja.
exports.crearLocalYCajaMP = onRequest(
  { secrets: [MP_ACCESS_TOKEN], cors: true, region: "southamerica-east1" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Usá POST" });
      return;
    }

    const {
      nombre_sucursal, external_id_sucursal,
      calle, numero, ciudad, provincia, lat, lng, referencia,
      nombre_pos, external_id_pos, operating_mode,
    } = req.body || {};

    if (!nombre_sucursal || !external_id_sucursal || !nombre_pos || !external_id_pos) {
      res.status(400).json({
        error: "Faltan campos obligatorios: nombre_sucursal, external_id_sucursal, nombre_pos, external_id_pos",
      });
      return;
    }

    const token = MP_ACCESS_TOKEN.value();
    const authHeaders = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

    try {
      // 1) Averiguar el user_id de la cuenta (lo pide el endpoint de sucursales).
      const meRes = await fetch("https://api.mercadopago.com/users/me", { headers: authHeaders });
      const me = await meRes.json();
      if (!meRes.ok) {
        logger.error("Error en users/me", me);
        res.status(meRes.status).json({ paso: "users/me", error: me });
        return;
      }
      const userId = me.id;

      // 2) Crear la sucursal (store).
      const storeRes = await fetch(`https://api.mercadopago.com/users/${userId}/stores`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          name: nombre_sucursal,
          external_id: external_id_sucursal,
          business_hours: {
            monday: [{ open: "08:00", close: "20:00" }],
            tuesday: [{ open: "08:00", close: "20:00" }],
            wednesday: [{ open: "08:00", close: "20:00" }],
            thursday: [{ open: "08:00", close: "20:00" }],
            friday: [{ open: "08:00", close: "20:00" }],
          },
          location: {
            street_name: calle || "",
            street_number: numero || "",
            city_name: ciudad || "",
            state_name: provincia || "",
            latitude: typeof lat === "number" ? lat : 0,
            longitude: typeof lng === "number" ? lng : 0,
            reference: referencia || "",
          },
        }),
      });
      const store = await storeRes.json();
      if (!storeRes.ok) {
        logger.error("Error creando la sucursal", store);
        res.status(storeRes.status).json({ paso: "crear sucursal", error: store });
        return;
      }

      // 3) Crear la caja (POS), asociada a esa sucursal.
      const posRes = await fetch("https://api.mercadopago.com/v2/pos", {
        method: "POST",
        headers: Object.assign({}, authHeaders, {
          "X-Idempotency-Key": `${external_id_pos}-${Date.now()}`,
        }),
        body: JSON.stringify({
          name: nombre_pos,
          store_id: store.id,
          external_id: external_id_pos,
          config: { qr: { operating_mode: operating_mode || "pdv" } },
        }),
      });
      const pos = await posRes.json();
      if (!posRes.ok) {
        logger.error("Error creando la caja", pos);
        res.status(posRes.status).json({ paso: "crear caja", error: pos });
        return;
      }

      res.status(200).json({ user_id: userId, store, pos });
    } catch (err) {
      logger.error("Error dando de alta sucursal/caja", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Datos de la sucursal/caja ya dados de alta (ver crearLocalYCajaMP más arriba).
// No son secretos — el QR estático de la caja es información pública que
// cualquiera podría fotografiar en el mostrador — pero los dejamos como
// constantes del servidor para no tener que mandarlos desde el cliente.
const MP_USER_ID = "1713803147";
const MP_EXTERNAL_POS_ID = "CE001POS001";

// "QR en persona": la caja tiene un QR ESTÁTICO fijo (se generó una sola vez
// al crear la caja, ver qr_response.qr_code en la respuesta de crearLocalYCajaMP).
// No hay que generar un QR nuevo por cada cobro: hay que dejar pegado ese mismo
// QR (lo puede mostrar pc-app.html) y, antes de que el cliente lo escanee, avisarle
// a Mercado Pago cuánto tiene que cobrar la próxima vez que alguien lo pague — eso
// es lo que hace esta función (PUT .../qrs), asociando un monto pendiente a la caja.
exports.crearOrdenQrMP = onRequest(
  { secrets: [MP_ACCESS_TOKEN], cors: true, region: "southamerica-east1" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Usá POST" });
      return;
    }

    const { monto, descripcion, referencia } = req.body || {};

    if (typeof monto !== "number" || !isFinite(monto) || monto <= 0) {
      res.status(400).json({ error: "Falta 'monto' (tiene que ser un número mayor a 0)" });
      return;
    }
    if (!referencia) {
      res.status(400).json({ error: "Falta 'referencia' (se usa como external_reference, tiene que ser único por pedido)" });
      return;
    }

    const token = MP_ACCESS_TOKEN.value();
    const url = `https://api.mercadopago.com/instore/orders/qr/seller/collectors/${MP_USER_ID}/pos/${MP_EXTERNAL_POS_ID}/qrs`;

    try {
      const mpRes = await fetch(url, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          external_reference: referencia,
          title: "Fotocopias — Centro de Estudiantes",
          description: descripcion || "Fotocopias",
          total_amount: monto,
          notification_url: WEBHOOK_URL,
          items: [
            {
              sku_number: "FOTOCOPIAS",
              category: "services",
              title: descripcion || "Fotocopias",
              description: descripcion || "Fotocopias",
              unit_price: monto,
              quantity: 1,
              unit_measure: "unit",
              total_amount: monto,
            },
          ],
        }),
      });

      // Esta API responde 201 sin body cuando sale bien.
      if (!mpRes.ok) {
        let data = null;
        try { data = await mpRes.json(); } catch (_e) { /* puede venir vacío */ }
        logger.error("Error creando la orden QR", data);
        res.status(mpRes.status).json({ error: "Error de Mercado Pago", detalle: data });
        return;
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error("Error creando la orden QR", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Recibe el aviso de Mercado Pago cuando pasa algo con un pago QR (se acredita,
// se cancela, vence, etc). Nunca confiamos en el body del webhook a ciegas —
// siempre volvemos a consultar la API de MP con el id que nos manda, y recién
// ahí actualizamos Firestore. Responde rápido (200) aunque el pago no haya
// sido aprobado, para que MP no reintente de más.
//
// TODO antes de producción real: validar la firma (header x-signature) contra
// el "Secret de firma" del panel de MP, para confirmar que el webhook es
// legítimo y no un POST inventado por cualquiera que adivine esta URL.
exports.webhookMP = onRequest(
  { secrets: [MP_ACCESS_TOKEN], region: "southamerica-east1" },
  async (req, res) => {
    // Respondemos 200 enseguida en cualquier caso que no podamos procesar,
    // para no generar reintentos infinitos de Mercado Pago.
    try {
      const token = MP_ACCESS_TOKEN.value();
      const authHeaders = { "Authorization": `Bearer ${token}` };

      // Puede llegar como query params (notificación clásica: ?topic=payment&id=123
      // o ?topic=merchant_order&id=123) o como body JSON (formato más nuevo:
      // { type: "payment"|"order", data: { id: "..." } }).
      const topic = req.query.topic || req.body?.type || req.body?.topic;
      const resourceId = req.query.id || req.body?.data?.id || req.body?.resource;

      if (!topic || !resourceId) {
        logger.warn("Webhook sin topic/id reconocible", { query: req.query, body: req.body });
        res.status(200).send("ok");
        return;
      }

      let sesionId = null;
      let pagado = false;
      let monto = null;
      let mpId = String(resourceId);

      if (topic === "payment") {
        const r = await fetch(`https://api.mercadopago.com/v1/payments/${resourceId}`, { headers: authHeaders });
        const pago = await r.json();
        if (!r.ok) {
          logger.error("No se pudo consultar el pago", pago);
          res.status(200).send("ok");
          return;
        }
        sesionId = pago.external_reference;
        pagado = pago.status === "approved";
        monto = pago.transaction_amount;
      } else if (topic === "merchant_order") {
        const r = await fetch(`https://api.mercadopago.com/merchant_orders/${resourceId}`, { headers: authHeaders });
        const orden = await r.json();
        if (!r.ok) {
          logger.error("No se pudo consultar la merchant_order", orden);
          res.status(200).send("ok");
          return;
        }
        sesionId = orden.external_reference;
        const pagoAprobado = (orden.payments || []).find((p) => p.status === "approved");
        pagado = !!pagoAprobado;
        monto = orden.total_amount;
        if (pagoAprobado) mpId = String(pagoAprobado.id);
      } else if (topic === "order") {
        const r = await fetch(`https://api.mercadopago.com/v1/orders/${resourceId}`, { headers: authHeaders });
        const orden = await r.json();
        if (!r.ok) {
          logger.error("No se pudo consultar la orden", orden);
          res.status(200).send("ok");
          return;
        }
        sesionId = orden.external_reference;
        pagado = orden.status === "processed";
        monto = orden.total_amount;
      } else {
        // Otros topics (ej: point_integration_wh) no nos interesan.
        res.status(200).send("ok");
        return;
      }

      if (!sesionId) {
        logger.warn("Webhook sin external_reference reconocible", { topic, resourceId });
        res.status(200).send("ok");
        return;
      }

      if (pagado) {
        await db.collection("pagos").doc(sesionId).set({
          estado: "aprobado",
          mp_payment_id: mpId,
          monto: monto,
          updated_at: admin.firestore.Timestamp.now(),
        }, { merge: true });

        await db.collection("sesiones").doc(sesionId).update({
          estado: "pagado",
          updated_at: admin.firestore.Timestamp.now(),
        });

        logger.info("Pago confirmado por webhook", { sesionId, mpId, monto });
      }

      res.status(200).send("ok");
    } catch (err) {
      logger.error("Error procesando webhook de Mercado Pago", err);
      // Igual respondemos 200: si fue un error transitorio nuestro, preferimos
      // no acumular reintentos indefinidos; queda logueado para revisar.
      res.status(200).send("ok");
    }
  }
);
