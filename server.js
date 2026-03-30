const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Hilfsfunktion für die Computer-Aktionen
async function performAction(page, action) {
    const { type, coordinate, text } = action;
    if (type === 'mouse_move' || type === 'left_click') {
        await page.mouse.click(coordinate[0], coordinate[1]);
        console.log(`Klick auf: ${coordinate}`);
    } else if (type === 'type') {
        await page.keyboard.type(text);
        console.log(`Tippe: ${text}`);
    } else if (type === 'key') {
        await page.keyboard.press(text);
    }
    await new Promise(r => setTimeout(r, 2000)); // Kurz warten nach Aktion
}

app.post('/search', async (req, res) => {
    const { vin, bauteil } = req.body;
    console.log(`START: Suche nach ${bauteil} für VIN ${vin}`);

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // WICHTIG für Render!
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 768 });

    try {
        await page.goto('https://www.partslink24.com/partslink24/login.action');

        let messages = [{
            role: 'user',
            content: `Logge dich ein (Firma: ${process.env.PL_FIRMA}, User: ${process.env.PL_USER}, Pass: ${process.env.PL_PASS}). 
                      Suche dann die VIN ${vin} und finde die OE-Nummer für: ${bauteil}. 
                      Gib am Ende NUR das Ergebnis als JSON zurück.`
        }];

        for (let i = 0; i < 15; i++) { // Max 15 Schritte (Sicherheitsschleife)
            const screenshot = await page.screenshot({ encoding: 'base64' });

            const response = await client.beta.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 1024,
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
                await performAction(page, toolUse.input);
                messages.push({ role: 'assistant', content: response.content });
                messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: "Aktion ausgeführt." }] });
            } else {
                return res.json({ result: response.content[0].text });
            }
        }
        res.json({ error: "Timeout: Zu viele Schritte." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await browser.close();
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`DECLAY Vision Server läuft auf Port ${PORT}`));
