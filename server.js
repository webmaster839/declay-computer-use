const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// DECLAY Partslink Navigator v7.2
// + Retry bei Rate Limit (429)
// + Konversation kuerzen (max 4 Austausche)
// + Nur 1 Job gleichzeitig
// ============================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 800;

const jobs = new Map();
let activeJob = false; // Nur 1 Job gleichzeitig

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DECLAY Partslink Navigator v7.2', jobs: jobs.size, busy: activeJob });
});

app.post('/search', (req, res) => {
  const { vin, bauteil } = req.body;
  if (!vin || !bauteil) {
    return res.status(400).json({ error: 'VIN und Bauteil erforderlich' });
  }

  if (activeJob) {
    return res.status(429).json({ error: 'Ein Job laeuft bereits. Bitte warten.' });
  }

  const jobId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  
  jobs.set(jobId, {
    status: 'starting',
    step: 0,
    message: 'Starte Partslink Navigation...',
    teile: [],
    error: null,
    startedAt: new Date().toISOString()
  });

  console.log(`[JOB ${jobId}] Gestartet: VIN=${vin} Bauteil=${bauteil}`);
  activeJob = true;

  processSearchJob(jobId, vin, bauteil).catch(err => {
    console.error(`[JOB ${jobId}] Fataler Fehler:`, err.message);
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = err.message;
    }
  }).finally(() => {
    activeJob = false;
  });

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

  try {
    updateJob(jobId, 'running', 1, 'Browser wird gestartet...');
    
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ],
      defaultViewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless || 'new',
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    updateJob(jobId, 'running', 2, 'Oeffne Partslink24...');
    await page.goto('https://www.partslink24.com', { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    
    console.log(`[JOB ${jobId}] Partslink24 geladen`);
    updateJob(jobId, 'running', 3, 'Claude navigiert Partslink24...');
    
    const firma = process.env.PARTSLINK_FIRMA || '';
    const user = process.env.PARTSLINK_USER || '';
    const pass = process.env.PARTSLINK_PASS || '';

    const systemPrompt = `Du bist ein KFZ-Teile Experte der Partslink24 navigiert.
Du siehst den Bildschirm und kannst klicken, tippen und navigieren.

ZIEL:
1. Einloggen: Firmenkennung: ${firma}, Benutzer: ${user}, Passwort: ${pass}
2. Fahrzeug mit VIN "${vin}" suchen
3. Baugruppe "${bauteil}" finden
4. OE-Nummern auslesen

REGELN:
- Mache zuerst einen Screenshot
- Klicke praezise auf Felder und Buttons
- Navigiere durch den Katalog zum Bauteil

WENN FERTIG, antworte:
ERGEBNIS_START
{"teile": [{"oe_nummer": "...", "bezeichnung": "...", "preis": "...", "hersteller": "..."}]}
ERGEBNIS_ENDE`;

    let messages = [{ 
      role: 'user', 
      content: `Finde OE-Nummern fuer "${bauteil}" am Fahrzeug VIN: ${vin}. Mache zuerst einen Screenshot.` 
    }];
    
    let maxIterations = 30;
    let iteration = 0;
    let result = null;

    while (iteration < maxIterations) {
      iteration++;
      updateJob(jobId, 'running', 3 + iteration, `Claude Schritt ${iteration}...`);
      console.log(`[JOB ${jobId}] Iteration ${iteration}`);

      // Rate Limit Schutz: 10 Sekunden Pause
      if (iteration > 1) {
        console.log(`[JOB ${jobId}] Warte 10 Sekunden...`);
        updateJob(jobId, 'running', 3 + iteration, `Navigiere... (Schritt ${iteration})`);
        await new Promise(r => setTimeout(r, 10000));
      }

      // Konversation kuerzen: nur letzte 4 Austausche behalten
      // (1 user + 1 assistant + 1 tool_result = 1 Austausch)
      if (messages.length > 9) {
        // Behalte erste Nachricht + letzte 8
        messages = [messages[0], ...messages.slice(-8)];
        console.log(`[JOB ${jobId}] Konversation gekuerzt auf ${messages.length} Nachrichten`);
      }

      // Claude API Call mit Retry
      let apiResponse = null;
      for (let retry = 0; retry < 3; retry++) {
        try {
          apiResponse = await callClaudeComputerUse(systemPrompt, messages);
          break; // Erfolg
        } catch (err) {
          if (err.message.includes('429') && retry < 2) {
            const waitTime = 65; // 65 Sekunden warten bei Rate Limit
            console.log(`[JOB ${jobId}] Rate Limit! Warte ${waitTime} Sekunden... (Retry ${retry + 1})`);
            updateJob(jobId, 'running', 3 + iteration, `Rate Limit - warte ${waitTime}s... (Retry ${retry + 1})`);
            await new Promise(r => setTimeout(r, waitTime * 1000));
          } else {
            throw err;
          }
        }
      }
      
      if (!apiResponse || !apiResponse.content) {
        throw new Error('Keine Antwort von Claude API');
      }

      console.log(`[JOB ${jobId}] Stop reason: ${apiResponse.stop_reason}`);

      // Check for results
      const textBlocks = apiResponse.content.filter(b => b.type === 'text');
      for (const tb of textBlocks) {
        const match = tb.text.match(/ERGEBNIS_START\s*([\s\S]*?)\s*ERGEBNIS_ENDE/);
        if (match) {
          try {
            result = JSON.parse(match[1]);
            console.log(`[JOB ${jobId}] Ergebnis gefunden!`, JSON.stringify(result));
          } catch (e) {
            console.log(`[JOB ${jobId}] JSON Parse Fehler:`, e.message);
          }
        }
      }

      if (result) break;

      const toolUseBlocks = apiResponse.content.filter(b => b.type === 'tool_use');
      
      if (toolUseBlocks.length === 0) {
        console.log(`[JOB ${jobId}] Keine weiteren Tool-Aufrufe`);
        const allText = textBlocks.map(b => b.text).join('\n');
        result = extractOeFromText(allText);
        break;
      }

      // Execute actions
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        const action = toolUse.input;
        console.log(`[JOB ${jobId}] Aktion: ${action.action}`, action.coordinate || action.text || '');
        updateJob(jobId, 'running', 3 + iteration, describeAction(action));

        await executeAction(page, action);

        const screenshot = await page.screenshot({ 
          encoding: 'base64', 
          type: 'png',
          fullPage: false
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: [{
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: screenshot
            }
          }]
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
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
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
      tools: [{
        type: 'computer_20251124',
        name: 'computer',
        display_width_px: DISPLAY_WIDTH,
        display_height_px: DISPLAY_HEIGHT,
        display_number: 1
      }],
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
        if (action.coordinate) {
          await page.mouse.click(action.coordinate[0], action.coordinate[1]);
          await delay(1500);
        }
        break;
      case 'right_click':
        if (action.coordinate) {
          await page.mouse.click(action.coordinate[0], action.coordinate[1], { button: 'right' });
          await delay(500);
        }
        break;
      case 'double_click':
        if (action.coordinate) {
          await page.mouse.click(action.coordinate[0], action.coordinate[1], { clickCount: 2 });
          await delay(500);
        }
        break;
      case 'triple_click':
        if (action.coordinate) {
          await page.mouse.click(action.coordinate[0], action.coordinate[1], { clickCount: 3 });
          await delay(500);
        }
        break;
      case 'type':
        if (action.text) {
          await page.keyboard.type(action.text, { delay: 50 });
          await delay(500);
        }
        break;
      case 'key':
        if (action.text) {
          const keys = action.text.split('+');
          if (keys.length > 1) {
            for (let i = 0; i < keys.length - 1; i++) await page.keyboard.down(mapKey(keys[i].trim()));
            await page.keyboard.press(mapKey(keys[keys.length - 1].trim()));
            for (let i = keys.length - 2; i >= 0; i--) await page.keyboard.up(mapKey(keys[i].trim()));
          } else {
            await page.keyboard.press(mapKey(action.text));
          }
          await delay(500);
        }
        break;
      case 'mouse_move':
        if (action.coordinate) {
          await page.mouse.move(action.coordinate[0], action.coordinate[1]);
          await delay(300);
        }
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
      default:
        console.log(`Unbekannte Aktion: ${action.action}`);
    }
  } catch (err) {
    console.log(`Aktion Fehler: ${err.message}`);
  }
}

// ============================================================
// HELPERS
// ============================================================
function mapKey(key) {
  const m = { 'Return':'Enter','return':'Enter','enter':'Enter','space':' ','Space':' ',
    'ctrl':'Control','Ctrl':'Control','alt':'Alt','shift':'Shift','tab':'Tab','Tab':'Tab',
    'escape':'Escape','Escape':'Escape','backspace':'Backspace','Backspace':'Backspace',
    'delete':'Delete','Delete':'Delete','Page_Down':'PageDown','Page_Up':'PageUp' };
  return m[key] || key;
}

function describeAction(a) {
  const d = { 'screenshot':'Screenshot...','left_click':`Klick (${a.coordinate?.join(',')})`,
    'type':`Tippe "${(a.text||'').substring(0,20)}"`, 'key':`Taste ${a.text}`,
    'scroll':`Scroll ${a.direction||'down'}`, 'wait':'Warte...' };
  return d[a.action] || a.action;
}

function extractOeFromText(text) {
  const patterns = [/\b\d{1,2}[A-Z]\d{1,2}\s?\d{3}\s?\d{3}\s?[A-Z]?\b/g,
    /\b\d{4}\.[A-Z]\d\b/g, /\b\d{2}\.\d{2}\.\d\.\d{3}\.\d{3}\b/g, /\b[A-Z]{2}\d{5,8}[A-Z]?\b/g];
  const found = new Set();
  for (const p of patterns) { const m = text.match(p); if (m) m.forEach(x => found.add(x.replace(/\s+/g,''))); }
  return { teile: Array.from(found).map(oe => ({ oe_nummer: oe, bezeichnung: '', preis: '', hersteller: 'OE' })) };
}

function updateJob(jobId, status, step, message) {
  const job = jobs.get(jobId);
  if (job) { job.status = status; job.step = step; job.message = message; }
  console.log(`[JOB ${jobId}] Step ${step}: ${message}`);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`DECLAY Partslink Navigator v7.2 auf Port ${PORT}`);
  console.log(`Retry bei 429 | Konversation kuerzen | 1 Job gleichzeitig`);
});
