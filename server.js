const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// DECLAY Partslink Navigator v7.5
// MINIMALER PROMPT — wie Chrome Extension!
// Puppeteer: Login + VIN (3 Sekunden)
// Claude: "Such die Teile" — fertig!
// STOPP ab Iteration 8 | Hard Stop 30 | Max 40
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
  res.json({ status: 'ok', service: 'DECLAY v7.5', jobs: jobs.size, busy: activeJob });
});

app.get('/stop', (req, res) => {
  if (!activeJob) return res.json({ status: 'no_active_job' });
  for (const [id, job] of jobs) {
    if (job.status === 'running') {
      job._forceStop = true;
      console.log(`[JOB ${id}] FORCE STOP via /stop`);
      return res.json({ status: 'stopping', jobId: id, teile: job.teile.length });
    }
  }
  res.json({ status: 'no_running_job' });
});

app.post('/search', (req, res) => {
  const { vin, bauteil, teile } = req.body;
  if (!vin) return res.status(400).json({ error: 'VIN erforderlich' });
  if (!bauteil && (!teile || teile.length === 0)) return res.status(400).json({ error: 'Bauteil oder Teile-Liste erforderlich' });
  if (activeJob) return res.status(429).json({ error: 'Ein Job laeuft bereits' });

  const teileListe = teile || [bauteil];
  const jobId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  jobs.set(jobId, { status: 'starting', step: 0, message: 'Starte...', teile: [], error: null, teileListe, startedAt: new Date().toISOString() });
  console.log(`[JOB ${jobId}] Start: VIN=${vin} | Teile: ${teileListe.join(', ')}`);
  activeJob = true;

  processSearchJob(jobId, vin, teileListe).catch(err => {
    console.error(`[JOB ${jobId}] Fatal:`, err.message);
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

app.get('/view/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.lastScreenshot) return res.status(404).send('Kein Screenshot');
  const img = Buffer.from(job.lastScreenshot, 'base64');
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': img.length, 'Cache-Control': 'no-cache' });
  res.end(img);
});

const LIVE_PW = process.env.LIVE_PASSWORD || '';
function checkLivePw(req, res) {
  if (!LIVE_PW) return true;
  if (req.query.pw === LIVE_PW) return true;
  res.status(401).send('<html><body style="background:#080a08;color:#ef4444;font-family:monospace;padding:40px;text-align:center"><h1>DECLAY LIVE VIEW</h1><p>Zugang verweigert.</p></body></html>');
  return false;
}

app.get('/live/:jobId', (req, res) => {
  if (!checkLivePw(req, res)) return;
  res.send(getLiveHtml(req.params.jobId));
});

app.get('/live', (req, res) => {
  if (!checkLivePw(req, res)) return;
  let latest = null, lid = null;
  for (const [id, job] of jobs) {
    if (!latest || new Date(job.startedAt) > new Date(latest.startedAt)) { latest = job; lid = id; }
  }
  if (!lid) return res.send('<html><body style="background:#080a08;color:#39ff14;font-family:monospace;padding:40px;text-align:center"><h1>DECLAY LIVE VIEW</h1><p>Kein aktiver Job.</p></body></html>');
  res.send(getLiveHtml(lid));
});

function getLiveHtml(jobId) {
  return `<!DOCTYPE html><html><head><title>DECLAY Live</title>
<style>body{background:#080a08;color:#39ff14;font-family:monospace;margin:0;padding:16px}h1{font-size:18px;letter-spacing:2px}#s{padding:8px 16px;background:#0f1f0f;border:1px solid #39ff14;border-radius:8px;margin:8px 0;font-size:14px}#t{padding:4px 16px;color:#888;font-size:12px}#i{max-width:100%;border:1px solid #39ff14;border-radius:4px;margin-top:8px}.done{color:#22c55e}.error{color:#ef4444}</style></head><body>
<h1>DECLAY LIVE VIEW</h1><div id="t">⏱️ --:--</div><div id="s">Verbinde...</div><img id="i" src="/view/${jobId}" onerror="this.style.display='none'"/>
<script>const s=document.getElementById('s'),i=document.getElementById('i'),t=document.getElementById('t');let st=null;function u(){if(!st)return;const d=Math.floor((Date.now()-st)/1000),m=Math.floor(d/60),sec=d%60;t.textContent='⏱️ '+m+':'+(sec<10?'0':'')+sec}setInterval(u,1000);async function r(){try{const j=await(await fetch('/status/${jobId}')).json();if(!st&&j.startedAt)st=new Date(j.startedAt).getTime();u();s.textContent='Schritt '+j.step+': '+j.message;s.className=j.status==='done'?'done':j.status==='error'?'error':'';i.src='/view/${jobId}?t='+Date.now();i.style.display='block';if(j.status==='done'||j.status==='error'){if(j.teile&&j.teile.length)s.textContent+=' | '+j.teile.length+' Teile!';return}setTimeout(r,3000)}catch(e){s.textContent='Warte...';setTimeout(r,5000)}}r();</script></body></html>`;
}

// ============================================================
// MAIN
// ============================================================
async function processSearchJob(jobId, vin, teileListe) {
  const job = jobs.get(jobId);
  let browser = null;
  const marke = getMarkeFromVin(vin);
  console.log(`[JOB ${jobId}] Marke: ${marke || '?'} | ${teileListe.length} Teile`);

  try {
    updateJob(jobId, 'running', 1, 'Verbinde...');
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
      defaultViewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless || 'new',
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    updateJob(jobId, 'running', 2, 'Lade Katalog...');
    await page.goto('https://www.partslink24.com', { waitUntil: 'networkidle2', timeout: 30000 });

    const firma = process.env.PARTSLINK_FIRMA || '';
    const user = process.env.PARTSLINK_USER || '';
    const pass = process.env.PARTSLINK_PASS || '';

    // ============================================================
    // PUPPETEER: Login (3 Sekunden, kein Claude noetig)
    // ============================================================
    updateJob(jobId, 'running', 3, 'Login...');
    try {
      await page.waitForTimeout(2000);
      try { const cb = await page.$('button[id*="cookie"],.cc-btn,#onetrust-accept-btn-handler'); if(cb){await cb.click();await page.waitForTimeout(1000);} } catch(e){}
      try { await page.mouse.click(1119, 747); await page.waitForTimeout(1000); } catch(e){}

      const inputs = await page.$$('input[type="text"],input[type="password"],input:not([type])');
      if (inputs.length >= 3) {
        await inputs[0].click(); await inputs[0].type(firma,{delay:30}); await page.waitForTimeout(300);
        await inputs[1].click(); await inputs[1].type(user,{delay:30}); await page.waitForTimeout(300);
        const pi = await page.$('input[type="password"]') || inputs[2];
        await pi.click(); await pi.type(pass,{delay:30}); await page.waitForTimeout(300);
      } else {
        await page.mouse.click(988,281); await page.waitForTimeout(500);
        await page.keyboard.type(firma,{delay:30}); await page.waitForTimeout(300);
        await page.mouse.click(988,345); await page.waitForTimeout(500);
        await page.keyboard.type(user,{delay:30}); await page.waitForTimeout(300);
        await page.mouse.click(988,406); await page.waitForTimeout(500);
        await page.keyboard.type(pass,{delay:30}); await page.waitForTimeout(300);
      }
      const lb = await page.$('button[type="submit"],input[type="submit"],.login-button');
      if(lb){await lb.click();}else{await page.mouse.click(988,485);}
      await page.waitForTimeout(5000);
      try{const ob=await page.$('.modal button,.dialog button');if(ob){await ob.click();await page.waitForTimeout(2000);}}catch(e){}

      const ss = await page.screenshot({encoding:'base64',type:'jpeg',quality:70});
      const j1 = jobs.get(jobId); if(j1) j1.lastScreenshot = ss;
      console.log(`[JOB ${jobId}] Login OK`);
      updateJob(jobId, 'running', 4, 'Eingeloggt!');
    } catch(e) {
      console.log(`[JOB ${jobId}] Login Fehler: ${e.message}`);
    }

    // ============================================================
    // CLAUDE: Mini-Prompt wie Chrome Extension!
    // ============================================================
    const teileText = teileListe.map((t,i) => `${i+1}. ${t}`).join('\n');

    const systemPrompt = '';

    updateJob(jobId, 'running', 5, 'Suche Teile...');

    const teileNatural = teileListe.join(', ');
    let messages = [{
      role: 'user',
      content: `Such mir ${teileNatural} fuer den ${marke || 'das Fahrzeug'} mit VIN ${vin} auf Partslink24. Die VIN gibst du oben links bei "Direkteinstieg" ein und drueckst GO. Wenn du eine OE-Nummer findest, melde sie mit: TEIL_GEFUNDEN: {"oe_nummer": "KOMPLETTE NUMMER", "bezeichnung": "Teilname"}`
    }];

    let maxIter = 40, iter = 0, result = null;

    while (iter < maxIter) {
      iter++;
      const sc = jobs.get(jobId);
      if (sc && sc._forceStop) { result = {teile:sc.teile}; break; }

      updateJob(jobId,'running',3+iter,'Analysiere...');
      console.log(`[JOB ${jobId}] Iter ${iter}`);
      if (iter > 1) { updateJob(jobId,'running',3+iter,'Identifiziere OE-Nummern...'); await new Promise(r=>setTimeout(r,10000)); }
      if (messages.length > 15) { messages = [messages[0],...messages.slice(-14)]; }

      let api = null;
      for (let retry = 0; retry < 3; retry++) {
        try { api = await callClaude(systemPrompt, messages); break; }
        catch(err) {
          if ((err.message.includes('429')||err.message.includes('529')||err.message.includes('fetch failed')) && retry<2) {
            const w = err.message.includes('529')?30:err.message.includes('fetch')?30:65;
            console.log(`[JOB ${jobId}] Retry ${retry+1}, ${w}s`);
            updateJob(jobId,'running',3+iter,`Warte ${w}s (Retry ${retry+1})`);
            await new Promise(r=>setTimeout(r,w*1000));
          } else throw err;
        }
      }
      if (!api||!api.content) throw new Error('Keine Antwort');

      const texts = api.content.filter(b=>b.type==='text');
      for (const tb of texts) {
        console.log(`[JOB ${jobId}] ${tb.text.substring(0,120)}...`);

        // TEIL_GEFUNDEN
        for (const tm of [...tb.text.matchAll(/TEIL_GEFUNDEN:\s*(\{[^}]+\})/g)]) {
          try { const t=JSON.parse(tm[1]); const cj=jobs.get(jobId);
            if(cj&&t.oe_nummer&&!cj.teile.some(x=>x.oe_nummer===t.oe_nummer)){
              cj.teile.push({oe_nummer:t.oe_nummer,bezeichnung:t.bezeichnung||'',preis:'',hersteller:'OE'});
              console.log(`[JOB ${jobId}] TEIL: ${t.oe_nummer}`);
            }
          } catch(e){}
        }

        // ERGEBNIS_START
        const em = tb.text.match(/ERGEBNIS_START\s*([\s\S]*?)\s*ERGEBNIS_ENDE/);
        if(em){try{const p=JSON.parse(em[1]);const cj=jobs.get(jobId);
          if(cj&&cj.teile.length>0){for(const t of p.teile){if(!cj.teile.some(x=>x.oe_nummer===t.oe_nummer))cj.teile.push(t);}result={teile:cj.teile};}
          else{result=p;}
        }catch(e){}}

        // Auto-Extrakt
        const found = extractOe(tb.text);
        if(found.length>0){const cj=jobs.get(jobId);if(cj){for(const t of found){if(!cj.teile.some(x=>x.oe_nummer===t.oe_nummer)){cj.teile.push(t);console.log(`[JOB ${jobId}] AUTO: ${t.oe_nummer}`);}}}}

        // STOPP ab Iteration 8 + 2 OE
        const cj2=jobs.get(jobId);
        if(cj2&&cj2.teile.length>=2&&iter>=8){
          console.log(`[JOB ${jobId}] STOPP: ${cj2.teile.length} OE bei Iter ${iter}`);
          cj2._forceNext=`Du hast ${cj2.teile.length} OE-Nummern. Reicht! Schliess die Suche (X), leere das Suchfeld, such das naechste Teil:\n${teileText}`;
        }

        // Hard Stop 30
        if(!result&&iter>=30){const cj=jobs.get(jobId);if(cj&&cj.teile.length>0){console.log(`[JOB ${jobId}] HARD STOP`);result={teile:cj.teile};}}
      }
      if(result) break;

      const tools = api.content.filter(b=>b.type==='tool_use');
      if(tools.length===0){result={teile:jobs.get(jobId)?.teile||extractOe(texts.map(b=>b.text).join('\n'))};break;}

      const tr = [];
      for (const tool of tools) {
        const a=tool.input, lt=(a.text===pass)?'****':(a.text||'');
        console.log(`[JOB ${jobId}] ${a.action}`,a.coordinate||lt);
        updateJob(jobId,'running',3+iter,describeAction(a));
        await executeAction(page,a);
        const ss=await page.screenshot({encoding:'base64',type:'jpeg',quality:70});
        const cj=jobs.get(jobId); if(cj) cj.lastScreenshot=ss;
        tr.push({type:'tool_result',tool_use_id:tool.id,content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:ss}}]});
      }

      const fj=jobs.get(jobId);
      if(fj&&fj._forceNext){tr.push({type:'text',text:fj._forceNext});delete fj._forceNext;}

      messages.push({role:'assistant',content:api.content});
      messages.push({role:'user',content:tr});
    }

    await browser.close(); browser=null;

    if(result&&result.teile&&result.teile.length>0){
      updateJob(jobId,'done',iter,`${result.teile.length} Teile gefunden!`);
      job.teile=result.teile;
    } else {
      updateJob(jobId,'done',iter,'Suche abgeschlossen');
      job.teile=result?.teile||[];
    }

  } catch(error) {
    console.error(`[JOB ${jobId}] Fehler:`,error.message);
    if(job.teile&&job.teile.length>0){
      job.status='done'; job.message=`Abgebrochen, ${job.teile.length} OE-Nummern gefunden!`;
    } else {
      updateJob(jobId,'error',0,error.message); job.error=error.message;
    }
  } finally {
    if(browser){try{await browser.close();}catch(e){}}
    setTimeout(()=>jobs.delete(jobId),10*60*1000);
  }
}

