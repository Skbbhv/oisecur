// Maandrapport per object naar de opdrachtgever (1e van de maand, over de vorige maand).
import { kv, escHtml, stuurMail } from './_lib.js';

const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

export function vorigeMaand(datum) {
  const [y, m] = datum.split('-').map(Number);
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const van = `${py}-${String(pm).padStart(2, '0')}-01`;
  const tot = `${py}-${String(pm).padStart(2, '0')}-${String(new Date(Date.UTC(py, pm, 0)).getUTCDate()).padStart(2, '0')}`;
  return { van, tot, label: `${MAANDEN[pm - 1]} ${py}`, sleutel: `${py}-${String(pm).padStart(2, '0')}` };
}

export function maandCijfers(rs) {
  const tel = t => rs.filter(r => r.type === t).length;
  const rondes = rs.filter(r => r.type === 'ronde');
  const pt = rondes.flatMap(r => (r.ronde || {}).punten || []);
  const inc = rs.filter(r => r.type === 'incident');
  const cats = {};
  inc.forEach(r => { const c = (r.incident || {}).cat || 'Overig'; cats[c] = (cats[c] || 0) + 1; });
  return { dienst: tel('dienst'), ronde: tel('ronde'), incident: inc.length, hoog: inc.filter(r => (r.incident || {}).prio === 'Hoog').length,
    politie: inc.filter(r => (r.incident || {}).politie).length, cp: pt.length, ok: pt.filter(p => p.status === 'OK').length,
    afw: pt.filter(p => p.status === 'Afwijking').length, qr: pt.filter(p => p.qr).length,
    cats: Object.entries(cats).sort((a, b) => b[1] - a[1]) };
}

export async function maandMails(datum, fetchFn = fetch) {
  const p = vorigeMaand(datum);
  const bids = await kv.smembers('bedrijven');
  let n = 0;
  for (const bid of bids) {
    const [bedrijf, objecten, nummers] = await Promise.all([kv.get(`bedrijf:${bid}`), kv.get(`bedrijf:${bid}:objecten`), kv.lrange(`bedrijf:${bid}:rapporten`, 0, 499)]);
    if (!bedrijf || bedrijf.geblokkeerd) continue;
    const metMail = (objecten || []).filter(o => o.email);
    if (!metMail.length) continue;
    const alle = (nummers || []).length ? (await Promise.all(nummers.map(x => kv.get(`rapport:${bid}:${x}`)))).filter(Boolean) : [];
    const inMaand = alle.filter(r => r.datum >= p.van && r.datum <= p.tot);
    for (const o of metMail) {
      const rs = inMaand.filter(r => r.object === o.naam);
      if (!rs.length) continue;
      const vlag = `maandmail:${bid}:${o.naam}:${p.sleutel}`;
      if (await kv.get(vlag)) continue;
      const c = maandCijfers(rs);
      const pct = c.cp ? Math.round(c.ok / c.cp * 100) + '%' : '—';
      const rij = (k, v) => `<tr><td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;color:#6b7280">${k}</td><td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-weight:bold;text-align:right">${v}</td></tr>`;
      const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;max-width:620px">
        <h2 style="color:#0d2456;border-bottom:3px solid #0d2456;padding-bottom:8px">Maandrapport ${escHtml(p.label)} — ${escHtml(o.naam)}</h2>
        <p>Geachte relatie,</p><p>Hierbij het maandoverzicht van ${escHtml(bedrijf.naam)} voor ${escHtml(o.naam)}.</p>
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px">
        ${rij('Dienstrapporten', c.dienst)}${rij('Controlerondes', c.ronde)}${rij('Checkpoints gecontroleerd', c.cp)}${rij('Checkpoints in orde', pct)}
        ${rij('Afwijkingen bij rondes', c.afw)}${rij('Meldingen / incidenten', c.incident)}${rij('Waarvan hoge prioriteit', c.hoog)}${rij('Politie ter plaatse', c.politie)}</table>
        ${c.cats.length ? `<h3 style="color:#0d2456;font-size:15px;margin-top:18px">Meldingen per categorie</h3><p>${c.cats.map(([k, v]) => `${escHtml(k)}: <b>${v}</b>`).join(' · ')}</p>` : ''}
        ${o.portaal ? `<p style="margin-top:18px"><a href="https://oisecur.nl/portaal.html?t=${encodeURIComponent(o.portaal)}&maand=${p.sleutel}" style="display:inline-block;background:#0d2456;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Bekijk het maandrapport (PDF)</a></p>` : ''}
        <p style="color:#9ca3af;font-size:12px">${escHtml(bedrijf.naam)} · automatisch maandrapport, gegenereerd met Oisecur</p></div>`;
      const ok = await stuurMail({ to: o.email, subject: `Maandrapport ${p.label} — ${String(o.naam).replace(/[\r\n]+/g, ' ')}`, html }, fetchFn);
      if (ok) { n++; await kv.set(vlag, 1, { ex: 40 * 86400 }); }
    }
  }
  return n;
}
