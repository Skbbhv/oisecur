// GET  /api/stamdata                      → { bedrijf, objecten, diensten, medewerkers }
// POST /api/stamdata (alleen beheerder)   → { actie, ... }
//   actie: 'profiel'        { naam?, logo? }
//   actie: 'objecten'       { objecten:[{naam,adres,email}] }        (hele lijst vervangen)
//   actie: 'diensten'       { diensten:[{naam,van,tot}] }            (hele lijst vervangen)
//   actie: 'medewerker+'    { naam, pnr, login, wachtwoord }
//   actie: 'medewerker-'    { login }
//   actie: 'wachtwoord'     { login, wachtwoord }                    (reset door beheerder)
//   actie: 'portaal'        { objectNaam }  → maakt/geeft alleen-lezen portaallink-token
import { kv, hashWachtwoord, sessieUitToken, fout } from './_lib.js';

export default async function handler(req, res) {
  const sessie = await sessieUitToken(req);
  if (!sessie) return fout(res, 401, 'Niet ingelogd of sessie verlopen.');
  const bid = sessie.bid;

  if (req.method === 'GET') {
    const [bedrijf, objecten, diensten, logins] = await Promise.all([
      kv.get(`bedrijf:${bid}`),
      kv.get(`bedrijf:${bid}:objecten`),
      kv.get(`bedrijf:${bid}:diensten`),
      kv.smembers(`bedrijf:${bid}:users`)
    ]);
    let medewerkers = [];
    if (sessie.rol === 'beheerder' && logins.length) {
      const users = await Promise.all(logins.map(l => kv.get(`user:${l}`)));
      medewerkers = users.filter(Boolean).map(u => ({ naam: u.naam, pnr: u.pnr || '', login: u.login, rol: u.rol }));
    }
    return res.status(200).json({
      rol: sessie.rol,
      bedrijf: { id: bedrijf.id, naam: bedrijf.naam, logo: bedrijf.logo || '' },
      objecten: objecten || [], diensten: diensten || [], medewerkers
    });
  }

  if (req.method !== 'POST') return fout(res, 405, 'Method not allowed');
  if (sessie.rol !== 'beheerder') return fout(res, 403, 'Alleen de beheerder kan dit aanpassen.');
  const b = req.body || {};

  if (b.actie === 'profiel') {
    const bedrijf = await kv.get(`bedrijf:${bid}`);
    if (b.naam) bedrijf.naam = String(b.naam).slice(0, 80);
    if (b.logo !== undefined) {
      if (b.logo && b.logo.length > 300000) return fout(res, 400, 'Logo te groot (max ~200 kB).');
      bedrijf.logo = b.logo;
    }
    await kv.set(`bedrijf:${bid}`, bedrijf);
    return res.status(200).json({ ok: true });
  }

  if (b.actie === 'objecten') {
    await kv.set(`bedrijf:${bid}:objecten`, (b.objecten || []).slice(0, 200));
    return res.status(200).json({ ok: true });
  }
  if (b.actie === 'diensten') {
    await kv.set(`bedrijf:${bid}:diensten`, (b.diensten || []).slice(0, 50));
    return res.status(200).json({ ok: true });
  }

  if (b.actie === 'medewerker+') {
    const login = String(b.login || '').toLowerCase().trim();
    if (!b.naam || !login || !b.wachtwoord) return fout(res, 400, 'Naam, login en wachtwoord zijn verplicht.');
    if (b.wachtwoord.length < 8) return fout(res, 400, 'Wachtwoord: minimaal 8 tekens.');
    if (await kv.get(`user:${login}`)) return fout(res, 409, 'Deze login bestaat al.');
    const { salt, hash } = hashWachtwoord(b.wachtwoord);
    await kv.set(`user:${login}`, { login, naam: b.naam, pnr: b.pnr || '', rol: 'medewerker', bid, salt, hash, actief: true });
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
