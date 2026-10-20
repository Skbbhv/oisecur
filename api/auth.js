// POST /api/auth  { actie:'login', gebruiker, wachtwoord }  →  { token, rol, naam, pnr, bedrijf }
//                { actie:'uitloggen' } met Authorization-header
import { kv, controleerWachtwoord, maakSessie, fout, synchroniseerOibase } from './_lib.js';

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

  // Bescherming tegen wachtwoorden raden: max. 8 foute pogingen per account en 30 per IP-adres per 15 minuten
  const login = gebruiker.toLowerCase().trim();
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'onbekend').split(',')[0].trim();
  const fAcc = `login:fout:acc:${login}`, fIp = `login:fout:ip:${ip}`;
  const [nAcc, nIp] = await Promise.all([kv.get(fAcc), kv.get(fIp)]);
  if (Number(nAcc) >= 8 || Number(nIp) >= 30)
    return fout(res, 429, 'Te veel mislukte pogingen. Probeer het over 15 minuten opnieuw.');

  const user = await kv.get(`user:${login}`);
  if (!user || user.actief === false || !controleerWachtwoord(wachtwoord, user.salt, user.hash)) {
    for (const k of [fAcc, fIp]) { const n = await kv.incr(k); if (n === 1) await kv.expire(k, 15 * 60); }
    return fout(res, 401, 'Onjuiste gebruikersnaam of wachtwoord.');
  }
  await kv.del(fAcc);

  let bedrijf = await kv.get(`bedrijf:${user.bid}`);
  if (!bedrijf) return fout(res, 401, 'Bedrijf niet gevonden.');
  bedrijf = await synchroniseerOibase(bedrijf);   // Oibase Enterprise = Oisecur gratis
  if (bedrijf.geblokkeerd)
    return fout(res, 403, 'Dit account is tijdelijk geblokkeerd. Neem contact op met info@oisecur.nl.');
  if (bedrijf.plan === 'proef' && bedrijf.proefTot && bedrijf.proefTot < new Date().toISOString().slice(0, 10))
    return fout(res, 403, 'Je gratis proefperiode is afgelopen. Mail naar info@oisecur.nl om verder te gaan; je rapporten blijven bewaard.');

  const token = await maakSessie(user.login, user.bid, user.rol);
  return res.status(200).json({
    token, rol: user.rol, naam: user.naam, pnr: user.pnr || '',
    bedrijf: { id: bedrijf.id, naam: bedrijf.naam, logo: bedrijf.logo || '', branche: bedrijf.branche || 'beveiliging' }
  });
}
