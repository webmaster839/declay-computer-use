const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// DECLAY Partslink Navigator v7.4
// + Einfacher Prompt (Claude denkt selbst)
// + Teile-LISTE statt einzelnes Bauteil
// + 1x Login → alle Teile suchen → Logout
// + 15 Messages Kontext (statt 9)
// ============================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 800;

const jobs = new Map();
let activeJob = false;

const VIN_MARKEN = {
  'WBA':'BMW','WBS':'BMW','WBY':'BMW','WVW':'Volkswagen','WVG':'Volkswagen',
  'WMW':'MINI','WF0':'Ford','WAU':'Audi','WUA':'Audi',
  'WDB':'Mercedes','WDC':'Mercedes','WDD':'Mercedes','W0L':'Opel',
  'TMB':'Skoda','VF1':'Renault','VF7':'Citroen','VF3':'Peugeot',
  'ZFA':'Fiat','SAL':'Land Rover','SAJ':'Jaguar','YV1':'Volvo',
  'KNA':'Kia','KNE':'Kia','KMH':'Hyundai','JTD':'Toyota','SB1':'Toyota',
  'VSS':'SEAT','TRU':'Audi','UU1':'Dacia','VNK':'Toyota',
  'WP0':'Porsche','WP1':'Porsche','SUZ':'Suzuki',
};

function getMarkeFromVin(vin) {
  if (!vin || vin.length < 3) return null;
  const p3 = vin.substring(0,3).toUpperCase();
  if (VIN_MARKEN[p3]) return VIN_MARKEN[p3];
  for (const [k,v] of Object.entries(VIN_MARKEN)) {
    if (k.substring(0,2) === p3.substring(0,2)) return v;
  }
  return null;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DECLAY v7.4', jobs: jobs.size, busy: activeJob });
});

app.post('/search', (req, res) => {
  const { vin, bauteil, teile } = req.body;
  if (!vin) return res.status(400).json({ error: 'VIN erforderlich' });
  if (!bauteil && (!teile || teile.length === 0)) return res.status(400).json({ error: 'Bauteil oder Teile-Liste erforderlich' });
  if (activeJob) return res.status(429).json({ error: 'Ein Job laeuft bereits. Bitte warten.' });

  // Teile-Liste: entweder aus "teile" Array oder einzelnes "bauteil"
  const teileListe = teile || [bauteil];

  const jobId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  jobs.set(jobId, { status: 'starting', step: 0, message: 'Starte...', teile: [], error: null, teileListe, startedAt: new Date().toISOString() });
  console.log(`[JOB ${jobId}] Gestartet: VIN=${vin} | Teile: ${teileListe.join(', ')}`);
  activeJob = true;

  processSearchJob(jobId, vin, teileListe).catch(err => {
    console.error(`[JOB ${jobId}] Fataler Fehler:`, err.message);
    const job = jobs.get(jobId);
    if (job) { job.status = 'error'; job.error = err.message; }
  }).finally(() => { activeJob = false; });

  res.json({ jobId, teileListe });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });
  res.json(job);
});

// Live Screenshot als Bild
app.get('/view/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.lastScreenshot) return res.status(404).send('Kein Screenshot verfuegbar');
  const img = Buffer.from(job.lastScreenshot, 'base64');
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length, 'Cache-Control': 'no-cache' });
  res.end(img);
});

// Passwort-Check fuer Live View
const LIVE_PW = process.env.LIVE_PASSWORD || '';
function checkLivePw(req, res) {
  if (!LIVE_PW) return true; // Kein Passwort gesetzt = offen
  if (req.query.pw === LIVE_PW) return true;
  res.status(401).send('<html><body style="background:#080a08;color:#ef4444;font-family:monospace;padding:40px;text-align:center"><h1>DECLAY LIVE VIEW</h1><p>Zugang verweigert. Passwort fehlt.</p><p style="color:#39ff14;margin-top:20px">Nutze: /live?pw=DEIN_PASSWORT</p></body></html>');
  return false;
}

// Live View Seite mit Auto-Refresh
app.get('/live/:jobId', (req, res) => {
  if (!checkLivePw(req, res)) return;
  const jobId = req.params.jobId;
  res.send(getLiveHtml(jobId));
});

