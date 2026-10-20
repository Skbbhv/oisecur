// Oisecur — gedeelde helpers (bestanden met _ worden door Vercel niet als route ontsloten)
// Werkt met de REDIS_URL die Vercel/Upstash levert (een redis:// of rediss:// adres).
// We bieden een kleine "kv"-laag met dezelfde methodes als voorheen, zodat de rest
// van de code (get/set/del/incr/sadd/srem/smembers/lpush/lrange/llen/lrem) ongewijzigd blijft.
import { createClient } from 'redis';
import crypto from 'crypto';

// Eén gedeelde verbinding, hergebruikt over aanvragen heen.
// Vercel/Upstash levert het adres als REDIS_URL (soms als KV_URL of REDIS_TLS_URL).
const REDIS = process.env.REDIS_URL || process.env.KV_URL || process.env.REDIS_TLS_URL || '';
let _client = null, _bezig = null;
async function conn() {
  if (_client && _client.isOpen) return _client;
  if (!REDIS) throw new Error('Database niet ingesteld: REDIS_URL ontbreekt in Vercel.');
  if (!_bezig) {
    _bezig = (async () => {
      const c = createClient({ url: REDIS, socket: { connectTimeout: 5000, reconnectStrategy: n => (n > 2 ? false : 300) } });
      c.on('error', () => {}); // fouten worden per aanroep afgehandeld
      await c.connect();
      _client = c;
      return c;
    })().catch(e => { throw new Error('Database niet bereikbaar: ' + (e.message || e)); })
      .finally(() => { _bezig = null; });
  }
  return _bezig;
}

// Waarden worden als JSON opgeslagen/gelezen, zodat objecten net als voorheen werken.
const enc = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const dec = (v) => {
  if (v === null || v === undefined) return null;
  try { return JSON.parse(v); } catch { return v; }
};

export const kv = {
  async get(k) { const c = await conn(); return dec(await c.get(k)); },
  async set(k, v, opts) {
    const c = await conn();
    if (opts && opts.ex) return c.set(k, enc(v), { EX: opts.ex });
    return c.set(k, enc(v));
  },
  async del(k) { const c = await conn(); return c.del(k); },
  async setnx(k, v) { const c = await conn(); return (await c.set(k, enc(v), { NX: true })) === 'OK'; },
  async incr(k) { const c = await conn(); return c.incr(k); },
  async expire(k, s) { const c = await conn(); return c.expire(k, s); },
  async sadd(k, v) { const c = await conn(); return c.sAdd(k, enc(v)); },
  async srem(k, v) { const c = await conn(); return c.sRem(k, enc(v)); },
  async smembers(k) { const c = await conn(); return (await c.sMembers(k)).map(dec); },
  async lpush(k, v) { const c = await conn(); return c.lPush(k, enc(v)); },
  async lrange(k, a, b) { const c = await conn(); return (await c.lRange(k, a, b)).map(dec); },
  async llen(k) { const c = await conn(); return c.lLen(k); },
  async lrem(k, count, v) { const c = await conn(); return c.lRem(k, count, enc(v)); }
};

/* ── Wachtwoorden: scrypt met salt, geen platte tekst in de database ── */
export function hashWachtwoord(wachtwoord) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(wachtwoord, salt, 32).toString('hex');
  return { salt, hash };
}
export function controleerWachtwoord(wachtwoord, salt, hash) {
  const h = crypto.scryptSync(wachtwoord, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}

/* ── Sessies: token in de database, 12 uur geldig ── */
export async function maakSessie(login, bid, rol) {
  const token = crypto.randomBytes(24).toString('hex');
  await kv.set(`sessie:${token}`, { login, bid, rol }, { ex: 60 * 60 * 12 });
  return token;
}
// Sessie ophalen én controleren of de gebruiker en het bedrijf nog toegang hebben.
// Verwijderde/gedeactiveerde gebruikers, geblokkeerde bedrijven en verlopen proeven → sessie vervalt.
export async function sessieUitToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token || !/^[a-f0-9]{16,128}$/i.test(token)) return null;
  const sleutel = `sessie:${token}`;
  const sessie = await kv.get(sleutel);
  if (!sessie || typeof sessie !== 'object' || !sessie.login || !sessie.bid) return null;
  const [user, bedrijf] = await Promise.all([kv.get(`user:${sessie.login}`), kv.get(`bedrijf:${sessie.bid}`)]);
  const vandaag = new Date().toISOString().slice(0, 10);
  const ongeldig = !user || user.actief === false || user.bid !== sessie.bid ||
    !bedrijf || bedrijf.geblokkeerd ||
    (bedrijf.plan === 'proef' && bedrijf.proefTot && bedrijf.proefTot < vandaag);
  if (ongeldig) { try { await kv.del(sleutel); } catch {} return null; }
  return { ...sessie, rol: user.rol || sessie.rol };
}

