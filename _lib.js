// Oisecur — gedeelde helpers (bestanden met _ worden door Vercel niet als route ontsloten)
import { kv } from '@vercel/kv';
import crypto from 'crypto';

export { kv };

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

/* ── Sessies: token in KV, 12 uur geldig ── */
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
