// Oisecur — veldfuncties: alleen werken (lone worker), noodknop, rondebewaking, alarmen,
// sleutel- en passenregister en de koppeling met het Oibase-rooster.
//
// GET  /api/veld                         → { alleen, alarmen (beheerder), sleutels, laatsteRonde (beheerder) }
// GET  /api/veld?actie=rooster           → diensten uit Oibase (vandaag -1 t/m +13 dagen)
// GET  /api/veld?actie=handtekening&id=X → handtekening bij een sleuteluitgifte
// GET  /api/veld?actie=bewaking&key=CRON_SECRET (of Authorization: Bearer CRON_SECRET)
//      → controleert rondes en alleenwerkers van alle bedrijven. Elke 5 minuten aanroepen (cron-job.org of Vercel Cron).
// POST /api/veld { actie, ... }
//   ping { object }                       → checkpoint gescand (voor de rondebewaking)
//   alleen-start { object, minuten }      → alleen werken starten (10–180 min tussen controles)
//   alleen-ok { gps? }                    → "Alles OK"
//   alleen-stop
//   sos { object?, gps?, tekst? }         → noodmelding: direct alarm
//   alarm-af { id }                       → (beheerder) alarm afgehandeld
//   sleutels { items:[{id,naam,soort,nummer,object}] }   → (beheerder) lijst vervangen
//   uitgifte { itemId, aan, organisatie, handtekening, opm }
//   retour { itemId, handtekening?, opm }
//   koppel-oibase { aan:boolean }         → (beheerder) rooster-koppeling aan/uit (vraagt e-mailbevestiging)
import crypto from 'crypto';
import {
  kv, sessieUitToken, fout, veiligGelijk, IS_AFBEELDING, stuurMail, escHtml, bevestigHash,
  amsParts, amsNaarUtc, dagErvoor, amsHm, maakAlarm, oibaseRooster, OIBASE_START, OIBASE_TYPES
} from './_lib.js';

const str = (v, max) => (v == null ? '' : String(v)).slice(0, max);
const gpsOf = g => (g && typeof g === 'object' && Number.isFinite(g.lat) && Number.isFinite(g.lng) ? { lat: g.lat, lng: g.lng, ...(Number.isFinite(g.acc) ? { acc: Math.round(g.acc) } : {}) } : null);
const SOORTEN = ['Sleutel', 'Pas', 'Portofoon', 'Afstandsbediening', 'Overig'];

