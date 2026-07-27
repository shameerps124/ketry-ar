// POST /api/redeem
// Body: { code: "KETRY-1234-A", deviceToken: "<uuid>" }
// Enforces the family device limit (default 3) per code.
//
// Requires: CODES (KV namespace)

function normalizeCode(raw){
  return (raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

export async function onRequestPost(context){
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch(e){
    return new Response(JSON.stringify({ ok: false, message: 'Invalid request' }), { status: 400 });
  }

  const code = normalizeCode(body.code);
  const deviceToken = (body.deviceToken || '').trim();

  if(!code || !/^KETRY-\d{4}-[A-Z]$/.test(code)){
    return new Response(JSON.stringify({ ok: false, message: "That code doesn't look right — check the card inside your box." }), { status: 200 });
  }
  if(!deviceToken){
    return new Response(JSON.stringify({ ok: false, message: 'Missing device identifier' }), { status: 400 });
  }

  const raw = await env.CODES.get(code);
  if(!raw){
    return new Response(JSON.stringify({ ok: false, message: 'This code was not found. Please check it and try again.' }), { status: 200 });
  }

  const record = JSON.parse(raw);

  // Already-registered device on this code: allow silently (e.g. re-entering
  // the same code after clearing site data doesn't consume a slot twice for
  // a token we've already seen — though in practice a fully-cleared browser
  // will have generated a new token anyway; this mainly protects rapid
  // duplicate submissions).
  if(record.devices.includes(deviceToken)){
    return new Response(JSON.stringify({
      ok: true,
      message: 'Welcome back!',
      slotsUsed: record.devices.length,
      maxDevices: record.maxDevices
    }), { status: 200 });
  }

  if(record.devices.length >= record.maxDevices){
    return new Response(JSON.stringify({
      ok: false,
      message: `This code has reached its limit of ${record.maxDevices} family devices. Contact us if you need help.`
    }), { status: 200 });
  }

  record.devices.push(deviceToken);
  await env.CODES.put(code, JSON.stringify(record));

  return new Response(JSON.stringify({
    ok: true,
    message: 'Unlocked!',
    slotsUsed: record.devices.length,
    maxDevices: record.maxDevices
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
