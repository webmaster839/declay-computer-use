const express = require('express')
const cors = require('cors')
const Anthropic = require('@anthropic-ai/sdk')

const app = express()
app.use(cors())
app.use(express.json())

const client = new Anthropic({ 
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    'anthropic-beta': 'computer-use-2025-01-24'
  }
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DECLAY Computer Use v2' })
})

app.post('/search', async (req, res) => {
  const { vin, bauteil, credentials } = req.body

  if (!vin || !bauteil) {
    return res.status(400).json({ error: 'VIN und Bauteil erforderlich' })
  }

  console.log(`SUCHE: VIN=${vin} | Bauteil=${bauteil}`)

  try {
    // Computer Use API - Claude navigiert selbst durch Partslink + Birner
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20251001',
      max_tokens: 4000,
      tools: [
        {
          type: 'computer_20250124',
          name: 'computer',
          display_width_px: 1280,
          display_height_px: 800,
          display_number: 1
        }
      ],
      system: `Du bist ein KFZ-Teile Recherche Assistent.
Deine Aufgabe ist es, OE-Nummern und Aftermarket-Alternativen für KFZ-Teile zu finden.

WORKFLOW:
1. Öffne https://www.partslink24.com im Browser
2. Logge dich ein mit:
   - Firmenkennung: ${credentials?.firma || process.env.PARTSLINK_FIRMA || ''}
   - Benutzername: ${credentials?.partslink_user || process.env.PARTSLINK_USER || ''}
   - Passwort: ${credentials?.partslink_pass || process.env.PARTSLINK_PASS || ''}
3. Suche das Fahrzeug mit VIN: ${vin}
4. Navigiere zur Baugruppe: ${bauteil}
5. Notiere die OE-Nummer(n)

6. Öffne https://tm2.carparts-cat.com/login/birner
7. Logge dich ein mit:
   - Benutzername: ${credentials?.birner_user || process.env.BIRNER_USER || ''}
   - Passwort: ${credentials?.birner_pass || process.env.BIRNER_PASS || ''}
8. Suche nach der gefundenen OE-Nummer
9. Notiere: Aftermarket Artikel, Preis, Verfügbarkeit, Richtzeit, Drehmomente

WICHTIG: Gib am Ende NUR dieses JSON zurück, KEIN Text davor oder danach:
{
  "oe_nummer": "...",
  "teile": [
    {
      "artikelnummer": "...",
      "bezeichnung": "...",
      "hersteller": "...",
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
          content: `Bitte führe den vollständigen Workflow durch:
- VIN: ${vin}
- Bauteil: ${bauteil}

Starte mit Partslink24, dann Birner. Gib das Ergebnis als JSON zurück.`
        }
      ]
    })

    // Antwort verarbeiten
    const textBlocks = response.content.filter(b => b.type === 'text')
    const fullText = textBlocks.map(b => b.text).join('\n')

    console.log('Claude Antwort:', fullText.substring(0, 500))

    // JSON extrahieren
    const jsonMatch = fullText.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const result = JSON.parse(jsonMatch[0])
        return res.json(result)
      } catch (e) {
        console.error('JSON Parse Fehler:', e)
      }
    }

    // Fallback: Rohantwort zurückgeben
    res.json({
      teile: [],
      raw: fullText,
      message: 'Keine strukturierten Daten gefunden'
    })

  } catch (error) {
    console.error('Fehler:', error.message)
    res.status(500).json({ error: error.message })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`DECLAY Computer Use Server v2 läuft auf Port ${PORT}`)
})
