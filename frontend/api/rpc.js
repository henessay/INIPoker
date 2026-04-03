export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString();

  try {
    const response = await fetch('http://204.168.233.1:8545', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    });
    const text = await response.text();
    res.setHeader('Content-Type', 'application/json');
    res.status(200).end(text);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
