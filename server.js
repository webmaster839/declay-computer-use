const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

// Dein Claude-Gehirn
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Hilfsfunktion: Führt die Klicks aus, die Claude "sieht"
async function performAction(page, action) {
    const { type, coordinate, text, key } = action;
    try {
        if (type === 'mouse_move' || type === 'left_click') {
            await page.mouse.click(coordinate[0], coordinate[1]);
            console.log(`Action: Klick auf Position ${coordinate}`);
        } else if (type === 'type') {
            await page.keyboard.type(text);
            console.log(`Action: Tippe Text: ${text}`);
        } else if (type === 'key') {
            await page.keyboard.press(key);
            console.log(`Action: Drücke Taste: ${key}`);
        }
        // Wichtig: Kurze Pause, damit die Seite laden kann
        await new Promise(r => setTimeout(r, 2500)); 
    } catch (e) {
        console.error("Fehler bei Browser-Aktion:", e.message);
    }
}

app.post('/search', async (req, res) => {
    const { vin, bauteil } = req.body;
    console.log(`--- NEUE SUCHE --- VIN: ${vin} | Bauteil: ${bauteil}`);

    const browser = await puppeteer.launch({
        headless: "new", // "new" für Render Kompatibilität
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 768 });

    try {
        // 1. Start auf der Login-Seite
        await page.goto('https://www.partslink24.com/partslink24/login.action');

        let messages = [{
            role: 'user',
            content: `Auftrag für DECLAY AI: 
            1. Logge dich ein. Firma: ${process.env.PARTSLINK_FIRMA}, User: ${process.env.PARTSLINK_USER}, Pass: ${process.env.PARTSLINK_PASS}
            2. Suche das Fahrzeug mit der VIN: ${vin}
            3. Navigiere zu den Baugruppen und finde die OE-Nummer für: ${bauteil}
            4. Sobald du die Nummer hast, beende den Prozess und gib mir nur das JSON: {"oe_nummer": "...", "bezeichnung": "..."}`
        }];

        // Maximal 12 Iterationen, damit der Server nicht ewig läuft (Kostenkontrolle)
        for (let step = 0; step < 12; step++) {
            console.log(`Schritt ${step + 1}: Mache Screenshot für Claude...`);
            const screenshot = await page.screenshot({ encoding: 'base64' });

            const response = await client.beta.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 1500,
                betas: ["computer-use-2024-10-22"],
                tools: [{
                    type: "computer_20241022",
                    name: "computer",
                    display_width_px: 1024,
                    display_height_px: 768,
                    display_number: 1
                }],
                messages: [...messages, {
                    role: 'user',
                    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshot } }]
                }]
            });

            const toolUse = response.content.find(b => b.type === 'tool_use');

            if (toolUse) {
                // Claude will was tun -> Wir führen es aus
                await performAction(page, toolUse.input);
                
                // Wir speichern den Fortschritt im Gedächtnis (Memory)
                messages.push({ role: 'assistant', content: response.content });
                messages.push({ 
                    role: 'user', 
                    content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: "Aktion erfolgreich ausgeführt. Was ist der nächste Schritt?" }] 
                });
            } else {
                // Kein Tool-Use mehr -> Claude ist fertig oder hat die Info
                console.log("Claude ist fertig. Ergebnis wird gesendet.");
                return res.json({ success: true, data: response.content[0].text });
            }
        }

        res.status(408).json({ error: "Timeout: Suche hat zu lange gedauert." });

    } catch (err) {
        console.error("Kritischer Fehler:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        await browser.close();
        console.log("Browser geschlossen.");
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`DECLAY Vision Server V5 läuft auf Port ${PORT}`));
