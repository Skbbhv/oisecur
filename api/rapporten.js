// GET  /api/rapporten             → lijst (beheerder: alles, medewerker: alleen eigen)
// GET  /api/rapporten?nummer=X    → één volledig rapport incl. foto's
// POST /api/rapporten             → rapport opslaan, server kent nummer toe
// POST /api/rapporten {actie:'verwijderen', nummer} (alleen beheerder)
// POST /api/rapporten {actie:'opvolging', nummer|nummers, status, notitie} (alleen beheerder)
//   Opvolging van meldingen staat los van het (vastgelegde) rapport in bedrijf:<bid>:opvolging
import { kv, sessieUitToken, fout, fotoSleutels, IS_AFBEELDING } from './_lib.js';

const CODE = { dienst: 'DR', incident: 'IR', ronde: 'CR' };
const STATUSSEN = ['OK', 'Afwijking', 'Niet gecontroleerd'];
const IS_NUMMER = n => typeof n === 'string' && /^[A-Za-z0-9-]{1,60}$/.test(n);
const IS_DATUM = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const IS_TIJD = s => /^\d{2}:\d{2}$/.test(s);
const OPV_STATUS = ['Open', 'In behandeling', 'Afgehandeld'];
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

// Korte samenvatting voor lijsten, dashboard en inzicht (zonder foto's en lange teksten)
function samenvatting(r, opv) {
  const pt = r.type === 'ronde' ? ((r.ronde || {}).punten || []) : [];
  const i = r.incident || {};
  return {
    nummer: r.nummer, type: r.type, naam: r.naam, object: r.object, datum: r.datum, door: r.door,
    aantal: r.type === 'dienst' ? (r.mutaties || []).length : r.type === 'ronde' ? pt.length : (i.cat || ''),
    ...(r.type === 'incident' ? { prio: i.prio || '', tijd: i.tijd || '', opv: (opv[r.nummer] || {}).status || 'Open',
      kort: str(i.oms, 140), politie: !!i.politie, schade: !!i.schade } : {}),
    ...(r.type === 'ronde' ? { ok: pt.filter(p => p.status === 'OK').length, afw: pt.filter(p => p.status === 'Afwijking').length,
      qr: pt.filter(p => p.qr).length } : {}),
    ...(r.type === 'dienst' ? { tijd: r.van || '' } : {})
  };
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
      if (r.type === 'incident') {
        const opv = ((await kv.get(`bedrijf:${bid}:opvolging`)) || {})[r.nummer];
        r.opvolging = opv || { status: 'Open', log: [] };
      }
      return res.status(200).json(r);
    }
    const [nummers, opv] = await Promise.all([kv.lrange(`bedrijf:${bid}:rapporten`, 0, 499), kv.get(`bedrijf:${bid}:opvolging`)]);
    const alle = (nummers || []).length ? await Promise.all(nummers.map(n => kv.get(`rapport:${bid}:${n}`))) : [];
    const lijst = alle.filter(Boolean)
      .filter(r => sessie.rol === 'beheerder' || r.door === sessie.login)
      .map(r => samenvatting(r, opv || {}));
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
    const opv = await kv.get(`bedrijf:${bid}:opvolging`);
    if (opv && opv[b.nummer]) { delete opv[b.nummer]; await kv.set(`bedrijf:${bid}:opvolging`, opv); }
    return res.status(200).json({ ok: true });
  }

  if (b.actie === 'opvolging') {
    if (sessie.rol !== 'beheerder') return fout(res, 403, 'Alleen de beheerder kan de opvolging aanpassen.');
    const lijst = (Array.isArray(b.nummers) ? b.nummers : [b.nummer]).filter(IS_NUMMER).slice(0, 500);
    if (!lijst.length) return fout(res, 404, 'Rapport niet gevonden.');
    const status = b.status ? String(b.status) : '';
    if (status && !OPV_STATUS.includes(status)) return fout(res, 400, 'Ongeldige status.');
    const notitie = str(b.notitie, 2000).trim();
    if (!status && !notitie) return fout(res, 400, 'Kies een status of schrijf een notitie.');
    const opv = (await kv.get(`bedrijf:${bid}:opvolging`)) || {};
    const t = new Date().toISOString();
    let n = 0;
    for (const nummer of lijst) {
      const r = await kv.get(`rapport:${bid}:${nummer}`);
      if (!r || r.type !== 'incident') continue;
      const e = opv[nummer] || { status: 'Open', log: [] };
      if (status && status !== e.status) e.log.push({ t, door: sessie.login, status });
      if (status) e.status = status;
      if (notitie) e.log.push({ t, door: sessie.login, tekst: notitie });
      e.log = e.log.slice(-100); e.bijgewerkt = t;
      opv[nummer] = e; n++;
    }
    if (!n) return fout(res, 404, 'Melding niet gevonden.');
    await kv.set(`bedrijf:${bid}:opvolging`, opv);
    return res.status(200).json({ ok: true, aantal: n, opvolging: lijst.length === 1 ? opv[lijst[0]] : undefined });
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
  // Laatste overdracht per object bewaren, zodat de volgende dienst (ook een collega) die ziet
  if (r.type === 'dienst' && r.overdracht && r.object) {
    try {
      const ovd = (await kv.get(`bedrijf:${bid}:overdracht`)) || {};
      ovd[r.object] = { tekst: r.overdracht.slice(0, 2000), naam: r.naam, datum: r.datum, tot: r.tot, nummer: r.nummer };
      await kv.set(`bedrijf:${bid}:overdracht`, ovd);
    } catch {}
  }
  return res.status(200).json({ ok: true, nummer: r.nummer });
}