/* ── Kleine beveiligingshelpers ── */
// Tijdsonafhankelijk vergelijken van geheimen (voorkomt timing-aanvallen).
export function veiligGelijk(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  if (!x.length || x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
export function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'onbekend').split(',')[0].trim();
}
export const IS_AFBEELDING = s => typeof s === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
export const IS_EMAIL = s => typeof s === 'string' && s.length <= 200 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(s);

// Alleen sleutels die de server zelf voor dit rapport heeft aangemaakt: foto:<bid>:<nummer>:<i>
export function fotoSleutels(bid, r) {
  if (!r || !Array.isArray(r.fotoRefs) || typeof r.nummer !== 'string') return [];
  const prefix = `foto:${bid}:${r.nummer}:`;
  return r.fotoRefs.filter(k => typeof k === 'string' && k.startsWith(prefix) && /^\d{1,2}$/.test(k.slice(prefix.length))).slice(0, 6);
}

/* ── Mail via Resend ── */
export const AFZENDER = 'Oisecur Rapportage <rapportage@oisecur.nl>';
export async function stuurMail({ to, subject, html }, fetchFn = fetch) {
  const r = await fetchFn('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: AFZENDER, to: [to], subject: String(subject).replace(/[\r\n]+/g, ' ').slice(0, 200), html })
  });
  return r.ok;
}

/* ── Bevestigingslink voor de Oibase-koppeling ── */
export function bevestigHash(bid, email) {
  const geheim = process.env.OIBASE_KOPPELING_GEHEIM;
  if (!geheim) return '';
  return crypto.createHmac('sha256', geheim).update('bevestig:' + bid + ':' + String(email || '').toLowerCase().trim()).digest('hex');
}

/* ── Standaard antwoorden ── */
export function fout(res, code, melding) {
  return res.status(code).json({ fout: melding });
}

/* ── Koppeling met Oibase: klanten met Oibase Enterprise gebruiken Oisecur gratis ──
   Vraagt aan de Oibase-database (Supabase-functie oisecur_enterprise) of dit e-mailadres
   bij een actieve Enterprise-klant hoort. Uitkomst 6 uur onthouden.
   Zonder OIBASE_KOPPELING_GEHEIM in Vercel staat de koppeling uit (altijd false). */
const OIBASE_SUPABASE = 'https://uexorfxmhjrvfgawsdlu.supabase.co';
const OIBASE_PUBLIEK = process.env.OIBASE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_FPEAeYQte7pgQWgeQ-OIsA_IkMCFMyt';
export async function oibaseEnterprise(email, fetchFn = fetch) {
  const geheim = process.env.OIBASE_KOPPELING_GEHEIM;
  const e = String(email || '').toLowerCase().trim();
  if (!geheim || !e) return false;
  const cache = `oibase:ent:${e}`;
  try { const c = await kv.get(cache); if (c === 1 || c === 0) return c === 1; } catch {}
  try {
    const r = await fetchFn(OIBASE_SUPABASE + '/rest/v1/rpc/oisecur_enterprise', {
      method: 'POST', headers: { apikey: OIBASE_PUBLIEK, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_email: e, p_geheim: geheim }), signal: AbortSignal.timeout(4000)
    });
    if (!r.ok) return false;                     // bij twijfel niets veranderen
    const ja = (await r.json()) === true;
    try { await kv.set(cache, ja ? 1 : 0, { ex: 6 * 3600 }); } catch {}
    return ja;
  } catch { return false; }
}

