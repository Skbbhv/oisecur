// Alleen voor Oisecur zelf: klantbedrijven beheren.
// Beveiligd met de environment variable OISECUR_ADMIN_KEY (zelf instellen in Vercel).
//
// GET  /api/admin                                  → { bedrijven:[...met statistiek] }
// POST /api/admin { id, naam, beheerderNaam, login, wachtwoord, plan, branche }   → nieuw bedrijf (zoals voorheen)
// POST /api/admin { actie:'detail',     bid }                     → { bedrijf, gebruikers, rapporten, objecten }
// POST /api/admin { actie:'plan',       bid, plan }                → pakket wijzigen (proef/starter/pro/business)
// POST /api/admin { actie:'proef',      bid, dagen }               → proefperiode verlengen
// POST /api/admin { actie:'blokkeer',   bid, aan:true|false }      → inloggen blokkeren / toestaan
// POST /api/admin { actie:'wachtwoord', bid, login, wachtwoord }   → wachtwoord van een gebruiker resetten
// POST /api/admin { actie:'notitie',    bid, notitie }             → eigen notitie bij het bedrijf
// POST /api/admin { actie:'verwijder',  bid, bevestig:bid }        → bedrijf met ALLE gegevens verwijderen
import { kv, hashWachtwoord, fout } from './_lib.js';

const PLANS = ['proef', 'starter', 'pro', 'business'];
const BRANCHES = ['beveiliging', 'schoonmaak', 'facilitair', 'techniek', 'evenementen', 'overig'];
const vandaag = () => new Date().toISOString().slice(0, 10);

async function statistiek(bid) {
  const [logins, aantal, laatste] = await Promise.all([
    kv.smembers(`bedrijf:${bid}:users`),
    kv.llen(`bedrijf:${bid}:rapporten`),
    kv.lrange(`bedrijf:${bid}:rapporten`, 0, 0)
  ]);
  const users = (await Promise.all(logins.map(l => kv.get(`user:${l}`)))).filter(Boolean);
  const beheerder = users.find(u => u.rol === 'beheerder');
  let laatsteRapport = '';
  if (laatste && laatste[0]) {
    const r = await kv.get(`rapport:${bid}:${laatste[0]}`);
    laatsteRapport = r ? (r.aangemaakt || r.datum || '') : '';
  }
  return { users: users.length, rapporten: aantal, laatsteRapport,
    beheerder: beheerder ? { naam: beheerder.naam, login: beheerder.login } : null };
}

