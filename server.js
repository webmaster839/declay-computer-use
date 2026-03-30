const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// DECLAY Partslink Navigator v7.1
// Claude Computer Use API + Puppeteer
// MIT Rate Limit Schutz (8 Sek Pause)
// ============================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 800;

// Job Queue (in-memory)
const jobs = new Map();

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DECLAY Partslink Navigator v7.1', jobs: jobs.size });
});

// ============================================================
// START SEARCH JOB
// ============================================================
app.post('/search', (req, res) => {
  const { vin, bauteil } = req.body;
  if (!vin || !bauteil) {
    return res.status(400).json({ error: 'VIN und Bauteil erforderlich' });
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

  // Start async processing - don't await!
  processSearchJob(jobId, vin, bauteil).catch(err => {
    console.error(`[JOB ${jobId}] Fataler Fehler:`, err.message);
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = err.message;
    }
  });

  // Return immediately with jobId
  res.json({ jobId });
});

// ============================================================
// CHECK JOB STATUS
// ============================================================
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job nicht gefunden' });
  }
  res.json(job);
});

// ============================================================
// MAIN PROCESSING: Claude Computer Use Loop
// ============================================================
async function processSearchJob(jobId, vin, bauteil) {
  const job = jobs.get(jobId);
  let browser = null;

  try {
    // Step 1: Launch Browser
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

    // Step 2: Navigate to Partslink24
    updateJob(jobId, 'running', 2, 'Oeffne Partslink24...');
    await page.goto('https://www.partslink24.com', { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    
    console.log(`[JOB ${jobId}] Partslink24 geladen`);

    // Step 3: Start Computer Use Loop
    updateJob(jobId, 'running', 3, 'Claude navigiert Partslink24...');
    
    const firma = process.env.PARTSLINK_FIRMA || '';
    const user = process.env.PARTSLINK_USER || '';
    const pass = process.env.PARTSLINK_PASS || '';

    const systemPrompt = `Du bist ein KFZ-Teile Experte der Partslink24 navigiert.
Du siehst den Bildschirm und kannst klicken, tippen und navigieren.

DEIN ZIEL:
1. Auf Partslink24 einloggen mit: Firmenkennung: ${firma}, Benutzer: ${user}, Passwort: ${pass}
2. Fahrzeug mit FIN/VIN "${vin}" suchen
3. Zur Baugruppe "${bauteil}" navigieren  
4. Alle OE-Nummern, Bezeichnungen und Preise auslesen

WICHTIG:
- Mache zuerst einen Screenshot um zu sehen wo du bist
- Klicke praezise auf Buttons und Eingabefelder
- Nach dem Login suche das FIN/VIN Eingabefeld
- Navigiere durch den Teilekatalog zum gesuchten Bauteil
- Wenn du die OE-Nummern gefunden hast, schreibe sie als Text-Antwort

WENN DU FERTIG BIST, antworte mit dem Text:
ERGEBNIS_START
{"teile": [{"oe_nummer": "...", "bezeichnung": "...", "preis": "...", "hersteller": "..."}]}
ERGEBNIS_ENDE`;

    const initialMessage = `Navigiere jetzt Partslink24 und finde die OE-Nummern fuer "${bauteil}" am Fahrzeug mit VIN: ${vin}. Mache zuerst einen Screenshot um zu sehen was auf dem Bildschirm ist.`;

    // Conversation history for the tool loop
    let messages = [{ role: 'user', content: initialMessage }];
    let maxIterations = 25;
    let iteration = 0;
    let result = null;

    while (iteration < maxIterations) {
      iteration++;
      updateJob(jobId, 'running', 3 + iteration, `Claude Schritt ${iteration}...`);
      console.log(`[JOB ${jobId}] Iteration ${iteration}`);

      // *** RATE LIMIT SCHUTZ ***
      // 8 Sekunden Pause zwischen API Calls
      if (iteration > 1) {
        console.log(`[JOB ${jobId}] Warte 8 Sekunden (Rate Limit Schutz)...`);
        updateJob(jobId, 'running', 3 + iteration, `Warte kurz... (Schritt ${iteration})`);
        await new Promise(r => setTimeout(r, 8000));
      }

      // Call Claude API with Computer Use
      const apiResponse = await callClaudeComputerUse(systemPrompt, messages);
      
      if (!apiResponse || !apiResponse.content) {
        throw new Error('Keine Antwort von Claude API');
      }

      console.log(`[JOB ${jobId}] Stop reason: ${apiResponse.stop_reason}`);

      // Check for text response with results
      const textBlocks = apiResponse.content.filter(b => b.type === 'text');
      for (const tb of textBlocks) {
        const match = tb.text.match(/ERGEBNIS_START\s*([\s\S]*?)\s*ERGEBNIS_ENDE/);
        if (match) {
          try {
            result = JSON.parse(match[1]);
            console.log(`[JOB ${jobId}] Ergebnis gefunden!`, result);
          } catch (e) {
            console.log(`[JOB ${jobId}] JSON Parse Fehler:`, e.message);
          }
        }
      }

      if (result) break;

      // Check if Claude wants to use tools
      const toolUseBlocks = apiResponse.content.filter(b => b.type === 'tool_use');
      
      if (toolUseBlocks.length === 0) {
        console.log(`[JOB ${jobId}] Keine weiteren Tool-Aufrufe`);
        const allText = textBlocks.map(b => b.text).join('\n');
        result = extractOeFromText(allText);
        break;
      }

      // Execute each tool action
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        const action = toolUse.input;
        console.log(`[JOB ${jobId}] Aktion: ${action.action}`, action.coordinate || action.text || '');
        
        updateJob(jobId, 'running', 3 + iteration, describeAction(action));

        // Execute the action on the browser
        await executeAction(page, action);

        // Take screenshot after action
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

      // Add assistant response and tool results to conversation
      messages.push({ role: 'assistant', content: apiResponse.content });
      messages.push({ role: 'user', content: toolResults });
    }

    // Done!
    await browser.close();
    browser = null;

    if (result && result.teile && result.teile.length > 0) {
      updateJob(jobId, 'done', iteration, `${result.teile.length} Teile gefunden!`);
      job.teile = result.teile;
    } else {
      updateJob(jobId, 'done', iteration, 'Suche abgeschlossen - keine OE Nummern gefunden');
      job.teile = result?.teile || [];
    }

  } catch (error) {
    console.error(`[JOB ${jobId}] Fehler:`, error.message);
    updateJob(jobId, 'error', 0, error.message);
    job.error = error.message;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
    setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
  }
}

// ============================================================
// CLAUDE API CALL with Computer Use
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
    console.error(`Claude API Fehler ${response.status}:`, errText);
    throw new Error(`Claude API ${response.status}: ${errText}`);
  }

  return await response.json();
}

