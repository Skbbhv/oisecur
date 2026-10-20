// Alleen-lezen opdrachtgever-portaal.
// GET /api/portaal?token=X            → bedrijf + rapportlijst van dit object
// GET /api/portaal?token=X&nummer=Y   → één volledig rapport (alleen van dit object)
import { kv, fout, fotoSleutels } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return fout(res, 405, 'Method not allowed');
  const t = String(req.query.token || '');
  const koppeling = /^[a-f0-9]{16,64}$/.test(t) ? await kv.get(`portaal:${t}`) : null;
  if (!koppeling) return fout(res, 401, 'Ongeldige of verlopen portaallink.');
  const { bid, objectNaam } = koppeling;
  const bedrijf = await kv.get(`bedrijf:${bid}`);
  if (!bedrijf) return fout(res, 401, 'Ongeldige of verlopen portaallink.');

  if (req.query.nummer) {
    const nummer = String(req.query.nummer);
    if (!/^[A-Za-z0-9-]{1,60}$/.test(nummer)) return fout(res, 404, 'Rapport niet gevonden.');
    const r = await kv.get(`rapport:${bid}:${nummer}`);
    if (!r || r.object !== objectNaam) return fout(res, 404, 'Rapport niet gevonden.');
    const refs = fotoSleutels(bid, r);
    if (refs.length) {
      r.incident = r.incident || {};
      r.incident.fotos = (await Promise.all(refs.map(k => kv.get(k)))).filter(Boolean);
    }
    delete r.fotoRefs;
    return res.status(200).json({ bedrijf: { naam: bedrijf.naam, logo: bedrijf.logo || '' }, rapport: r });
  }

  const nummers = (await kv.lrange(`bedrijf:${bid}:rapporten`, 0, 499)) || [];
  const alle = nummers.length ? await Promise.all(nummers.map(n => kv.get(`rapport:${bid}:${n}`))) : [];
  const rapporten = alle.filter(Boolean).filter(r => r.object === objectNaam)
    .map(r => {
      const pt = r.type === 'ronde' ? ((r.ronde || {}).punten || []) : [], i = r.incident || {};
      return { nummer: r.nummer, type: r.type, naam: r.naam, datum: r.datum,
        ...(r.type === 'incident' ? { cat: i.cat || '', prio: i.prio || '', politie: !!i.politie } : {}),
        ...(r.type === 'ronde' ? { cp: pt.length, ok: pt.filter(p => p.status === 'OK').length, afw: pt.filter(p => p.status === 'Afwijking').length, qr: pt.filter(p => p.qr).length } : {}) };
    });
  return res.status(200).json({
    bedrijf: { naam: bedrijf.naam, logo: bedrijf.logo || '', branche: bedrijf.branche || 'beveiliging' },
    object: objectNaam, rapporten
  });
}
