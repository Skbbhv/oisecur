// Oisecur — factuur (HTML), zelfde opbouw als de facturen van Oibase. Afzender is Oibase B.V.
import { escHtml as esc } from './_lib.js';
import { BV, LOGO_URL, bedrag, datumNL, periodeLabel, PRIJS, PLAN_NAAM } from './_mail.js';

const dagenInMaand = p => { const [j, m] = p.split('-').map(Number); return new Date(Date.UTC(j, m, 0)).getUTCDate(); };

// Regels voor één maand. Eerste maand naar rato vanaf betaaldSinds. Geen regels = niets te factureren.
export function factuurRegels(bedrijf, periode) {
  const prijs = PRIJS[bedrijf.plan];
  if (!prijs) return [];
  const eerste = periode + '-01', laatste = periode + '-' + String(dagenInMaand(periode)).padStart(2, '0');
  const start = String(bedrijf.betaaldSinds || '').slice(0, 10) || eerste;
  if (start > laatste) return [];
  const naam = `Oisecur ${PLAN_NAAM[bedrijf.plan]} — ${periodeLabel(periode)}`;
  if (start <= eerste) return [{ omschrijving: naam, aantal: 1, prijs, bedrag: prijs }];
  const dagen = dagenInMaand(periode) - Number(start.slice(8, 10)) + 1;
  const b = Math.round(prijs * dagen / dagenInMaand(periode) * 100) / 100;
  return [{ omschrijving: naam, toelichting: `Naar rato: ${dagen} van de ${dagenInMaand(periode)} dagen (vanaf ${start.split('-').reverse().join('-')})`, aantal: 1, prijs: b, bedrag: b }];
}

export function klantGegevens(bedrijf) {
  const f = bedrijf.factuur || {};
  return { bedrijfsnaam: f.bedrijfsnaam || bedrijf.naam || '', factuur_email: (f.email || bedrijf.email || '').toLowerCase(),
    adres: f.adres || '', postcode: f.postcode || '', plaats: f.plaats || '', kvk: f.kvk || '', btw_nummer: f.btw || '' };
}

export const factuurOnderwerp = f => `Factuur ${f.nummer} — Oisecur, ${periodeLabel(f.periode)}`;
export const factuurInleiding = f => `Beste ${esc((f.klant || {}).bedrijfsnaam || 'klant')},<br><br>Hierbij ontvangt u de factuur voor uw Oisecur-abonnement over ${esc(periodeLabel(f.periode))}. U kunt het bedrag overmaken via een gewone bankoverschrijving; de gegevens staan onderaan.<br><br>Heeft u een vraag over deze factuur? Beantwoord deze e-mail of mail naar ${BV.email}.<br><br>Met vriendelijke groet,<br>${BV.naam}`;

