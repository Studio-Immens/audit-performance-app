# 🔍 Studio Immens Audit Proxy

Proxy sicuro per Google PageSpeed Insights API con rilevamento WordPress, rate limiting e anti-abuso.

## 🚀 Deploy su CapRover

### 1. Crea l'app su CapRover
```bash
caprover deploy --caproverName tuo-caprover --appName studio-immens-audit
```

### 2. Configura le variabili d'ambiente
Nella UI di CapRover (App Configs → Environmental Variables):

| Variabile | Descrizione | Esempio |
|-----------|-------------|---------|
| `PSI_API_KEY` | API Key Google PageSpeed Insights | `AIzaSy...` |
| `ALLOWED_ORIGINS` | Domini permessi (CORS) | `https://studioimmens.com` |
| `NODE_ENV` | Ambiente | `production` |

### 3. Ottieni la PSI API Key
1. Vai su [Google Cloud Console](https://console.cloud.google.com/)
2. Crea un progetto (o usa uno esistente)
3. Abilita l'API "PageSpeed Insights API"
4. Crea una API Key (Credentials → Create Credentials → API Key)
5. (Opzionale) Limita la key per referrer/domain

## 🔒 Sicurezza

- **API Key nascosta**: mai esposta al frontend
- **Rate limiting**: 10 audit/ora per IP, 100 req/15min globali
- **CORS**: solo domini autorizzati
- **Helmet**: headers di sicurezza
- **HPP**: protezione parameter pollution
- **IP blocking**: localhost e private IPs bloccati
- **Progressive delay**: rallentamento dopo 5 req/15min

## 📡 API Endpoints

### POST `/api/audit`
Audit completo: PSI + WordPress detection + business impact.

**Body:**
```json
{
  "url": "https://example.com",
  "traffic": 5000,
  "conversionValue": 150
}
```

**Response:**
```json
{
  "success": true,
  "url": "https://example.com",
  "wordpress": {
    "isWordPress": true,
    "version": "6.4.2",
    "theme": "astra",
    "plugins": ["woocommerce", "elementor", "yoast-seo"],
    "hasWooCommerce": true,
    "hasElementor": true,
    "cms": "WordPress"
  },
  "performance": { "mobile": {...}, "desktop": {...} },
  "business": {
    "speedPenalty": 30,
    "annualLoss": 15400,
    "recommendations": [...]
  }
}
```

### POST `/api/detect`
Solo rilevamento WordPress (più leggero).

### GET `/health`
Health check.

## 🛠️ Sviluppo Locale

```bash
npm install
npm run dev
```

Richiede file `.env` con `PSI_API_KEY`.

## 📄 Licenza
MIT — Studio Immens
