// Wekelijkse samenvatting per object naar de opdrachtgever.
// Draait via Vercel Cron (zie vercel.json, maandag 07:00). Beveiligd met CRON_SECRET.
import { kv, fout } from './_lib.js';

const FROM = 'Oisecur Rapportage <rapportage@oisecur.nl>';

export default async function handler(req, res) {
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`)
    return fout(res, 401, 'Geen toegang.');

  const week = 7 * 24 * 3600 * 1000;
  const vanaf = new Date(Date.now() - week).toISOString().slice(0, 10);
  const bids = await kv.smembers('bedrijven');
  let verstuurd = 0;

  for (const bid of bids) {
    const [bedrijf, objecten, nummers] = await Promise.all([
      kv.get(`bedrijf:${bid}`),
      kv.get(`bedrijf:${bid}:objecten`),
      kv.lrange(`bedrijf:${bid}:rapporten`, 0, 199)
    ]);
    const metMail = (objecten || []).filter(o => o.email);
    if (!metMail.length) continue;
    const alle = nummers.length ? (await Promise.all(nummers.map(n => kv.get(`rapport:${bid}:${n}`)))).filter(Boolean) : [];
    const recent = alle.filter(r => r.datum >= vanaf);

    for (const obj of metMail) {
      const vanObj = recent.filter(r => r.object === obj.naam);
      if (!vanObj.length) continue;
      const tel = t => vanObj.filter(r => r.type === t).length;
      const afwijkingen = vanObj.filter(r => r.type === 'ronde')
        .reduce((n, r) => n + ((r.ronde || {}).punten || []).filter(p => p.status === 'Afwijking').length, 0);
      const html =
        `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333">` +
        `<h2 style="color:#0d2456">Weekoverzicht — ${obj.naam}</h2>` +
        `<p>Samenvatting van de beveiligingsrapportages van de afgelopen week door ${bedrijf.naam}:</p>` +
        `<table cellpadding="6" style="border-collapse:collapse;font-size:14px">` +
        `<tr><td style="border:1px solid #ccc"><b>Dienstrapporten</b></td><td style="border:1px solid #ccc">${tel('dienst')}</td></tr>` +
        `<tr><td style="border:1px solid #ccc"><b>Controlerondes</b></td><td style="border:1px solid #ccc">${tel('ronde')}</td></tr>` +
        `<tr><td style="border:1px solid #ccc"><b>Incidenten</b></td><td style="border:1px solid #ccc">${tel('incident')}</td></tr>` +
        `<tr><td style="border:1px solid #ccc"><b>Afwijkingen bij rondes</b></td><td style="border:1px solid #ccc">${afwijkingen}</td></tr>` +
        `</table>` +
        (obj.portaal ? `<p><a href="https://oisecur.nl/portaal.html?t=${obj.portaal}">Bekijk alle rapporten in uw portaal</a></p>` : '') +
        `<p style="color:#888;font-size:12px">Automatisch weekoverzicht — gegenereerd met Oisecur.</p></div>`;
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [obj.email], subject: `Weekoverzicht beveiliging — ${obj.naam}`, html })
      });
      if (r.ok) verstuurd++;
    }
  }
  return res.status(200).json({ ok: true, verstuurd });
}
