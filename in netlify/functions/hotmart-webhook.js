// netlify/functions/hotmart-webhook.js
// Webhook que recibe notificaciones de Hotmart y actualiza el acceso de suscriptoras de Luzia

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  // Solo aceptamos peticiones POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // 1. Verificar el Hottok (token secreto de Hotmart)
  const hottokRecibido = payload.hottok;
  const hottokEsperado = process.env.HOTMART_HOTTOK_LUZIA;

  if (!hottokRecibido || hottokRecibido !== hottokEsperado) {
    await supabase.from('webhook_log').insert({
      event_id: payload?.data?.purchase?.transaction || 'unknown',
      type: payload?.event || 'unknown',
      result: 'unauthorized'
    });
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const eventType = payload.event;
  const eventId = payload?.data?.purchase?.transaction || payload?.id || `${eventType}-${Date.now()}`;

  // 2. Chequear si ya procesamos este evento antes (idempotencia)
  const { data: existente } = await supabase
    .from('processed_events')
    .select('event_id')
    .eq('event_id', eventId)
    .maybeSingle();

  if (existente) {
    await supabase.from('webhook_log').insert({
      event_id: eventId,
      type: eventType,
      result: 'duplicate'
    });
    return { statusCode: 200, body: 'Already processed' };
  }

  // 3. Extraer datos del comprador
  const email = payload?.data?.buyer?.email;
  const transactionId = payload?.data?.purchase?.transaction;
  const subscriberCode = payload?.data?.subscription?.subscriber?.code || null;

  if (!email) {
    await supabase.from('webhook_log').insert({
      event_id: eventId,
      type: eventType,
      result: 'no_user'
    });
    return { statusCode: 200, body: 'No email in payload' };
  }

  let resultado = 'applied';

  try {
    // 4. Actualizar la tabla luzia_subscribers según el tipo de evento
    if (eventType === 'PURCHASE_APPROVED' || eventType === 'PURCHASE_COMPLETE') {
      await supabase.from('luzia_subscribers').upsert({
        email: email,
        estado: 'activo',
        hotmart_transaction_id: transactionId,
        hotmart_subscriber_code: subscriberCode,
        fecha_compra: new Date().toISOString(),
        fecha_activacion: new Date().toISOString()
      }, { onConflict: 'email' });

    } else if (eventType === 'PURCHASE_REFUNDED' || eventType === 'PURCHASE_CHARGEBACK') {
      await supabase.from('luzia_subscribers')
        .update({ estado: 'reembolsado', fecha_cancelacion: new Date().toISOString() })
        .eq('email', email);

    } else if (eventType === 'SUBSCRIPTION_CANCELLATION' || eventType === 'PURCHASE_CANCELED') {
      await supabase.from('luzia_subscribers')
        .update({ estado: 'cancelado', fecha_cancelacion: new Date().toISOString() })
        .eq('email', email);

    } else {
      resultado = 'illegal'; // evento que no manejamos, lo dejamos registrado igual
    }

    // 5. Marcar el evento como procesado (para idempotencia futura)
    await supabase.from('processed_events').insert({
      event_id: eventId,
      event_type: eventType
    });

    // 6. Dejar huella en el log
    await supabase.from('webhook_log').insert({
      event_id: eventId,
      type: eventType,
      result: resultado
    });

    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    await supabase.from('webhook_log').insert({
      event_id: eventId,
      type: eventType,
      result: 'error'
    });
    return { statusCode: 500, body: 'Internal error' };
  }
};