// Live View OHNE JobId - zeigt automatisch den letzten/aktuellen Job
app.get('/live', (req, res) => {
  if (!checkLivePw(req, res)) return;
  // Finde den aktuellsten Job
  let latestJob = null;
  let latestId = null;
  for (const [id, job] of jobs) {
    if (!latestJob || new Date(job.startedAt) > new Date(latestJob.startedAt)) {
      latestJob = job;
      latestId = id;
    }
  }
  if (!latestId) return res.send('<html><body style="background:#080a08;color:#39ff14;font-family:monospace;padding:40px;text-align:center"><h1>DECLAY LIVE VIEW</h1><p>Kein aktiver Job. Starte eine Suche in DECLAY!</p></body></html>');
  res.send(getLiveHtml(latestId));
});

function getLiveHtml(jobId) {
  return `<!DOCTYPE html>
<html><head><title>DECLAY Live View</title>
<style>
  body { background: #080a08; color: #39ff14; font-family: monospace; margin: 0; padding: 16px; }
  h1 { font-size: 18px; letter-spacing: 2px; }
  #status { padding: 8px 16px; background: #0f1f0f; border: 1px solid #39ff14; border-radius: 8px; margin: 8px 0; font-size: 14px; }
  #screenshot { max-width: 100%; border: 1px solid #39ff14; border-radius: 4px; margin-top: 8px; }
  .done { color: #22c55e; }
  .error { color: #ef4444; }
</style>
</head><body>
<h1>DECLAY LIVE VIEW</h1>
<div id="status">Verbinde...</div>
<img id="screenshot" src="/view/${jobId}" onerror="this.style.display='none'" />
<script>
  const jobId = '${jobId}';
  const statusEl = document.getElementById('status');
  const imgEl = document.getElementById('screenshot');
  
  async function refresh() {
    try {
      const res = await fetch('/status/' + jobId);
      const job = await res.json();
      statusEl.textContent = 'Schritt ' + job.step + ': ' + job.message;
      statusEl.className = job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : '';
      
      imgEl.src = '/view/' + jobId + '?t=' + Date.now();
      imgEl.style.display = 'block';
      
      if (job.status === 'done') {
        statusEl.textContent += ' ✅';
        if (job.teile && job.teile.length > 0) {
          statusEl.textContent += ' | ' + job.teile.length + ' Teile gefunden!';
        }
        return;
      }
      if (job.status === 'error') {
        statusEl.textContent += ' ❌';
        return;
      }
      
      setTimeout(refresh, 3000);
    } catch(e) {
      statusEl.textContent = 'Warte auf Server...';
      setTimeout(refresh, 5000);
    }
  }
  refresh();
</script>
</body></html>`;
}

