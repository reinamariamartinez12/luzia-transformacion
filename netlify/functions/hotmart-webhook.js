// netlify/functions/hotmart-webhook.js
// Webhook que recibe notificaciones de Hotmart y actualiza el acceso de suscriptoras de Luzia
// Version sin librerias externas: usa fetch nativo para hablar con la API REST de Supabase

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function supabaseHeaders(extra = {}) {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function supabaseSelect(table, filterQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filterQuery}`, {
    headers: supabaseHeaders()
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.length > 0 ? data[0] : null;
}

async function supabaseInsert(table, row) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(row)
  });
}

async function supabaseUpsert(table, row, conflictColumn) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row)
  });
}

async function supabaseUpdateByEmail(table, email, changes) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: supabaseHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(changes)
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const hottokRecibido = payload.hottok;
  const hottokEsperado = process.env.HOTMART_HOTTOK_LUZIA;

  if (!hottokRecibido || hottokRecibido !== hottokEsperado) {
    await supabaseInsert('webhook_log', {
      event_id: payload?.data?.purchase?.transaction || 'unknown',
      type: payload?.event || 'unknown',
      result: 'unauthorized',
      received_at: new Date().toISOString()
    });
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const eventType = payload.event;
  const eventId = payload?.data?.purchase?.transaction || payload?.id || `${eventType}-${Date.now()}`;

  const existente = await supabaseSelect('processed_events', `event_id=eq.${encodeURIComponent(eventId)}&select=event_id`);

  if (existente) {
    await supabaseInsert('webhook_log', {
      event_id: eventId,
      type: eventType,
      result: 'duplicate',
      received_at: new Date().toISOString()
    });
    return { statusCode: 200, body: 'Already processed' };
  }

  const email = payload?.data?.buyer?.email;
  const transactionId = payload?.data?.purchase?.transaction;
  const subscriberCode = payload?.data?.subscription?.subscriber?.code || null;

  if (!email) {
    await supabaseInsert('webhook_log', {
      event_id: eventId,
      type: eventType,
      result: 'no_user',
      received_at: new Date().toISOString()
    });
    return { statusCode: 200, body: 'No email in payload' };
  }

  let resultado = 'applied';

  try {
    if (eventType === 'PURCHASE_APPROVED' || eventType === 'PURCHASE_COMPLETE') {
      await supabaseUpsert('luzia_subscribers', {
        email: email,
        estado: 'activo',
        hotmart_transaction_id: transactionId,
        hotmart_subscriber_code: subscriberCode,
        fecha_compra: new Date().toISOString(),
        fecha_activacion: new Date().toISOString()
      }, 'email');

    } else if (eventType === 'PURCHASE_REFUNDED' || eventType === 'PURCHASE_CHARGEBACK') {
      await supabaseUpdateByEmail('luzia_subscribers', email, {
        estado: 'reembolsado',
        fecha_cancelacion: new Date().toISOString()
      });

    } else if (eventType === 'SUBSCRIPTION_CANCELLATION' || eventType === 'PURCHASE_CANCELED') {
      await supabaseUpdateByEmail('luzia_subscribers', email, {
        estado: 'cancelado',
        fecha_cancelacion: new Date().toISOString()
      });

    } else {
      resultado = 'illegal';
    }

    await supabaseInsert('processed_events', {
      event_id: eventId,
      event_type: eventType
    });

    await supabaseInsert('webhook_log', {
      event_id: eventId,
      type: eventType,
      result: resultado,
      received_at: new Date().toISOString()
    });

    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    await supabaseInsert('webhook_log', {
      event_id: eventId,
      type: eventType,
      result: 'error',
      received_at: new Date().toISOString()
    });
    return { statusCode: 500, body: 'Internal error' };
  }
};