/* ═════════ Bewaking: gemiste rondes en alleenwerkers ═════════ */
export async function controleer(bid, { nu = Date.now(), force = false } = {}) {
  const lock = `bewaking:lock:${bid}`;
  if (!force) { if (await kv.get(lock)) return { overgeslagen: true }; await kv.set(lock, 1, { ex: 50 }); }
  const [bedrijf, objecten, laatste, actief] = await Promise.all([
    kv.get(`bedrijf:${bid}`), kv.get(`bedrijf:${bid}:objecten`), kv.get(`bedrijf:${bid}:laatsteronde`), kv.smembers(`bedrijf:${bid}:alleen`)
  ]);
  if (!bedrijf || bedrijf.geblokkeerd) return { alarmen: 0 };
  let n = 0;
  const { datum, hm } = amsParts(new Date(nu));
  for (const o of objecten || []) {
    const elke = Number(o.rondeElke) || 0, van = o.rondeVan, tot = o.rondeTot;
    if (!elke || !/^\d{2}:\d{2}$/.test(van || '') || !/^\d{2}:\d{2}$/.test(tot || '') || van === tot) continue;
    let start;
    if (van < tot) { if (hm < van || hm >= tot) continue; start = datum; }
    else if (hm >= van) start = datum;
    else if (hm < tot) start = dagErvoor(datum);
    else continue;
    const venster = amsNaarUtc(start, van);
    const last = laatste && laatste[o.naam] ? Date.parse(laatste[o.naam]) || 0 : 0;
    const ref = Math.max(venster, last);
    if (nu - ref <= (elke + 15) * 60000) continue;
    const k = `bewaking:ronde:${bid}:${o.naam}`;
    if (String(await kv.get(k)) === String(ref)) continue;          // voor deze onderbreking al gemeld
    await kv.set(k, String(ref), { ex: 2 * 86400 });
    await maakAlarm(bid, bedrijf, {
      soort: 'ronde', object: o.naam, titel: `Geen ronde op ${o.naam}`,
      tekst: `Sinds ${amsHm(ref)} is er op ${o.naam} geen checkpoint gescand. Afspraak: elke ${elke} minuten een ronde tussen ${van} en ${tot}.`
    });
    n++;
  }
  for (const login of actief || []) {
    const s = await kv.get(`alleen:${bid}:${login}`);
    if (!s) { await kv.srem(`bedrijf:${bid}:alleen`, login); continue; }
    if (s.alarm) continue;
    const deadline = Date.parse(s.laatste) + (Number(s.minuten) + 5) * 60000;
    if (nu <= deadline) continue;
    s.alarm = true; s.alarmT = new Date(nu).toISOString();
    await kv.set(`alleen:${bid}:${login}`, s, { ex: 16 * 3600 });
    await maakAlarm(bid, bedrijf, {
      soort: 'alleen', object: s.object, wie: s.naam, login, gps: s.gps || null, titel: `${s.naam} reageert niet`,
      tekst: `${s.naam} werkt alleen${s.object ? ' op ' + s.object : ''} en heeft sinds ${amsHm(Date.parse(s.laatste))} niet op "Alles OK" getikt (controle elke ${s.minuten} minuten). Neem direct contact op.`
    });
    n++;
  }
  return { alarmen: n };
}

/* ═════════ Rooster uit Oibase ═════════ */
async function rooster(bedrijf, bid) {
  if (!bedrijf.oibaseKoppeling) return { ok: false, reden: 'uit' };
  if (bedrijf.emailBevestigd !== true) return { ok: false, reden: 'bevestigen' };
  const cache = `rooster:${bid}`;
  const c = await kv.get(cache);
  if (c && c.ok) return c;
  const nu = Date.now();
  const week = Math.floor((nu - OIBASE_START) / (7 * 864e5));
  const d = await oibaseRooster(bedrijf.email, week - 1, week + 2);
  if (!d.ok) return d;
  const types = d.types || {};
  const opd = Object.fromEntries((d.opdrachten || []).map(o => [String(o.id), o]));
  const mw = Object.fromEntries((d.medewerkers || []).map(m => [String(m.id), m]));
  const vanaf = new Date(nu - 864e5).toISOString().slice(0, 10), totDag = new Date(nu + 13 * 864e5).toISOString().slice(0, 10);
  const diensten = (d.diensten || []).map(x => {
    const datum = new Date(OIBASE_START + ((Number(x.week) || 0) * 7 + (Number(x.dag) || 0)) * 864e5).toISOString().slice(0, 10);
    const t = types[x.type] || {}, std = OIBASE_TYPES[x.type] || [];
    const o = opd[String(x.opdrachtId)] || {}, m = mw[String(x.medId)] || {};
    return { id: String(x.id), datum, type: x.type || '', van: t.start || std[0] || '', tot: t.eind || std[1] || '',
      opdracht: o.naam || '', adres: o.adres || '', naam: m.naam || '', pnr: m.pnr || '' };
  }).filter(x => x.datum >= vanaf && x.datum <= totDag).sort((a, b) => (a.datum + a.van).localeCompare(b.datum + b.van));
  const uit = { ok: true, bedrijf: d.bedrijf || '', opdrachten: (d.opdrachten || []).map(o => o.naam).filter(Boolean), diensten };
  await kv.set(cache, uit, { ex: 600 });
  return uit;
}