// ============================================================
// MAIN PROCESSING
// ============================================================
async function processSearchJob(jobId, vin, teileListe) {
  const job = jobs.get(jobId);
  let browser = null;
  const marke = getMarkeFromVin(vin);

  console.log(`[JOB ${jobId}] Marke: ${marke || 'unbekannt'} | ${teileListe.length} Teile zu suchen`);

  try {
    updateJob(jobId, 'running', 1, 'Verbinde mit Teilekatalog...');
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
      defaultViewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless || 'new',
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    updateJob(jobId, 'running', 2, 'Lade Teilekatalog...');
    await page.goto('https://www.partslink24.com', { waitUntil: 'networkidle2', timeout: 30000 });
    console.log(`[JOB ${jobId}] Partslink24 geladen`);

    const firma = process.env.PARTSLINK_FIRMA || '';
    const user = process.env.PARTSLINK_USER || '';
    const pass = process.env.PARTSLINK_PASS || '';

    // ============================================================
    // PUPPETEER DIREKT-LOGIN (spart 12 API Calls!)
    // ============================================================
    updateJob(jobId, 'running', 3, 'Authentifiziere...');
    console.log(`[JOB ${jobId}] Puppeteer Login startet...`);

    try {
      // Cookie-Banner akzeptieren falls vorhanden
      await page.waitForTimeout(2000);
      try {
        const cookieBtn = await page.$('button[id*="cookie"], button[class*="cookie"], .cc-btn, #onetrust-accept-btn-handler');
        if (cookieBtn) { await cookieBtn.click(); await page.waitForTimeout(1000); }
      } catch(e) {}
      // Auch per Klick auf bekannte Position (unten rechts)
      try { await page.mouse.click(1119, 747); await page.waitForTimeout(1000); } catch(e) {}

      // Login-Felder ausfuellen (rechts auf der Seite)
      // Finde alle Input-Felder
      const inputs = await page.$$('input[type="text"], input[type="password"], input:not([type])');
      console.log(`[JOB ${jobId}] ${inputs.length} Input-Felder gefunden`);
      
      if (inputs.length >= 3) {
        // Methode 1: Direkt ueber gefundene Inputs
        await inputs[0].click();
        await inputs[0].type(firma, { delay: 30 });
        await page.waitForTimeout(300);
        
        await inputs[1].click();
        await inputs[1].type(user, { delay: 30 });
        await page.waitForTimeout(300);
        
        // Passwort-Feld (letztes oder type=password)
        const passInput = await page.$('input[type="password"]') || inputs[2];
        await passInput.click();
        await passInput.type(pass, { delay: 30 });
        await page.waitForTimeout(300);
      } else {
        // Methode 2: Klick auf bekannte Koordinaten (Fallback)
        console.log(`[JOB ${jobId}] Fallback: Klick auf Koordinaten`);
        await page.mouse.click(988, 281); await page.waitForTimeout(500);
        await page.keyboard.type(firma, { delay: 30 }); await page.waitForTimeout(300);
        await page.mouse.click(988, 345); await page.waitForTimeout(500);
        await page.keyboard.type(user, { delay: 30 }); await page.waitForTimeout(300);
        await page.mouse.click(988, 406); await page.waitForTimeout(500);
        await page.keyboard.type(pass, { delay: 30 }); await page.waitForTimeout(300);
      }

      // Login Button klicken
      const loginBtn = await page.$('button[type="submit"], input[type="submit"], .login-button');
      if (loginBtn) {
        await loginBtn.click();
      } else {
        await page.mouse.click(988, 485); // Fallback Koordinate
      }
      
      console.log(`[JOB ${jobId}] Login abgeschickt, warte auf Seite...`);
      await page.waitForTimeout(5000);

      // Pop-up schliessen falls vorhanden
      try {
        const okBtn = await page.$('.modal button, .dialog button, button[type="button"]');
        if (okBtn) { await okBtn.click(); await page.waitForTimeout(2000); }
      } catch(e) {}

      // Screenshot nach Login fuer Live View
      const loginScreenshot = await page.screenshot({ encoding: 'base64', type: 'png' });
      const currentJob1 = jobs.get(jobId);
      if (currentJob1) currentJob1.lastScreenshot = loginScreenshot;

      console.log(`[JOB ${jobId}] Login fertig! Suche Marke: ${marke}`);
      updateJob(jobId, 'running', 4, `Eingeloggt! Suche ${marke}...`);

    } catch (loginErr) {
      console.log(`[JOB ${jobId}] Puppeteer Login Fehler: ${loginErr.message} - Claude uebernimmt`);
    }

    // ============================================================
    // CLAUDE UEBERNIMMT AB HIER
    // ============================================================

    // Teile-Liste als Text formatieren
    const teileText = teileListe.map((t, i) => `${i+1}. ${t}`).join('\n');

    // PROMPT: Claude muss NICHT mehr einloggen!
    const systemPrompt = `Du bist ein erfahrener KFZ-Mechaniker der Partslink24 bedient.
Du siehst den Bildschirm und navigierst wie ein Mensch.

AKTUELLER STAND: Du bist bereits auf partslink24.com. Der Login wurde bereits durchgefuehrt!
Pruefe den Screenshot: Wenn du eingeloggt bist (oben steht "Abmelden"), mache weiter mit der Suche.
Wenn der Login NICHT geklappt hat, logge dich ein:
Firmenkennung: ${firma} | Benutzer: ${user} | Passwort: ${pass}

DEINE AUFGABE:
1. Falls noetig: Klicke auf das Logo der Marke "${marke || 'erkenne die Marke aus der VIN'}".
2. Gib die VIN im Feld "Direkteinstieg" oben links ein: ${vin}
3. Suche nacheinander folgende Teile ueber das Suchfeld "Teile suchen" oben:
${teileText}
4. Fuer jedes Teil: Lies die OE-Nummern ab.
5. Wenn du alle Teile hast, melde dich ab (oben rechts Menue → Abmelden).

WICHTIG - SO LIEST DU OE-NUMMERN AB:
- Nachdem du links ein Suchergebnis angeklickt hast, erscheinen die OE-Nummern RECHTS in der Detailansicht!
- Die rechte Seite zeigt eine Explosionszeichnung und daneben eine Teileliste mit Teilenummern.
- LIES DIE NUMMERN RECHTS AB! Nicht links weiter scrollen oder klicken!
- NUR Teile mit SCHWARZER Schrift passen zum Fahrzeug! GRAUE Schrift ignorieren!
- Suche Teile OHNE "VA" oder "HA" - nur z.B. "Bremsscheibe" nicht "Bremsscheibe VA"

ERGEBNIS SOFORT MELDEN - Teil fuer Teil:
Sobald du die OE-Nummern fuer EIN Teil gefunden hast, melde es SOFORT mit:
TEIL_GEFUNDEN: {"oe_nummer": "5Q0 615 301 H", "bezeichnung": "Bremsscheibe vorne"}
Dann suche das naechste Teil!

Wenn du ALLE Teile gesucht hast, gib die komplette Liste aus:
ERGEBNIS_START
{"teile": [
  {"oe_nummer": "5Q0 615 301 H", "bezeichnung": "Bremsscheibe vorne", "preis": "", "hersteller": "OE"},
  {"oe_nummer": "5K0 698 151", "bezeichnung": "Bremsbelag vorne", "preis": "", "hersteller": "OE"}
]}
ERGEBNIS_ENDE

Auch Teilergebnisse sind OK! Lieber 3 von 5 Nummern liefern als gar keine.
ABER: Suche ZUERST ALLE Teile durch bevor du ERGEBNIS_START ausgibst!
Wenn du ein Teil gefunden hast, melde es mit TEIL_GEFUNDEN und suche das naechste Teil.
Erst wenn du alle Teile gesucht hast ODER nicht weiterkommst, gib ERGEBNIS_START aus.`;

    updateJob(jobId, 'running', 5, 'Suche Teile...');

    let messages = [{
      role: 'user',
      content: `Du bist auf partslink24.com. Der Login wurde bereits durchgefuehrt. Mache einen Screenshot um zu sehen wo du bist. Falls du eingeloggt bist, suche diese Teile fuer VIN ${vin} (${marke || 'Marke aus VIN erkennen'}):\n${teileText}\n\nFalls du NICHT eingeloggt bist, logge dich zuerst ein.`
    }];
    
    let maxIterations = 50;
    let iteration = 0;
    let result = null;

    while (iteration < maxIterations) {
      iteration++;
      updateJob(jobId, 'running', 3 + iteration, `Analysiere Katalog...`);
      console.log(`[JOB ${jobId}] Iteration ${iteration}`);

      // Rate Limit Schutz
      if (iteration > 1) {
        console.log(`[JOB ${jobId}] Warte 10 Sekunden...`);
        updateJob(jobId, 'running', 3 + iteration, `Identifiziere OE-Nummern...`);
        await new Promise(r => setTimeout(r, 10000));
      }

      // Konversation kuerzen: 15 statt 9 Messages behalten
      if (messages.length > 15) {
        messages = [messages[0], ...messages.slice(-14)];
        console.log(`[JOB ${jobId}] Konversation gekuerzt auf ${messages.length}`);
      }

      // Claude API Call mit Retry (429 Rate Limit + 529 Overloaded + fetch failed)
      let apiResponse = null;
      for (let retry = 0; retry < 3; retry++) {
        try {
          apiResponse = await callClaudeComputerUse(systemPrompt, messages);
          break;
        } catch (err) {
          if ((err.message.includes('429') || err.message.includes('529') || err.message.includes('fetch failed')) && retry < 2) {
            const waitTime = err.message.includes('529') ? 30 : err.message.includes('fetch') ? 30 : 65;
            const reason = err.message.includes('529') ? 'Server ueberlastet' : err.message.includes('fetch') ? 'Verbindungsfehler' : 'Rate Limit';
            console.log(`[JOB ${jobId}] ${reason}! Warte ${waitTime}s (Retry ${retry + 1})`);
            updateJob(jobId, 'running', 3 + iteration, `${reason} - warte ${waitTime}s... (Retry ${retry + 1})`);
            await new Promise(r => setTimeout(r, waitTime * 1000));
          } else { throw err; }
        }
      }
      
      if (!apiResponse || !apiResponse.content) throw new Error('Keine Antwort vom Server');
      console.log(`[JOB ${jobId}] Stop reason: ${apiResponse.stop_reason}`);

      // Check for results in text
      const textBlocks = apiResponse.content.filter(b => b.type === 'text');
      for (const tb of textBlocks) {
        console.log(`[JOB ${jobId}] Text: ${tb.text.substring(0, 200)}...`);
        
        // TEIL_GEFUNDEN: Sofort zum Job hinzufuegen (stoppt NICHT die Suche!)
        const teilMatches = [...tb.text.matchAll(/TEIL_GEFUNDEN:\s*(\{[^}]+\})/g)];
        for (const tm of teilMatches) {
          try {
            const teil = JSON.parse(tm[1]);
            const currentJob = jobs.get(jobId);
            if (currentJob && teil.oe_nummer) {
              // Duplikate vermeiden
              const exists = currentJob.teile.some(t => t.oe_nummer === teil.oe_nummer);
              if (!exists) {
                currentJob.teile.push({ oe_nummer: teil.oe_nummer, bezeichnung: teil.bezeichnung || '', preis: '', hersteller: 'OE' });
                console.log(`[JOB ${jobId}] TEIL LIVE: ${teil.oe_nummer} - ${teil.bezeichnung}`);
                updateJob(jobId, 'running', 3 + iteration, `${currentJob.teile.length} Teile gefunden - suche weiter...`);
              }
            }
          } catch(e) { console.log(`[JOB ${jobId}] TEIL_GEFUNDEN Parse Fehler`); }
        }
        
        // ERGEBNIS_START: Alle Teile auf einmal (stoppt die Suche)
        const match = tb.text.match(/ERGEBNIS_START\s*([\s\S]*?)\s*ERGEBNIS_ENDE/);
        if (match) {
          try { 
            const parsed = JSON.parse(match[1]);
            // Merge mit bereits gefundenen Teilen
            const currentJob = jobs.get(jobId);
            if (currentJob && currentJob.teile.length > 0) {
              // Neue Teile aus ERGEBNIS hinzufuegen die noch nicht da sind
              for (const t of parsed.teile) {
                const exists = currentJob.teile.some(x => x.oe_nummer === t.oe_nummer);
                if (!exists) currentJob.teile.push(t);
              }
              result = { teile: currentJob.teile };
            } else {
              result = parsed;
            }
            console.log(`[JOB ${jobId}] ERGEBNIS: ${result.teile.length} Teile gefunden!`);
          } catch (e) { 
            console.log(`[JOB ${jobId}] JSON Parse Fehler: ${e.message}`); 
          }
        }
        
        // BACKUP: OE-Nummern aus Claudes Text sammeln (laufend!)
        const foundInText = extractOeFromText(tb.text);
        if (foundInText.teile.length > 0) {
          const currentJob = jobs.get(jobId);
          if (currentJob) {
            for (const t of foundInText.teile) {
              const exists = currentJob.teile.some(x => x.oe_nummer === t.oe_nummer);
              if (!exists) {
                currentJob.teile.push(t);
                console.log(`[JOB ${jobId}] AUTO-SAMMLUNG: ${t.oe_nummer}`);
              }
            }
          }
        }
        
        // AUTO-EXTRAKT: Ab Iteration 20 OE-Nummern direkt aus Claudes Text extrahieren
        if (!result && iteration >= 20) {
          const autoExtract = extractOeFromText(tb.text);
          if (autoExtract.teile.length > 0) {
            const currentJob = jobs.get(jobId);
            if (currentJob) {
              for (const t of autoExtract.teile) {
                const exists = currentJob.teile.some(x => x.oe_nummer === t.oe_nummer);
                if (!exists) {
                  currentJob.teile.push(t);
                  console.log(`[JOB ${jobId}] AUTO-EXTRAKT LIVE: ${t.oe_nummer}`);
                }
              }
              updateJob(jobId, 'running', 3 + iteration, `${currentJob.teile.length} OE-Nummern gefunden - suche weiter...`);
            }
          }
        }
        
        // Ab Iteration 30: Wenn wir gesammelte Nummern haben, Ergebnis liefern
        if (!result && iteration >= 30) {
          const currentJob = jobs.get(jobId);
          if (currentJob && currentJob.teile.length > 0) {
            console.log(`[JOB ${jobId}] AUTO-EXTRAKT FERTIG: ${currentJob.teile.length} OE-Nummern!`);
            result = { teile: currentJob.teile };
          }
        }
      }
      if (result) break;

      // End if no more tool calls
      const toolUseBlocks = apiResponse.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) {
        console.log(`[JOB ${jobId}] Keine Tool-Aufrufe mehr`);
        const allText = textBlocks.map(b => b.text).join('\n');
        result = extractOeFromText(allText);
        break;
      }

      // Execute actions
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        const action = toolUse.input;
        
        // Passwort maskieren
        const logText = (action.text === pass) ? '****' : (action.text || '');
        console.log(`[JOB ${jobId}] Aktion: ${action.action}`, action.coordinate || logText);
        updateJob(jobId, 'running', 3 + iteration, describeAction(action, pass));

        await executeAction(page, action);

        const screenshot = await page.screenshot({ encoding: 'base64', type: 'png', fullPage: false });
        
        // Screenshot im Job speichern fuer Live-View
        const currentJob = jobs.get(jobId);
        if (currentJob) currentJob.lastScreenshot = screenshot;
        
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } }]
        });
      }

      messages.push({ role: 'assistant', content: apiResponse.content });
      messages.push({ role: 'user', content: toolResults });
    }

    await browser.close();
    browser = null;

    if (result && result.teile && result.teile.length > 0) {
      updateJob(jobId, 'done', iteration, `${result.teile.length} Teile gefunden!`);
      job.teile = result.teile;
    } else {
      updateJob(jobId, 'done', iteration, 'Suche abgeschlossen');
      job.teile = result?.teile || [];
    }

  } catch (error) {
    console.error(`[JOB ${jobId}] Fehler:`, error.message);
    updateJob(jobId, 'error', 0, error.message);
    job.error = error.message;
  } finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
  }
}

