// POST /api/auth  { actie:'login', gebruiker, wachtwoord }  →  { token, rol, naam, pnr, bedrijf }
//                { actie:'uitloggen' } met Authorization-header
import { kv, controleerWachtwoord, maakSessie, fout } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return fout(res, 405, 'Method not allowed');
  const { actie, gebruiker, wachtwoord } = req.body || {};

  if (actie === 'uitloggen') {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (token) await kv.del(`sessie:${token}`);
    return res.status(200).json({ ok: true });
  }

  if (actie !== 'login' || !gebruiker || !wachtwoord)
    return fout(res, 400, 'Ontbrekende velden');

  const user = await kv.get(`user:${gebruiker.toLowerCase().trim()}`);
  if (!user || user.actief === false || !controleerWachtwoord(wachtwoord, user.salt, user.hash))
    return fout(res, 401, 'Onjuiste gebruikersnaam of wachtwoord.');

  const bedrijf = await kv.get(`bedrijf:${user.bid}`);
  if (!bedrijf) return fout(res, 401, 'Bedrijf niet gevonden.');

  const token = await maakSessie(user.login, user.bid, user.rol);
  return res.status(200).json({
    token, rol: user.rol, naam: user.naam, pnr: user.pnr || '',
    bedrijf: { id: bedrijf.id, naam: bedrijf.naam, logo: bedrijf.logo || '' }
  });
}
