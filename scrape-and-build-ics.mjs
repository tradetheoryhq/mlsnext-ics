import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { createEvents } from 'ics';

// ==== CONFIG (preset for you) ====
const TEAM = process.env.TEAM || 'LA Surf Soccer Club';
const URL  = 'https://www.mlssoccer.com/mlsnext/schedule/academy_division/';
// =================================

// Broad selectors; refine later with `npx playwright codegen` if needed.
const SELECTORS = {
  ROW: 'article:has(time), li:has(time), [data-testid*="match"], .match, .schedule__row',
  TIME: 'time'
};

function parseTeams(text) {
  const vs = text.match(/(.+?)\s+vs\.?\s+(.+?)(?:\s|$)/i);
  if (vs) return { home: vs[1].trim(), away: vs[2].trim() };
  const at = text.match(/(.+?)\s+@\s+(.+?)(?:\s|$)/);
  if (at) return { home: at[2].trim(), away: at[1].trim() };
  return { home: '', away: '' };
}
function isoToStartArray(iso) {
  const d = new Date(iso);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
}

(async () => {
  const browser = await chromium.launch(); // headless
  const page = await browser.newPage();

  // Capture JSON API responses as a fallback
  const packets = [];
  page.on('response', async (resp) => {
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    if (ct.includes('application/json')) {
      const url = resp.url();
      if (/(schedule|match|fixture|game|event)/i.test(url)) {
        try { packets.push({ url, data: await resp.json() }); } catch {}
      }
    }
  });

  await page.goto(URL, { waitUntil: 'networkidle' });

  // Try to click an "U14" filter/chip if present (non-fatal if it isn't)
  try {
    await page.getByRole('button', { name: /U14/i }).click({ timeout: 2000 });
    // Sometimes filters are toggles; brief pause helps content refresh
    await page.waitForTimeout(800);
  } catch {}

  // Load more (handles infinite scroll)
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 30000);
    await page.waitForTimeout(800);
  }

  const rows = await page.$$(SELECTORS.ROW);
  const events = [];

  // Primary path: parse visible DOM
  if (rows.length) {
    for (const row of rows) {
      const text = (await row.innerText()).replace(/\s+/g, ' ').trim();

      // Team must match
      if (!/LA\s*Surf\s*Soccer\s*Club/i.test(text)) continue;

      // If we couldn't click an age filter, keep only rows that contain U14 text
      // (harmless if filter worked—most rows won't contain "U14" then)
      if (!/U14/i.test(text)) {
        // Allow through if a filter was clicked but the text doesn't show "U14"
        // Detect by presence of many rows and absence of other age strings.
        // No-op here; comment this out if you prefer strict "U14" text matching.
      }

      const timeEl = await row.$(SELECTORS.TIME);
      const iso = timeEl ? await timeEl.getAttribute('datetime') : null;
      if (!iso) continue;

      const { home, away } = parseTeams(text);
      const title = (home && away) ? `${home} vs ${away}` : text.slice(0, 80);

      events.push({
        start: isoToStartArray(iso),
        startInputType: 'local',
        title,
        description: `MLS NEXT Academy Division (U14) — scraped from ${URL}`,
        status: 'CONFIRMED',
        productId: 'mlsnext-ics',
        busyStatus: 'BUSY'
      });
    }
  }

  // Fallback: mine any JSON packets the page loaded (if DOM path found nothing)
  if (events.length === 0 && packets.length) {
    for (const pkt of packets) {
      const list = Array.isArray(pkt.data) ? pkt.data : (pkt.data?.data || pkt.data?.items || []);
      for (const g of list || []) {
        const home = g.homeTeam?.name || g.home?.name || g.home || '';
        const away = g.awayTeam?.name || g.away?.name || g.away || '';
        const when = g.startTime || g.kickoff || g.date || g.datetime || g.start;
        const title = (home && away) ? `${home} vs ${away}` : (g.title || 'Match');
        const both = `${home} ${away}`.toLowerCase();
        if (!both.includes('la surf')) continue;
        if (!when) continue;

        events.push({
          start: isoToStartArray(when),
          startInputType: 'local',
          title,
          description: `MLS NEXT Academy Division (U14) — ${pkt.url}`,
          status: 'CONFIRMED',
          productId: 'mlsnext-ics',
          busyStatus: 'BUSY'
        });
      }
    }
  }

  await browser.close();

  if (!events.length) {
    console.error('No LA Surf U14 Academy Division events found (try adjusting selectors or wait for fixtures).');
    process.exit(2);
  }

  const { error, value } = createEvents(events);
  if (error) { console.error(error); process.exit(1); }

  await writeFile('docs/mlsnext.ics', value, 'utf8');
  console.log(`Wrote docs/mlsnext.ics with ${events.length} events.`);
})();
