// POST /api/registreer — zelf een proefaccount aanmaken (14 dagen).
// { bedrijf, naam, email, wachtwoord, branche, website }   (website = honeypot, moet leeg zijn)
// → { token, rol, naam, pnr, bedrijf, oibaseBevestigen? }  (direct ingelogd, zelfde antwoord als /api/auth)
// Beveiliging tegen misbruik: max. 5 aanmeldingen per IP-adres per uur.
//
// GET /api/registreer?bevestig=<bid>&h=<hmac> — bevestigingslink uit de mail voor Oibase Enterprise-klanten.
//   Pas na bevestiging van het e-mailadres krijgt het bedrijf het gratis pakket 'oibase'.
import { kv, hashWachtwoord, maakSessie, fout, oibaseEnterprise, bevestigHash, veiligGelijk, stuurMail, escHtml, clientIp } from './_lib.js';

const BRANCHES = ['beveiliging', 'schoonmaak', 'facilitair', 'techniek', 'evenementen', 'overig'];
const PROEF_DAGEN = 14;

function pagina(res, code, titel, tekst, knop = true) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).send(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(titel)} — Oisecur</title><link rel="icon" href="/favicon.ico">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f6fb;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2937;padding:16px;box-sizing:border-box}
.k{background:#fff;max-width:480px;width:100%;border-radius:14px;padding:32px 28px;box-shadow:0 10px 30px rgba(13,36,86,.12);text-align:center}
h1{color:#0d2456;font-size:22px;margin:0 0 12px}p{line-height:1.55;margin:0 0 22px;color:#4b5563}
a{display:inline-block;background:#0d2456;color:#fff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:600}</style></head>
<body><div class="k"><h1>${escHtml(titel)}</h1><p>${escHtml(tekst)}</p>${knop ? '<a href="/app.html">Naar de app</a>' : ''}</div></body></html>`);
}

async function bevestig(req, res) {
  const bid = String(req.query.bevestig || '').toUpperCase();
  const h = String(req.query.h || '');
  const ongeldig = () => pagina(res, 400, 'Link ongeldig', 'Deze bevestigingslink is ongeldig of verlopen. Neem contact op met info@oisecur.nl als je hulp nodig hebt.');
  if (!/^[A-Z0-9]{1,12}$/.test(bid) || !/^[a-f0-9]{64}$/.test(h)) return ongeldig();
  const bedrijf = await kv.get(`bedrijf:${bid}`);
  if (!bedrijf || !bedrijf.email) return ongeldig();
  const verwacht = bevestigHash(bid, bedrijf.email);
  if (!verwacht || !veiligGelijk(h, verwacht)) return ongeldig();

  bedrijf.emailBevestigd = true;
  let gratis = bedrijf.plan === 'oibase';
  if (bedrijf.plan === 'proef' && (await oibaseEnterprise(bedrijf.email))) {
    bedrijf.plan = 'oibase'; delete bedrijf.proefTot; bedrijf.oibaseSinds = new Date().toISOString().slice(0, 10);
    gratis = true;
  }
  await kv.set(`bedrijf:${bid}`, bedrijf);
  return gratis
    ? pagina(res, 200, 'E-mailadres bevestigd', 'Je gebruikt Oisecur gratis via Oibase Enterprise.')
    : pagina(res, 200, 'E-mailadres bevestigd', 'Bedankt, je e-mailadres is bevestigd.');
}

export default async function handler(req, res) {
  if (req.method === 'GET' && req.query && req.query.bevestig) return bevestig(req, res);
  if (req.method !== 'POST') return fout(res, 405, 'Method not allowed');
  const b = req.body || {};

  // Bots vullen het verborgen veld "website" in: dan maken we niets aan.
  if (b.website) return fout(res, 400, 'Aanmelden is mislukt.');

  const ip = clientIp(req);
  const teller = `registreer:ip:${ip}`;
  const pogingen = await kv.incr(teller);
  if (pogingen === 1) await kv.expire(teller, 3600);
  if (pogingen > 5) return fout(res, 429, 'Te veel aanmeldingen vanaf dit adres. Probeer het over een uur opnieuw.');

  const bedrijfsnaam = String(b.bedrijf || '').trim().slice(0, 80);
  const naam = String(b.naam || '').trim().slice(0, 80);
  const login = String(b.email || '').toLowerCase().trim().slice(0, 200);
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
  // Klant van Oibase Enterprise? Dan pas gratis nadat het e-mailadres is bevestigd (zie GET ?bevestig=).
  const enterprise = await oibaseEnterprise(login);

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

  let oibaseBevestigen = false;
  if (enterprise) {
    const link = `https://oisecur.nl/api/registreer?bevestig=${encodeURIComponent(bid)}&h=${bevestigHash(bid, login)}`;
    try {
      oibaseBevestigen = await stuurMail({
        to: login, subject: 'Bevestig je e-mailadres voor gratis Oisecur via Oibase',
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;max-width:560px">` +
          `<p>Hallo ${escHtml(naam)},</p>` +
          `<p>Je hebt een Oisecur-account aangemaakt voor <b>${escHtml(bedrijfsnaam)}</b>. Omdat dit e-mailadres hoort bij een klant van Oibase Enterprise, kun je Oisecur gratis gebruiken.</p>` +
          `<p>Bevestig je e-mailadres om dit te activeren:</p>` +
          `<p><a href="${link}" style="display:inline-block;background:#0d2456;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">E-mailadres bevestigen</a></p>` +
          `<p style="color:#6b7280;font-size:12px">Heb je dit account niet zelf aangemaakt? Dan kun je deze mail negeren.</p></div>`
      });
    } catch { oibaseBevestigen = false; }
  }

  const token = await maakSessie(login, bid, 'beheerder');
  return res.status(200).json({
    token, rol: 'beheerder', naam, pnr: '',
    bedrijf: { id: bid, naam: bedrijfsnaam, logo: '', branche, plan: bedrijf.plan },
    ...(oibaseBevestigen ? { oibaseBevestigen: true } : {})
  });
}
