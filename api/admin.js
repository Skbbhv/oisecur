// Alleen voor jou (Oisecur zelf): bedrijven aanmaken en bekijken.
// Beveiligd met de environment variable OISECUR_ADMIN_KEY (zelf instellen in Vercel).
// GET  /api/admin  (header x-admin-key)                → lijst van bedrijven
// POST /api/admin  { id, naam, beheerderNaam, login, wachtwoord, plan }
import { kv, hashWachtwoord, fout } from './_lib.js';

export default async function handler(req, res) {
  const key = req.headers['x-admin-key'];
  if (!process.env.OISECUR_ADMIN_KEY || key !== process.env.OISECUR_ADMIN_KEY)
    return fout(res, 401, 'Ongeldige beheersleutel.');

  if (req.method === 'GET') {
    const bids = await kv.smembers('bedrijven');
    const bedrijven = bids.length ? await Promise.all(bids.map(b => kv.get(`bedrijf:${b}`))) : [];
    const met = await Promise.all(bids.map(async b => ({
      bid: b, users: (await kv.smembers(`bedrijf:${b}:users`)).length,
      rapporten: await kv.llen(`bedrijf:${b}:rapporten`)
    })));
    return res.status(200).json({ bedrijven: bedrijven.filter(Boolean), statistiek: met });
  }

  if (req.method !== 'POST') return fout(res, 405, 'Method not allowed');
  const b = req.body || {};
  const bid = String(b.id || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const login = String(b.login || '').toLowerCase().trim();
  if (!bid || !b.naam || !b.beheerderNaam || !login || !b.wachtwoord)
    return fout(res, 400, 'Alle velden zijn verplicht.');
  if (b.wachtwoord.length < 8) return fout(res, 400, 'Wachtwoord: minimaal 8 tekens.');
  if (await kv.get(`bedrijf:${bid}`)) return fout(res, 409, 'Bedrijfscode bestaat al.');
  if (await kv.get(`user:${login}`)) return fout(res, 409, 'Deze login bestaat al.');

  await kv.set(`bedrijf:${bid}`, { id: bid, naam: b.naam, logo: '', plan: b.plan || 'pro', sinds: new Date().toISOString() });
  await kv.sadd('bedrijven', bid);
  await kv.set(`bedrijf:${bid}:diensten`, [
    { naam: 'Dagdienst',   van: '07:00', tot: '15:00' },
    { naam: 'Avonddienst', van: '15:00', tot: '23:00' },
    { naam: 'Nachtdienst', van: '23:00', tot: '07:00' }
  ]);
  await kv.set(`bedrijf:${bid}:objecten`, []);
  const { salt, hash } = hashWachtwoord(b.wachtwoord);
  await kv.set(`user:${login}`, { login, naam: b.beheerderNaam, pnr: '', rol: 'beheerder', bid, salt, hash, actief: true });
  await kv.sadd(`bedrijf:${bid}:users`, login);
  return res.status(200).json({ ok: true, bid });
}
