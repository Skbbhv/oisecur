// GET  /api/rapporten             → lijst (beheerder: alles, medewerker: alleen eigen)
// GET  /api/rapporten?nummer=X    → één volledig rapport incl. foto's
// POST /api/rapporten             → rapport opslaan, server kent nummer toe
// POST /api/rapporten {actie:'verwijderen', nummer} (alleen beheerder)
import { kv, sessieUitToken, fout } from './_lib.js';

const CODE = { dienst: 'DR', incident: 'IR', ronde: 'CR' };

export default async function handler(req, res) {
  const sessie = await sessieUitToken(req);
  if (!sessie) return fout(res, 401, 'Niet ingelogd of sessie verlopen.');
  const bid = sessie.bid;

  if (req.method === 'GET') {
    if (req.query.nummer) {
      const r = await kv.get(`rapport:${bid}:${req.query.nummer}`);
      if (!r) return fout(res, 404, 'Rapport niet gevonden.');
      if (sessie.rol !== 'beheerder' && r.door !== sessie.login)
        return fout(res, 403, 'Geen toegang tot dit rapport.');
      if (r.fotoRefs && r.fotoRefs.length) {
        r.incident = r.incident || {};
        r.incident.fotos = (await Promise.all(r.fotoRefs.map(k => kv.get(k)))).filter(Boolean);
      }
      return res.status(200).json(r);
    }
    const nummers = (await kv.lrange(`bedrijf:${bid}:rapporten`, 0, 499)) || [];
    const alle = nummers.length ? await Promise.all(nummers.map(n => kv.get(`rapport:${bid}:${n}`))) : [];
    const lijst = alle.filter(Boolean)
      .filter(r => sessie.rol === 'beheerder' || r.door === sessie.login)
      .map(r => ({ nummer: r.nummer, type: r.type, naam: r.naam, object: r.object, datum: r.datum,
                   aantal: r.type === 'dienst' ? (r.mutaties || []).length
                         : r.type === 'ronde' ? ((r.ronde || {}).punten || []).length
                         : ((r.incident || {}).cat || ''), door: r.door }));
    return res.status(200).json({ rapporten: lijst });
  }

  if (req.method !== 'POST') return fout(res, 405, 'Method not allowed');
  const b = req.body || {};

  if (b.actie === 'verwijderen') {
    if (sessie.rol !== 'beheerder') return fout(res, 403, 'Alleen de beheerder kan rapporten verwijderen.');
    const r = await kv.get(`rapport:${bid}:${b.nummer}`);
    if (!r) return fout(res, 404, 'Rapport niet gevonden.');
    if (r.fotoRefs) await Promise.all(r.fotoRefs.map(k => kv.del(k)));
    await kv.del(`rapport:${bid}:${b.nummer}`);
    await kv.lrem(`bedrijf:${bid}:rapporten`, 0, b.nummer);
    return res.status(200).json({ ok: true });
  }

  /* ── Nieuw rapport ── */
  const r = b.rapport;
  if (!r || !CODE[r.type]) return fout(res, 400, 'Ongeldig rapport.');
  r.door = sessie.login;
  r.aangemaakt = new Date().toISOString();

  const seq = await kv.incr(`bedrijf:${bid}:seq`);
  const d = (r.datum || new Date().toISOString().slice(0, 10)).replaceAll('-', '');
  r.nummer = `${bid}-${CODE[r.type]}-${d}-${String(seq).padStart(3, '0')}`;

  /* Foto's als losse sleutels opslaan (blijven onder de KV-limiet per waarde) */
  if (r.type === 'incident' && r.incident && Array.isArray(r.incident.fotos)) {
    const fotos = r.incident.fotos.slice(0, 6);
    r.fotoRefs = [];
    for (let i = 0; i < fotos.length; i++) {
      if (typeof fotos[i] !== 'string' || fotos[i].length > 500000) continue;
      const sleutel = `foto:${bid}:${r.nummer}:${i}`;
      await kv.set(sleutel, fotos[i]);
      r.fotoRefs.push(sleutel);
    }
    delete r.incident.fotos;
  }

  await kv.set(`rapport:${bid}:${r.nummer}`, r);
  await kv.lpush(`bedrijf:${bid}:rapporten`, r.nummer);
  return res.status(200).json({ ok: true, nummer: r.nummer });
}