// ============================================================
// CLAUDE API
// ============================================================
async function callClaude(sys, msgs) {
  const body = {model:'claude-sonnet-4-6',max_tokens:4096,
    tools:[{type:'computer_20251124',name:'computer',display_width_px:DISPLAY_WIDTH,display_height_px:DISPLAY_HEIGHT,display_number:1}],messages:msgs};
  if (sys) body.system = sys;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','anthropic-beta':'computer-use-2025-11-24'},
    body:JSON.stringify(body)
  });
  if(!r.ok) throw new Error(`API ${r.status}`);
  return await r.json();
}

// ============================================================
// BROWSER ACTIONS
// ============================================================
async function executeAction(page,a) {
  const d=ms=>new Promise(r=>setTimeout(r,ms));
  try{switch(a.action){
    case 'screenshot':break;
    case 'left_click':if(a.coordinate){await page.mouse.click(a.coordinate[0],a.coordinate[1]);await d(1500);}break;
    case 'right_click':if(a.coordinate){await page.mouse.click(a.coordinate[0],a.coordinate[1],{button:'right'});await d(500);}break;
    case 'double_click':if(a.coordinate){await page.mouse.click(a.coordinate[0],a.coordinate[1],{clickCount:2});await d(500);}break;
    case 'triple_click':if(a.coordinate){await page.mouse.click(a.coordinate[0],a.coordinate[1],{clickCount:3});await d(500);}break;
    case 'type':if(a.text){await page.keyboard.type(a.text,{delay:50});await d(500);}break;
    case 'key':if(a.text){const k=a.text.split('+');if(k.length>1){for(let i=0;i<k.length-1;i++)await page.keyboard.down(mapKey(k[i].trim()));await page.keyboard.press(mapKey(k[k.length-1].trim()));for(let i=k.length-2;i>=0;i--)await page.keyboard.up(mapKey(k[i].trim()));}else await page.keyboard.press(mapKey(a.text));await d(500);}break;
    case 'mouse_move':if(a.coordinate){await page.mouse.move(a.coordinate[0],a.coordinate[1]);await d(300);}break;
    case 'scroll':if(a.coordinate)await page.mouse.move(a.coordinate[0],a.coordinate[1]);const amt=a.amount||3,dir=a.direction||'down';await page.mouse.wheel({deltaX:dir==='right'?amt*100:dir==='left'?-amt*100:0,deltaY:dir==='down'?amt*100:dir==='up'?-amt*100:0});await d(800);break;
    case 'wait':await d((a.duration||2)*1000);break;
  }}catch(err){console.log(`Fehler (${a.action}): ${err.message}`);}
}

