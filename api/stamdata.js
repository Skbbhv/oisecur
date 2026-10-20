// GET  /api/stamdata                      → { bedrijf, objecten, diensten, medewerkers }
// POST /api/stamdata (alleen beheerder)   → { actie, ... }
//   actie: 'profiel'        { naam?, logo?, branche? }
//   actie: 'objecten'       { objecten:[{naam,adres,email}] }        (hele lijst vervangen)
//   actie: 'diensten'       { diensten:[{naam,van,tot}] }            (hele lijst vervangen)
//   actie: 'medewerker+'    { naam, pnr, login, wachtwoord }
//   actie: 'medewerker-'    { login }
//   actie: 'wachtwoord'     { login, wachtwoord }                    (reset door beheerder)
//   actie: 'portaal'        { objectNaam }  → maakt/geeft alleen-lezen portaallink-token
//   actie: 'mededelingen'   { mededelingen:[{id,titel,tekst,belangrijk,object,tot}] } (hele lijst vervangen)
// POST /api/stamdata (iedereen)
//   actie: 'mijnwachtwoord' { oud, nieuw }                           (eigen wachtwoord wijzigen)
import { kv, hashWachtwoord, controleerWachtwoord, sessieUitToken, fout, IS_AFBEELDING } from './_lib.js';

const str = (v, max) => (v == null ? '' : String(v)).slice(0, max);
const BRANCHES = ['beveiliging', 'schoonmaak', 'facilitair', 'techniek', 'evenementen', 'overig'];