export function factuurHTML(f, { inleiding = '', logo = LOGO_URL, printknop = false } = {}) {
  const k = f.klant || {};
  const td = 'style="padding:10px 12px;border-bottom:1px solid #E3E6EE;font-size:14px;vertical-align:top"';
  const tdR = 'style="padding:10px 12px;border-bottom:1px solid #E3E6EE;font-size:14px;text-align:right;white-space:nowrap;vertical-align:top"';
  const th = a => `style="text-align:${a};padding:10px 12px;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:#5A6478;border-bottom:2px solid #1C2333"`;
  const regels = (f.regels || []).map(r => `<tr><td ${td}>${esc(r.omschrijving)}${r.toelichting ? `<div style="font-size:12px;color:#5A6478">${esc(r.toelichting)}</div>` : ''}</td>
    <td ${tdR}>${r.aantal != null ? esc(r.aantal) : ''}</td><td ${tdR}>${r.prijs != null ? bedrag(r.prijs) : ''}</td><td ${tdR}>${bedrag(r.bedrag)}</td></tr>`).join('');
  return `<div style="font-family:Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1C2333;max-width:760px;margin:0 auto;padding:32px 24px;line-height:1.55">
  ${printknop ? `<div style="text-align:center;margin:0 0 20px" class="geen-print"><button onclick="window.print()" style="background:#0a5ff0;color:#fff;border:none;padding:12px 26px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit">Opslaan als PDF of printen</button></div>` : ''}
  ${inleiding ? `<div style="font-size:14px;line-height:1.7;margin:0 0 24px">${inleiding}</div>` : ''}
  <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:28px"><tr>
    <td style="vertical-align:top"><img src="${esc(logo)}" alt="Oisecur" width="190" style="display:block;width:190px;height:auto">
      <div style="font-size:22px;font-weight:800;margin-top:16px">Factuur</div><div style="font-size:13px;color:#5A6478">${esc(f.nummer)}</div></td>
    <td style="vertical-align:top;text-align:right;font-size:12.5px;color:#5A6478;line-height:1.7">
      <strong style="color:#1C2333">${BV.naam}</strong><br>${BV.adres}<br>${BV.postcode} ${BV.plaats}<br>${BV.land}<br>KvK ${BV.kvk}<br>Btw ${BV.btw}<br>${BV.email}</td>
  </tr></table>
  <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:24px"><tr>
    <td style="vertical-align:top;font-size:13.5px;line-height:1.7">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8A94A6;font-weight:700">Factuur aan</div>
      <strong>${esc(k.bedrijfsnaam)}</strong>${k.adres ? '<br>' + esc(k.adres) : ''}${k.postcode || k.plaats ? `<br>${esc(k.postcode)} ${esc(k.plaats)}` : ''}
      ${k.kvk ? `<br>KvK ${esc(k.kvk)}` : ''}${k.btw_nummer ? `<br>Btw ${esc(k.btw_nummer)}` : ''}${k.factuur_email ? `<br>${esc(k.factuur_email)}` : ''}</td>
    <td style="vertical-align:top;text-align:right;font-size:13.5px;line-height:1.7">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8A94A6;font-weight:700">Gegevens</div>
      Factuurnummer: <strong>${esc(f.nummer)}</strong><br>Factuurdatum: ${datumNL(f.factuurdatum || f.aangemaakt)}<br>
      Periode: ${esc(periodeLabel(f.periode))}<br>Vervaldatum: <strong>${datumNL(f.vervaldatum)}</strong></td>
  </tr></table>
  <table style="width:100%;border-collapse:collapse"><thead><tr><th ${th('left')}>Omschrijving</th><th ${th('right')}>Aantal</th><th ${th('right')}>Prijs</th><th ${th('right')}>Bedrag</th></tr></thead>
    <tbody>${regels}</tbody></table>
  <table role="presentation" style="width:300px;margin:14px 0 0 auto;border-collapse:collapse;font-size:14px">
    <tr><td style="padding:5px 12px">Subtotaal</td><td style="padding:5px 12px;text-align:right">${bedrag(f.bedrag_ex)}</td></tr>
    <tr><td style="padding:5px 12px">Btw ${esc(String(f.btw_pct).replace('.', ','))}%</td><td style="padding:5px 12px;text-align:right">${bedrag(f.btw)}</td></tr>
    <tr><td style="padding:9px 12px;border-top:2px solid #1C2333;font-weight:800;font-size:16px">Te betalen</td><td style="padding:9px 12px;border-top:2px solid #1C2333;font-weight:800;font-size:16px;text-align:right;color:#0a5ff0">${bedrag(f.totaal)}</td></tr>
  </table>
  <div style="background:#F4F6FA;border:1px solid #E3E6EE;border-radius:12px;padding:16px 20px;margin-top:26px;font-size:13.5px;line-height:1.8">
    Graag <strong>${bedrag(f.totaal)}</strong> overmaken vóór <strong>${datumNL(f.vervaldatum)}</strong> op <strong>${BV.iban}</strong> ten name van ${BV.naam}, onder vermelding van factuurnummer <strong>${esc(f.nummer)}</strong>.
  </div>
  <div style="margin-top:26px;font-size:11.5px;color:#8A94A6;text-align:center;border-top:1px solid #E3E6EE;padding-top:14px">
    ${BV.naam} · ${BV.adres}, ${BV.postcode} ${BV.plaats} · KvK ${BV.kvk} · Btw ${BV.btw} · Oisecur is een product van Oibase B.V.
  </div>
</div>`;
}

export const factuurMailHTML = f => `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(factuurOnderwerp(f))}</title></head><body style="margin:0;background:#fff">${factuurHTML(f, { inleiding: factuurInleiding(f) })}</body></html>`;
