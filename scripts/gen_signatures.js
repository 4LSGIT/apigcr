// scripts/gen_signatures.js
/**
 * Email signature generator.
 *
 * Signatures live on email_credentials (the SENDING IDENTITY), not on users:
 * campaigns.sender and campaigns.created_by are separate columns, and every
 * send path lets the operator pick any from-address. Keying off the logged-in
 * user would sign Stuart's mail with whoever happened to be logged in.
 *
 * This file is the single source of truth for signature markup. To change a
 * phone number / title / brand: edit PEOPLE below, re-run, apply the SQL.
 * Never hand-edit signature_html in the DB — the next run overwrites it.
 *
 *   node scripts/gen_signatures.js            # print SQL to stdout
 *   node scripts/gen_signatures.js --html 6   # print one signature's HTML
 *
 * Logo assets are PNG (never WebP — unsupported in Outlook) and are hosted on
 * the firm's own static sites. Displayed at half their natural size for 2x
 * retina. If a logo 404s, every signature using it shows a broken image.
 */

const ADDRESS = ['18481 West Ten Mile Road, Suite 100', 'Southfield, Michigan 48075'];
const FAX = '248-971-1500';

const ACCENT = '#1fabf7'; // labels, name, title
const LINK   = '#3abffa'; // hyperlinks
const BODY   = '#333333';
const FONT   = 'font-family:Calibri,Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.35;';

const BRANDS = {
  mdblg: {
    firm:     'Metro Detroit Bankruptcy Law Group',
    // apex 301s to www — link www directly to avoid the redirect hop
    logo:     'https://www.metrodetroitbankruptcylaw.com/assets/logo-email.png',
    logoW:    200, logoH: 100, // natural 400x200
    site:     'metrodetroitbankruptcylaw.com',
    siteHref: 'https://www.metrodetroitbankruptcylaw.com/',
  },
  lsg: {
    firm:     'Legal Solutions Group, P.C.',
    logo:     'https://legalsolutions.group/assets/lsg-logo-email.png',
    logoW:    200, logoH: 88, // natural 400x175
    site:     'legalsolutions.group',
    siteHref: 'https://legalsolutions.group/',
  },
};

// email_credentials.id -> person
// Automated senders (automations@, it@, admin@, remindme@, IT@metrodetroit…)
// are intentionally absent: a personal signature on a system notification
// reads as a phishing tell.
const PEOPLE = {
  1:  { brand: 'lsg',   name: 'Stuart Sandweiss, CPA, Esq.', title: null,
        phone: '248-559-2400', email: 'stuart@4lsg.com' },
  5:  { brand: 'mdblg', name: 'Rena Grunberger', title: 'Executive Assistant',
        phone: '248-965-5355', email: 'rena@4lsg.com' },
  6:  { brand: 'mdblg', name: 'Shoshana Beitner', title: 'Accountant',
        phone: '248-965-4574', email: 'shoshana@metrodetroitbankruptcylaw.com' },
  // Billing box: `e:` shows the billing address on purpose so replies land
  // there rather than in Shoshana's personal inbox.
  12: { brand: 'mdblg', name: 'Shoshana Beitner', title: 'Accountant',
        phone: '248-965-4574', email: 'Billing@4lsg.com' },

  // Charlie Grunberger (users.user = 23, default_email Charlie@4lsg.com) has
  // NO email_credentials row, so he cannot send at all — sendEmail throws
  // "No credentials found for sender". Create the credential row first, then
  // add him here keyed by its id, with his real title and direct phone.
  // NN: { brand: 'mdblg', name: 'Charlie Grunberger', title: 'TODO',
  //       phone: 'TODO', email: 'Charlie@4lsg.com' },
};

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function row(label, valueHtml) {
  return (
    `        <tr>\n` +
    `          <td valign="top" width="18" style="width:18px;color:${ACCENT};padding:0 6px 0 0;">${label}:</td>\n` +
    `          <td valign="top">${valueHtml}</td>\n` +
    `        </tr>\n`
  );
}

function buildHtml(p) {
  const b = BRANDS[p.brand];
  if (!b) throw new Error(`Unknown brand '${p.brand}'`);
  const tel = '+1' + p.phone.replace(/-/g, '');

  let ident = `            <div style="color:${ACCENT};">${esc(p.name)}</div>\n`;
  if (p.title) ident += `            <div style="color:${ACCENT};">${esc(p.title)}</div>\n`;
  ident += `            <div style="font-weight:bold;">${esc(b.firm)}</div>\n`;

  let rows = '';
  rows += row('p', `<a href="tel:${tel}" style="color:${BODY};text-decoration:none;">${p.phone}</a>`);
  rows += row('f', FAX);
  rows += row('a', ADDRESS.map(esc).join('<br>'));
  rows += row('w', `<a href="${b.siteHref}" style="color:${LINK};text-decoration:none;">${esc(b.site)}</a>`);
  rows += row('e', `<a href="mailto:${p.email}" style="color:${LINK};text-decoration:none;">${esc(p.email)}</a>`);

  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;color:${BODY};${FONT}">
  <tr>
    <td valign="top" style="padding:0 7px 0 0;border-right:3px solid ${ACCENT};">
      <img src="${b.logo}" width="${b.logoW}" height="${b.logoH}" alt="${esc(b.firm)}" style="display:block;border:0;width:${b.logoW}px;height:${b.logoH}px;">
    </td>
    <td valign="top" style="padding:0 0 0 12px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;color:${BODY};${FONT}">
        <tr>
          <td colspan="2" style="padding:0 0 5px 0;">
${ident}          </td>
        </tr>
${rows}      </table>
    </td>
  </tr>
</table>`;
}

function buildText(p) {
  const b = BRANDS[p.brand];
  const lines = [p.name];
  if (p.title) lines.push(p.title);
  lines.push(b.firm, '',
    `p: ${p.phone}`, `f: ${FAX}`,
    `a: ${ADDRESS[0]}`, `   ${ADDRESS[1]}`,
    `w: ${b.site}`, `e: ${p.email}`);
  return lines.join('\n');
}

const q = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

function buildSql() {
  const out = ['-- Generated by scripts/gen_signatures.js — do not hand-edit signature_html.'];
  for (const [id, p] of Object.entries(PEOPLE)) {
    out.push(
      `\n-- id ${id}: ${p.email} (${p.name})\n` +
      `UPDATE email_credentials\n` +
      `SET signature_html = ${q(buildHtml(p))},\n` +
      `    signature_text = ${q(buildText(p))}\n` +
      `WHERE id = ${id};`
    );
  }
  return out.join('\n') + '\n';
}

if (require.main === module) {
  const i = process.argv.indexOf('--html');
  if (i !== -1) {
    const id = process.argv[i + 1];
    if (!PEOPLE[id]) { console.error(`No entry for id ${id}`); process.exit(1); }
    console.log(buildHtml(PEOPLE[id]));
  } else {
    process.stdout.write(buildSql());
  }
}

module.exports = { PEOPLE, BRANDS, buildHtml, buildText, buildSql };
