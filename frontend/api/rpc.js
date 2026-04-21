// Vercel serverless proxy to the INIPoker MiniEVM RPC.
// Backend URL can be overridden with env var RPC_BACKEND in Vercel Dashboard;
// defaults to the current VPS IP for the hackathon deploy.
const RPC_BACKEND = process.env.RPC_BACKEND || 'http://204.168.233.1:8545';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // CRITICAL: RPC responses MUST NOT be cached anywhere. Stale eth_call reads
  // cause client-client desync (one sees handId=N+1 while the other still sees
  // handId=N). These headers cover browser, Vercel edge, and any upstream CDN.
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate, private');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const response = await fetch(RPC_BACKEND, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache',
      },
      body: body,
      // Node's fetch: never reuse cached response from upstream.
      cache: 'no-store',
    });
    const data = await response.text();
    res.setHeader('Content-Type', 'application/json');
    res.status(200).end(data);
  } catch (err) {
    res.status(502).json({ jsonrpc: '2.0', error: { code: -32000, message: err.message }, id: null });
  }
}
