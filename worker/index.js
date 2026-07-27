// Single Worker entry point for the new unified Cloudflare Workers + Static
// Assets model. Replaces the old functions/api/*.js file-based routing,
// which only worked on classic Cloudflare Pages, not this project type.
//
// Static files (index.html, ar.html, assets/, etc.) are served automatically
// via the ASSETS binding for any request that isn't matched below.
//
// Required bindings/env vars (Cloudflare dashboard → Settings/Bindings):
//   ASSETS                   (static assets binding, configured in wrangler.jsonc)
//   ORDERS, CODES             (KV namespaces)
//   CASHFREE_CLIENT_ID        (secret)
//   CASHFREE_CLIENT_SECRET    (secret)
//   CASHFREE_ENV              ("sandbox" or "production")

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O, avoid confusion
const MAX_DEVICES = 3;

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ---------- POST /api/create-order ----------
function genOrderId() {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  return `ketry_${Date.now()}_${rand}`;
}
function isValidPhone(p) { return /^[6-9]\d{9}$/.test(p); }
function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function isValidPin(p) { return /^\d{6}$/.test(p); }

async function handleCreateOrder(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const { name, phone, email, address, city, pin } = body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return jsonResponse({ error: 'Please enter a valid name' }, 400);
  }
  if (!isValidPhone(phone || '')) {
    return jsonResponse({ error: 'Please enter a valid 10-digit Indian phone number' }, 400);
  }
  if (!isValidEmail(email || '')) {
    return jsonResponse({ error: 'Please enter a valid email address' }, 400);
  }
  if (!address || address.trim().length < 5) {
    return jsonResponse({ error: 'Please enter a valid address' }, 400);
  }
  if (!city || city.trim().length < 2) {
    return jsonResponse({ error: 'Please enter a valid city' }, 400);
  }
  if (!isValidPin(pin || '')) {
    return jsonResponse({ error: 'Please enter a valid 6-digit PIN code' }, 400);
  }

  const ORDER_AMOUNT = 499.00;
  const ORDER_CURRENCY = 'INR';
  const orderId = genOrderId();
  const cashfreeBase = env.CASHFREE_ENV === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';

  const returnUrl = `${new URL(request.url).origin}/order-status.html?order_id=${orderId}`;

  const cfPayload = {
    order_id: orderId,
    order_amount: ORDER_AMOUNT,
    order_currency: ORDER_CURRENCY,
    customer_details: {
      customer_id: `cust_${orderId}`,
      customer_name: name.trim(),
      customer_email: email.trim(),
      customer_phone: phone.trim()
    },
    order_meta: { return_url: returnUrl }
  };

  let cfResponse;
  try {
    cfResponse = await fetch(`${cashfreeBase}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': env.CASHFREE_CLIENT_ID,
        'x-client-secret': env.CASHFREE_CLIENT_SECRET,
        'x-api-version': '2023-08-01'
      },
      body: JSON.stringify(cfPayload)
    });
  } catch (e) {
    return jsonResponse({ error: 'Could not reach payment gateway. Please try again.' }, 502);
  }

  const cfData = await cfResponse.json();

  if (!cfResponse.ok || !cfData.payment_session_id) {
    return jsonResponse({ error: 'Payment gateway rejected the order', details: cfData }, 502);
  }

  const record = {
    status: 'pending',
    customer: { name: name.trim(), phone: phone.trim(), email: email.trim(), address: address.trim(), city: city.trim(), pin: pin.trim() },
    amount: ORDER_AMOUNT,
    createdAt: Date.now(),
    code: null
  };
  await env.ORDERS.put(orderId, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 });

  return jsonResponse({ order_id: orderId, payment_session_id: cfData.payment_session_id });
}

// ---------- POST /api/cashfree-webhook ----------
function randomDigits(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes).map(b => b % 10).join('');
}
function checkLetter(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += parseInt(digits[i], 10) * (i + 3);
  return CODE_LETTERS[sum % CODE_LETTERS.length];
}
async function generateUniqueCode(env) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const digits = randomDigits(4);
    const code = `KETRY-${digits}-${checkLetter(digits)}`;
    const existing = await env.CODES.get(code);
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique code after 10 attempts');
}
async function verifySignature(rawBody, timestamp, signatureHeader, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signed = await crypto.subtle.sign('HMAC', key, enc.encode(timestamp + rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(signed)));
  if (computed.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

async function handleWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-webhook-signature');
  const timestamp = request.headers.get('x-webhook-timestamp');

  if (!signature || !timestamp) {
    return new Response('Missing signature headers', { status: 400 });
  }

  const valid = await verifySignature(rawBody, timestamp, signature, env.CASHFREE_CLIENT_SECRET);
  if (!valid) {
    return new Response('Invalid signature', { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return new Response('Invalid JSON', { status: 400 });
  }

  const eventType = payload.type;
  const orderId = payload.data && payload.data.order && payload.data.order.order_id;
  if (!orderId) {
    return new Response('Missing order_id', { status: 400 });
  }

  const existingRaw = await env.ORDERS.get(orderId);
  if (!existingRaw) {
    return new Response('OK (unknown order)', { status: 200 });
  }
  const order = JSON.parse(existingRaw);

  if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' || eventType === 'PAYMENT_SUCCESS') {
    if (order.status !== 'paid') {
      const code = await generateUniqueCode(env);
      await env.CODES.put(code, JSON.stringify({
        devices: [], maxDevices: MAX_DEVICES, orderId, createdAt: Date.now()
      }));
      order.status = 'paid';
      order.code = code;
      order.paidAt = Date.now();
      await env.ORDERS.put(orderId, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 365 });
    }
  } else if (eventType === 'PAYMENT_FAILED_WEBHOOK' || eventType === 'PAYMENT_FAILED') {
    order.status = 'failed';
    await env.ORDERS.put(orderId, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  return new Response('OK', { status: 200 });
}

// ---------- GET /api/order-status ----------
async function handleOrderStatus(request, env) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get('order_id');
  if (!orderId) {
    return jsonResponse({ error: 'Missing order_id' }, 400);
  }
  const raw = await env.ORDERS.get(orderId);
  if (!raw) {
    return jsonResponse({ status: 'not_found' }, 404);
  }
  const order = JSON.parse(raw);
  return jsonResponse({
    status: order.status,
    code: order.status === 'paid' ? order.code : null
  });
}

// ---------- POST /api/redeem ----------
function normalizeCode(raw) {
  return (raw || '').trim().toUpperCase().replace(/\s+/g, '');
}
async function handleRedeem(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, message: 'Invalid request' }, 400);
  }

  const code = normalizeCode(body.code);
  const deviceToken = (body.deviceToken || '').trim();

  if (!code || !/^KETRY-\d{4}-[A-Z]$/.test(code)) {
    return jsonResponse({ ok: false, message: "That code doesn't look right — check the card inside your box." });
  }
  if (!deviceToken) {
    return jsonResponse({ ok: false, message: 'Missing device identifier' }, 400);
  }

  const raw = await env.CODES.get(code);
  if (!raw) {
    return jsonResponse({ ok: false, message: 'This code was not found. Please check it and try again.' });
  }

  const record = JSON.parse(raw);

  if (record.devices.includes(deviceToken)) {
    return jsonResponse({ ok: true, message: 'Welcome back!', slotsUsed: record.devices.length, maxDevices: record.maxDevices });
  }

  if (record.devices.length >= record.maxDevices) {
    return jsonResponse({ ok: false, message: `This code has reached its limit of ${record.maxDevices} family devices. Contact us if you need help.` });
  }

  record.devices.push(deviceToken);
  await env.CODES.put(code, JSON.stringify(record));

  return jsonResponse({ ok: true, message: 'Unlocked!', slotsUsed: record.devices.length, maxDevices: record.maxDevices });
}

// ---------- Router ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/api/create-order' && request.method === 'POST') {
        return await handleCreateOrder(request, env);
      }
      if (url.pathname === '/api/cashfree-webhook' && request.method === 'POST') {
        return await handleWebhook(request, env);
      }
      if (url.pathname === '/api/order-status' && request.method === 'GET') {
        return await handleOrderStatus(request, env);
      }
      if (url.pathname === '/api/redeem' && request.method === 'POST') {
        return await handleRedeem(request, env);
      }
    } catch (err) {
      return jsonResponse({ error: 'Internal error', message: String(err && err.message || err) }, 500);
    }

    // Anything else (index.html, ar.html, assets/*, etc.) — serve as a static file.
    return env.ASSETS.fetch(request);
  }
};
