const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// DECLAY Partslink Navigator v7.3
// Optimierter Flow basierend auf echtem Partslink Walkthrough
// + Passwort maskiert
// + 50 Iterationen
// + Retry bei 429
// + Intelligente Bauteil-Suche
// ============================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 800;

const jobs = new Map();
let activeJob = false;

// VIN Prefix → Markenname fuer Logo-Erkennung
const VIN_MARKEN = {
  'WBA': 'BMW', 'WBS': 'BMW', 'WBY': 'BMW',
  'WVW': 'Volkswagen', 'WVG': 'Volkswagen',
  'WMW': 'MINI',
  'WF0': 'Ford',
  'WAU': 'Audi', 'WUA': 'Audi',
  'WDB': 'Mercedes', 'WDC': 'Mercedes', 'WDD': 'Mercedes',
  'W0L': 'Opel',
  'TMB': 'Skoda',
  'VF1': 'Renault',
  'VF7': 'Citroen',
  'VF3': 'Peugeot',
  'ZFA': 'Fiat',
  'SUZ': 'Suzuki',
  'SAL': 'Land Rover', 'SAJ': 'Jaguar',
  'YV1': 'Volvo',
  'KNA': 'Kia', 'KNE': 'Kia',
  'KMH': 'Hyundai',
  'JTD': 'Toyota', 'SB1': 'Toyota',
  'VSS': 'SEAT',
  'TRU': 'Audi',
  'UU1': 'Dacia',
  'VNK': 'Toyota',
  'WP0': 'Porsche', 'WP1': 'Porsche',
};

// Bauteil-Suchbegriff optimieren (VA/HA entfernen)
function cleanBauteil(bauteil) {
  return bauteil
    .replace(/\bVA\b/gi, '')
    .replace(/\bHA\b/gi, '')
    .replace(/\bvorne?\b/gi, '')
    .replace(/\bhinten?\b/gi, '')
    .replace(/\bVorderachse\b/gi, '')
    .replace(/\bHinterachse\b/gi, '')
    .replace(/\bBelaege\b/gi, 'Bremsbelag')
    .replace(/\bBeläge\b/gi, 'Bremsbelag')
    .trim();
}

// Achse aus Original-Bauteil erkennen
function getAchse(bauteil) {
  const lower = bauteil.toLowerCase();
  if (lower.includes('va') || lower.includes('vorn') || lower.includes('vorderachse')) return 'vorne';
  if (lower.includes('ha') || lower.includes('hinten') || lower.includes('hinterachse')) return 'hinten';
  return 'vorne'; // Default
}

function getMarkeFromVin(vin) {
  if (!vin || vin.length < 3) return null;
  const prefix3 = vin.substring(0, 3).toUpperCase();
  if (VIN_MARKEN[prefix3]) return VIN_MARKEN[prefix3];
  const prefix2 = vin.substring(0, 2).toUpperCase();
  for (const [key, val] of Object.entries(VIN_MARKEN)) {
    if (key.startsWith(prefix2)) return val;
  }
  return null;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DECLAY v7.3', jobs: jobs.size, busy: activeJob });
});

app.post('/search', (req, res) => {
  const { vin, bauteil } = req.body;
  if (!vin || !bauteil) return res.status(400).json({ error: 'VIN und Bauteil erforderlich' });
  if (activeJob) return res.status(429).json({ error: 'Ein Job laeuft bereits. Bitte warten.' });

  const jobId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  jobs.set(jobId, { status: 'starting', step: 0, message: 'Starte...', teile: [], error: null, startedAt: new Date().toISOString() });
  console.log(`[JOB ${jobId}] Gestartet: VIN=${vin} Bauteil=${bauteil}`);
  activeJob = true;

  processSearchJob(jobId, vin, bauteil).catch(err => {
    console.error(`[JOB ${jobId}] Fataler Fehler:`, err.message);
    const job = jobs.get(jobId);
    if (job) { job.status = 'error'; job.error = err.message; }
  }).finally(() => { activeJob = false; });

  res.json({ jobId });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });
  res.json(job);
});

