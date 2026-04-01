export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', proxy: 'INIPoker RPC' });
  }

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const response = await fetch('http://204.168.233.1/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    });
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({
      jsonrpc: '2.0',
      id: req.body?.id || 1,
      error: { code: -32000, message: 'RPC proxy error: ' + err.message }
    });
  }
}
