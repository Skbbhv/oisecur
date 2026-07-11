// Alleen-lezen opdrachtgever-portaal.
// GET /api/portaal?token=X            → bedrijf + rapportlijst van dit object
// GET /api/portaal?token=X&nummer=Y   → één volledig rapport (alleen van dit object)
import { kv, fout } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return fout(res, 405, 'Method not allowed');
  const koppeling = req.query.token ? await kv.get(`portaal:${req.query.token}`) : null;
  if (!koppeling) return fout(res, 401, 'Ongeldige of verlopen portaallink.');
  const { bid, objectNaam } = koppeling;
  const bedrijf = await kv.get(`bedrijf:${bid}`);

  if (req.query.nummer) {
    const r = await kv.get(`rapport:${bid}:${req.query.nummer}`);
    if (!r || r.object !== objectNaam) return fout(res, 404, 'Rapport niet gevonden.');
    if (r.fotoRefs && r.fotoRefs.length) {
      r.incident = r.incident || {};
      r.incident.fotos = (await Promise.all(r.fotoRefs.map(k => kv.get(k)))).filter(Boolean);
    }
    return res.status(200).json({ bedrijf: { naam: bedrijf.naam, logo: bedrijf.logo || '' }, rapport: r });
  }

  const nummers = (await kv.lrange(`bedrijf:${bid}:rapporten`, 0, 499)) || [];
  const alle = nummers.length ? await Promise.all(nummers.map(n => kv.get(`rapport:${bid}:${n}`))) : [];
  const rapporten = alle.filter(Boolean).filter(r => r.object === objectNaam)
    .map(r => ({ nummer: r.nummer, type: r.type, naam: r.naam, datum: r.datum }));
  return res.status(200).json({
    bedrijf: { naam: bedrijf.naam, logo: bedrijf.logo || '' },
    object: objectNaam, rapporten
  });
}
