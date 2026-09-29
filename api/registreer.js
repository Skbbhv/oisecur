// POST /api/registreer — zelf een proefaccount aanmaken (14 dagen).
// { bedrijf, naam, email, wachtwoord, branche, website }   (website = honeypot, moet leeg zijn)
// → { token, rol, naam, pnr, bedrijf }  (direct ingelogd, zelfde antwoord als /api/auth)
// Beveiliging tegen misbruik: max. 5 aanmeldingen per IP-adres per uur.
import { kv, hashWachtwoord, maakSessie, fout } from './_lib.js';

const BRANCHES = ['beveiliging', 'schoonmaak', 'facilitair', 'techniek', 'evenementen', 'overig'];
const PROEF_DAGEN = 14;

export default async function handler(req, res) {
  if (req.method !== 'POST') return fout(res, 405, 'Method not allowed');
  const b = req.body || {};

  // Bots vullen het verborgen veld "website" in: dan maken we niets aan.
  if (b.website) return fout(res, 400, 'Aanmelden is mislukt.');

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'onbekend').split(',')[0].trim();
  const teller = `registreer:ip:${ip}`;
  const pogingen = await kv.incr(teller);
  if (pogingen === 1) await kv.expire(teller, 3600);
  if (pogingen > 5) return fout(res, 429, 'Te veel aanmeldingen vanaf dit adres. Probeer het over een uur opnieuw.');

  const bedrijfsnaam = String(b.bedrijf || '').trim().slice(0, 80);
  const naam = String(b.naam || '').trim().slice(0, 80);
  const login = String(b.email || '').toLowerCase().trim();
  const wachtwoord = String(b.wachtwoord || '');
  const branche = BRANCHES.includes(b.branche) ? b.branche : 'beveiliging';

  if (!bedrijfsnaam || !naam || !login || !wachtwoord) return fout(res, 400, 'Vul alle velden in.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)) return fout(res, 400, 'Vul een geldig e-mailadres in.');
  if (wachtwoord.length < 8) return fout(res, 400, 'Wachtwoord: minimaal 8 tekens.');
  if (await kv.get(`user:${login}`)) return fout(res, 409, 'Er bestaat al een account met dit e-mailadres. Log in of vraag je beheerder om hulp.');

  // Bedrijfscode: letters uit de naam + 2 cijfers, uniek gemaakt.
  const basis = (bedrijfsnaam.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'OIS').slice(0, 5);
  let bid = '';
  for (let i = 0; i < 20 && !bid; i++) {
    const kandidaat = basis + String(Math.floor(Math.random() * 90) + 10);
    if (!(await kv.get(`bedrijf:${kandidaat}`))) bid = kandidaat;
  }
  if (!bid) return fout(res, 500, 'Kon geen bedrijfscode maken. Probeer het opnieuw.');

  const nu = new Date();
  const proefTot = new Date(nu.getTime() + PROEF_DAGEN * 864e5).toISOString().slice(0, 10);
  const bedrijf = { id: bid, naam: bedrijfsnaam, logo: '', plan: 'proef', branche, sinds: nu.toISOString(), proefTot, email: login };

  await kv.set(`bedrijf:${bid}`, bedrijf);
  await kv.sadd('bedrijven', bid);
  await kv.set(`bedrijf:${bid}:diensten`, [
    { naam: 'Dagdienst', van: '07:00', tot: '15:00' },
    { naam: 'Avonddienst', van: '15:00', tot: '23:00' },
    { naam: 'Nachtdienst', van: '23:00', tot: '07:00' }
  ]);
  await kv.set(`bedrijf:${bid}:objecten`, []);
  const { salt, hash } = hashWachtwoord(wachtwoord);
  await kv.set(`user:${login}`, { login, naam, pnr: '', rol: 'beheerder', bid, salt, hash, actief: true });
  await kv.sadd(`bedrijf:${bid}:users`, login);

  const token = await maakSessie(login, bid, 'beheerder');
  return res.status(200).json({
    token, rol: 'beheerder', naam, pnr: '',
    bedrijf: { id: bid, naam: bedrijfsnaam, logo: '', branche }
  });
}