// ============================================================
// MAIN PROCESSING
// ============================================================
async function processSearchJob(jobId, vin, bauteil) {
  const job = jobs.get(jobId);
  let browser = null;

  const suchbegriff = cleanBauteil(bauteil);
  const achse = getAchse(bauteil);
  const marke = getMarkeFromVin(vin);
  
  console.log(`[JOB ${jobId}] Suchbegriff: "${suchbegriff}" | Achse: ${achse} | Marke: ${marke || 'unbekannt'}`);

  try {
    updateJob(jobId, 'running', 1, 'Browser wird gestartet...');
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
      defaultViewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless || 'new',
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    updateJob(jobId, 'running', 2, 'Oeffne Partslink24...');
    await page.goto('https://www.partslink24.com', { waitUntil: 'networkidle2', timeout: 30000 });
    console.log(`[JOB ${jobId}] Partslink24 geladen`);

    updateJob(jobId, 'running', 3, 'Claude navigiert...');
    
    const firma = process.env.PARTSLINK_FIRMA || '';
    const user = process.env.PARTSLINK_USER || '';
    const pass = process.env.PARTSLINK_PASS || '';

    const systemPrompt = `Du bist ein KFZ-Teile Experte der Partslink24 navigiert.
Du siehst Screenshots und steuerst den Browser mit Klicks und Tastatureingaben.

EXAKTER ABLAUF - FOLGE DIESEN SCHRITTEN:

SCHRITT 1 - LOGIN (rechts oben auf der Seite):
Die Login-Felder sind rechts oben. Dort stehen 3 Eingabefelder untereinander:
- "Firmenkennung / ID:" → Klick ins Feld, tippe: ${firma}
- "Benutzername:" → Klick ins Feld, tippe: ${user}
- "Passwort:" → Klick ins Feld, tippe: ${pass}
- Dann klick den "Login" Button darunter.
WICHTIG: Die Felder sind RECHTS auf der Seite, nicht links! Klicke DIREKT ins jeweilige Feld!

SCHRITT 2 - POP-UP:
Nach dem Login kommt oft ein Pop-up mit einem "OK" Button. Klicke auf "OK" um es zu schliessen.

SCHRITT 3 - MARKE WAEHLEN:
Du siehst Marken-Logos (BMW, VW, Skoda, etc.). 
Die Marke fuer VIN ${vin} ist: ${marke || 'aus der VIN ableiten'}.
Klicke auf das richtige Marken-Logo!

SCHRITT 4 - VIN EINGEBEN:
Nach dem Klick auf die Marke siehst du oben links ein Feld "Direkteinstieg" mit einer Lupe.
Klicke in dieses Feld und tippe die VIN: ${vin}
Dann klicke auf die Lupe daneben oder druecke Enter.

SCHRITT 5 - FAHRZEUG BESTAETIGEN:
Es oeffnet sich ein Fenster "Fahrzeugidentifikation" mit den Fahrzeugdaten.
Wenn ein ">" Pfeil oder "weiter" Button sichtbar ist, klicke darauf.
Eventuell kommt noch eine Fahrzeugauswahl - waehle das passende Modell.

SCHRITT 6 - TEIL SUCHEN:
Oben in der Mitte/rechts gibt es ein Suchfeld "Teile suchen".
Klicke hinein und tippe: ${suchbegriff}
Dann klicke auf die Lupe oder druecke Enter.
WICHTIG: Suche NUR nach "${suchbegriff}" - NICHT nach "VA" oder "HA"!

SCHRITT 7 - ERGEBNISSE LESEN:
Links erscheint eine Liste mit Teilenummern und Benennung.
Klicke auf einen Eintrag der "${suchbegriff}" in der Benennung hat.
Rechts erscheint dann eine Detailansicht mit Explosionszeichnung und Teileliste.

SCHRITT 8 - OE-NUMMERN PRUEFEN:
In der rechten Teileliste stehen die OE-Nummern.
WICHTIG: Nur Teile mit SCHWARZER Schrift passen zu diesem Fahrzeug!
Teile mit GRAUER Schrift passen NICHT - diese ignorieren!
Achte auf die Bemerkung "${achse}" oder "vorn"/"hinten".

Lies alle passenden OE-Nummern ab (nur schwarze Schrift!) und gib sie zurueck.

WENN DU FERTIG BIST, antworte mit:
ERGEBNIS_START
{"teile": [{"oe_nummer": "...", "bezeichnung": "...", "preis": "...", "hersteller": "..."}]}
ERGEBNIS_ENDE

REGELN:
- Mache zuerst einen Screenshot um zu sehen wo du bist
- Sei schnell und direkt - nicht herumscrollen wenn nicht noetig
- Wenn ein Pop-up kommt, klicke OK oder schliesse es
- Wenn du nicht weiterkommst, mache einen Screenshot und analysiere neu
- Gib nach spaetestens 40 Schritten das bisherige Ergebnis aus, auch wenn unvollstaendig`;

    let messages = [{ 
      role: 'user', 
      content: `Du bist auf partslink24.com. Mache einen Screenshot und beginne mit dem Login (rechts oben auf der Seite). Danach suche "${suchbegriff}" fuer VIN: ${vin} (${marke || 'Marke aus VIN ableiten'}).` 
    }];
    
    let maxIterations = 50;
    let iteration = 0;
    let result = null;

    while (iteration < maxIterations) {
      iteration++;
      updateJob(jobId, 'running', 3 + iteration, `Claude Schritt ${iteration}...`);
      console.log(`[JOB ${jobId}] Iteration ${iteration}`);

      // Rate Limit Schutz
      if (iteration > 1) {
        console.log(`[JOB ${jobId}] Warte 10 Sekunden...`);
        updateJob(jobId, 'running', 3 + iteration, `Navigiere... (Schritt ${iteration})`);
        await new Promise(r => setTimeout(r, 10000));
      }

      // Konversation kuerzen
      if (messages.length > 9) {
        messages = [messages[0], ...messages.slice(-8)];
        console.log(`[JOB ${jobId}] Konversation gekuerzt`);
      }

      // Claude API Call mit Retry
      let apiResponse = null;
      for (let retry = 0; retry < 3; retry++) {
        try {
          apiResponse = await callClaudeComputerUse(systemPrompt, messages);
          break;
        } catch (err) {
          if (err.message.includes('429') && retry < 2) {
            console.log(`[JOB ${jobId}] Rate Limit! Warte 65s (Retry ${retry + 1})`);
            updateJob(jobId, 'running', 3 + iteration, `Rate Limit - warte... (Retry ${retry + 1})`);
            await new Promise(r => setTimeout(r, 65000));
          } else { throw err; }
        }
      }
      
      if (!apiResponse || !apiResponse.content) throw new Error('Keine Antwort von Claude API');
      console.log(`[JOB ${jobId}] Stop reason: ${apiResponse.stop_reason}`);

      // Check for results
      const textBlocks = apiResponse.content.filter(b => b.type === 'text');
      for (const tb of textBlocks) {
        const match = tb.text.match(/ERGEBNIS_START\s*([\s\S]*?)\s*ERGEBNIS_ENDE/);
        if (match) {
          try { result = JSON.parse(match[1]); console.log(`[JOB ${jobId}] Ergebnis gefunden!`); } 
          catch (e) { console.log(`[JOB ${jobId}] JSON Parse Fehler`); }
        }
      }
      if (result) break;

      // End if no more tool calls
      const toolUseBlocks = apiResponse.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) {
        const allText = textBlocks.map(b => b.text).join('\n');
        result = extractOeFromText(allText);
        break;
      }

      // Execute actions
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        const action = toolUse.input;
        
        // Passwort maskieren in Logs
        const logText = (action.text === pass) ? '****' : (action.text || '');
        console.log(`[JOB ${jobId}] Aktion: ${action.action}`, action.coordinate || logText);
        updateJob(jobId, 'running', 3 + iteration, describeAction(action, pass));

        await executeAction(page, action);

        const screenshot = await page.screenshot({ encoding: 'base64', type: 'png', fullPage: false });
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
    throw new Error(`Claude API ${response.status}: ${errText}`);
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
  const safeText = (action.text === password) ? '****' : (action.text || '');
  switch (action.action) {
    case 'screenshot': return 'Screenshot...';
    case 'left_click': return `Klick (${action.coordinate?.join(',')})`;
    case 'type': return `Tippe "${safeText.substring(0, 20)}"`;
    case 'key': return `Taste ${action.text}`;
    case 'scroll': return `Scroll ${action.direction || 'down'}`;
    case 'wait': return 'Warte...';
    default: return action.action;
  }
}

function extractOeFromText(text) {
  const patterns = [
    /\b\d{1,2}[A-Z]\d{1,2}\s?\d{3}\s?\d{3}\s?[A-Z]{0,2}\b/g,
    /\b[A-Z]{1,3}\s?\d{3}\s?\d{3}\s?[A-Z]{0,2}\b/g,
    /\b\d{4}\.[A-Z]\d\b/g,
    /\b\d{2}\.\d{2}\.\d\.\d{3}\.\d{3}\b/g,
  ];
  const found = new Set();
  for (const p of patterns) {
    const m = text.match(p);
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
  console.log(`DECLAY Partslink Navigator v7.3 auf Port ${PORT}`);
  console.log(`Optimierter Flow | PW maskiert | 50 Iterationen | Retry 429`);
});