// Pakket bijwerken op basis van Oibase: 'oibase' erbij of eraf. Geeft het (eventueel aangepaste) bedrijf terug.
export async function synchroniseerOibase(bedrijf) {
  if (!bedrijf || !bedrijf.email) return bedrijf;
  if (bedrijf.plan !== 'proef' && bedrijf.plan !== 'oibase') return bedrijf;   // betalende klanten niet aanraken
  const ent = await oibaseEnterprise(bedrijf.email);
  // Upgraden alleen als het e-mailadres via de bevestigingslink is geverifieerd.
  if (ent && bedrijf.plan !== 'oibase' && bedrijf.emailBevestigd === true) {
    bedrijf.plan = 'oibase'; bedrijf.oibaseSinds = new Date().toISOString().slice(0, 10);
    await kv.set(`bedrijf:${bedrijf.id}`, bedrijf);
  } else if (!ent && bedrijf.plan === 'oibase' && process.env.OIBASE_KOPPELING_GEHEIM) {
    // Geen Enterprise meer: 14 dagen om over te stappen, daarna als een verlopen proef
    bedrijf.plan = 'proef'; bedrijf.proefTot = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    bedrijf.oibaseTot = new Date().toISOString().slice(0, 10);
    await kv.set(`bedrijf:${bedrijf.id}`, bedrijf);
  }
  return bedrijf;
}

