// GET /api/status — controle of de server goed is ingesteld.
// Toont alleen óf instellingen aanwezig zijn (ja/nee), nooit de waarden zelf.
import { kv } from './_lib.js';

export default async function handler(req, res) {
  const aanwezig = k => !!process.env[k];
  const instellingen = {
    REDIS_URL: aanwezig('REDIS_URL'), KV_URL: aanwezig('KV_URL'), REDIS_TLS_URL: aanwezig('REDIS_TLS_URL'),
    KV_REST_API_URL: aanwezig('KV_REST_API_URL'), UPSTASH_REDIS_REST_URL: aanwezig('UPSTASH_REDIS_REST_URL'),
    RESEND_API_KEY: aanwezig('RESEND_API_KEY'), OISECUR_ADMIN_KEY: aanwezig('OISECUR_ADMIN_KEY'), CRON_SECRET: aanwezig('CRON_SECRET')
  };
  let database = 'ok';
  try {
    await Promise.race([kv.get('status:ping'), new Promise((_, r) => setTimeout(() => r(new Error('geen antwoord binnen 8 seconden')), 8000))]);
  } catch (e) { database = 'fout: ' + e.message; }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ database, instellingen });
}
