const express = require('express')
const cors = require('cors')
const Anthropic = require('@anthropic-ai/sdk')

const app = express()
app.use(cors())
app.use(express.json())

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Partslink Zugangsdaten aus Environment
const PL_FIRMA = process.env.PARTSLINK_FIRMA || ''
const PL_USER  = process.env.PARTSLINK_USER  || ''
const PL_PASS  = process.env.PARTSLINK_PASS  || ''

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DECLAY Partslink v4' })
})

app.post('/search', async (req, res) => {
  const { vin, bauteil } = req.body
  if (!vin || !bauteil) return res.status(400).json({ error: 'VIN und Bauteil erforderlich' })

  console.log(`SUCHE: VIN=${vin} | Bauteil=${bauteil}`)

  try {
    // Claude mit web_fetch Tool - navigiert Partslink via HTTP
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      tools: [
        {
          type: 'web_fetch_20260309',
          name: 'web_fetch'
        }
      ],
      system: `Du bist ein KFZ-Teile Assistent der Partslink24 via HTTP Requests durchsucht.

Partslink24 Login Daten:
- Firmenkennung: ${PL_FIRMA}
- Benutzername: ${PL_USER}  
- Passwort: ${PL_PASS}
- Login URL: https://www.partslink24.com/partslink24/login.action

WORKFLOW:
1. Führe einen POST Login Request durch mit den Zugangsdaten
2. Speichere den Session Cookie aus der Antwort
3. Suche das Fahrzeug mit der VIN über: https://www.partslink24.com/partslink24/catalog/vehicleSearch.do?fin=VIN
4. Navigiere zur richtigen Baugruppe für das gesuchte Bauteil
5. Lese die OE-Nummern aus dem HTML aus

Gib am Ende NUR dieses JSON zurück:
{
  "oe_nummer": "...",
  "fahrzeug": "...",
  "teile": [
    {
      "oe_nummer": "...",
      "bezeichnung": "...",
      "hersteller": "...",
      "artikelnummer": "...",
      "preis": "...",
      "verfuegbarkeit": "...",
      "richtzeit": "...",
      "drehmoment": "..."
    }
  ]
}`,
      messages: [
        {
          role: 'user',
          content: `Suche in Partslink24:
- VIN: ${vin}
- Bauteil: ${bauteil}

Logge dich ein und finde die OE-Nummern. Gib das Ergebnis als JSON zurück.`
        }
      ]
    })

    // Alle Antwort-Blöcke verarbeiten
    console.log('Response stop_reason:', response.stop_reason)
    
    const textBlocks = response.content.filter(b => b.type === 'text')
    const fullText = textBlocks.map(b => b.text).join('\n')
    
    console.log('Text:', fullText.substring(0, 400))

    // JSON extrahieren
    const jsonMatch = fullText.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const result = JSON.parse(jsonMatch[0])
        if (!result.teile) result.teile = []
        return res.json(result)
      } catch(e) {
        console.error('Parse Fehler:', e.message)
      }
    }

    res.json({ teile: [], oe_nummer: '', raw: fullText })

  } catch (error) {
    console.error('Fehler:', error.message)
    res.status(500).json({ error: error.message })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`DECLAY Partslink Server v4 läuft auf Port ${PORT}`))