export default async function handler(req, res) {
  const key = req.headers['x-admin-key'];
  if (!process.env.OISECUR_ADMIN_KEY || key !== process.env.OISECUR_ADMIN_KEY)
    return fout(res, 401, 'Ongeldige beheersleutel.');

  if (req.method === 'GET') {
    const bids = await kv.smembers('bedrijven');
    const lijst = await Promise.all(bids.map(async bid => {
      const b = await kv.get(`bedrijf:${bid}`);
      if (!b) return null;
      const { logo, ...zonderLogo } = b;
      return { ...zonderLogo, heeftLogo: !!logo, ...(await statistiek(bid)) };
    }));
    // Ook het oude formaat meesturen, voor de zekerheid
    const bedrijven = lijst.filter(Boolean);
    return res.status(200).json({ bedrijven, statistiek: bedrijven.map(b => ({ bid: b.id, users: b.users, rapporten: b.rapporten })), vandaag: vandaag() });
  }

  if (req.method !== 'POST') return fout(res, 405, 'Method not allowed');
  const b = req.body || {};

  /* ── Acties op een bestaand bedrijf ── */
  if (b.actie) {
    const bid = String(b.bid || '').toUpperCase();
    const bedrijf = await kv.get(`bedrijf:${bid}`);
    if (!bedrijf) return fout(res, 404, 'Bedrijf niet gevonden.');

    if (b.actie === 'detail') {
      const logins = await kv.smembers(`bedrijf:${bid}:users`);
      const gebruikers = (await Promise.all(logins.map(l => kv.get(`user:${l}`)))).filter(Boolean)
        .map(u => ({ naam: u.naam, login: u.login, rol: u.rol, pnr: u.pnr || '' }));
      const nummers = (await kv.lrange(`bedrijf:${bid}:rapporten`, 0, 19)) || [];
      const rapporten = (await Promise.all(nummers.map(n => kv.get(`rapport:${bid}:${n}`)))).filter(Boolean)
        .map(r => ({ nummer: r.nummer, type: r.type, naam: r.naam, object: r.object, datum: r.datum }));
      const objecten = ((await kv.get(`bedrijf:${bid}:objecten`)) || [])
        .map(o => ({ naam: o.naam, email: o.email || '', checkpoints: (o.checkpoints || []).length, portaal: !!o.portaal }));
      const { logo, ...rest } = bedrijf;
      return res.status(200).json({ bedrijf: { ...rest, heeftLogo: !!logo }, gebruikers, rapporten, objecten });
    }

    if (b.actie === 'plan') {
      if (!PLANS.includes(b.plan)) return fout(res, 400, 'Onbekend pakket.');
      bedrijf.plan = b.plan;
      if (b.plan !== 'proef') bedrijf.betaaldSinds = bedrijf.betaaldSinds || vandaag();
      await kv.set(`bedrijf:${bid}`, bedrijf);
      return res.status(200).json({ ok: true, bedrijf: { plan: bedrijf.plan } });
    }

    if (b.actie === 'proef') {
      const dagen = Math.max(1, Math.min(365, parseInt(b.dagen, 10) || 14));
      const start = bedrijf.proefTot && bedrijf.proefTot > vandaag() ? new Date(bedrijf.proefTot) : new Date();
      bedrijf.proefTot = new Date(start.getTime() + dagen * 864e5).toISOString().slice(0, 10);
      bedrijf.plan = 'proef';
      await kv.set(`bedrijf:${bid}`, bedrijf);
      return res.status(200).json({ ok: true, proefTot: bedrijf.proefTot });
    }

    if (b.actie === 'blokkeer') {
      bedrijf.geblokkeerd = !!b.aan;
      await kv.set(`bedrijf:${bid}`, bedrijf);
      return res.status(200).json({ ok: true, geblokkeerd: bedrijf.geblokkeerd });
    }

    if (b.actie === 'notitie') {
      bedrijf.notitie = String(b.notitie || '').slice(0, 2000);
      await kv.set(`bedrijf:${bid}`, bedrijf);
      return res.status(200).json({ ok: true });
    }

    if (b.actie === 'wachtwoord') {
      const login = String(b.login || '').toLowerCase().trim();
      const user = await kv.get(`user:${login}`);
      if (!user || user.bid !== bid) return fout(res, 404, 'Gebruiker niet gevonden.');
      if (!b.wachtwoord || b.wachtwoord.length < 8) return fout(res, 400, 'Wachtwoord: minimaal 8 tekens.');
      const { salt, hash } = hashWachtwoord(b.wachtwoord);
      await kv.set(`user:${login}`, { ...user, salt, hash });
      return res.status(200).json({ ok: true });
    }

    if (b.actie === 'verwijder') {
      if (String(b.bevestig || '').toUpperCase() !== bid) return fout(res, 400, 'Typ de bedrijfscode ter bevestiging.');
      const [logins, nummers, objecten] = await Promise.all([
        kv.smembers(`bedrijf:${bid}:users`),
        kv.lrange(`bedrijf:${bid}:rapporten`, 0, -1),
        kv.get(`bedrijf:${bid}:objecten`)
      ]);
      for (const n of nummers || []) {
        const r = await kv.get(`rapport:${bid}:${n}`);
        if (r && r.fotoRefs) for (const f of r.fotoRefs) await kv.del(f);
        await kv.del(`rapport:${bid}:${n}`);
      }
      for (const o of objecten || []) if (o.portaal) await kv.del(`portaal:${o.portaal}`);
      for (const l of logins) await kv.del(`user:${l}`);
      for (const k of ['users', 'rapporten', 'objecten', 'diensten', 'seq']) await kv.del(`bedrijf:${bid}:${k}`);
      await kv.del(`bedrijf:${bid}`);
      await kv.srem('bedrijven', bid);
      return res.status(200).json({ ok: true });
    }

    return fout(res, 400, 'Onbekende actie.');
  }

  /* ── Nieuw bedrijf aanmaken ── */
  const bid = String(b.id || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const login = String(b.login || '').toLowerCase().trim();
  if (!bid || !b.naam || !b.beheerderNaam || !login || !b.wachtwoord)
    return fout(res, 400, 'Alle velden zijn verplicht.');
  if (b.wachtwoord.length < 8) return fout(res, 400, 'Wachtwoord: minimaal 8 tekens.');
  if (await kv.get(`bedrijf:${bid}`)) return fout(res, 409, 'Bedrijfscode bestaat al.');
  if (await kv.get(`user:${login}`)) return fout(res, 409, 'Deze login bestaat al.');

  const plan = PLANS.includes(b.plan) ? b.plan : 'pro';
  const nieuw = { id: bid, naam: b.naam, logo: '', plan, branche: BRANCHES.includes(b.branche) ? b.branche : 'beveiliging',
    sinds: new Date().toISOString(), email: login.includes('@') ? login : '' };
  if (plan === 'proef') nieuw.proefTot = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  else nieuw.betaaldSinds = vandaag();

  await kv.set(`bedrijf:${bid}`, nieuw);
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
