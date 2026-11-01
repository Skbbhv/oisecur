// Oisecur — dagelijkse taken (elke ochtend, gestart door Supabase pg_cron of Vercel Cron).
//  1. Proefmails: welkom (vangnet), halverwege, loopt bijna af
//  2. Facturen: dag 1–7 van de maand de factuur over de vorige maand (eenmalig per bedrijf per maand)
//  3. Betalingsherinneringen: 7 en 21 dagen na de vervaldatum
//  4. Dagoverzicht naar info@oibase.nl (elke dag, ook als er niets gebeurd is)
// Toegang: Authorization: Bearer CRON_SECRET, of kop x-oisecur-geheim = OIBASE_KOPPELING_GEHEIM.
// ?droog=1 → alles uitrekenen, niets versturen of opslaan (antwoord laat zien wat er zou gebeuren).
import { kv, fout, veiligGelijk, amsParts, factuurDb, IS_EMAIL } from './_lib.js';
import { verstuur, mailHTML, proefMail, herinneringMail, EIGENAAR, PRIJS, PLAN_NAAM, bedrag, kortNL, periodeLabel } from './_mail.js';
import { factuurRegels, klantGegevens, factuurOnderwerp, factuurMailHTML } from './_factuur.js';

const plusDagen = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dagenTussen = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
const vorigeMaand = d => { const [j, m] = d.split('-').map(Number); return new Date(Date.UTC(j, m - 2, 1)).toISOString().slice(0, 7); };

function toegang(req) {
  const cron = process.env.CRON_SECRET, geheim = process.env.OIBASE_KOPPELING_GEHEIM;
  return (!!cron && veiligGelijk(req.headers.authorization || '', `Bearer ${cron}`)) ||
    (!!geheim && veiligGelijk(req.headers['x-oisecur-geheim'] || '', geheim));
}

async function beheerderNaam(bid) {
  try {
    const logins = await kv.smembers(`bedrijf:${bid}:users`);
    const users = (await Promise.all(logins.map(l => kv.get(`user:${l}`)))).filter(Boolean);
    const b = users.find(u => u.rol === 'beheerder');
    return b ? String(b.naam || '').split(' ')[0] : '';
  } catch { return ''; }
}

export const status = b => b.geblokkeerd ? 'geblokkeerd' : b.plan === 'oibase' ? 'oibase' : PRIJS[b.plan] ? (b.factureren === false ? 'intern' : 'betalend') : 'proef';

