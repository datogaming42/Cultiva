const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

const ALLOWED_ORIGINS = new Set([
  'https://datogaming42.github.io',
  'https://cultiva-hazel.vercel.app',
  'https://cultiva-sahbibi.vercel.app',
  'https://cultiva-git-main-sahbibi.vercel.app',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
]);

function allowCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.has(origin);
  if (allowed) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  return allowed;
}

function rateLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const current = hits.get(ip);
  if (!current || now - current.start > WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= MAX_PER_WINDOW;
}

function clean(value, max = 700) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

module.exports = async function handler(req, res) {
  const corsOk = allowCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsOk ? 204 : 403).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!corsOk) return res.status(403).json({ error: 'Origin not allowed' });
  if (!rateLimit(req)) return res.status(429).json({ error: 'Too many requests' });

  const cat = clean(req.body?.cat, 80);
  const question = clean(req.body?.question, 600);
  const correct = clean(req.body?.correct, 300);
  const note = clean(req.body?.note, 700);
  if (!cat || !question || !correct) return res.status(400).json({ error: 'Invalid payload' });

  const token = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
  if (!token) return res.status(503).json({ error: 'AI Gateway is not configured' });

  const system = [
    'Tu es le module Deep Dive de Cultiva, une app française de culture générale.',
    'Ta réponse doit apporter un fait complémentaire SPECIFIQUE au sujet exact de la question, jamais un conseil d’apprentissage général.',
    'Réponds en français en exactement 2 phrases, environ 35 à 70 mots au total.',
    'La première phrase doit contenir un ancrage factuel concret : date, nombre, nom propre, lieu, œuvre, mécanisme précis, exemple réel ou conséquence directement vérifiable.',
    'La seconde phrase explique brièvement pourquoi ce détail éclaire la question ou le concept.',
    'Le détail choisi doit être différent de la bonne réponse et de l’explication déjà affichée.',
    'Interdiction des formulations vagues ou métapédagogiques comme « relie ce repère », « regarde le contexte », « cela aide à comprendre », « pense à » ou « demande-toi ».',
    'N’invente ni date, ni chiffre, ni citation. Si un point est discuté, formule la nuance explicitement plutôt que de trancher.',
    'Pas de markdown, pas de question à l’utilisateur, pas d’introduction du type « Le saviez-vous ? ».'
  ].join(' ');

  const user = [
    `Catégorie : ${cat}`,
    `Question : ${question}`,
    `Bonne réponse : ${correct}`,
    `Explication déjà affichée : ${note || '(aucune)'}`,
    'Ajoute maintenant UN fait complémentaire concret, spécifique à ce sujet, puis explique sa pertinence en une seconde phrase.'
  ].join('\n');

  try {
    const gateway = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-5.6-sol',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        max_completion_tokens: 220
      })
    });

    const data = await gateway.json().catch(() => ({}));
    if (!gateway.ok) {
      console.error('AI Gateway error', gateway.status, data?.error?.message || data?.error || 'unknown');
      return res.status(502).json({ error: 'AI provider error' });
    }

    const deepDive = clean(data?.choices?.[0]?.message?.content, 1200);
    if (!deepDive) return res.status(502).json({ error: 'Empty AI response' });
    return res.status(200).json({ deepDive });
  } catch (error) {
    console.error('Deep dive error', error);
    return res.status(502).json({ error: 'AI request failed' });
  }
};
