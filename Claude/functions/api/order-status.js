// GET /api/order-status?order_id=xxx
// Frontend polls this after returning from Cashfree checkout, since the
// webhook (which actually generates the code) may arrive a moment after
// the browser redirect does.
//
// Requires: ORDERS (KV namespace)

export async function onRequestGet(context){
  const { request, env } = context;
  const url = new URL(request.url);
  const orderId = url.searchParams.get('order_id');

  if(!orderId){
    return new Response(JSON.stringify({ error: 'Missing order_id' }), { status: 400 });
  }

  const raw = await env.ORDERS.get(orderId);
  if(!raw){
    return new Response(JSON.stringify({ status: 'not_found' }), { status: 404 });
  }

  const order = JSON.parse(raw);

  // Only return what the frontend actually needs — never leak the full
  // customer record (address etc.) back over a public polling endpoint.
  return new Response(JSON.stringify({
    status: order.status,
    code: order.status === 'paid' ? order.code : null
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
