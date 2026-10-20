// GET  /api/rapporten             → lijst (beheerder: alles, medewerker: alleen eigen)
// GET  /api/rapporten?nummer=X    → één volledig rapport incl. foto's
// POST /api/rapporten             → rapport opslaan, server kent nummer toe
// POST /api/rapporten {actie:'verwijderen', nummer} (alleen beheerder)
import { kv, sessieUitToken, fout, fotoSleutels, IS_AFBEELDING } from './_lib.js';

const CODE = { dienst: 'DR', incident: 'IR', ronde: 'CR' };
const STATUSSEN = ['OK', 'Afwijking', 'Niet gecontroleerd'];
const IS_NUMMER = n => typeof n === 'string' && /^[A-Za-z0-9-]{1,60}$/.test(n);
const IS_DATUM = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const IS_TIJD = s => /^\d{2}:\d{2}$/.test(s);
const MAX_FOTO = 500000, MAX_HANDTEKENING = 400000;

class Ongeldig extends Error {}
const str = (v, max) => (v == null ? '' : String(v)).slice(0, max);
const tijd = (v, veld) => {
  const s = v == null ? '' : String(v);
  if (s && !IS_TIJD(s)) throw new Ongeldig(`Ongeldige tijd bij ${veld}.`);
  return s;
};
const gps = g => (g && typeof g === 'object' && Number.isFinite(g.lat) && Number.isFinite(g.lng)
  ? { lat: g.lat, lng: g.lng, ...(Number.isFinite(g.acc) ? { acc: Math.round(g.acc) } : {}) } : null);

// Alleen bekende velden overnemen (zoals app.html ze verstuurt) en alles valideren.
function schoonRapport(r) {
  if (!r || typeof r !== 'object' || !CODE[r.type]) throw new Ongeldig('Ongeldig rapport.');
  const datum = r.datum == null || r.datum === '' ? new Date().toISOString().slice(0, 10) : String(r.datum);
  if (!IS_DATUM(datum)) throw new Ongeldig('Ongeldige datum.');
  let handtekening = null;
  if (r.handtekening) {
    if (!IS_AFBEELDING(r.handtekening) || r.handtekening.length > MAX_HANDTEKENING) throw new Ongeldig('Ongeldige handtekening.');
    handtekening = r.handtekening;
  }
  const s = {
    type: r.type, naam: str(r.naam, 120), pnr: str(r.pnr, 40), object: str(r.object, 120), adres: str(r.adres, 200),
    email: str(r.email, 200), dienstnaam: str(r.dienstnaam, 80), datum,
    van: tijd(r.van, 'van'), tot: tijd(r.tot, 'tot'), handtekening
  };
  if (r.type === 'dienst') {
    const m = Array.isArray(r.mutaties) ? r.mutaties.slice(0, 300) : [];
    s.mutaties = m.map(x => ({ tijd: tijd(x && x.tijd, 'regel'), oms: str(x && x.oms, 2000), gps: gps(x && x.gps) }));
    s.overdracht = str(r.overdracht, 5000);
  }
  if (r.type === 'incident') {
    const i = r.incident && typeof r.incident === 'object' ? r.incident : {};
    s.gps = gps(r.gps);
    s.incident = {
      cat: str(i.cat, 80), tijd: tijd(i.tijd, 'tijdstip'), loc: str(i.loc, 300), prio: str(i.prio, 20),
      oms: str(i.oms, 10000), actie: str(i.actie, 5000), betrok: str(i.betrok, 3000), vervolg: str(i.vervolg, 3000),
      politie: !!i.politie, hulp: !!i.hulp, schade: !!i.schade
    };
    const fotos = Array.isArray(i.fotos) ? i.fotos.slice(0, 6) : [];
    for (const f of fotos) if (!IS_AFBEELDING(f) || f.length > MAX_FOTO) throw new Ongeldig("Ongeldige of te grote foto.");
    s._fotos = fotos;
  }
  if (r.type === 'ronde') {
    const rd = r.ronde && typeof r.ronde === 'object' ? r.ronde : {};
    const punten = Array.isArray(rd.punten) ? rd.punten.slice(0, 200) : [];
    s.ronde = {
      start: tijd(rd.start, 'start ronde'), eind: tijd(rd.eind, 'einde ronde'),
      punten: punten.map(p => {
        p = p && typeof p === 'object' ? p : {};
        if (!STATUSSEN.includes(p.status)) throw new Ongeldig('Ongeldige status bij checkpoint.');
        return { naam: str(p.naam, 120), status: p.status, opm: str(p.opm, 2000), qr: !!p.qr, tijd: tijd(p.tijd, 'checkpoint'), gps: gps(p.gps) };
      })
    };
  }
  return s;
}

export default async function handler(req, res) {
  const sessie = await sessieUitToken(req);
  if (!sessie) return fout(res, 401, 'Niet ingelogd of sessie verlopen.');
  const bid = sessie.bid;

  if (req.method === 'GET') {
    if (req.query.nummer) {
      if (!IS_NUMMER(req.query.nummer)) return fout(res, 404, 'Rapport niet gevonden.');
      const r = await kv.get(`rapport:${bid}:${req.query.nummer}`);
      if (!r) return fout(res, 404, 'Rapport niet gevonden.');
      if (sessie.rol !== 'beheerder' && r.door !== sessie.login)
        return fout(res, 403, 'Geen toegang tot dit rapport.');
      const refs = fotoSleutels(bid, r);
      if (refs.length) {
        r.incident = r.incident || {};
        r.incident.fotos = (await Promise.all(refs.map(k => kv.get(k)))).filter(Boolean);
      }
      delete r.fotoRefs;
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
    if (!IS_NUMMER(b.nummer)) return fout(res, 404, 'Rapport niet gevonden.');
    const r = await kv.get(`rapport:${bid}:${b.nummer}`);
    if (!r) return fout(res, 404, 'Rapport niet gevonden.');
    await Promise.all(fotoSleutels(bid, r).map(k => kv.del(k)));
    await kv.del(`rapport:${bid}:${b.nummer}`);
    await kv.lrem(`bedrijf:${bid}:rapporten`, 0, b.nummer);
    return res.status(200).json({ ok: true });
  }

  /* ── Nieuw rapport ── */
  let r;
  try { r = schoonRapport(b.rapport); }
  catch (e) { if (e instanceof Ongeldig) return fout(res, 400, e.message); throw e; }
  const fotos = r._fotos || [];
  delete r._fotos;
  delete r.fotoRefs;                       // nooit van de client overnemen
  r.door = sessie.login;
  r.aangemaakt = new Date().toISOString();

  const seq = await kv.incr(`bedrijf:${bid}:seq`);
  r.nummer = `${bid}-${CODE[r.type]}-${r.datum.replaceAll('-', '')}-${String(seq).padStart(3, '0')}`;

  /* Foto's als losse sleutels opslaan (blijven onder de KV-limiet per waarde); sleutels alleen server-side */
  if (r.type === 'incident') {
    r.fotoRefs = [];
    for (let i = 0; i < fotos.length; i++) {
      const sleutel = `foto:${bid}:${r.nummer}:${i}`;
      await kv.set(sleutel, fotos[i]);
      r.fotoRefs.push(sleutel);
    }
  }

  await kv.set(`rapport:${bid}:${r.nummer}`, r);
  await kv.lpush(`bedrijf:${bid}:rapporten`, r.nummer);
  return res.status(200).json({ ok: true, nummer: r.nummer });
}
