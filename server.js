const express = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const puppeteer = require('puppeteer-core')
const chromium = require('chrome-aws-lambda')

const app = express()
app.use(express.json())

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

async function performAction(page, action) {
  const { type, coordinate, text, key } = action
  try {
    if (type === 'mouse_move' || type === 'left_click') {
      await page.mouse.click(coordinate[0], coordinate[1])
      console.log(`Klick auf: ${coordinate}`)
    } else if (type === 'type') {
      await page.keyboard.type(text)
      console.log(`Tippe: ${text}`)
    } else if (type === 'key') {
      await page.keyboard.press(key)
      console.log(`Taste: ${key}`)
    }
    await new Promise(r => setTimeout(r, 2500))
  } catch(e) {
    console.error('Aktion Fehler:', e.message)
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DECLAY Vision Server v5' })
})

app.post('/search', async (req, res) => {
  const { vin, bauteil } = req.body
  if (!vin || !bauteil) return res.status(400).json({ error: 'VIN und Bauteil erforderlich' })

  console.log(`SUCHE: VIN=${vin} | Bauteil=${bauteil}`)

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath,
    headless: chromium.headless
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1024, height: 768 })

  try {
    await page.goto('https://www.partslink24.com/partslink24/login.action', {
      waitUntil: 'networkidle2',
      timeout: 30000
    })

    let messages = [{
      role: 'user',
      content: `Auftrag für DECLAY:
1. Logge dich ein:
   - Firma: ${process.env.PARTSLINK_FIRMA}
   - User: ${process.env.PARTSLINK_USER}
   - Pass: ${process.env.PARTSLINK_PASS}
2. Suche Fahrzeug mit VIN: ${vin}
3. Finde OE-Nummer für: ${bauteil}
4. Gib NUR dieses JSON zurück: {"oe_nummer": "...", "bezeichnung": "...", "fahrzeug": "..."}`
    }]

    for (let step = 0; step < 12; step++) {
      console.log(`Schritt ${step + 1}: Screenshot für Claude...`)
      const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 80 })

      const response = await client.beta.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1500,
        betas: ['computer-use-2024-10-22'],
        tools: [{
          type: 'computer_20241022',
          name: 'computer',
          display_width_px: 1024,
          display_height_px: 768,
          display_number: 1
        }],
        messages: [...messages, {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshot } }]
        }]
      })

      const toolUse = response.content.find(b => b.type === 'tool_use')

      if (toolUse) {
        await performAction(page, toolUse.input)
        messages.push({ role: 'assistant', content: response.content })
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Aktion erfolgreich. Was ist der nächste Schritt?' }]
        })
      } else {
        console.log('Claude fertig!')
        const text = response.content[0]?.text || ''
        const jsonMatch = text.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          try {
            const result = JSON.parse(jsonMatch[0])
            return res.json({ teile: [result], oe_nummer: result.oe_nummer })
          } catch(e) {}
        }
        return res.json({ teile: [], raw: text })
      }
    }

    res.status(408).json({ error: 'Timeout' })

  } catch(err) {
    console.error('Fehler:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    await browser.close()
    console.log('Browser geschlossen')
  }
})

const PORT = process.env.PORT || 10000
app.listen(PORT, () => console.log(`DECLAY Vision Server v5 läuft auf Port ${PORT}`))
