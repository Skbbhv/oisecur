// Oisecur — gedeelde opmaak voor klantmails, facturen en het dagoverzicht.
import { escHtml as esc, IS_EMAIL } from './_lib.js';

export const BV = {
  naam: 'Oibase B.V.', adres: 'Goordelaan 19', postcode: '9591 CB', plaats: 'Onstwedde', land: 'Nederland',
  kvk: '42117378', btw: 'NL869807729B01', iban: 'NL60INGB0119080214', email: 'info@oibase.nl'
};
export const EIGENAAR = 'info@oibase.nl';                  // dagoverzicht en meldingen
export const WHATSAPP = '06 24 62 66 38';
export const WHATSAPP_LINK = 'https://wa.me/31624626638';
export const LOGO_URL = 'https://oisecur.nl/mail-logo.png';
export const PRIJS = { starter: 19, pro: 49, business: 89 };   // per maand, excl. btw
export const PLAN_NAAM = { proef: 'Proef', starter: 'Starter', pro: 'Pro', business: 'Business', oibase: 'Gratis via Oibase Enterprise' };
export const BETAALTERMIJN = 14;

const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
export const datumNL = d => { const [j, m, dag] = String(d).slice(0, 10).split('-').map(Number); return `${dag} ${MAANDEN[m - 1]} ${j}`; };
export const kortNL = d => String(d || '').slice(0, 10).split('-').reverse().join('-');
export const periodeLabel = p => { const m = /^(\d{4})-(\d{2})$/.exec(p || ''); return m ? MAANDEN[Number(m[2]) - 1] + ' ' + m[1] : String(p || ''); };
export function bedrag(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const a = Math.abs(v).toFixed(2).split('.');
  return '€ ' + (v < 0 ? '-' : '') + a[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + a[1];
}

// Nette mail in Oisecur-stijl. alineas = platte tekst (\n = nieuwe regel); knop = [tekst, url]
export function mailHTML(alineas, knop) {
  const body = alineas.filter(Boolean).map(a => `<p style="margin:0 0 14px">${esc(a).replace(/\n/g, '<br>')}</p>`).join('');
  const k = knop ? `<p style="margin:22px 0"><a href="${esc(knop[1])}" style="background:#0a5ff0;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">${esc(knop[0])}</a></p>` : '';
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"></head><body style="margin:0;background:#fff">
<div style="font-family:Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1C2333;max-width:600px;margin:0 auto;padding:28px 22px;font-size:15px;line-height:1.65">
  <img src="${LOGO_URL}" alt="Oisecur" width="180" style="display:block;width:180px;height:auto;margin-bottom:24px">
  ${body}${k}
  <div style="margin-top:26px;padding-top:14px;border-top:1px solid #E3E6EE;font-size:12px;color:#8A94A6">
    Oisecur is een product van ${BV.naam} · ${BV.adres}, ${BV.postcode} ${BV.plaats} · ${BV.email} · oisecur.nl
  </div>
</div></body></html>`;
}

// Versturen via Resend. Eerst vanaf oisecur.nl; lukt dat niet (domein niet geverifieerd), dan vanaf oibase.nl.
const AFZENDERS = ['Oisecur <info@oisecur.nl>', 'Oisecur <info@oibase.nl>'];
export const mailFouten = [];   // laatste weigeringen van de mailserver (voor het dagoverzicht en /api/dagelijks)
export async function verstuur({ aan, onderwerp, html, tekst, bcc, afzender }, fetchFn = fetch) {
  if (!process.env.RESEND_API_KEY || !IS_EMAIL(String(aan || ''))) return false;
  const lijst = afzender ? [afzender, ...AFZENDERS] : AFZENDERS;
  for (const from of lijst) {
    try {
      const r = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [aan], subject: String(onderwerp).replace(/[\r\n]+/g, ' ').slice(0, 200), html,
          ...(tekst ? { text: tekst } : {}), ...(bcc && bcc !== aan ? { bcc: [bcc] } : {}), reply_to: BV.email }),
        signal: AbortSignal.timeout(10000)
      });
      if (r.ok) return true;
      const melding = await r.text().catch(() => '');
      mailFouten.push(`${from} → ${r.status} ${melding.slice(0, 160)}`); if (mailFouten.length > 10) mailFouten.shift();
      if (r.status !== 403 && r.status !== 422) return false;   // alleen bij een afzenderprobleem de volgende proberen
    } catch (e) { mailFouten.push(`${from} → ${e.message || e}`); return false; }
  }
  return false;
}

/* ── Teksten voor klanten ── */
const groet = ['Met vriendelijke groet,', 'Erik Zuurman', 'Oisecur'].join('\n');
export function proefMail(soort, b, naam = '') {
  const aanhef = `Beste ${naam || b.naam || 'klant'},`;
  const eind = b.proefTot ? datumNL(b.proefTot) : '';
  if (soort === 'welkom') return {
    onderwerp: 'Welkom bij Oisecur',
    alineas: [aanhef,
      `Welkom bij Oisecur! Je account voor ${b.naam} staat klaar. Je proefperiode van 14 dagen loopt tot en met ${eind}.`,
      'Zo ben je snel op weg:\n1. Zet je locaties erin via Instellingen → Objecten.\n2. Maak accounts voor je team. Iedereen krijgt een eigen inlog.\n3. Laat je team Oisecur op hun telefoon zetten via oisecur.nl/app.html en maak je eerste rapport.',
      `Je bedrijfscode is ${b.id}. Loop je ergens tegenaan? Beantwoord gewoon deze e-mail of app naar ${WHATSAPP}.`, groet],
    knop: ['Open Oisecur', 'https://oisecur.nl/app.html'] };
  if (soort === 'halverwege') return {
    onderwerp: 'Halverwege je proef: haal meer uit Oisecur',
    alineas: [aanhef, 'Je bent halverwege je proefperiode. Drie dingen die de meeste tijd schelen:',
      '• Zet QR-checkpoints op je locaties, dan zie je precies welke ronde is gelopen.\n• Geef je opdrachtgever een eigen portaal-link: die ziet de rapporten zonder dat jij iets hoeft te mailen.\n• Zet de alleenwerkerfunctie aan voor medewerkers die alleen op een object staan.',
      `Je proef loopt tot en met ${eind}. Vragen? Beantwoord deze e-mail.`, groet],
    knop: ['Open Oisecur', 'https://oisecur.nl/app.html'] };
  return {
    onderwerp: 'Je proefperiode loopt bijna af',
    alineas: [aanhef, `Je proefperiode van Oisecur eindigt op ${eind}. Daarna kun je niet meer inloggen. Je rapporten blijven wel bewaard.`,
      `Wil je verder? Laat weten welk pakket je kiest. Beantwoord deze e-mail of app naar ${WHATSAPP}:\n• Starter: € 19 per maand\n• Pro: € 49 per maand\n• Business: € 89 per maand\nAlle prijzen zijn exclusief btw en maandelijks opzegbaar. Je betaalt per factuur; er wordt nooit automatisch afgeschreven.`,
      'Heb je meer tijd nodig om te proberen? Laat het ook even weten, dan verlengen we je proef.', groet],
    knop: ['Kies je pakket via WhatsApp', WHATSAPP_LINK] };
}

export function pakketMail(b, plan) {
  return {
    onderwerp: `Je Oisecur-abonnement: ${PLAN_NAAM[plan] || plan}`,
    alineas: [`Beste ${b.naam || 'klant'},`,
      `Bedankt voor je keuze! Je abonnement ${PLAN_NAAM[plan] || plan} is actief. Je kunt gewoon verder met Oisecur, al je rapporten en instellingen blijven staan.`,
      PRIJS[plan] ? `Je betaalt ${bedrag(PRIJS[plan])} per maand (excl. btw). Aan het begin van elke maand ontvang je per e-mail de factuur over de maand ervoor. De eerste maand rekenen we naar rato. Je betaalt per overboeking binnen ${BETAALTERMIJN} dagen; er wordt nooit automatisch afgeschreven.` : '',
      'Moet de factuur naar een ander e-mailadres, of wil je je adres en KvK-nummer op de factuur? Beantwoord dan deze e-mail.', groet],
    knop: ['Open Oisecur', 'https://oisecur.nl/app.html'] };
}

export function herinneringMail(f, nr) {
  const k = f.klant || {};
  return {
    onderwerp: `${nr === 1 ? 'Herinnering' : 'Tweede herinnering'}: factuur ${f.nummer} — Oisecur`,
    alineas: [`Beste ${k.bedrijfsnaam || 'klant'},`,
      `Volgens onze administratie is factuur ${f.nummer} van ${bedrag(f.totaal)} (vervaldatum ${kortNL(f.vervaldatum)}) nog niet betaald. Wilt u het bedrag binnen 14 dagen overmaken op ${BV.iban} ten name van ${BV.naam}, onder vermelding van ${f.nummer}?`,
      nr === 2 ? 'Dit is de tweede herinnering. Als wij de betaling niet ontvangen, kan de toegang tot Oisecur tijdelijk worden geblokkeerd. Uw gegevens blijven bewaard.' : '',
      'Heeft u al betaald? Dan kunt u deze e-mail als niet verzonden beschouwen. Vragen? Beantwoord deze e-mail.', groet] };
}
