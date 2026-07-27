// POST /api/create-order
// Creates a Cashfree order and stores a pending record in KV.
// Requires environment bindings (set in Cloudflare Pages dashboard):
//   CASHFREE_CLIENT_ID       (secret)
//   CASHFREE_CLIENT_SECRET   (secret)
//   CASHFREE_ENV             ("sandbox" or "production")
//   ORDERS                   (KV namespace binding)

function genOrderId(){
  const rand = crypto.randomUUID().replace(/-/g,'').slice(0,10);
  return `ketry_${Date.now()}_${rand}`;
}

function isValidPhone(p){ return /^[6-9]\d{9}$/.test(p); }
function isValidEmail(e){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function isValidPin(p){ return /^\d{6}$/.test(p); }

export async function onRequestPost(context){
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch(e){
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 });
  }

  const { name, phone, email, address, city, pin, amount } = body || {};

  // --- Server-side validation. Never trust the client for order amount. ---
  if(!name || typeof name !== 'string' || name.trim().length < 2){
    return new Response(JSON.stringify({ error: 'Please enter a valid name' }), { status: 400 });
  }
  if(!isValidPhone(phone || '')){
    return new Response(JSON.stringify({ error: 'Please enter a valid 10-digit Indian phone number' }), { status: 400 });
  }
  if(!isValidEmail(email || '')){
    return new Response(JSON.stringify({ error: 'Please enter a valid email address' }), { status: 400 });
  }
  if(!address || address.trim().length < 5){
    return new Response(JSON.stringify({ error: 'Please enter a valid address' }), { status: 400 });
  }
  if(!city || city.trim().length < 2){
    return new Response(JSON.stringify({ error: 'Please enter a valid city' }), { status: 400 });
  }
  if(!isValidPin(pin || '')){
    return new Response(JSON.stringify({ error: 'Please enter a valid 6-digit PIN code' }), { status: 400 });
  }

  // Order amount is fixed server-side — the client can send a hint but we
  // never trust it, otherwise someone could tamper the request to pay ₹1.
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
    order_meta: {
      return_url: returnUrl
    }
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
  } catch(e){
    return new Response(JSON.stringify({ error: 'Could not reach payment gateway. Please try again.' }), { status: 502 });
  }

  const cfData = await cfResponse.json();

  if(!cfResponse.ok || !cfData.payment_session_id){
    return new Response(JSON.stringify({
      error: 'Payment gateway rejected the order',
      details: cfData
    }), { status: 502 });
  }

  // Save a pending record so the webhook has something to update, and so
  // order-status polling works even before the webhook arrives.
  const record = {
    status: 'pending',
    customer: { name: name.trim(), phone: phone.trim(), email: email.trim(), address: address.trim(), city: city.trim(), pin: pin.trim() },
    amount: ORDER_AMOUNT,
    createdAt: Date.now(),
    code: null
  };
  await env.ORDERS.put(orderId, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 }); // 30 days

  return new Response(JSON.stringify({
    order_id: orderId,
    payment_session_id: cfData.payment_session_id
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
