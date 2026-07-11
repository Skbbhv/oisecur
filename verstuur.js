// Rapport mailen via Resend — vereist een geldige sessie.
// Vercel env vars: RESEND_API_KEY. Pas FROM aan naar je geverifieerde Resend-domein.
import { sessieUitToken, fout } from './_lib.js';

const FROM = 'Oisecur Rapportage <rapportage@oisecur.nl>';

export default async function handler(req, res) {
  if (req.method !== 'POST') return fout(res, 405, 'Method not allowed');
  const sessie = await sessieUitToken(req);
  if (!sessie) return fout(res, 401, 'Niet ingelogd of sessie verlopen.');

  const { to, onderwerp, html, bedrijf } = req.body || {};
  if (!to || !onderwerp || !html) return fout(res, 400, 'Ontbrekende velden');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return fout(res, 400, 'Ongeldig e-mailadres');

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM, to: [to], subject: onderwerp,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333">` +
            `<p>Geachte relatie,</p><p>Hierbij ontvangt u een rapportage van ${bedrijf || 'uw beveiligingsorganisatie'}.</p></div>` + html
    })
  });
  if (!r.ok) return fout(res, 502, 'Verzenden mislukt');
  return res.status(200).json({ ok: true });
}
