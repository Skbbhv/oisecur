// Rapport mailen via Resend — vereist een geldige sessie.
// POST /api/verstuur { nummer, to? }
//   De server bouwt de mail zelf op uit het opgeslagen rapport van het eigen bedrijf.
//   Ontvanger: het e-mailadres van een object/locatie van het bedrijf. Heeft de locatie van het rapport
//   geen e-mailadres, dan mag er één los adres worden opgegeven (max. 10 per bedrijf per dag).
//   Totaal max. 50 mails per bedrijf per dag.
// Vercel env vars: RESEND_API_KEY.
import { kv, sessieUitToken, fout, escHtml as esc, IS_EMAIL, stuurMail } from './_lib.js';

const MAX_PER_DAG = 50, MAX_LOS_PER_DAG = 10;

// Benamingen per branche (gelijk aan app.html)
const B_ALG = { persoon: 'Medewerker', object: 'Locatie', log: 'Logboek', incident: 'Melding' };
const SECTORS = {
  beveiliging: { persoon: 'Beveiliger', object: 'Object', log: 'Mutaties', incident: 'Incident', types: { dienst: 'Dienstrapport', incident: 'Incidentrapport', ronde: 'Ronderapport' } },
  schoonmaak: { ...B_ALG, log: 'Werkzaamheden', types: { dienst: 'Werkrapport', incident: 'Melding', ronde: 'Kwaliteitscontrole' } },
  facilitair: { ...B_ALG, object: 'Gebouw', log: 'Werkzaamheden', incident: 'Storing', types: { dienst: 'Dagrapport', incident: 'Storingsmelding', ronde: 'Inspectieronde' } },
  techniek: { ...B_ALG, persoon: 'Monteur', object: 'Project', log: 'Werkzaamheden', types: { dienst: 'Werkbon', incident: 'Meldingsrapport', ronde: 'Inspectierapport' } },
  evenementen: { ...B_ALG, incident: 'Incident', types: { dienst: 'Dienstrapport', incident: 'Incidentrapport', ronde: 'Controleronde' } },
  overig: { ...B_ALG, types: { dienst: 'Dagrapport', incident: 'Melding', ronde: 'Controleronde' } }
};
const STATUS_LBL = { OK: 'In orde', Afwijking: 'Afwijking', 'Niet gecontroleerd': 'Niet gecontroleerd' };
const fmtDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : '—'; };

function mailHTML(r, bedrijf, l, portaal) {
  const i = r.incident || {};
  const row = (k, v) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#6b7280;width:170px">${k}</td><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${v || '—'}</td></tr>`;
  const h = t => `<h3 style="color:#0d2456;font-size:15px;margin:18px 0 6px;text-transform:uppercase">${t}</h3>`;
  const tbl = rows => `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px">${rows}</table>`;
  const p = t => `<p style="white-space:pre-wrap">${esc(t)}</p>`;
  let body = tbl(row(esc(l.persoon), esc(r.naam) + (r.pnr ? ` (${esc(r.pnr)})` : '')) + row(esc(l.object), esc(r.object) + (r.adres ? ' — ' + esc(r.adres) : '')) +
    row('Datum', fmtDate(r.datum)) + row('Dienst', (r.dienstnaam ? esc(r.dienstnaam) + ' · ' : '') + esc(r.van || '—') + ' – ' + esc(r.tot || '—')));
  if (r.type === 'dienst') {
    body += h(esc(l.log)) + tbl((r.mutaties || []).map(m => row(esc(m.tijd || '—'), esc(m.oms))).join(''));
    if (r.overdracht) body += h('Overdracht') + p(r.overdracht);
  }
  if (r.type === 'incident') {
    body += h(esc(l.incident)) + tbl(row('Categorie', esc(i.cat)) + row('Prioriteit', esc(i.prio)) + row('Tijdstip', esc(i.tijd)) + row('Exacte locatie', esc(i.loc)) +
      row('Politie ter plaatse', i.politie ? 'Ja' : 'Nee') + row('Overige hulpdiensten', i.hulp ? 'Ja' : 'Nee') + row('Schade geconstateerd', i.schade ? 'Ja' : 'Nee'));
    [['Omschrijving', i.oms], ['Genomen acties', i.actie], ['Betrokkenen / signalement', i.betrok], ['Vervolgacties', i.vervolg]].forEach(([a, b]) => { if (b) body += h(a) + p(b); });
    const n = Array.isArray(r.fotoRefs) ? r.fotoRefs.length : 0;
    if (n) body += `<p style="color:#6b7280">Bij dit rapport horen ${n} foto('s). Vraag de PDF op als u deze wilt ontvangen.</p>`;
  }
  if (r.type === 'ronde') {
    const rd = r.ronde || {};
    body += h('Checkpoints') + `<p>Start ${esc(rd.start || '—')} · einde ${esc(rd.eind || '—')}</p>` +
      tbl((rd.punten || []).map(c => row(esc(c.naam), `<b style="color:${c.status === 'Afwijking' ? '#c1121f' : c.status === 'OK' ? '#15803d' : '#b7791f'}">${esc(STATUS_LBL[c.status] || c.status || '—')}</b>${c.tijd ? ' · ' + esc(c.tijd) : ''}${c.qr ? ' · QR' : ''}${c.opm ? '<br>' + esc(c.opm) : ''}`)).join(''));
  }
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333">` +
    `<p>Geachte relatie,</p><p>Hierbij ontvangt u een rapportage van ${esc(bedrijf.naam || 'uw beveiligingsorganisatie')}.</p></div>` +
    `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;max-width:640px">
    <h2 style="color:#0d2456;border-bottom:3px solid #0d2456;padding-bottom:8px;margin:18px 0 12px">${esc(l.types[r.type] || 'Rapport')} ${esc(r.nummer)}</h2>
    ${body}
    <p style="margin-top:18px">Ondertekend door ${esc(r.naam)}.</p>
    ${portaal ? `<p><a href="https://oisecur.nl/portaal.html?t=${encodeURIComponent(portaal)}">Bekijk al uw rapporten in het portaal</a></p>` : ''}
    <p style="color:#9ca3af;font-size:12px">${esc(bedrijf.naam)} · gegenereerd met Oisecur</p></div>`;
}

