# 📦 MediaVault — Aggregatore Personale di Media

PWA per aggregare e organizzare foto, video e link dai social media in un'unica interfaccia elegante.

## ✨ Funzionalità

- 🔗 **Importa link** da YouTube, Instagram, Facebook, Twitter/X, TikTok, Vimeo, Reddit, Spotify e altri
- 🖼️ **Anteprima automatica** di foto, video e link con thumbnail e metadati
- 📱 **Embed nativo** di YouTube, Instagram, TikTok, Vimeo, Spotify
- 🏷️ **Auto-categorizzazione** tramite algoritmo keyword + hashtag (sport, travel, food, tech, ecc.)
- ⭐ **Preferiti** — tab dedicata ai post preferiti
- 🔍 **Ricerca e filtri** per piattaforma e categoria
- 💾 **Doppio storage**: localStorage + Upstash Redis (sync cloud gratuito)
- 📤 **Import/Export** del database in JSON
- 📲 **PWA installabile** su mobile e desktop
- 🌐 **Full responsive** — ottimizzato per mobile

## 🔧 Configurazione Upstash Redis (opzionale)

Per sincronizzare i dati tra dispositivi:

1. Vai su [upstash.com](https://upstash.com) e crea un account gratuito
2. Crea un nuovo database **Redis** (seleziona la region più vicina)
3. Copia il **REST URL** e il **REST Token** dalla dashboard
4. Nell'app vai in **Impostazioni** e incolla le credenziali
5. Clicca **Test connessione** per verificare
6. I dati si sincronizzano automaticamente ogni 2 secondi dopo una modifica

> ⚠️ Il piano free di Upstash include 10.000 request/giorno — più che sufficiente per uso personale.

## 📋 Come usare

### Aggiungere un link
1. Clicca il bottone **+** (FAB) o il pulsante in alto
2. Incolla l'URL del post/video/foto
3. Clicca **Analizza** — l'app rileva la piattaforma e scarica i metadati
4. Verifica/correggi titolo, descrizione, categorie e hashtag
5. Salva

### Piattaforme supportate
| Piattaforma | Thumbnail | Embed | Metadati |
|-------------|-----------|-------|----------|
| YouTube | ✅ | ✅ | ✅ |
| Instagram | ✅ | ✅ iframe | ✅ |
| TikTok | ✅ | ✅ | ✅ |
| Vimeo | ✅ | ✅ | ✅ |
| Spotify | — | ✅ | ✅ |
| Facebook | ✅ | ✅ iframe | ✅ |
| Twitter/X | ✅ | ✅ widget | ✅ |
| Reddit | ✅ | — | ✅ |
| Link generici | ✅ OG | — | ✅ |
| Immagini dirette | ✅ | ✅ | — |

### Categorie auto-rilevate
Sport · Viaggi · Cibo · Musica · Tech · Moda · Arte · Natura · News · Gaming · Motivazione · Intrattenimento

## 🛠️ Servizi esterni gratuiti

| Servizio | Utilizzo | Limite free |
|----------|----------|-------------|
| [Microlink.io](https://microlink.io) | Metadati OG (titolo, thumb, desc) | 50 req/giorno |
| [AllOrigins](https://allorigins.win) | Proxy CORS fallback | Illimitato |
| [Upstash Redis](https://upstash.com) | Cloud storage sync | 10k req/giorno |
| YouTube oEmbed | Thumbnail dirette | Illimitato |

## 📱 Installazione come app (PWA)

**iOS (Safari):** Apri il sito → tap il pulsante condividi → "Aggiungi alla schermata Home"

**Android (Chrome):** Apri il sito → menù ⋮ → "Aggiungi alla schermata Home" oppure aspetta il banner automatico

**Desktop (Chrome/Edge):** Clicca l'icona di installazione nella barra degli indirizzi

## 📂 Struttura file

```
mediavault/
├── index.html          # App principale
├── manifest.json       # Configurazione PWA
├── sw.js               # Service Worker (offline)
├── css/
│   └── style.css       # Stili completi
├── js/
│   ├── app.js          # Logica UI principale
│   ├── storage.js      # localStorage + Upstash Redis
│   ├── detector.js     # Rilevamento piattaforma + metadati
│   └── categorizer.js  # Auto-categorizzazione
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

## 🔒 Privacy

- I dati restano nel tuo **localStorage** del browser
- Se configuri Redis, i dati vengono salvati nel tuo account Upstash personale
- Nessun dato viene inviato a server di terze parti (eccetto le API per i metadati)

## 📄 Licenza

MIT — libero uso personale e commerciale.