// ============================================================
// CLAUDE API CALL
// ============================================================
async function callClaudeComputerUse(systemPrompt, messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'computer-use-2025-11-24'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      tools: [{ type: 'computer_20251124', name: 'computer', display_width_px: DISPLAY_WIDTH, display_height_px: DISPLAY_HEIGHT, display_number: 1 }],
      messages: messages
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API Fehler ${response.status}`);
  }
  return await response.json();
}

// ============================================================
// EXECUTE BROWSER ACTION
// ============================================================
async function executeAction(page, action) {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  try {
    switch (action.action) {
      case 'screenshot': break;
      case 'left_click':
        if (action.coordinate) { await page.mouse.click(action.coordinate[0], action.coordinate[1]); await delay(1500); }
        break;
      case 'right_click':
        if (action.coordinate) { await page.mouse.click(action.coordinate[0], action.coordinate[1], { button: 'right' }); await delay(500); }
        break;
      case 'double_click':
        if (action.coordinate) { await page.mouse.click(action.coordinate[0], action.coordinate[1], { clickCount: 2 }); await delay(500); }
        break;
      case 'triple_click':
        if (action.coordinate) { await page.mouse.click(action.coordinate[0], action.coordinate[1], { clickCount: 3 }); await delay(500); }
        break;
      case 'type':
        if (action.text) { await page.keyboard.type(action.text, { delay: 50 }); await delay(500); }
        break;
      case 'key':
        if (action.text) {
          const keys = action.text.split('+');
          if (keys.length > 1) {
            for (let i = 0; i < keys.length - 1; i++) await page.keyboard.down(mapKey(keys[i].trim()));
            await page.keyboard.press(mapKey(keys[keys.length - 1].trim()));
            for (let i = keys.length - 2; i >= 0; i--) await page.keyboard.up(mapKey(keys[i].trim()));
          } else { await page.keyboard.press(mapKey(action.text)); }
          await delay(500);
        }
        break;
      case 'mouse_move':
        if (action.coordinate) { await page.mouse.move(action.coordinate[0], action.coordinate[1]); await delay(300); }
        break;
      case 'scroll':
        if (action.coordinate) await page.mouse.move(action.coordinate[0], action.coordinate[1]);
        const amt = action.amount || 3;
        const dir = action.direction || 'down';
        const dY = dir === 'down' ? amt * 100 : dir === 'up' ? -amt * 100 : 0;
        const dX = dir === 'right' ? amt * 100 : dir === 'left' ? -amt * 100 : 0;
        await page.mouse.wheel({ deltaX: dX, deltaY: dY });
        await delay(800);
        break;
      case 'wait':
        await delay((action.duration || 2) * 1000);
        break;
      case 'cursor_position': break;
      default: console.log(`Unbekannte Aktion: ${action.action}`);
    }
  } catch (err) {
    console.log(`Aktion Fehler (${action.action}): ${err.message}`);
  }
}

// ============================================================
// HELPERS
// ============================================================
function mapKey(key) {
  const m = { 'Return':'Enter','return':'Enter','enter':'Enter','space':' ','Space':' ',
    'ctrl':'Control','Ctrl':'Control','alt':'Alt','shift':'Shift','tab':'Tab','Tab':'Tab',
    'escape':'Escape','Escape':'Escape','backspace':'Backspace','Backspace':'Backspace',
    'delete':'Delete','Delete':'Delete','Page_Down':'PageDown','Page_Up':'PageUp',
    'Home':'Home','End':'End','F5':'F5',
    'ArrowUp':'ArrowUp','ArrowDown':'ArrowDown','ArrowLeft':'ArrowLeft','ArrowRight':'ArrowRight' };
  return m[key] || key;
}

function describeAction(action, password) {
  // Neutrale Beschreibungen - keine Browser-Aktionen zeigen
  switch (action.action) {
    case 'screenshot': return 'Analysiere...';
    case 'left_click': return 'Verarbeite...';
    case 'type': return 'Suche Daten...';
    case 'key': return 'Verarbeite...';
    case 'scroll': return 'Durchsuche Katalog...';
    case 'wait': return 'Warte auf Antwort...';
    default: return 'Verarbeite...';
  }
}

function extractOeFromText(text) {
  // Markdown Formatierung entfernen (Claude schreibt **1K0 615 601 AA**)
  const cleanText = text.replace(/\*\*/g, '').replace(/\*/g, '');
  
  const patterns = [
    /\b\d{1,2}[A-Z]\d{1,2}\s?\d{3}\s?\d{3}\s?[A-Z]{0,2}\b/g,
    /\b[A-Z]{1,3}\s?\d{3}\s?\d{3}\s?[A-Z]{0,2}\b/g,
    /\b\d{4}\.[A-Z]\d\b/g,
    /\b\d{2}\.\d{2}\.\d\.\d{3}\.\d{3}\b/g,
  ];
  const found = new Set();
  for (const p of patterns) {
    const m = cleanText.match(p);
    if (m) m.forEach(x => {
      const clean = x.replace(/\s+/g, ' ').trim();
      if (clean.length >= 9) found.add(clean);
    });
  }
  return { teile: Array.from(found).map(oe => ({ oe_nummer: oe, bezeichnung: '', preis: '', hersteller: 'OE' })) };
}

function updateJob(jobId, status, step, message) {
  const job = jobs.get(jobId);
  if (job) { job.status = status; job.step = step; job.message = message; }
  console.log(`[JOB ${jobId}] Step ${step}: ${message}`);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`DECLAY Partslink Navigator v7.4 auf Port ${PORT}`);
  console.log(`Einfacher Prompt | Teile-Liste | 15 Messages Kontext | Retry 429`);
});