export default async function handler(req, res) {
  if (!toegang(req)) return fout(res, 401, 'Geen toegang.');
  const q = req.query || {};
  const droog = q.droog === '1';
  const vandaag = /^\d{4}-\d{2}-\d{2}$/.test(q.datum || '') ? q.datum : amsParts().datum;
  const v = { vandaag, droog, aanmeldingen: [], proefmails: [], facturen: [], herinneringen: [], fouten: [] };
  const fouten = (waar, e) => v.fouten.push(waar + ': ' + String((e && e.message) || e).slice(0, 200));

  const bids = await kv.smembers('bedrijven');
  const bedrijven = (await Promise.all(bids.map(b => kv.get(`bedrijf:${b}`)))).filter(b => b && b.id);

  // 1. Proefmails (één keer per soort per bedrijf)
  for (const b of bedrijven.filter(x => x.plan === 'proef' && x.proefTot && !x.geblokkeerd && IS_EMAIL(x.email || ''))) {
    const dag = dagenTussen(plusDagen(b.proefTot, -14), vandaag), rest = dagenTussen(vandaag, b.proefTot);
    const soort = dag >= 0 && dag <= 2 ? 'welkom' : dag >= 6 && dag <= 8 ? 'halverwege' : rest >= 0 && rest <= 2 ? 'afloop' : null;
    if (!soort) continue;
    const sleutel = `mail:${b.id}:proef_${soort}`;
    if (droog) { if (!(await kv.get(sleutel))) v.proefmails.push(`${soort} · ${b.naam} (zou verstuurd worden)`); continue; }
    try {
      if (!(await kv.setnx(sleutel, vandaag))) continue;
      const t = proefMail(soort, b, await beheerderNaam(b.id));
      const ok = await verstuur({ aan: b.email, onderwerp: t.onderwerp, html: mailHTML(t.alineas, t.knop), tekst: t.alineas.join('\n\n') });
      if (!ok) { await kv.del(sleutel); fouten('proefmail ' + b.naam, 'mail geweigerd, morgen opnieuw'); continue; }
      v.proefmails.push(`${soort} · ${b.naam}`);
    } catch (e) { fouten('proefmail ' + b.naam, e); }
  }

  // 2. Facturen over de vorige maand (dag 1–7, zodat een gemiste dag wordt ingehaald)
  if (Number(vandaag.slice(8, 10)) <= 7) {
    const periode = vorigeMaand(vandaag);
    for (const b of bedrijven.filter(x => PRIJS[x.plan] && !x.geblokkeerd && x.factureren !== false)) {
      const regels = factuurRegels(b, periode);
      if (!regels.length) continue;
      const klant = klantGegevens(b);
      if (!IS_EMAIL(klant.factuur_email)) { fouten('factuur ' + b.naam, 'geen e-mailadres'); continue; }
      if (droog) { v.facturen.push(`${b.naam} · ${periodeLabel(periode)} · ${bedrag(regels.reduce((n, r) => n + r.bedrag, 0))} excl. btw (zou gemaakt worden)`); continue; }
      try {
        const m = await factuurDb('maak', { bid: b.id, periode, klant, regels, btw_pct: 21, termijn: 14 });
        if (!m || !m.ok) { fouten('factuur ' + b.naam, (m && m.reden) || 'onbekend'); continue; }
        const f = m.factuur;
        if (f.status !== 'aangemaakt') continue;               // al verstuurd
        const ok = await verstuur({ aan: klant.factuur_email, onderwerp: factuurOnderwerp(f), html: factuurMailHTML(f), bcc: EIGENAAR });
        if (!ok) { fouten('factuur ' + f.nummer, 'mail geweigerd, morgen opnieuw'); continue; }
        await factuurDb('status', { id: f.id, status: 'verstuurd' });
        v.facturen.push(`${f.nummer} · ${b.naam} · ${bedrag(f.totaal)} · verstuurd`);
      } catch (e) { fouten('factuur ' + b.naam, e); }
    }
  }

  // 3. Herinneringen
  let open = [];
  try { open = await factuurDb('lijst', { open: true }); } catch (e) { fouten('facturen ophalen', e); }
  for (const f of open) {
    const over = dagenTussen(f.vervaldatum, vandaag), al = Number(f.herinneringen) || 0;
    const nr = al === 0 && over >= 7 ? 1 : al === 1 && over >= 21 ? 2 : 0;
    const adres = (f.klant || {}).factuur_email;
    if (!nr || !IS_EMAIL(adres || '')) continue;
    if (droog) { v.herinneringen.push(`${nr}e herinnering ${f.nummer} (zou verstuurd worden)`); continue; }
    try {
      if ((await factuurDb('herinnerd', { id: f.id, verwacht: al })) !== true) continue;
      const t = herinneringMail(f, nr);
      const ok = await verstuur({ aan: adres, onderwerp: t.onderwerp, html: mailHTML(t.alineas), tekst: t.alineas.join('\n\n'), bcc: EIGENAAR });
      if (!ok) { await factuurDb('herinnerd', { id: f.id, verwacht: al, terug: true }); fouten('herinnering ' + f.nummer, 'mail geweigerd'); continue; }
      v.herinneringen.push(`${nr}e herinnering ${f.nummer} · ${(f.klant || {}).bedrijfsnaam || ''}`);
    } catch (e) { fouten('herinnering ' + f.nummer, e); }
  }

  // 4. Dagoverzicht
  const gisteren = plusDagen(vandaag, -1), sinds = Date.now() - 24 * 3600e3;
  v.aanmeldingen = bedrijven.filter(b => b.sinds && Date.parse(b.sinds) >= sinds)
    .map(b => `${b.naam} · ${b.email || ''} · ${b.plan === 'proef' ? 'proef t/m ' + kortNL(b.proefTot) : PLAN_NAAM[b.plan] || b.plan}`);
  const tel = s => bedrijven.filter(b => status(b) === s);
  const proef = tel('proef'), lopend = proef.filter(b => !b.proefTot || b.proefTot >= vandaag), verlopen = proef.filter(b => b.proefTot && b.proefTot < vandaag);
  const mrr = tel('betalend').reduce((n, b) => n + PRIJS[b.plan], 0);
  const bijnaOm = lopend.filter(b => b.proefTot && dagenTussen(vandaag, b.proefTot) <= 3).map(b => `${b.naam} · t/m ${kortNL(b.proefTot)}`);
  const teLaat = open.filter(f => f.vervaldatum < vandaag);
  const activiteit = [];
  for (const b of bedrijven.filter(x => !x.geblokkeerd)) {
    try {
      const nummers = await kv.lrange(`bedrijf:${b.id}:rapporten`, 0, 99);
      const r = (await Promise.all(nummers.map(n => kv.get(`rapport:${b.id}:${n}`)))).filter(x => x && x.datum === gisteren);
      if (r.length) activiteit.push(`${b.naam}: ${r.length} ${r.length === 1 ? 'rapport' : 'rapporten'}`);
    } catch {}
  }
  const blok = (titel, l) => l.length ? titel + ':\n' + l.map(x => '• ' + x).join('\n') : '';
  const alineas = [`Oisecur-overzicht van ${kortNL(vandaag)}.`,
    `Stand: ${tel('betalend').length} betalend (${bedrag(mrr)} per maand excl. btw), ${lopend.length} in proef, ${verlopen.length} proef verlopen, ${tel('oibase').length} gratis via Oibase, ${tel('geblokkeerd').length} geblokkeerd${tel('intern').length ? `, ${tel('intern').length} eigen account` : ''}.`,
    blok('Nieuwe aanmeldingen (afgelopen 24 uur)', v.aanmeldingen) || 'Geen nieuwe aanmeldingen in de afgelopen 24 uur.',
    blok('Proef loopt binnen 3 dagen af', bijnaOm),
    blok('Facturen verstuurd', v.facturen), blok('Herinneringen verstuurd', v.herinneringen), blok('Proefmails verstuurd', v.proefmails),
    open.length ? `Openstaande facturen: ${open.length} (${bedrag(open.reduce((n, f) => n + Number(f.totaal), 0))})${teLaat.length ? `, waarvan ${teLaat.length} te laat` : ''}.` : '',
    blok(`Gebruik gisteren (${kortNL(gisteren)})`, activiteit) || `Gisteren (${kortNL(gisteren)}) zijn er geen rapporten gemaakt.`,
    blok('Fouten', v.fouten)].filter(Boolean);
  const onderwerp = 'Oisecur: dagoverzicht' + (v.aanmeldingen.length ? ` · ${v.aanmeldingen.length} nieuw` : '') + (v.fouten.length ? ` (${v.fouten.length} fout${v.fouten.length === 1 ? '' : 'en'})` : '');
  if (droog) return res.status(200).json({ ...v, overzicht: { onderwerp, alineas } });
  let overzicht = 'al verstuurd vandaag';
  if (q.opnieuw === '1' || await kv.setnx(`dagoverzicht:${vandaag}`, 1)) {
    await kv.expire(`dagoverzicht:${vandaag}`, 3 * 864e2);
    const ok = await verstuur({ aan: EIGENAAR, onderwerp, html: mailHTML(alineas, ['Naar het beheer', 'https://oisecur.nl/admin.html']), tekst: alineas.join('\n\n') });
    overzicht = ok ? 'verstuurd' : 'mislukt';
    if (!ok) await kv.del(`dagoverzicht:${vandaag}`);
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, ...v, overzicht });
}