/* ── Tijd in Nederland (server draait in UTC) ── */
export const TZ = 'Europe/Amsterdam';
export function amsParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { datum: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
// Nederlandse datum + tijd → UTC-milliseconden
export function amsNaarUtc(datum, hm) {
  const [y, m, d] = datum.split('-').map(Number), [H, M] = hm.split(':').map(Number);
  const doel = Date.UTC(y, m - 1, d, H, M);
  let t = doel;
  for (let i = 0; i < 3; i++) {
    const p = amsParts(new Date(t));
    const [y2, m2, d2] = p.datum.split('-').map(Number), [H2, M2] = p.hm.split(':').map(Number);
    const diff = Date.UTC(y2, m2 - 1, d2, H2, M2) - doel;
    if (!diff) break; t -= diff;
  }
  return t;
}
export const dagErvoor = datum => new Date(Date.parse(datum + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
export const amsHm = ms => amsParts(new Date(ms)).hm;

/* ── Alarmen: lijst per bedrijf + mail naar de alarmontvangers ── */
export function alarmOntvangers(bedrijf) {
  const lijst = [bedrijf && bedrijf.email, ...((bedrijf && bedrijf.alarmEmails) || [])].map(e => String(e || '').toLowerCase().trim()).filter(IS_EMAIL);
  return [...new Set(lijst)].slice(0, 4);
}
const ALARM_KOP = { incident: 'Melding met hoge prioriteit', ronde: 'Ronde gemist', alleen: 'Alleenwerker reageert niet', sos: 'NOODMELDING' };
export async function maakAlarm(bid, bedrijf, alarm, { extraTo = [], fetchFn = fetch } = {}) {
  const a = { id: crypto.randomBytes(6).toString('hex'), t: new Date().toISOString(), afgehandeld: false, ...alarm };
  const sleutel = `bedrijf:${bid}:alarmen`;
  const lijst = (await kv.get(sleutel)) || [];
  lijst.unshift(a);
  await kv.set(sleutel, lijst.slice(0, 200));
  if (!a.afgehandeld) await alarmPush(bid, a);
  const aan = [...new Set([...alarmOntvangers(bedrijf), ...extraTo.map(e => String(e || '').toLowerCase().trim()).filter(IS_EMAIL)])];
  if (!aan.length || !process.env.RESEND_API_KEY) return a;
  const dag = new Date().toISOString().slice(0, 10);
  const n = await kv.incr(`mail:alarm:${bid}:${dag}`);
  if (n === 1) await kv.expire(`mail:alarm:${bid}:${dag}`, 2 * 864e2);
  if (n > 80) return a;
  const kop = ALARM_KOP[a.soort] || 'Alarm';
  const gps = a.gps && Number.isFinite(a.gps.lat) ? `<p><a href="https://maps.google.com/?q=${a.gps.lat},${a.gps.lng}">Locatie op de kaart (${a.gps.lat.toFixed(5)}, ${a.gps.lng.toFixed(5)})</a></p>` : '';
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937;max-width:600px">
    <div style="background:${a.soort === 'sos' || a.soort === 'alleen' ? '#c1121f' : '#0d2456'};color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-weight:bold;font-size:17px">${escHtml(kop)}</div>
    <div style="border:1px solid #e5e7eb;border-top:none;padding:16px 18px;border-radius:0 0 10px 10px">
    <h2 style="margin:0 0 8px;font-size:18px;color:#0d2456">${escHtml(a.titel || kop)}</h2>
    ${a.tekst ? `<p style="white-space:pre-wrap">${escHtml(a.tekst)}</p>` : ''}
    <p style="color:#6b7280">${a.object ? 'Locatie: ' + escHtml(a.object) + '<br>' : ''}${a.wie ? 'Medewerker: ' + escHtml(a.wie) + '<br>' : ''}Tijd: ${escHtml(amsParts(new Date(a.t)).hm)} (${escHtml(amsParts(new Date(a.t)).datum.split('-').reverse().join('-'))})</p>
    ${gps}
    <p><a href="https://oisecur.nl/app.html#/opvolging" style="display:inline-block;background:#0a5ff0;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open Oisecur</a></p>
    <p style="color:#9ca3af;font-size:12px">${escHtml((bedrijf && bedrijf.naam) || '')} · automatisch alarm van Oisecur</p></div></div>`;
  const onderwerp = `${a.soort === 'sos' ? '🚨 ' : '⚠️ '}${kop}: ${a.titel || ''}`;
  await Promise.all(aan.map(to => stuurMail({ to, subject: onderwerp, html }, fetchFn).catch(() => false)));
  return a;
}
async function alarmPush(bid, a) {
  try {
    await pushBeheerders(bid, { titel: (a.soort === 'sos' ? '🚨 ' : '⚠️ ') + (ALARM_KOP[a.soort] || 'Alarm'), tekst: a.titel || '', url: '/app.html#/opvolging/alarmen',
      tag: 'alarm-' + a.id, urgent: a.soort === 'sos' || a.soort === 'alleen' });
  } catch {}
}

/* ── Pushmeldingen op de telefoon (Web Push). Sleutels worden één keer gemaakt en in de database bewaard. ── */
let _wp = null;
async function webpush() {
  if (_wp) return _wp;
  const m = (await import('web-push')).default;
  let keys = await kv.get('vapid:keys');
  if (!keys || !keys.publicKey) {
    const nieuw = m.generateVAPIDKeys();
    await kv.setnx('vapid:keys', nieuw);
    keys = await kv.get('vapid:keys');
  }
  m.setVapidDetails('mailto:info@oisecur.nl', keys.publicKey, keys.privateKey);
  _wp = { m, keys };
  return _wp;
}
export async function vapidPubliek() { return (await webpush()).keys.publicKey; }
export async function stuurPush(bid, login, data) {
  const k = `push:${bid}:${login}`;
  const subs = (await kv.get(k)) || [];
  if (!subs.length) return 0;
  let wp; try { wp = await webpush(); } catch { return 0; }
  let n = 0; const houden = [];
  for (const s of subs) {
    try { await wp.m.sendNotification(s, JSON.stringify(data), { TTL: 900, urgency: data.urgent ? 'high' : 'normal' }); n++; houden.push(s); }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) continue; houden.push(s); }
  }
  if (houden.length !== subs.length) await kv.set(k, houden);
  return n;
}
export async function pushBeheerders(bid, data) {
  const logins = await kv.smembers(`bedrijf:${bid}:users`);
  const users = await Promise.all(logins.map(l => kv.get(`user:${l}`)));
  let n = 0;
  for (const u of users) if (u && u.rol === 'beheerder' && u.actief !== false) n += await stuurPush(bid, u.login, data);
  return n;
}

/* ── Oibase-koppeling ── */
export const koppelingAan = b => !!b && (b.oibaseKoppeling === true || (b.oibaseKoppeling !== false && b.plan === 'oibase'));
export const koppelingBevestigd = b => !!b && (b.emailBevestigd === true || b.plan === 'oibase');
async function oibaseRpc(fn, body, fetchFn = fetch) {
  const geheim = process.env.OIBASE_KOPPELING_GEHEIM;
  if (!geheim) return { ok: false, reden: 'geen-geheim' };
  try {
    const r = await fetchFn(OIBASE_SUPABASE + '/rest/v1/rpc/' + fn, {
      method: 'POST', headers: { apikey: OIBASE_PUBLIEK, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, p_geheim: geheim }), signal: AbortSignal.timeout(4000)
    });
    if (!r.ok) return { ok: false, reden: 'oibase-fout' };
    return (await r.json()) || { ok: false };
  } catch { return { ok: false, reden: 'oibase-onbereikbaar' }; }
}
// Rapport bij de dienst in Oibase zetten (korte samenvatting, geen foto's of handtekening)
export function rapportSamenvatting(r) {
  if (r.type === 'dienst') return `${(r.mutaties || []).length} ${(r.mutaties || []).length === 1 ? 'regel' : 'regels'}${r.overdracht ? ' · overdracht: ' + r.overdracht : ''}`.slice(0, 300);
  if (r.type === 'ronde') { const p = (r.ronde || {}).punten || []; const a = p.filter(x => x.status === 'Afwijking').length;
    return `${p.filter(x => x.status === 'OK').length}/${p.length} checkpoints in orde${a ? ' · ' + a + ' afwijking' + (a === 1 ? '' : 'en') : ''}`; }
  const i = r.incident || {}; return `${i.cat || 'Melding'}${i.prio ? ' (' + i.prio + ')' : ''}: ${i.oms || ''}`.slice(0, 300);
}
export async function oibaseRapportMelden(bedrijf, r) {
  if (!koppelingAan(bedrijf) || !koppelingBevestigd(bedrijf) || !bedrijf.email) return { ok: false, reden: 'uit' };
  return oibaseRpc('oisecur_rapport_melden', { p_email: bedrijf.email, p_rapport: {
    nummer: r.nummer, type: r.type, datum: r.datum, object: r.object, naam: r.naam, pnr: r.pnr || '', dienst_id: r.oibaseDienstId || '',
    samenvatting: rapportSamenvatting(r), prio: (r.incident || {}).prio || '' } });
}
export async function oibaseRapportIntrekken(bedrijf, nummer) {
  if (!koppelingAan(bedrijf) || !bedrijf.email) return { ok: false };
  return oibaseRpc('oisecur_rapport_ingetrokken', { p_email: bedrijf.email, p_nummer: nummer });
}

/* ── Oibase-rooster (alleen-lezen) ── */
export const OIBASE_START = Date.UTC(2026, 6, 6);   // maandag 6 juli 2026 = week 0 in Oibase
export const OIBASE_TYPES = { Ochtend: ['08:00', '16:00'], Avond: ['16:00', '23:00'], Nacht: ['23:00', '07:00'], Tussendienst: ['11:00', '19:00'] };
export async function oibaseRooster(email, vanWeek, totWeek, fetchFn = fetch) {
  const geheim = process.env.OIBASE_KOPPELING_GEHEIM;
  if (!geheim) return { ok: false, reden: 'geen-geheim' };
  try {
    const r = await fetchFn(OIBASE_SUPABASE + '/rest/v1/rpc/oisecur_rooster', {
      method: 'POST', headers: { apikey: OIBASE_PUBLIEK, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_email: String(email || '').toLowerCase().trim(), p_geheim: geheim, p_van_week: vanWeek, p_tot_week: totWeek }),
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return { ok: false, reden: 'oibase-fout' };
    const d = await r.json();
    return d && d.ok ? d : { ok: false, reden: 'niet-gevonden' };
  } catch { return { ok: false, reden: 'oibase-onbereikbaar' }; }
}
