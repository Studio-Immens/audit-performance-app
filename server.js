const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const hpp = require('hpp');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// SECURITY MIDDLEWARE
// ============================================

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"]
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

app.use(hpp()); // Prevent HTTP Parameter Pollution
app.use(express.json({ limit: '10kb' })); // Limit body size

// CORS - Only allow Studio Immens domain
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['https://studioimmens.com', 'https://www.studioimmens.com'];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('CORS policy: Origin not allowed'), false);
    }
    return callback(null, true);
  },
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Origin'],
  credentials: false
}));

// ============================================
// RATE LIMITING & ANTI-ABUSE
// ============================================

// Global rate limiter: 100 requests per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: {
    error: 'Troppe richieste. Riprova tra 15 minuti.',
    retryAfter: 900
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Rate limit exceeded',
      message: 'Hai effettuato troppe richieste. Attendi 15 minuti.',
      retryAfter: 900
    });
  }
});

// Stricter limiter for audit endpoint: 10 audits per hour per IP
const auditLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: {
    error: 'Limite audit raggiunto. Massimo 10 audit all\'ora per IP.',
    retryAfter: 3600
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Audit limit exceeded',
      message: 'Massimo 10 audit all\'ora per indirizzo IP. Riprova più tardi.',
      retryAfter: 3600
    });
  }
});

// Speed limiter: progressive delay after 5 requests
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 5,
  delayMs: (hits) => hits * 500, // 500ms delay per request over limit
  maxDelayMs: 10000 // Max 10 seconds delay
});

app.use(globalLimiter);
app.use(speedLimiter);

// ============================================
// WORDPRESS DETECTION UTILITIES
// ============================================

