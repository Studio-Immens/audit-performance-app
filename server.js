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
    hasWPForms: false,
    hasSliderRevolution: false,
    hasGravityForms: false,
    hasJetpack: false,
    hasAkismet: false,
    hasWordfence: false,
    hasLiteSpeedCache: false,
    hasW3TotalCache: false,
    hasAutoptimize: false,
    hasSmush: false,
    hasUpdraftPlus: false,
    serverInfo: null,
    cms: 'Unknown',
    detectionMethods: []
  };

  const detectedPlugins = new Set();
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

  try {
    // === METODO 1: Fetch homepage HTML ===
    const [homeResponse, apiResponse] = await Promise.allSettled([
      axios.get(url, {
        timeout: 15000,
        maxRedirects: 5,
        headers: { 'User-Agent': userAgent },
        validateStatus: (status) => status < 500
      }),
      // === METODO 2: Prova la REST API wp-json ===
      axios.get(`${url.replace(/\/$/, '')}/wp-json/`, {
        timeout: 8000,
        headers: { 'User-Agent': userAgent },
        validateStatus: (status) => status < 500
      }).catch(() => null)
    ]);

    let html = '';
    let headers = {};

    if (homeResponse.status === 'fulfilled') {
      html = homeResponse.value.data || '';
      headers = homeResponse.value.headers || {};
    }

    // --- Check WordPress in HTML ---
    const wpPatterns = [
      /wp-content/i, /wp-includes/i, /wp-json/i, /wordpress/i,
      /generator.*wordpress/i, /<link rel="https:\/\/api\.w\.org\//i,
      /xmlrpc\.php/i, /wp-embed/i, /wp-emoji/i, /wp-block-library/i,
      /class="[^"]*wp-/i, /id="[^"]*wp-/i, /data-wp-/i
    ];

    result.isWordPress = wpPatterns.some(pattern => pattern.test(html));

    if (result.isWordPress) {
      result.detectionMethods.push('html-patterns');
    }

    // --- Check REST API response ---
    if (apiResponse.status === 'fulfilled' && apiResponse.value) {
      const apiData = apiResponse.value.data;
      if (apiData && (apiData.namespaces || apiData.authentication)) {
        result.isWordPress = true;
        result.detectionMethods.push('rest-api');
        
        // Estrai plugin dalle namespaces API
        if (apiData.namespaces) {
          const apiPlugins = {
            'wc': 'WooCommerce',
            'wc-admin': 'WooCommerce',
            'elementor': 'Elementor',
            'yoast': 'Yoast SEO',
            'rank-math': 'Rank Math',
            'jetpack': 'Jetpack',
            'wordfence': 'Wordfence',
            'contact-form-7': 'Contact Form 7',
            'wpforms': 'WPForms',
            'gravityforms': 'Gravity Forms',
            'slider-revolution': 'Slider Revolution',
            'wpml': 'WPML',
            'litespeed-cache': 'LiteSpeed Cache',
            'w3-total-cache': 'W3 Total Cache',
            'autoptimize': 'Autoptimize',
            'wp-smush': 'Smush',
            'updraftplus': 'UpdraftPlus',
            'akismet': 'Akismet'
          };
          
          apiData.namespaces.forEach(ns => {
            Object.entries(apiPlugins).forEach(([prefix, name]) => {
              if (ns.startsWith(prefix + '/') || ns === prefix) {
                detectedPlugins.add(name);
              }
            });
          });
        }
      }
    }

    // --- Extract WordPress version ---
    const versionMatch = html.match(/<meta\s+name=["']generator["']\s+content=["']WordPress\s+([0-9.]+)["']/i) ||
                         html.match(/["']wp["']\s*:\s*["']([0-9.]+)["']/i);
    if (versionMatch) result.version = versionMatch[1];

    // --- Extract theme ---
    const themePatterns = [
      /wp-content\/themes\/([^\/\s"'>]+)/i,
      /wp-content\\\/themes\\\/([^\/\s"'>]+)/i,
      /stylesheet["']?\s*:\s*["']([^"']*\/themes\/([^\/"']+))["']/i
    ];
    for (const pattern of themePatterns) {
      const match = html.match(pattern);
      if (match) {
        result.theme = match[1].split('/').pop() || match[1];
        break;
      }
    }

    // --- Detect plugins from HTML/JS/CSS references ---
    const htmlPluginPatterns = {
      'WooCommerce': /woocommerce|wc-frontend|wc-add-to-cart|wc-blocks|wc-cart/i,
      'Elementor': /elementor|elementor-frontend|elementor-pro|elementor-icons/i,
      'Yoast SEO': /yoast-seo|wordpress-seo|yoast-schema/i,
      'WP Rocket': /wp-rocket|rocket-lazyload|rocket-loader|wpr-/i,
      'Rank Math': /rank-math|rank-math-seo|rank-math-schema/i,
      'Contact Form 7': /contact-form-7|wpcf7|cf7-/i,
      'WPML': /wpml|sitepress|wpml-/i,
      'WPForms': /wpforms|wpf-/i,
      'Gravity Forms': /gravityforms|gform/i,
      'Slider Revolution': /revslider|slider-revolution|revolution-slider/i,
      'Jetpack': /jetpack|jp-/i,
      'Akismet': /akismet/i,
      'Wordfence': /wordfence|wf-/i,
      'LiteSpeed Cache': /litespeed-cache|lscache/i,
      'W3 Total Cache': /w3-total-cache|w3tc/i,
      'Autoptimize': /autoptimize|ao-/i,
      'Smush': /smush|wp-smush/i,
      'UpdraftPlus': /updraftplus|updraft-/i,
      'WP Super Cache': /wp-super-cache/i,
      'Cache Enabler': /cache-enabler/i,
      'SG Optimizer': /sg-optimizer/i,
      'Ninja Forms': /ninja-forms|nf-/i,
      'Formidable': /formidable/i,
      'Mailchimp': /mailchimp|mc4wp/i,
      'WP Mail SMTP': /wp-mail-smtp/i,
      'All in One SEO': /all-in-one-seo|aioseo/i,
      'SEOPress': /seopress/i,
      'Sucuri': /sucuri/i,
      'iThemes Security': /ithemes-security|better-wp-security/i,
      'Really Simple SSL': /really-simple-ssl/i,
      'Cookie Notice': /cookie-notice|cookie-law/i,
      'GDPR Cookie Consent': /gdpr-cookie-consent/i,
      'WP Cookie Consent': /wp-cookie-consent/i,
      'MonsterInsights': /monsterinsights|mi-/i,
      'ExactMetrics': /exactmetrics/i,
      'Google Site Kit': /google-site-kit|site-kit/i,
      'Redirection': /redirection/i,
      'Yoast Duplicate Post': /duplicate-post/i,
      'Advanced Custom Fields': /advanced-custom-fields|acf-/i,
      'Custom Field Suite': /custom-field-suite/i,
      'Pods': /pods/i,
      'Toolset': /toolset|types/i,
      'Beaver Builder': /beaver-builder|fl-builder/i,
      'Divi Builder': /divi-builder|et_pb/i,
      'Visual Composer': /visual-composer|vc_/i,
      'WPBakery': /wpbakery|js_composer/i,
      'Oxygen': /oxygen/i,
      'Bricks': /bricks/i,
      'Breakdance': /breakdance/i,
      'Kadence': /kadence|kt-/i,
      'GenerateBlocks': /generateblocks/i,
      'Stackable': /stackable|ugb-/i,
      'Ultimate Blocks': /ultimate-blocks/i,
      'Spectra': /spectra|uagb-/i,
      'CoBlocks': /coblocks/i,
      'Gutenberg': /gutenberg/i,
      'Classic Editor': /classic-editor/i,
      'Disable Gutenberg': /disable-gutenberg/i,
      'Code Snippets': /code-snippets/i,
      'WPCode': /wpcode/i,
      'Admin Menu Editor': /admin-menu-editor/i,
      'User Role Editor': /user-role-editor/i,
      'Members': /members/i,
      'Capability Manager': /capability-manager/i,
      'Simple History': /simple-history/i,
      'Activity Log': /activity-log/i,
      'Query Monitor': /query-monitor/i,
      'Debug Bar': /debug-bar/i,
      'WP Crontrol': /wp-crontrol/i,
      'Advanced Cron Manager': /advanced-cron-manager/i,
      'WP-Optimize': /wp-optimize/i,
      'WP Sweep': /wp-sweep/i,
      'Advanced Database Cleaner': /advanced-database-cleaner/i,
      'Media Cleaner': /media-cleaner/i,
      'Enable Media Replace': /enable-media-replace/i,
      'Regenerate Thumbnails': /regenerate-thumbnails/i,
      'EWWW Image Optimizer': /ewww-image-optimizer/i,
      'ShortPixel': /shortpixel/i,
      'Imagify': /imagify/i,
      'Optimole': /optimole/i,
      'WebP Express': /webp-express/i,
      'Perfmatters': /perfmatters/i,
      'Flying Press': /flying-press/i,
      'Swift Performance': /swift-performance/i,
      'Breeze': /breeze/i,
      'NitroPack': /nitropack/i,
      'Cloudflare': /cloudflare/i,
      'Sucuri Scanner': /sucuri-scanner/i,
      'Wordfence Security': /wordfence/i,
      'iThemes Security Pro': /ithemes-security-pro/i,
      'All In One WP Security': /all-in-one-wp-security/i,
      'BulletProof Security': /bulletproof-security/i,
      'Cerber Security': /cerber/i,
      'Loginizer': /loginizer/i,
      'Limit Login Attempts': /limit-login-attempts/i,
      'Two Factor': /two-factor/i,
      'WP 2FA': /wp-2fa/i,
      'Solid Security': /solid-security/i,
      'Patchstack': /patchstack/i,
      'MalCare': /malcare/i,
      'BlogVault': /blogvault/i,
      'ManageWP': /managewp/i,
      'MainWP': /mainwp/i,
      'InfiniteWP': /infinitewp/i,
      'WP Remote': /wp-remote/i,
      'SolidWP': /solidwp/i,
      'Duplicator': /duplicator/i,
      'All-in-One WP Migration': /all-in-one-wp-migration/i,
      'WPvivid': /wpvivid/i,
      'BackupBuddy': /backupbuddy/i,
      'BlogVault Backup': /blogvault/i,
      'VaultPress': /vaultpress/i,
      'Jetpack Backup': /jetpack-backup/i,
      'BoldGrid Backup': /boldgrid-backup/i,
      'Total Upkeep': /total-upkeep/i,
      'WP Staging': /wp-staging/i,
      'WP Stagecoach': /wp-stagecoach/i,
      'Duplicator Pro': /duplicator-pro/i,
      'Migrate Guru': /migrate-guru/i,
      'Search & Replace': /search-replace/i,
      'Better Search Replace': /better-search-replace/i,
      'WP Migrate DB': /wp-migrate-db/i,
      'Polylang': /polylang/i,
      'qTranslate': /qtranslate/i,
      'GTranslate': /gtranslate/i,
      'Weglot': /weglot/i,
      'TranslatePress': /translatepress/i,
      'Loco Translate': /loco-translate/i,
      'MultilingualPress': /multilingualpress/i,
      'BuddyPress': /buddypress/i,
      'BuddyBoss': /buddyboss/i,
      'bbPress': /bbpress/i,
      'PeepSo': /peepso/i,
      'LearnDash': /learndash/i,
      'LifterLMS': /lifterlms/i,
      'Tutor LMS': /tutor-lms/i,
      'Sensei': /sensei/i,
      'WP Courseware': /wp-courseware/i,
      'LearnPress': /learnpress/i,
      'MasterStudy': /masterstudy/i,
      'Tribe Events': /the-events-calendar|tribe-events/i,
      'Events Manager': /events-manager/i,
      'EventON': /eventon/i,
      'Amelia': /amelia/i,
      'Bookly': /bookly/i,
      'WP Booking Calendar': /wp-booking-calendar/i,
      'Easy Appointments': /easy-appointments/i,
      'Simply Schedule Appointments': /simply-schedule-appointments/i,
      'LatePoint': /latepoint/i,
      'WP ERP': /wp-erp/i,
      'WP Project Manager': /wp-project-manager/i,
      'UpStream': /upstream/i,
      'Panorama': /panorama/i,
      'WP Client Portal': /wp-client-portal/i,
      'Client Dash': /client-dash/i,
      'Admin Columns': /admin-columns/i,
      'Pods': /pods/i,
      'Custom Post Type UI': /custom-post-type-ui/i,
      'Custom Post Type Maker': /custom-post-type-maker/i,
      'Post Types Unlimited': /post-types-unlimited/i,
      'ACF': /advanced-custom-fields|acf-/i,
      'Meta Box': /meta-box/i,
      'Carbon Fields': /carbon-fields/i,
      'CMB2': /cmb2/i,
      'Custom Field Suite': /custom-field-suite/i,
      'Piklist': /piklist/i,
      'Toolset Types': /toolset-types/i,
      'FacetWP': /facetwp/i,
      'SearchWP': /searchwp/i,
      'Relevanssi': /relevanssi/i,
      'ElasticPress': /elasticpress/i,
      'Ajax Search Pro': /ajax-search-pro/i,
      'Ivory Search': /ivory-search/i,
      'FiboSearch': /fibosearch/i,
      'WP Extended Search': /wp-extended-search/i,
      'Better Search': /better-search/i,
      'Search Everything': /search-everything/i,
      'WP Google Search': /wp-google-search/i,
      'Google Custom Search': /google-custom-search/i,
      'Swiftype Search': /swiftype/i,
      'Algolia': /algolia/i,
      'FacetWP': /facetwp/i,
      'Gridbuilder': /gridbuilder/i,
      'WP Grid Builder': /wp-grid-builder/i,
      'Essential Grid': /essential-grid/i,
      'The Grid': /the-grid/i,
      'Media Grid': /media-grid/i,
      'UberGrid': /ubergrid/i,
      'Grid Plus': /grid-plus/i,
      'Post Grid': /post-grid/i,
      'Content Views': /content-views/i,
      'WP Show Posts': /wp-show-posts/i,
      'Display Posts': /display-posts/i,
      'Posts Table Pro': /posts-table-pro/i,
      'TablePress': /tablepress/i,
      'WP Table Builder': /wp-table-builder/i,
      'Ninja Tables': /ninja-tables/i,
      'wpDataTables': /wpdatatables/i,
      'Visualizer': /visualizer/i,
      'M Chart': /m-chart/i,
      'Inline Google Spreadsheet Viewer': /inline-google-spreadsheet-viewer/i,
      'WP Google Sheets': /wp-google-sheets/i,
      'Sheet2Site': /sheet2site/i,
      'ImportWP': /importwp/i,
      'WP All Import': /wp-all-import/i,
      'WP All Export': /wp-all-export/i,
      'Product CSV Import Suite': /product-csv-import-suite/i,
      'WP CSV': /wp-csv/i,
      'CSV Importer': /csv-importer/i,
      'Really Simple CSV Importer': /really-simple-csv-importer/i,
      'WordPress Importer': /wordpress-importer/i,
      'Widget Importer & Exporter': /widget-importer-exporter/i,
      'Customizer Export/Import': /customizer-export-import/i,
      'Customizer Search': /customizer-search/i,
      'Kirki': /kirki/i,
      'Customizer Framework': /customizer-framework/i,
      'Options Framework': /options-framework/i,
      'Redux Framework': /redux-framework/i,
      'CMB2': /cmb2/i,
      'Carbon Fields': /carbon-fields/i,
      'Pods': /pods/i,
      'Advanced Custom Fields': /advanced-custom-fields/i,
      'Meta Box': /meta-box/i,
      'Custom Field Suite': /custom-field-suite/i,
      'Piklist': /piklist/i,
      'Toolset Types': /toolset-types/i,
      'Custom Post Type UI': /custom-post-type-ui/i,
      'Pods': /pods/i,
      'Custom Post Type Maker': /custom-post-type-maker/i,
      'Post Types Unlimited': /post-types-unlimited/i,
      'ACF': /advanced-custom-fields/i,
      'Meta Box': /meta-box/i,
      'Carbon Fields': /carbon-fields/i,
      'CMB2': /cmb2/i,
      'Custom Field Suite': /custom-field-suite/i,
      'Piklist': /piklist/i,
      'Toolset Types': /toolset-types/i
    };

    for (const [name, pattern] of Object.entries(htmlPluginPatterns)) {
      if (pattern.test(html)) {
        detectedPlugins.add(name);
        const key = 'has' + name.replace(/[^a-zA-Z0-9]/g, '');
        if (result.hasOwnProperty(key)) {
          result[key] = true;
        }
      }
    }

    // --- Count plugins from wp-content/plugins references ---
    const pluginMatches = html.match(/wp-content\/plugins\/([^\/\s"'>]+)/gi);
    if (pluginMatches) {
      const uniquePlugins = [...new Set(pluginMatches.map(m => {
        const slug = m.replace(/wp-content\/plugins\//i, '').split('/')[0];
        return slug;
      }))].filter(p => p && p.length > 1);
      
      uniquePlugins.forEach(p => detectedPlugins.add(p));
    }

    // --- Detect CMS if not WordPress ---
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

    // --- Server info from headers ---
    if (headers['server']) result.serverInfo = headers['server'];
    if (headers['x-powered-by']) result.serverInfo = (result.serverInfo ? result.serverInfo + ' | ' : '') + headers['x-powered-by'];

    // --- Convert Set to Array ---
    result.plugins = [...detectedPlugins].slice(0, 30);

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
  const categories = ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO'];
  const results = {};

  for (const strategy of strategies) {
    // Costruisci URL manualmente per supportare parametri multipli
    const params = new URLSearchParams();
    params.set('url', url);
    params.set('key', API_KEY);
    params.set('strategy', strategy);
    
    // Aggiungi TUTTE le categorie con append (non set!)
    categories.forEach(cat => params.append('category', cat));

    const psiUrl = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + params.toString();

    console.log(`[PSI] Calling ${strategy} audit for: ${url}`);
    console.log(`[PSI] URL (no key): ${psiUrl.replace(API_KEY, '***')}`);

    try {
      const response = await axios.get(psiUrl, {
        timeout: 45000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Studio-Immens-Audit-Proxy/1.0)'
        },
        validateStatus: (status) => status < 500
      });

      if (response.status !== 200) {
        console.error(`[PSI] ${strategy} returned status ${response.status}:`, response.data);
        throw new Error(`PageSpeed API returned ${response.status}: ${JSON.stringify(response.data)}`);
      }

      const data = response.data;
      
      if (!data.lighthouseResult) {
        console.error(`[PSI] ${strategy} missing lighthouseResult:`, data);
        throw new Error('PageSpeed API response missing lighthouseResult');
      }

      const lighthouse = data.lighthouseResult;
      const audits = lighthouse.audits || {};

      results[strategy.toLowerCase()] = {
        score: Math.round((lighthouse.categories?.performance?.score || 0) * 100),
        accessibility: Math.round((lighthouse.categories?.accessibility?.score || 0) * 100),
        bestPractices: Math.round((lighthouse.categories?.['best-practices']?.score || 0) * 100),
        seo: Math.round((lighthouse.categories?.seo?.score || 0) * 100),
        metrics: {
          lcp: {
            value: audits['largest-contentful-paint']?.numericValue ? audits['largest-contentful-paint'].numericValue / 1000 : 0,
            displayValue: audits['largest-contentful-paint']?.displayValue || 'N/A'
          },
          inp: {
            value: audits['interaction-to-next-paint']?.numericValue || 0,
            displayValue: audits['interaction-to-next-paint']?.displayValue || 'N/A'
          },
          cls: {
            value: audits['cumulative-layout-shift']?.numericValue || 0,
            displayValue: audits['cumulative-layout-shift']?.displayValue || 'N/A'
          },
          ttfb: {
            value: audits['server-response-time']?.numericValue || 0,
            displayValue: audits['server-response-time']?.displayValue || 'N/A'
          },
          fcp: {
            value: audits['first-contentful-paint']?.numericValue ? audits['first-contentful-paint'].numericValue / 1000 : 0,
            displayValue: audits['first-contentful-paint']?.displayValue || 'N/A'
          },
          si: {
            value: audits['speed-index']?.numericValue ? audits['speed-index'].numericValue / 1000 : 0,
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

      console.log(`[PSI] ${strategy} audit completed. Score: ${results[strategy.toLowerCase()].score}`);

    } catch (error) {
      console.error(`[PSI] ${strategy} audit failed:`, error.message);
      if (error.response) {
        console.error(`[PSI] Status: ${error.response.status}`);
        console.error(`[PSI] Data:`, JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
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
    'minify-css',
    'minify-javascript',
    'enable-text-compression',
    'preload-lcp-image'
  ];

  const opportunities = [];
  for (const auditKey of opportunityAudits) {
    const audit = audits?.[auditKey];
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

// GET /api/audit - Test endpoint (no body needed, uses query params)
app.get('/api/audit', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL query parameter required. Example: /api/audit?url=https://example.com' });
    }

    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http')) {
      targetUrl = 'https://' + targetUrl;
    }

    console.log(`[AUDIT-GET] Testing PSI API with URL: ${targetUrl}`);

    const API_KEY = process.env.PSI_API_KEY;
    if (!API_KEY) {
      return res.status(500).json({ error: 'PSI_API_KEY not configured' });
    }

    const psiUrl = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    psiUrl.searchParams.set('url', targetUrl);
    psiUrl.searchParams.set('key', API_KEY);
    psiUrl.searchParams.set('category', 'PERFORMANCE');
    psiUrl.searchParams.set('strategy', 'MOBILE');

    console.log(`[AUDIT-GET] Calling PSI API...`);

    const response = await axios.get(psiUrl.toString(), {
      timeout: 30000,
      validateStatus: (status) => true
    });

    res.json({
      psiStatus: response.status,
      psiStatusText: response.statusText,
      hasLighthouseResult: !!response.data?.lighthouseResult,
      score: response.data?.lighthouseResult?.categories?.performance?.score,
      responsePreview: JSON.stringify(response.data).substring(0, 500)
    });

  } catch (error) {
    console.error('[AUDIT-GET] Error:', error.message);
    res.status(500).json({
      error: error.message,
      responseStatus: error.response?.status,
      responseData: error.response?.data
    });
  }
});

// Main audit endpoint
app.post('/api/audit', auditLimiter, async (req, res) => {
  try {
    const { url, traffic, conversionValue } = req.body;

    console.log(`[AUDIT] Request received. URL: ${url}, Traffic: ${traffic}, Value: ${conversionValue}`);

    // Validate URL
    if (!url) {
      console.log('[AUDIT] Rejected: URL missing');
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
      console.log('[AUDIT] Rejected: Invalid URL format');
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
      console.log('[AUDIT] Rejected: Private IP/localhost');
      return res.status(403).json({ error: 'URL non accessibile' });
    }

    // Run WordPress detection
    console.log('[AUDIT] Starting WordPress detection...');
    const wpInfo = await detectWordPress(targetUrl);
    console.log(`[AUDIT] WordPress detected: ${wpInfo.isWordPress}, CMS: ${wpInfo.cms}`);

    // Run PageSpeed Insights
    console.log('[AUDIT] Starting PageSpeed Insights...');
    const psiData = await runPageSpeedAudit(targetUrl);
    console.log(`[AUDIT] PSI completed. Mobile score: ${psiData.mobile.score}`);

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
    console.error('[AUDIT] Fatal error:', error.message);
    if (error.stack) {
      console.error('[AUDIT] Stack:', error.stack);
    }
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
