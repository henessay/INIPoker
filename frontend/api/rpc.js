export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const response = await fetch('http://204.168.233.1:8545', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    });
    const data = await response.text();
    res.setHeader('Content-Type', 'application/json');
    res.status(200).end(data);
  } catch (err) {
    res.status(502).json({ jsonrpc: '2.0', error: { code: -32000, message: err.message }, id: null });
  }
}
