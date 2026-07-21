const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function scoreColor(score) {
  if (score >= 90) return '#4ade80';
  if (score >= 50) return '#fbbf24';
  return '#f87171';
}

function scoreLabel(score) {
  if (score >= 90) return 'Eccellente';
  if (score >= 50) return 'Necessita Interventi';
  return 'Critico';
}

function formatCurrency(n) {
  return '€ ' + Number(n).toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatMetric(value, unit, thresholds) {
  let cls = '#4ade80';
  if (thresholds) {
    if (value > thresholds.poor) cls = '#f87171';
    else if (value > thresholds.good) cls = '#fbbf24';
  }
  return { text: value + (unit || ''), color: cls };
}

async function generateReport(auditData) {
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(16).toString('hex');
    const filename = token + '.pdf';
    const filepath = path.join(REPORTS_DIR, filename);

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 36, bottom: 36, left: 44, right: 44 },
      info: {
        Title: 'Report Audit Performance - Studio Immens',
        Author: 'Studio Immens',
        Subject: 'Analisi performance sito WordPress',
        Keywords: 'audit, performance, wordpress, pagespeed'
      }
    });

    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    const gold = '#c9a96e';
    const goldDark = '#a88a4a';
    const bgDark = '#0a0a0f';
    const cardBg = '#1a1a24';
    const borderClr = '#2a2a3a';
    const textClr = '#f0f0f5';
    const textSec = '#a0a0b0';
    const textMut = '#6a6a7a';

    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const pageH = doc.page.height;

    function footer() {
      const y = doc.page.height - doc.page.margins.bottom - 20;
      doc.fontSize(7).fillColor(textMut);
      doc.text('Studio Immens — software house d\'élite', doc.page.margins.left, y, { width: pageW, align: 'center' });
      doc.text('studioimmens.com | report generato il ' + new Date().toLocaleDateString('it-IT'), doc.page.margins.left, y + 10, { width: pageW, align: 'center' });
    }

    function headerBar(y) {
      doc.rect(0, y, doc.page.width, 3).fill(gold);
    }

    function sectionTitle(text, y) {
      doc.fontSize(14).fillColor(gold).font('Helvetica-Bold');
      doc.text(text, doc.page.margins.left, y);
      doc.moveTo(doc.page.margins.left, doc.y + 4).lineTo(doc.page.width - doc.page.margins.right, doc.y + 4).stroke(borderClr);
      return doc.y + 10;
    }

    function tableRow(y, label, value, valueColor) {
      if (y > pageH - 80) {
        footer();
        doc.addPage();
        y = doc.page.margins.top + 20;
      }
      doc.rect(doc.page.margins.left, y, pageW, 28).fill(bgDark);
      doc.rect(doc.page.margins.left, y, pageW, 1).fill(borderClr);
      doc.fontSize(9).fillColor(textSec).font('Helvetica');
      doc.text(label, doc.page.margins.left + 14, y + 8);
      doc.fontSize(10).fillColor(valueColor || textClr).font('Helvetica-Bold');
      doc.text(String(value), doc.page.margins.left + pageW - 14, y + 8, { align: 'right' });
      return y + 28;
    }

    // Background fill
    doc.rect(0, 0, doc.page.width, pageH).fill(bgDark);

    // Header bar
    headerBar(0);

    // Brand
    doc.fontSize(8).fillColor(gold).font('Helvetica-Bold');
    doc.text('STUDIO IMMENS', doc.page.margins.left, 14);
    doc.fontSize(7).fillColor(textMut).font('Helvetica');
    doc.text('software house d\'élite', doc.page.margins.left, 26);

    // Date
    doc.fontSize(7).fillColor(textMut).font('Helvetica');
    doc.text(new Date().toLocaleDateString('it-IT', { year: 'numeric', month: 'long', day: 'numeric' }), doc.page.width - doc.page.margins.right, 16, { align: 'right' });

    // Title
    doc.fontSize(22).fillColor(textClr).font('Helvetica-Bold');
    doc.text('Report Audit Performance', doc.page.margins.left, 50, { width: pageW, align: 'center' });
    doc.fontSize(9).fillColor(textSec).font('Helvetica');
    doc.text(auditData.url || 'URL non specificato', doc.page.margins.left, 76, { width: pageW, align: 'center' });

    // Score Section
    let y = 104;
    const score = auditData.score || 0;
    const sColor = scoreColor(score);

    doc.rect(doc.page.margins.left, y, pageW, 140).fill(cardBg);
    doc.rect(doc.page.margins.left, y, pageW, 2).fill(sColor);

    // Score circle
    const cx = doc.page.margins.left + 90;
    const cy = y + 75;
    const r = 40;
    doc.circle(cx, cy, r + 4).fill(bgDark);
    doc.circle(cx, cy, r).fill(sColor);
    doc.circle(cx, cy, r - 5).fill(bgDark);
    doc.fontSize(28).fillColor(sColor).font('Helvetica-Bold');
    doc.text(String(score), cx, cy - 12, { width: 0, align: 'center' });
    doc.fontSize(8).fillColor(textMut).font('Helvetica');
    doc.text('/100', cx + 30, cy - 4, { width: 0 });

    // Score info
    doc.fontSize(18).fillColor(textClr).font('Helvetica-Bold');
    doc.text(scoreLabel(score), doc.page.margins.left + 150, y + 48);
    doc.fontSize(9).fillColor(textSec).font('Helvetica');

    const descs = {
      'Eccellente': 'Il sito è ben ottimizzato. Piccoli miglioramenti per il top.',
      'Necessita Interventi': 'Problemi significativi che costano conversioni e ranking.',
      'Critico': 'Il sito perde clienti ogni giorno. Intervento urgente.'
    };
    doc.text(descs[scoreLabel(score)] || '', doc.page.margins.left + 150, y + 74, { width: pageW - 160 });

    y += 160;

    // Core Web Vitals
    y = sectionTitle('Core Web Vitals (Mobile)', y + 6);
    const met = auditData.metrics || {};
    const rows = [
      ['LCP — Largest Contentful Paint', formatMetric(met.lcp, 's', { good: 2.5, poor: 4 })],
      ['INP — Interaction to Next Paint', formatMetric(met.inp, 'ms', { good: 200, poor: 500 })],
      ['CLS — Cumulative Layout Shift', formatMetric(met.cls, '', { good: 0.1, poor: 0.25 })],
      ['TTFB — Time to First Byte', formatMetric(met.ttfb, 'ms', { good: 600, poor: 1000 })],
      ['FCP — First Contentful Paint', formatMetric(met.fcp, 's', { good: 1.8, poor: 3 })],
      ['Speed Index', formatMetric(met.si, 's', { good: 3.4, poor: 5.8 })],
    ];
    rows.forEach(([label, val]) => {
      y = tableRow(y, label, val.text, val.color);
    });

    y += 12;

    // Technology
    y = sectionTitle('Tecnologia Rilevata', y + 6);
    const wp = auditData.wordpress || {};
    y = tableRow(y, 'CMS', wp.cms || 'N/A', textClr);
    y = tableRow(y, 'WordPress', wp.isWordPress ? '✅ Rilevato' : '❌ Non rilevato', wp.isWordPress ? '#4ade80' : '#f87171');
    if (wp.version) y = tableRow(y, 'Versione', wp.version, textClr);
    if (wp.theme) y = tableRow(y, 'Tema', wp.theme, textClr);
    const pluginCount = (wp.plugins || []).length;
    y = tableRow(y, 'Plugin Rilevati', pluginCount + (pluginCount === 1 ? ' plugin' : ' plugin'), pluginCount > 10 ? '#fbbf24' : '#4ade80');
    if (wp.serverInfo) y = tableRow(y, 'Server', wp.serverInfo, textClr);

    // Plugin tags
    if (pluginCount > 0) {
      y += 6;
      doc.fontSize(7).fillColor(textMut).font('Helvetica');
      doc.text('Plugin: ' + wp.plugins.slice(0, 15).join(', ') + (pluginCount > 15 ? ' (+' + (pluginCount - 15) + ' altri)' : ''), doc.page.margins.left + 10, y, { width: pageW - 20 });
      y += 14;
    }

    y += 12;

    // Diagnostics
    y = sectionTitle('Metriche Tecniche', y + 6);
    const diag = auditData.diagnostics || {};
    y = tableRow(y, 'Dimensione Pagina', diag.pageSizeFormatted || 'N/A', textClr);
    y = tableRow(y, 'Richieste HTTP', String(diag.requests || 0), (diag.requests || 0) > 60 ? '#fbbf24' : '#4ade80');
    y = tableRow(y, 'Risorse Render-Blocking', String(diag.renderBlockingResources || 0), (diag.renderBlockingResources || 0) > 3 ? '#f87171' : '#4ade80');
    y = tableRow(y, 'Server Response Time', (diag.serverResponseTime || 0) + 'ms', (diag.serverResponseTime || 0) > 600 ? '#f87171' : '#4ade80');

    y += 12;

    // Business Impact
    y = sectionTitle('Impatto Economico Stimato', y + 6);
    const biz = auditData.business || {};
    y = tableRow(y, 'Penalità Velocità', biz.speedPenalty ? '-' + biz.speedPenalty + '% conversioni' : 'Nessuna', biz.speedPenalty > 0 ? '#f87171' : '#4ade80');
    y = tableRow(y, 'Lead Persi / Mese', String(biz.lostLeads || 0), '#f87171');

    // Annual loss - big
    doc.rect(doc.page.margins.left, y, pageW, 42).fill(cardBg);
    doc.rect(doc.page.margins.left, y, pageW, 2).fill('#f87171');
    doc.fontSize(9).fillColor(textSec).font('Helvetica');
    doc.text('Perdita Annuale Stimata', doc.page.margins.left + 14, y + 6);
    doc.fontSize(22).fillColor('#f87171').font('Helvetica-Bold');
    doc.text(formatCurrency(biz.annualLoss || 0), doc.page.margins.left + 14, y + 16);
    y += 54;

    y += 12;

    // Recommendations
    y = sectionTitle('Priorità di Intervento', y + 6);
    const recs = biz.recommendations || [];

    if (recs.length === 0) {
      doc.fontSize(9).fillColor(textMut).font('Helvetica');
      doc.text('Nessuna raccomandazione critica. Ottimo lavoro!', doc.page.margins.left + 10, y, { width: pageW - 20 });
      y += 20;
    } else {
      recs.forEach(function(rec) {
        const color = rec.impact === 'Alto' ? '#f87171' : rec.impact === 'Medio-Alto' ? '#fbbf24' : '#4ade80';
        const indent = 10;
        if (y > pageH - 100) {
          footer();
          doc.addPage();
          doc.rect(0, 0, doc.page.width, doc.page.height).fill(bgDark);
          headerBar(0);
          y = doc.page.margins.top + 20;
        }
        doc.rect(doc.page.margins.left + indent, y, pageW - indent * 2, 50).fill(cardBg);
        doc.rect(doc.page.margins.left + indent, y, 3, 50).fill(color);
        doc.fontSize(9).fillColor(textClr).font('Helvetica-Bold');
        doc.text(rec.title || '', doc.page.margins.left + indent + 14, y + 8, { width: pageW - indent * 2 - 28 });
        doc.fontSize(8).fillColor(textSec).font('Helvetica');
        doc.text(rec.description || '', doc.page.margins.left + indent + 14, y + 24, { width: pageW - indent * 2 - 28 });
        doc.fontSize(7).fillColor(color).font('Helvetica-Bold');
        doc.text('Impatto: ' + (rec.impact || 'Medio'), doc.page.margins.left + indent + 14, y + 38);
        y += 56;
      });
    }

    y += 16;

    // CTA Box
    if (y > pageH - 120) {
      footer();
      doc.addPage();
      doc.rect(0, 0, doc.page.width, doc.page.height).fill(bgDark);
      headerBar(0);
      y = doc.page.margins.top + 20;
    }

    doc.rect(doc.page.margins.left, y, pageW, 90).fill(cardBg);
    doc.rect(doc.page.margins.left, y, pageW, 2).fill(gold);
    doc.fontSize(13).fillColor(gold).font('Helvetica-Bold');
    doc.text('La Soluzione: Fortezza Digitale', doc.page.margins.left + 20, y + 16, { width: pageW - 40, align: 'center' });
    doc.fontSize(8).fillColor(textSec).font('Helvetica');
    doc.text('VPS OVH dedicato • Software nativo • Manutenzione 24/7 • Canone unico', doc.page.margins.left + 20, y + 38, { width: pageW - 40, align: 'center' });
    doc.fontSize(9).fillColor(gold).font('Helvetica-Bold');
    doc.text('→ Scopri di più su studioimmens.com', doc.page.margins.left + 20, y + 58, { width: pageW - 40, align: 'center' });
    doc.fontSize(7).fillColor(textMut).font('Helvetica');
    doc.text('🔒 Garanzia 30 Giorni: soddisfatto o ti aiutiamo a migrare gratis', doc.page.margins.left + 20, y + 74, { width: pageW - 40, align: 'center' });

    // Footer
    footer();

    doc.end();

    stream.on('finish', function() {
      resolve({ token, filename, filepath, size: fs.statSync(filepath).size });
    });
    stream.on('error', reject);
  });
}

function getReportPath(token) {
  const filepath = path.join(REPORTS_DIR, token + '.pdf');
  return fs.existsSync(filepath) ? filepath : null;
}

function cleanupOldReports(maxAgeDays) {
  const maxAge = maxAgeDays || 30;
  const now = Date.now();
  let removed = 0;
  if (fs.existsSync(REPORTS_DIR)) {
    fs.readdirSync(REPORTS_DIR).forEach(function(f) {
      if (f.endsWith('.pdf')) {
        const fp = path.join(REPORTS_DIR, f);
        const age = (now - fs.statSync(fp).mtimeMs) / (1000 * 60 * 60 * 24);
        if (age > maxAge) {
          fs.unlinkSync(fp);
          removed++;
        }
      }
    });
  }
  return removed;
}

module.exports = { generateReport, getReportPath, cleanupOldReports };