async function detectWordPress(url) {
  const result = {
    isWordPress: false,
    version: null,
    theme: null,
    plugins: [],
    hasWooCommerce: false,
    hasElementor: false,
    hasYoast: false,
    hasWPRocket: false,
    hasRankMath: false,
    hasContactForm7: false,
    hasWPML: false,
    serverInfo: null,
    cms: 'Unknown'
  };

  try {
    // Fetch the homepage
    const response = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      validateStatus: (status) => status < 500
    });

    const html = response.data;
    const $ = cheerio.load(html);
    const headers = response.headers;

    // Check for WordPress in HTML
    const wpPatterns = [
      /wp-content/i,
      /wp-includes/i,
      /wp-json/i,
      /wordpress/i,
      /generator.*wordpress/i,
      /<link rel="https:\/\/api\.w\.org\//i,
      /xmlrpc\.php/i
    ];

    result.isWordPress = wpPatterns.some(pattern => pattern.test(html));

    // Extract WordPress version
    const versionMatch = html.match(/<meta name="generator" content="WordPress ([0-9.]+)"/i);
    if (versionMatch) result.version = versionMatch[1];

    // Extract theme from CSS links
    const themeMatch = html.match(/wp-content\/themes\/([^\/\s"']+)/i);
    if (themeMatch) result.theme = themeMatch[1];

    // Detect plugins from HTML/JS/CSS references
    const pluginPatterns = {
      hasWooCommerce: /woocommerce|wc-frontend|wc-add-to-cart/i,
      hasElementor: /elementor|elementor-frontend|elementor-pro/i,
      hasYoast: /yoast-seo|wordpress-seo/i,
      hasWPRocket: /wp-rocket|rocket-lazyload/i,
      hasRankMath: /rank-math|rank-math-seo/i,
      hasContactForm7: /contact-form-7|wpcf7/i,
      hasWPML: /wpml|sitepress/i
    };

    for (const [key, pattern] of Object.entries(pluginPatterns)) {
      if (pattern.test(html)) result[key] = true;
    }

    // Count plugins from wp-content/plugins references
    const pluginMatches = html.match(/wp-content\/plugins\/([^\/\s"']+)/gi);
    if (pluginMatches) {
      const uniquePlugins = [...new Set(pluginMatches.map(m => m.replace(/wp-content\/plugins\//i, '').split('/')[0]))];
      result.plugins = uniquePlugins.slice(0, 20); // Limit to 20
    }

    // Server info from headers
    if (headers['server']) result.serverInfo = headers['server'];
    if (headers['x-powered-by']) result.serverInfo += ` | ${headers['x-powered-by']}`;

    // Detect CMS if not WordPress
    if (!result.isWordPress) {
      if (/drupal/i.test(html)) result.cms = 'Drupal';
      else if (/joomla/i.test(html)) result.cms = 'Joomla';
      else if (/shopify/i.test(html)) result.cms = 'Shopify';
      else if (/wix/i.test(html)) result.cms = 'Wix';
      else if (/squarespace/i.test(html)) result.cms = 'Squarespace';
      else if (/react|next\.js|gatsby/i.test(html)) result.cms = 'React/Headless';
      else result.cms = 'Custom/Other';
    } else {
      result.cms = 'WordPress';
    }

  } catch (error) {
    console.error('WordPress detection error:', error.message);
    result.error = 'Unable to fetch site for analysis';
  }

  return result;
}

// ============================================
// PAGESPEED INSIGHTS PROXY
// ============================================

async function runPageSpeedAudit(url) {
  const API_KEY = process.env.PSI_API_KEY;
  if (!API_KEY) {
    throw new Error('PSI_API_KEY not configured');
  }

  const strategies = ['MOBILE', 'DESKTOP'];
  const results = {};

  for (const strategy of strategies) {
    const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${API_KEY}&category=PERFORMANCE&category=ACCESSIBILITY&category=BEST_PRACTICES&category=SEO&strategy=${strategy}`;

    const response = await axios.get(psiUrl, { timeout: 30000 });
    const data = response.data;
    const lighthouse = data.lighthouseResult;
    const audits = lighthouse.audits;

    results[strategy.toLowerCase()] = {
      score: Math.round(lighthouse.categories.performance.score * 100),
      accessibility: Math.round(lighthouse.categories.accessibility.score * 100),
      bestPractices: Math.round(lighthouse.categories['best-practices'].score * 100),
      seo: Math.round(lighthouse.categories.seo.score * 100),
      metrics: {
        lcp: {
          value: audits['largest-contentful-paint']?.numericValue / 1000 || 0,
          displayValue: audits['largest-contentful-paint']?.displayValue || 'N/A',
          score: audits['largest-contentful-paint']?.score || 0
        },
        inp: {
          value: audits['interaction-to-next-paint']?.numericValue || 0,
          displayValue: audits['interaction-to-next-paint']?.displayValue || 'N/A',
          score: audits['interaction-to-next-paint']?.score || 0
        },
        cls: {
          value: audits['cumulative-layout-shift']?.numericValue || 0,
          displayValue: audits['cumulative-layout-shift']?.displayValue || 'N/A',
          score: audits['cumulative-layout-shift']?.score || 0
        },
        ttfb: {
          value: audits['server-response-time']?.numericValue || 0,
          displayValue: audits['server-response-time']?.displayValue || 'N/A'
        },
        fcp: {
          value: audits['first-contentful-paint']?.numericValue / 1000 || 0,
          displayValue: audits['first-contentful-paint']?.displayValue || 'N/A'
        },
        si: {
          value: audits['speed-index']?.numericValue / 1000 || 0,
          displayValue: audits['speed-index']?.displayValue || 'N/A'
        },
        tbt: {
          value: audits['total-blocking-time']?.numericValue || 0,
          displayValue: audits['total-blocking-time']?.displayValue || 'N/A'
        }
      },
      diagnostics: {
        pageSize: audits['total-byte-weight']?.numericValue || 0,
        pageSizeFormatted: audits['total-byte-weight']?.displayValue || 'N/A',
        requests: audits['network-requests']?.numericValue || 0,
        renderBlockingResources: audits['render-blocking-resources']?.details?.items?.length || 0,
        unusedCss: audits['unused-css-rules']?.details?.overallSavingsBytes || 0,
        unusedJs: audits['unused-javascript']?.details?.overallSavingsBytes || 0,
        imageOptimization: audits['uses-optimized-images']?.details?.overallSavingsBytes || 0,
        modernImageFormats: audits['modern-image-formats']?.details?.overallSavingsBytes || 0,
        serverResponseTime: audits['server-response-time']?.numericValue || 0
      },
      opportunities: extractOpportunities(audits)
    };
  }

  return results;
}

function extractOpportunities(audits) {
  const opportunityAudits = [
    'render-blocking-resources',
    'unused-css-rules',
    'unused-javascript',
    'modern-image-formats',
    'uses-optimized-images',
    'uses-text-compression',
    'uses-responsive-images',
    'efficiently-encode-images',
    'reduce-server-response-time',
    'eliminate-render-blocking-resources',
    'minify-css',
    'minify-javascript',
    'enable-text-compression',
    'preload-lcp-image'
  ];

  const opportunities = [];
  for (const auditKey of opportunityAudits) {
    const audit = audits[auditKey];
    if (audit && audit.score !== null && audit.score < 1) {
      opportunities.push({
        id: auditKey,
        title: audit.title,
        description: audit.description,
        savings: audit.displayValue || 'N/A',
        score: audit.score
      });
    }
  }

  return opportunities.sort((a, b) => (a.score || 0) - (b.score || 0));
}

// ============================================
// CALCULATE BUSINESS IMPACT
// ============================================

function calculateBusinessImpact(psiData, traffic = 5000, conversionValue = 100) {
  const mobile = psiData.mobile;
  const loadTime = mobile.metrics.lcp.value;
  const pageSize = mobile.diagnostics.pageSize;
  const requests = mobile.diagnostics.requests;

  // Speed penalty calculation
  let speedPenalty = 0;
  if (loadTime > 5) speedPenalty = 0.45;
  else if (loadTime > 3) speedPenalty = 0.30;
  else if (loadTime > 2.5) speedPenalty = 0.20;
  else if (loadTime > 2) speedPenalty = 0.10;
  else if (loadTime > 1.5) speedPenalty = 0.05;

  const monthlyLeads = traffic * 0.02; // Assume 2% base conversion
  const lostLeads = monthlyLeads * speedPenalty;
  const annualLoss = Math.round(lostLeads * conversionValue * 12);

  // Hosting cost estimation based on performance
  let estimatedHosting = 'shared';
  if (mobile.diagnostics.serverResponseTime < 200) estimatedHosting = 'dedicated/vps-optimized';
  else if (mobile.diagnostics.serverResponseTime < 600) estimatedHosting = 'vps';

  // Plugin bloat estimation
  const pluginBloat = requests > 80 ? 'high' : requests > 50 ? 'medium' : 'low';

  return {
    speedPenalty: Math.round(speedPenalty * 100),
    monthlyLeads: Math.round(monthlyLeads),
    lostLeads: Math.round(lostLeads),
    annualLoss,
    estimatedHosting,
    pluginBloat,
    pageSizeMB: (pageSize / (1024 * 1024)).toFixed(2),
    recommendations: generateRecommendations(mobile, loadTime, requests, pageSize)
  };
}

function generateRecommendations(mobile, loadTime, requests, pageSize) {
  const recs = [];

  if (loadTime > 3) {
    recs.push({
      priority: 'critical',
      title: 'Hosting lento o sovraccarico',
      description: `LCP di ${loadTime.toFixed(1)}s indica un server che non regge il carico. Passa a VPS dedicato.`,
      impact: 'Alto'
    });
  }

  if (requests > 60) {
    recs.push({
      priority: 'high',
      title: 'Troppe richieste HTTP',
      description: `${requests} richieste rallentano il caricamento. Unisci CSS/JS e rimuovi script inutili.`,
      impact: 'Medio-Alto'
    });
  }

  if (pageSize > 2 * 1024 * 1024) {
    recs.push({
      priority: 'high',
      title: 'Pagina troppo pesante',
      description: `${(pageSize/(1024*1024)).toFixed(1)}MB è eccessivo. Comprimi immagini e abilita lazy loading.`,
      impact: 'Medio-Alto'
    });
  }

  if (mobile.metrics.ttfb.value > 600) {
    recs.push({
      priority: 'critical',
      title: 'TTFB troppo alto',
      description: `Server impiega ${mobile.metrics.ttfb.value.toFixed(0)}ms a rispondere. Ottimizza server o cambia hosting.`,
      impact: 'Alto'
    });
  }

  if (mobile.diagnostics.renderBlockingResources > 3) {
    recs.push({
      priority: 'medium',
      title: 'Risorse render-blocking',
      description: `${mobile.diagnostics.renderBlockingResources} file bloccano il rendering. Carica in modo differito.`,
      impact: 'Medio'
    });
  }

  if (recs.length === 0) {
    recs.push({
      priority: 'low',
      title: 'Monitoraggio continuo',
      description: 'Performance buone. Imposta monitoraggio mensile per mantenere il vantaggio.',
      impact: 'Basso'
    });
  }

  return recs;
}

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main audit endpoint
app.post('/api/audit', auditLimiter, async (req, res) => {
  try {
    const { url, traffic, conversionValue } = req.body;

    // Validate URL
    if (!url) {
      return res.status(400).json({ error: 'URL richiesto' });
    }

    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http')) {
      targetUrl = 'https://' + targetUrl;
    }

    // Validate URL format
    try {
      new URL(targetUrl);
    } catch {
      return res.status(400).json({ error: 'URL non valido' });
    }

    // Block private IPs and localhost
    const blockedPatterns = [
      /^https?:\/\/localhost/i,
      /^https?:\/\/127\./i,
      /^https?:\/\/10\./i,
      /^https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./i,
      /^https?:\/\/192\.168\./i,
      /^https?:\/\/0\./i,
      /^https?:\/\/::1/i
    ];

    if (blockedPatterns.some(pattern => pattern.test(targetUrl))) {
      return res.status(403).json({ error: 'URL non accessibile' });
    }

    // Run WordPress detection
    const wpInfo = await detectWordPress(targetUrl);

    // Run PageSpeed Insights
    const psiData = await runPageSpeedAudit(targetUrl);

    // Calculate business impact
    const businessImpact = calculateBusinessImpact(
      psiData,
      parseInt(traffic) || 5000,
      parseFloat(conversionValue) || 100
    );

    // Log audit (for analytics, not PII)
    console.log(`[AUDIT] ${new Date().toISOString()} | IP: ${req.ip} | URL: ${targetUrl} | Score: ${psiData.mobile.score}`);

    res.json({
      success: true,
      url: targetUrl,
      wordpress: wpInfo,
      performance: psiData,
      business: businessImpact,
      auditedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Audit error:', error.message);
    res.status(500).json({
      error: 'Audit fallito',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Errore interno del server'
    });
  }
});

// WordPress detection only endpoint (lighter)
app.post('/api/detect', auditLimiter, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL richiesto' });

    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

    const wpInfo = await detectWordPress(targetUrl);
    res.json({ success: true, wordpress: wpInfo });

  } catch (error) {
    console.error('Detection error:', error.message);
    res.status(500).json({ error: 'Analisi fallita' });
  }
});

// Serve static files
app.use(express.static('public'));
app.use(express.static('views'));

// Fallback: serve the audit tool
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/views/index.html');
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Errore interno',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Qualcosa è andato storto'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Studio Immens Audit Proxy running on port ${PORT}`);
  console.log(`🔒 Allowed origins: ${allowedOrigins.join(', ')}`);
  console.log(`📊 Rate limits: 100 req/15min global, 10 audits/hour per IP`);
});