async function teller(sleutel) {
  const n = await kv.incr(sleutel);
  if (n === 1) await kv.expire(sleutel, 2 * 24 * 3600);
  return n;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return fout(res, 405, 'Method not allowed');
  const sessie = await sessieUitToken(req);
  if (!sessie) return fout(res, 401, 'Niet ingelogd of sessie verlopen.');
  const bid = sessie.bid;

  const { nummer, to } = req.body || {};
  if (typeof nummer !== 'string' || !/^[A-Za-z0-9-]{1,60}$/.test(nummer)) return fout(res, 400, 'Ontbrekend rapportnummer.');
  const [r, bedrijf, objecten] = await Promise.all([
    kv.get(`rapport:${bid}:${nummer}`), kv.get(`bedrijf:${bid}`), kv.get(`bedrijf:${bid}:objecten`)
  ]);
  if (!r) return fout(res, 404, 'Rapport niet gevonden.');
  if (sessie.rol !== 'beheerder' && r.door !== sessie.login) return fout(res, 403, 'Geen toegang tot dit rapport.');

  // Ontvanger bepalen
  const objs = Array.isArray(objecten) ? objecten : [];
  const bekend = new Set(objs.map(o => String(o.email || '').toLowerCase().trim()).filter(IS_EMAIL));
  const obj = objs.find(o => o.naam === r.object);
  const objMail = obj && IS_EMAIL(String(obj.email || '').trim()) ? String(obj.email).trim().toLowerCase() : '';
  const gevraagd = String(to || '').toLowerCase().trim();
  let ontvanger = '', los = false;
  if (!gevraagd) ontvanger = objMail;
  else if (!IS_EMAIL(gevraagd)) return fout(res, 400, 'Ongeldig e-mailadres');
  else if (bekend.has(gevraagd)) ontvanger = gevraagd;
  else if (!objMail) { ontvanger = gevraagd; los = true; }   // locatie zonder e-mailadres: één los adres toegestaan
  else return fout(res, 403, `Rapporten kunnen alleen worden gemaild naar het e-mailadres van de opdrachtgever (${objMail}).`);
  if (!ontvanger) return fout(res, 400, 'Geen e-mailadres bekend voor deze locatie.');

  // Limieten per bedrijf per dag
  const dag = new Date().toISOString().slice(0, 10);
  if (los && (await teller(`mail:los:${bid}:${dag}`)) > MAX_LOS_PER_DAG)
    return fout(res, 429, 'Daglimiet bereikt voor mailen naar losse e-mailadressen. Zet het adres bij de locatie of probeer het morgen opnieuw.');
  if ((await teller(`mail:dag:${bid}:${dag}`)) > MAX_PER_DAG)
    return fout(res, 429, 'Daglimiet voor het mailen van rapporten bereikt. Probeer het morgen opnieuw.');

  const l = SECTORS[(bedrijf && bedrijf.branche)] || SECTORS.beveiliging;
  const b = bedrijf || {};
  const onderwerp = `${b.naam || 'Oisecur'} — ${l.types[r.type] || 'Rapport'} ${r.nummer} (${fmtDate(r.datum)})`;
  const ok = await stuurMail({ to: ontvanger, subject: onderwerp, html: mailHTML(r, b, l, obj && obj.portaal) });
  if (!ok) return fout(res, 502, 'Verzenden mislukt');
  return res.status(200).json({ ok: true, to: ontvanger });
}
