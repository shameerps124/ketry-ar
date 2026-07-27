// POST /api/cashfree-webhook
// Receives payment status webhooks from Cashfree. MUST verify the signature
// before trusting anything in the body — otherwise anyone who finds this URL
// could forge a "payment succeeded" event and get free codes.
//
// Per Cashfree's official docs (cashfree.com/docs/api-reference/vrs/webhook-signature-verification):
//   1. Take the x-webhook-timestamp header
//   2. Concatenate: timestamp + raw request body (exact bytes, not re-serialized JSON)
//   3. HMAC-SHA256 that string using your client secret
//   4. Base64-encode the result
//   5. Compare to the x-webhook-signature header
//
// Requires environment bindings:
//   CASHFREE_CLIENT_SECRET   (secret — same one used for order creation)
//   ORDERS                   (KV namespace)
//   CODES                    (KV namespace)

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O, avoid confusion
const MAX_DEVICES = 3;

function randomDigits(n){
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes).map(b => b % 10).join('');
}
function checkLetter(digits){
  let sum = 0;
  for(let i=0;i<digits.length;i++) sum += parseInt(digits[i],10) * (i+3);
  return CODE_LETTERS[sum % CODE_LETTERS.length];
}
async function generateUniqueCode(env){
  for(let attempt=0; attempt<10; attempt++){
    const digits = randomDigits(4);
    const code = `KETRY-${digits}-${checkLetter(digits)}`;
    const existing = await env.CODES.get(code);
    if(!existing) return code;
  }
  throw new Error('Could not generate a unique code after 10 attempts');
}

async function verifySignature(rawBody, timestamp, signatureHeader, secret){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const signed = await crypto.subtle.sign('HMAC', key, enc.encode(timestamp + rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(signed)));
  // Constant-time-ish comparison
  if(computed.length !== signatureHeader.length) return false;
  let diff = 0;
  for(let i=0;i<computed.length;i++) diff |= computed.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost(context){
  const { request, env } = context;

  const rawBody = await request.text();
  const signature = request.headers.get('x-webhook-signature');
  const timestamp = request.headers.get('x-webhook-timestamp');

  if(!signature || !timestamp){
    return new Response('Missing signature headers', { status: 400 });
  }

  const valid = await verifySignature(rawBody, timestamp, signature, env.CASHFREE_CLIENT_SECRET);
  if(!valid){
    return new Response('Invalid signature', { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch(e){
    return new Response('Invalid JSON', { status: 400 });
  }

  const eventType = payload.type;
  const orderId = payload.data && payload.data.order && payload.data.order.order_id;

  if(!orderId){
    return new Response('Missing order_id', { status: 400 });
  }

  const existingRaw = await env.ORDERS.get(orderId);
  if(!existingRaw){
    // Unknown order — could be a replay or a test event. Acknowledge but do nothing.
    return new Response('OK (unknown order)', { status: 200 });
  }
  const order = JSON.parse(existingRaw);

  if(eventType === 'PAYMENT_SUCCESS_WEBHOOK' || eventType === 'PAYMENT_SUCCESS'){
    // Idempotency: if we've already generated a code for this order
    // (webhook can be delivered more than once), don't generate a second one.
    if(order.status !== 'paid'){
      const code = await generateUniqueCode(env);
      await env.CODES.put(code, JSON.stringify({
        devices: [],
        maxDevices: MAX_DEVICES,
        orderId,
        createdAt: Date.now()
      }));
      order.status = 'paid';
      order.code = code;
      order.paidAt = Date.now();
      await env.ORDERS.put(orderId, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 365 });
    }
  } else if(eventType === 'PAYMENT_FAILED_WEBHOOK' || eventType === 'PAYMENT_FAILED'){
    order.status = 'failed';
    await env.ORDERS.put(orderId, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  return new Response('OK', { status: 200 });
}
