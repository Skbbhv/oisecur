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
