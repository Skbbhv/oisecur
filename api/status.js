// GET /api/status — controle of de server goed is ingesteld.
// Openbaar: alleen of de database werkt en welke opslag actief is. Welke instellingen aanwezig zijn (ja/nee, nooit de waarden)
// alleen met de beheerderssleutel in de kop x-admin-key.
// Zolang de gegevens nog in Redis staan, start deze aanroep de eenmalige overzetting naar Supabase.
import { kv, opslagModus, migreerNaarSupabase } from './_lib.js';
import crypto from 'crypto';

function isBeheerder(req) {
  const goed = process.env.OISECUR_ADMIN_KEY || '', mee = String(req.headers['x-admin-key'] || '');
  return !!goed && mee.length === goed.length && crypto.timingSafeEqual(Buffer.from(mee), Buffer.from(goed));
}

export default async function handler(req, res) {
  const aanwezig = k => !!process.env[k];
  const instellingen = {
    REDIS_URL: aanwezig('REDIS_URL'), KV_URL: aanwezig('KV_URL'), REDIS_TLS_URL: aanwezig('REDIS_TLS_URL'),
    RESEND_API_KEY: aanwezig('RESEND_API_KEY'), OISECUR_ADMIN_KEY: aanwezig('OISECUR_ADMIN_KEY'), CRON_SECRET: aanwezig('CRON_SECRET'),
    OIBASE_KOPPELING_GEHEIM: aanwezig('OIBASE_KOPPELING_GEHEIM')
  };

  let overzetting = null;
  try {
    if (await opslagModus() === 'redis' && process.env.OIBASE_KOPPELING_GEHEIM) overzetting = await migreerNaarSupabase();
  } catch (e) { overzetting = { status: 'fout', melding: String(e.message || e).slice(0, 300) }; }

  let database = 'ok';
  try {
    await Promise.race([kv.get('status:ping'), new Promise((_, r) => setTimeout(() => r(new Error('geen antwoord binnen 8 seconden')), 8000))]);
  } catch (e) { database = 'fout: ' + e.message; }
  let opslag = 'onbekend';
  try { opslag = await opslagModus(); } catch {}

  res.setHeader('Cache-Control', 'no-store');
  const uit = { database, opslag, ...(overzetting ? { overzetting } : {}) };
  return res.status(200).json(isBeheerder(req) ? { ...uit, instellingen } : uit);
}