function mapKey(k){const m={'Return':'Enter','return':'Enter','enter':'Enter','space':' ','Space':' ','ctrl':'Control','Ctrl':'Control','alt':'Alt','shift':'Shift','tab':'Tab','escape':'Escape','backspace':'Backspace','delete':'Delete','Delete':'Delete','Page_Down':'PageDown','Page_Up':'PageUp'};return m[k]||k;}
function describeAction(a){return{screenshot:'Analysiere...',left_click:'Verarbeite...',type:'Suche Daten...',key:'Verarbeite...',scroll:'Durchsuche Katalog...',wait:'Warte...'}[a.action]||'Verarbeite...';}

function extractOe(text){
  // Regex entfernt — schneidet Mercedes/Opel/BMW Nummern ab
  // OE-Nummern kommen nur noch ueber Claudes natuerlichen Text
  return[];
}

function updateJob(id,status,step,msg){const j=jobs.get(id);if(j){j.status=status;j.step=step;j.message=msg;}console.log(`[JOB ${id}] Step ${step}: ${msg}`);}

const PORT=process.env.PORT||3001;
app.listen(PORT,()=>{console.log(`DECLAY v7.5 Port ${PORT}`);console.log(`MINI-PROMPT | STOPP Iter 8 | Hard 30 | Max 40`);});
