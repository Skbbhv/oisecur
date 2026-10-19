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
export async function sessieUitToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  return await kv.get(`sessie:${token}`);
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
  if (ent && bedrijf.plan !== 'oibase') {
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
