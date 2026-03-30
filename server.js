const express = require('express')
const cors = require('cors')
const Anthropic = require('@anthropic-ai/sdk')

const app = express()
app.use(cors())
app.use(express.json())

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DECLAY Computer Use' })
})

app.post('/search', async (req, res) => {
  const { vin, bauteil, portal, credentials } = req.body
  
  if (!vin || !bauteil) {
    return res.status(400).json({ error: 'VIN und Bauteil erforderlich' })
  }

  try {
    const messages = [{
      role: 'user',
      content: `Du bist ein KFZ-Teile Assistent. 
      
Öffne ${portal === 'birner' ? 'https://tm2.carparts-cat.com/login/birner' : 'https://www.partslink24.com'} im Browser.

Logge dich ein mit:
- Benutzername: ${credentials?.username || ''}
- Passwort: ${credentials?.password || ''}

Suche dann nach dem Fahrzeug mit VIN: ${vin}
Gesuchtes Bauteil: ${bauteil}

Finde die OE-Nummern, Artikelnummern, Preise und Verfügbarkeit.
Gib das Ergebnis als JSON zurück:
{
  "teile": [
    {
      "oe_nummer": "...",
      "artikelnummer": "...", 
      "bezeichnung": "...",
      "hersteller": "...",
      "preis": "...",
      "verfuegbarkeit": "..."
    }
  ]
}`
    }]

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages
    })

    const text = response.content[0].text
    
    // JSON aus Antwort extrahieren
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0])
      return res.json(result)
    }

    res.json({ teile: [], raw: text })

  } catch (error) {
    console.error('Fehler:', error)
    res.status(500).json({ error: error.message })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`DECLAY Computer Use Server läuft auf Port ${PORT}`)
})