export default async function handler(req, res) {
  const q = req.query || {};

  /* ── Bewaking (cron) ── */
  if (req.method === 'GET' && q.actie === 'bewaking') {
    const geheim = process.env.CRON_SECRET;
    const mee = String(q.key || '') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!geheim || !veiligGelijk(mee, geheim)) return fout(res, 401, 'Geen toegang.');
    const bids = await kv.smembers('bedrijven');
    let alarmen = 0;
    for (const bid of bids) { try { alarmen += (await controleer(bid, { force: true })).alarmen || 0; } catch {} }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, bedrijven: bids.length, alarmen });
  }

  const sessie = await sessieUitToken(req);
  if (!sessie) return fout(res, 401, 'Niet ingelogd of sessie verlopen.');
  const { bid, login } = sessie;
  const admin = sessie.rol === 'beheerder';
  const user = await kv.get(`user:${login}`);
  const naam = (user && user.naam) || login;

  if (req.method === 'GET') {
    if (q.actie === 'rooster') {
      const bedrijf = await kv.get(`bedrijf:${bid}`);
      const r = await rooster(bedrijf || {}, bid);
      if (r.ok && !admin) {
        // Medewerker: alleen eigen diensten (op naam of personeelsnummer)
        const nm = String(naam).toLowerCase().trim(), pnr = String((user && user.pnr) || '').trim();
        r.diensten = r.diensten.filter(x => (pnr && x.pnr === pnr) || String(x.naam).toLowerCase().trim() === nm);
      }
      return res.status(200).json(r);
    }
    if (q.actie === 'handtekening') {
      const id = String(q.id || '');
      if (!/^[a-f0-9]{8,32}$/.test(id)) return fout(res, 404, 'Niet gevonden.');
      const h = await kv.get(`sleutelsig:${bid}:${id}`);
      return h ? res.status(200).json({ handtekening: h }) : fout(res, 404, 'Niet gevonden.');
    }
    try { await Promise.race([controleer(bid), new Promise(r => setTimeout(r, 2500))]); } catch {}
    const [alleen, alarmen, sleutels, laatste, bedrijf] = await Promise.all([
      kv.get(`alleen:${bid}:${login}`), admin ? kv.get(`bedrijf:${bid}:alarmen`) : null,
      kv.get(`bedrijf:${bid}:sleutels`), admin ? kv.get(`bedrijf:${bid}:laatsteronde`) : null, kv.get(`bedrijf:${bid}`)
    ]);
    const actief = admin ? await kv.smembers(`bedrijf:${bid}:alleen`) : [];
    const alleenTeam = admin ? (await Promise.all(actief.map(l => kv.get(`alleen:${bid}:${l}`)))).filter(Boolean)
      .map(s => ({ naam: s.naam, object: s.object, minuten: s.minuten, laatste: s.laatste, alarm: !!s.alarm, login: s.login })) : undefined;
    return res.status(200).json({
      alleen: alleen || null,
      alarmen: admin ? (alarmen || []).slice(0, 100) : undefined,
      alleenTeam,
      laatsteRonde: admin ? (laatste || {}) : undefined,
      sleutels: sleutels || { items: [], log: [] },
      koppeling: admin ? { aan: !!(bedrijf && bedrijf.oibaseKoppeling), bevestigd: !!(bedrijf && bedrijf.emailBevestigd), email: (bedrijf && bedrijf.email) || '',
        beschikbaar: !!process.env.OIBASE_KOPPELING_GEHEIM, bewaking: !!process.env.CRON_SECRET } : undefined
    });
  }

  if (req.method !== 'POST') return fout(res, 405, 'Method not allowed');
  const b = req.body || {};
  const nuIso = new Date().toISOString();

  /* ── Rondebewaking: checkpoint gescand ── */
  if (b.actie === 'ping') {
    const object = str(b.object, 120);
    if (object) {
      const k = `bedrijf:${bid}:laatsteronde`;
      const m = (await kv.get(k)) || {};
      m[object] = nuIso; await kv.set(k, m);
    }
    const s = await kv.get(`alleen:${bid}:${login}`);
    if (s) { s.laatste = nuIso; s.alarm = false; await kv.set(`alleen:${bid}:${login}`, s, { ex: 16 * 3600 }); }
    return res.status(200).json({ ok: true });
  }

  /* ── Alleen werken ── */
  if (b.actie === 'alleen-start') {
    const minuten = Math.min(180, Math.max(10, Math.round(Number(b.minuten) || 30)));
    const s = { login, naam, object: str(b.object, 120), minuten, start: nuIso, laatste: nuIso, gps: gpsOf(b.gps), alarm: false };
    await kv.set(`alleen:${bid}:${login}`, s, { ex: 16 * 3600 });
    await kv.sadd(`bedrijf:${bid}:alleen`, login);
    return res.status(200).json({ ok: true, alleen: s });
  }
  if (b.actie === 'alleen-ok') {
    const s = await kv.get(`alleen:${bid}:${login}`);
    if (!s) return fout(res, 404, 'Alleen werken staat niet aan.');
    const wasAlarm = s.alarm;
    s.laatste = nuIso; s.alarm = false; const g = gpsOf(b.gps); if (g) s.gps = g;
    await kv.set(`alleen:${bid}:${login}`, s, { ex: 16 * 3600 });
    if (wasAlarm) {
      const bedrijf = await kv.get(`bedrijf:${bid}`);
      await maakAlarm(bid, bedrijf, { soort: 'alleen', object: s.object, wie: naam, login, titel: `${naam} heeft zich weer gemeld`, tekst: `${naam} heeft om ${amsHm(Date.now())} alsnog op "Alles OK" getikt.`, afgehandeld: true });
    }
    return res.status(200).json({ ok: true, alleen: s });
  }
  if (b.actie === 'alleen-stop') {
    await kv.del(`alleen:${bid}:${login}`);
    await kv.srem(`bedrijf:${bid}:alleen`, login);
    return res.status(200).json({ ok: true });
  }

  /* ── Noodknop ── */
  if (b.actie === 'sos') {
    const n = await kv.incr(`sos:${bid}:${login}`); if (n === 1) await kv.expire(`sos:${bid}:${login}`, 60);
    if (n > 3) return fout(res, 429, 'Noodmelding is al verstuurd. Bel bij gevaar 112.');
    const bedrijf = await kv.get(`bedrijf:${bid}`);
    const a = await maakAlarm(bid, bedrijf, {
      soort: 'sos', object: str(b.object, 120), wie: naam, login, gps: gpsOf(b.gps), titel: `Noodmelding van ${naam}`,
      tekst: (str(b.tekst, 500) || `${naam} heeft de noodknop ingedrukt.`) + '\nNeem direct contact op. Bel bij levensgevaar 112.'
    });
    return res.status(200).json({ ok: true, id: a.id });
  }

  /* ── Sleutel- en passenregister ── */
  if (b.actie === 'uitgifte' || b.actie === 'retour') {
    const k = `bedrijf:${bid}:sleutels`;
    const reg = (await kv.get(k)) || { items: [], log: [] };
    const it = (reg.items || []).find(x => x.id === b.itemId);
    if (!it) return fout(res, 404, 'Item niet gevonden.');
    let hId = '';
    if (b.handtekening) {
      if (!IS_AFBEELDING(b.handtekening) || b.handtekening.length > 300000) return fout(res, 400, 'Ongeldige handtekening.');
      hId = crypto.randomBytes(8).toString('hex');
      await kv.set(`sleutelsig:${bid}:${hId}`, b.handtekening, { ex: 400 * 86400 });
    }
    if (b.actie === 'uitgifte') {
      if (it.uit) return fout(res, 409, `${it.naam} is al uitgegeven aan ${it.uit.aan}.`);
      const aan = str(b.aan, 120).trim();
      if (!aan) return fout(res, 400, 'Vul in aan wie je het uitgeeft.');
      if (!hId) return fout(res, 400, 'Laat de ontvanger tekenen.');
      it.uit = { aan, org: str(b.organisatie, 120), t: nuIso, door: naam, h: hId, opm: str(b.opm, 300) };
      reg.log = [{ itemId: it.id, naam: it.naam, actie: 'uit', aan, org: it.uit.org, t: nuIso, door: naam, h: hId, opm: it.uit.opm }, ...(reg.log || [])].slice(0, 400);
    } else {
      if (!it.uit) return fout(res, 409, `${it.naam} is niet uitgegeven.`);
      reg.log = [{ itemId: it.id, naam: it.naam, actie: 'in', aan: it.uit.aan, org: it.uit.org, t: nuIso, door: naam, h: hId, opm: str(b.opm, 300) }, ...(reg.log || [])].slice(0, 400);
      it.uit = null;
    }
    await kv.set(k, reg);
    return res.status(200).json({ ok: true, sleutels: reg });
  }

  if (!admin) return fout(res, 403, 'Alleen de beheerder kan dit doen.');

  if (b.actie === 'alarm-af') {
    const k = `bedrijf:${bid}:alarmen`;
    const lijst = (await kv.get(k)) || [];
    const ids = Array.isArray(b.ids) ? b.ids : [b.id];
    lijst.forEach(a => { if (ids.includes(a.id) && !a.afgehandeld) { a.afgehandeld = true; a.afDoor = naam; a.afT = nuIso; } });
    await kv.set(k, lijst);
    return res.status(200).json({ ok: true });
  }
  if (b.actie === 'sleutels') {
    const k = `bedrijf:${bid}:sleutels`;
    const reg = (await kv.get(k)) || { items: [], log: [] };
    const oud = Object.fromEntries((reg.items || []).map(x => [x.id, x]));
    reg.items = (Array.isArray(b.items) ? b.items : []).slice(0, 300).filter(x => x && x.naam)
      .map(x => { const id = /^[A-Za-z0-9]{4,20}$/.test(x.id || '') ? x.id : crypto.randomBytes(5).toString('hex');
        return { id, naam: str(x.naam, 120), soort: SOORTEN.includes(x.soort) ? x.soort : 'Sleutel', nummer: str(x.nummer, 40), object: str(x.object, 120), uit: (oud[id] && oud[id].uit) || null }; });
    await kv.set(k, reg);
    return res.status(200).json({ ok: true, sleutels: reg });
  }
  if (b.actie === 'koppel-oibase') {
    const bedrijf = await kv.get(`bedrijf:${bid}`);
    bedrijf.oibaseKoppeling = !!b.aan;
    await kv.set(`bedrijf:${bid}`, bedrijf);
    await kv.del(`rooster:${bid}`);
    let mail = false;
    if (bedrijf.oibaseKoppeling && bedrijf.emailBevestigd !== true && bedrijf.email) {
      const h = bevestigHash(bid, bedrijf.email);
      if (h) {
        const link = `https://oisecur.nl/api/registreer?bevestig=${encodeURIComponent(bid)}&h=${h}`;
        mail = await stuurMail({ to: bedrijf.email, subject: 'Bevestig je e-mailadres voor de Oibase-koppeling',
          html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937"><p>Hallo,</p><p>Je wilt het rooster uit Oibase in Oisecur zien. Bevestig eerst dat dit e-mailadres (${escHtml(bedrijf.email)}) van jou is:</p><p><a href="${link}" style="display:inline-block;background:#0a5ff0;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:bold">E-mailadres bevestigen</a></p><p style="color:#6b7280;font-size:13px">Heb je dit niet aangevraagd? Dan kun je deze mail negeren.</p></div>` }).catch(() => false);
      }
    }
    return res.status(200).json({ ok: true, aan: bedrijf.oibaseKoppeling, bevestigd: bedrijf.emailBevestigd === true, mail });
  }

  return fout(res, 400, 'Onbekende actie.');
}