export default async function handler(req, res) {
  const sessie = await sessieUitToken(req);
  if (!sessie) return fout(res, 401, 'Niet ingelogd of sessie verlopen.');
  const bid = sessie.bid;

  if (req.method === 'GET') {
    const [bedrijf, objecten, diensten, logins, mededelingen, overdracht] = await Promise.all([
      kv.get(`bedrijf:${bid}`),
      kv.get(`bedrijf:${bid}:objecten`),
      kv.get(`bedrijf:${bid}:diensten`),
      kv.smembers(`bedrijf:${bid}:users`),
      kv.get(`bedrijf:${bid}:mededelingen`),
      kv.get(`bedrijf:${bid}:overdracht`)
    ]);
    const vandaag = new Date().toISOString().slice(0, 10);
    let medewerkers = [];
    if (sessie.rol === 'beheerder' && logins.length) {
      const users = await Promise.all(logins.map(l => kv.get(`user:${l}`)));
      medewerkers = users.filter(Boolean).map(u => ({ naam: u.naam, pnr: u.pnr || '', login: u.login, rol: u.rol }));
    }
    return res.status(200).json({
      rol: sessie.rol,
      bedrijf: { id: bedrijf.id, naam: bedrijf.naam, logo: bedrijf.logo || '', branche: bedrijf.branche || 'beveiliging',
        ...(sessie.rol === 'beheerder' ? { alarmEmails: bedrijf.alarmEmails || [], email: bedrijf.email || '' } : {}) },
      objecten: objecten || [], diensten: diensten || [], medewerkers,
      mededelingen: (Array.isArray(mededelingen) ? mededelingen : [])
        .filter(m => sessie.rol === 'beheerder' || !m.tot || m.tot >= vandaag),
      overdracht: overdracht && typeof overdracht === 'object' ? overdracht : {},
      plan: sessie.rol === 'beheerder' ? { plan: bedrijf.plan || '', proefTot: bedrijf.proefTot || '' } : undefined
    });
  }

  if (req.method !== 'POST') return fout(res, 405, 'Method not allowed');
  const b = req.body || {};

  if (b.actie === 'mijnwachtwoord') {
    const user = await kv.get(`user:${sessie.login}`);
    if (!user || user.bid !== bid) return fout(res, 404, 'Account niet gevonden.');
    if (!b.oud || !controleerWachtwoord(String(b.oud), user.salt, user.hash)) return fout(res, 400, 'Je huidige wachtwoord klopt niet.');
    if (!b.nieuw || String(b.nieuw).length < 8) return fout(res, 400, 'Nieuw wachtwoord: minimaal 8 tekens.');
    const { salt, hash } = hashWachtwoord(String(b.nieuw));
    await kv.set(`user:${sessie.login}`, { ...user, salt, hash });
    return res.status(200).json({ ok: true });
  }

  if (sessie.rol !== 'beheerder') return fout(res, 403, 'Alleen de beheerder kan dit aanpassen.');

  if (b.actie === 'mededelingen') {
    const datum = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : '');
    const lijst = (Array.isArray(b.mededelingen) ? b.mededelingen : []).slice(0, 50).filter(m => m && typeof m === 'object' && (m.titel || m.tekst))
      .map(m => ({ id: str(m.id, 20) || Math.random().toString(36).slice(2, 10), titel: str(m.titel, 120), tekst: str(m.tekst, 3000),
        belangrijk: !!m.belangrijk, object: str(m.object, 120), tot: datum(m.tot), datum: datum(m.datum) || new Date().toISOString().slice(0, 10),
        door: str(m.door, 120) }));
    await kv.set(`bedrijf:${bid}:mededelingen`, lijst);
    return res.status(200).json({ ok: true });
  }

  if (b.actie === 'profiel') {
    const bedrijf = await kv.get(`bedrijf:${bid}`);
    if (b.naam) bedrijf.naam = String(b.naam).slice(0, 80);
    if (b.logo !== undefined) {
      if (b.logo && !IS_AFBEELDING(b.logo)) return fout(res, 400, 'Logo moet een PNG-, JPEG- of WebP-afbeelding zijn.');
      if (b.logo && b.logo.length > 300000) return fout(res, 400, 'Logo te groot (max ~200 kB).');
      bedrijf.logo = b.logo || '';
    }
    if (b.branche && BRANCHES.includes(b.branche)) bedrijf.branche = b.branche;
    if (Array.isArray(b.alarmEmails)) bedrijf.alarmEmails = b.alarmEmails.map(e => String(e || '').toLowerCase().trim())
      .filter(e => e.length <= 200 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(e)).slice(0, 3);
    await kv.set(`bedrijf:${bid}`, bedrijf);
    return res.status(200).json({ ok: true });
  }

  if (b.actie === 'objecten') {
    const lijst = (Array.isArray(b.objecten) ? b.objecten : []).slice(0, 200).filter(o => o && typeof o === 'object' && o.naam)
      .map(o => ({
        naam: str(o.naam, 120), adres: str(o.adres, 200), email: str(o.email, 200),
        contact: str(o.contact, 120), telefoon: str(o.telefoon, 40), instructie: str(o.instructie, 5000),
        rondeElke: [0, 30, 45, 60, 90, 120, 180, 240].includes(Number(o.rondeElke)) ? Number(o.rondeElke) : 0,
        rondeVan: /^\d{2}:\d{2}$/.test(String(o.rondeVan || '')) ? String(o.rondeVan) : '',
        rondeTot: /^\d{2}:\d{2}$/.test(String(o.rondeTot || '')) ? String(o.rondeTot) : '',
        alarmKlant: !!o.alarmKlant, oibaseOpdracht: str(o.oibaseOpdracht, 120),
        checkpoints: (Array.isArray(o.checkpoints) ? o.checkpoints : []).slice(0, 200)
          .map(c => ({ id: str(c && c.id, 40), naam: str(c && c.naam, 120) })),
        ...(typeof o.portaal === 'string' && /^[a-f0-9]{16,64}$/.test(o.portaal) ? { portaal: o.portaal } : {})
      }));
    await kv.set(`bedrijf:${bid}:objecten`, lijst);
    return res.status(200).json({ ok: true });
  }
  if (b.actie === 'diensten') {
    const tijd = v => (/^\d{2}:\d{2}$/.test(String(v ?? '')) ? String(v) : '');
    const lijst = (Array.isArray(b.diensten) ? b.diensten : []).slice(0, 50).filter(d => d && typeof d === 'object')
      .map(d => ({ naam: str(d.naam, 80), van: tijd(d.van), tot: tijd(d.tot) }));
    await kv.set(`bedrijf:${bid}:diensten`, lijst);
    return res.status(200).json({ ok: true });
  }

  if (b.actie === 'medewerker+') {
    const login = String(b.login || '').toLowerCase().trim();
    if (!b.naam || !login || !b.wachtwoord) return fout(res, 400, 'Naam, login en wachtwoord zijn verplicht.');
    if (login.length > 120) return fout(res, 400, 'Login te lang.');
    if (String(b.wachtwoord).length < 8) return fout(res, 400, 'Wachtwoord: minimaal 8 tekens.');
    if (await kv.get(`user:${login}`)) return fout(res, 409, 'Deze login bestaat al.');
    const { salt, hash } = hashWachtwoord(b.wachtwoord);
    await kv.set(`user:${login}`, { login, naam: str(b.naam, 120), pnr: str(b.pnr, 40), rol: 'medewerker', bid, salt, hash, actief: true });
    await kv.sadd(`bedrijf:${bid}:users`, login);
    return res.status(200).json({ ok: true });
  }

  if (b.actie === 'medewerker-') {
    const login = String(b.login || '').toLowerCase().trim();
    const user = await kv.get(`user:${login}`);
    if (!user || user.bid !== bid) return fout(res, 404, 'Medewerker niet gevonden.');
    if (user.rol === 'beheerder') return fout(res, 400, 'De beheerder kan niet worden verwijderd.');
    await kv.del(`user:${login}`);
    await kv.srem(`bedrijf:${bid}:users`, login);
    return res.status(200).json({ ok: true });
  }

  if (b.actie === 'wachtwoord') {
    const login = String(b.login || '').toLowerCase().trim();
    const user = await kv.get(`user:${login}`);
    if (!user || user.bid !== bid) return fout(res, 404, 'Medewerker niet gevonden.');
    if (!b.wachtwoord || b.wachtwoord.length < 8) return fout(res, 400, 'Wachtwoord: minimaal 8 tekens.');
    const { salt, hash } = hashWachtwoord(b.wachtwoord);
    await kv.set(`user:${login}`, { ...user, salt, hash });
    return res.status(200).json({ ok: true });
  }

  if (b.actie === 'portaal') {
    const objecten = (await kv.get(`bedrijf:${bid}:objecten`)) || [];
    const obj = objecten.find(o => o.naam === b.objectNaam);
    if (!obj) return fout(res, 404, 'Object niet gevonden.');
    if (!obj.portaal) {
      obj.portaal = (await import('crypto')).randomBytes(18).toString('hex');
      await kv.set(`bedrijf:${bid}:objecten`, objecten);
      await kv.set(`portaal:${obj.portaal}`, { bid, objectNaam: obj.naam });
    }
    return res.status(200).json({ ok: true, token: obj.portaal });
  }

  return fout(res, 400, 'Onbekende actie.');
}