// ============================================================
// EXECUTE BROWSER ACTION
// ============================================================
async function executeAction(page, action) {
  const delay = ms => new Promise(r => setTimeout(r, ms));

  switch (action.action) {
    case 'screenshot':
      break;

    case 'left_click':
      if (action.coordinate) {
        await page.mouse.click(action.coordinate[0], action.coordinate[1]);
        await delay(1000);
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
        await page.keyboard.type(action.text, { delay: 30 });
        await delay(500);
      }
      break;

    case 'key':
      if (action.text) {
        const keys = action.text.split('+');
        if (keys.length > 1) {
          for (let i = 0; i < keys.length - 1; i++) {
            await page.keyboard.down(mapKey(keys[i].trim()));
          }
          await page.keyboard.press(mapKey(keys[keys.length - 1].trim()));
          for (let i = keys.length - 2; i >= 0; i--) {
            await page.keyboard.up(mapKey(keys[i].trim()));
          }
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

    case 'left_click_drag':
      if (action.coordinate && action.start_coordinate) {
        await page.mouse.move(action.start_coordinate[0], action.start_coordinate[1]);
        await page.mouse.down();
        await page.mouse.move(action.coordinate[0], action.coordinate[1], { steps: 10 });
        await page.mouse.up();
        await delay(500);
      }
      break;

    case 'scroll':
      if (action.coordinate) {
        await page.mouse.move(action.coordinate[0], action.coordinate[1]);
      }
      const scrollAmount = action.amount || 3;
      const direction = action.direction || 'down';
      const deltaY = direction === 'down' ? scrollAmount * 100 : 
                      direction === 'up' ? -scrollAmount * 100 : 0;
      const deltaX = direction === 'right' ? scrollAmount * 100 : 
                      direction === 'left' ? -scrollAmount * 100 : 0;
      await page.mouse.wheel({ deltaX, deltaY });
      await delay(800);
      break;

    case 'wait':
      await delay((action.duration || 2) * 1000);
      break;

    case 'cursor_position':
      break;

    default:
      console.log(`Unbekannte Aktion: ${action.action}`);
  }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function mapKey(key) {
  const keyMap = {
    'Return': 'Enter', 'return': 'Enter', 'enter': 'Enter',
    'space': ' ', 'Space': ' ',
    'ctrl': 'Control', 'Ctrl': 'Control',
    'alt': 'Alt', 'shift': 'Shift',
    'tab': 'Tab', 'Tab': 'Tab',
    'escape': 'Escape', 'Escape': 'Escape',
    'backspace': 'Backspace', 'Backspace': 'Backspace',
    'delete': 'Delete', 'Delete': 'Delete',
    'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
    'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
    'Page_Down': 'PageDown', 'Page_Up': 'PageUp',
    'Home': 'Home', 'End': 'End', 'F5': 'F5'
  };
  return keyMap[key] || key;
}

function describeAction(action) {
  switch (action.action) {
    case 'screenshot': return 'Screenshot...';
    case 'left_click': return `Klick auf (${action.coordinate?.join(', ')})`;
    case 'type': return `Tippe: "${(action.text || '').substring(0, 20)}..."`;
    case 'key': return `Taste: ${action.text}`;
    case 'scroll': return `Scrollen ${action.direction || 'down'}`;
    case 'wait': return 'Warte...';
    default: return action.action;
  }
}

function extractOeFromText(text) {
  const patterns = [
    /\b\d{1,2}[A-Z]\d{1,2}\s?\d{3}\s?\d{3}\s?[A-Z]?\b/g,
    /\b\d{4}\.[A-Z]\d\b/g,
    /\b\d{2}\.\d{2}\.\d\.\d{3}\.\d{3}\b/g,
    /\b[A-Z]{2}\d{5,8}[A-Z]?\b/g,
  ];

  const found = new Set();
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach(m => found.add(m.replace(/\s+/g, '')));
    }
  }

  if (found.size > 0) {
    return {
      teile: Array.from(found).map(oe => ({
        oe_nummer: oe,
        bezeichnung: '',
        preis: '',
        hersteller: 'OE'
      }))
    };
  }

  return { teile: [] };
}

function updateJob(jobId, status, step, message) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = status;
    job.step = step;
    job.message = message;
    console.log(`[JOB ${jobId}] Step ${step}: ${message}`);
  }
}

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`DECLAY Partslink Navigator v7.1 laeuft auf Port ${PORT}`);
  console.log(`Computer Use: computer_20251124 + claude-sonnet-4-6`);
  console.log(`Rate Limit Schutz: 8 Sekunden Pause zwischen Schritten`);
  console.log(`Display: ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}`);
});
