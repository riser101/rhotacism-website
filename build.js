import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// Default includes for therollracademy
const DEFAULT_NAV_FILE = path.join(ROOT, 'therollracademy/includes/nav.html');
const DEFAULT_FOOTER_FILE = path.join(ROOT, 'therollracademy/includes/footer.html');

const NAV_PLACEHOLDER = '<!-- NAV_PLACEHOLDER -->';
const FOOTER_PLACEHOLDER = '<!-- FOOTER_PLACEHOLDER -->';

// Cache for includes
const defaultIncludes = { nav: null, footer: null };
const productIncludes = {};

function getDefaultIncludes() {
  if (!defaultIncludes.nav) {
    defaultIncludes.nav = fs.readFileSync(DEFAULT_NAV_FILE, 'utf8');
    defaultIncludes.footer = fs.readFileSync(DEFAULT_FOOTER_FILE, 'utf8');
  }
  return defaultIncludes;
}

function getProductIncludes(product) {
  if (!productIncludes[product]) {
    productIncludes[product] = {
      nav: fs.readFileSync(path.join(ROOT, `${product}/includes/nav.html`), 'utf8'),
      footer: fs.readFileSync(path.join(ROOT, `${product}/includes/footer.html`), 'utf8')
    };
  }
  return productIncludes[product];
}

function findHtmlFiles(dir, files = []) {
  for (const item of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory() && !['includes', 'node_modules', '.git', '.claude'].includes(item)) {
      findHtmlFiles(fullPath, files);
    } else if (item.endsWith('.html') && !fullPath.includes('/includes/')) {
      files.push(fullPath);
    }
  }
  return files;
}

const htmlFiles = findHtmlFiles(ROOT);

let updated = 0;
for (const file of htmlFiles) {
  const relativePath = path.relative(ROOT, file);
  // Determine product based on top-level directory
  const parts = relativePath.split(path.sep);
  let product = null;
  if (parts.length > 0 && (parts[0] === 'thestutteracademy' || parts[0] === 'thelispacademy')) {
    product = parts[0];
  }

  // Get appropriate includes
  let navContent, footerContent;
  if (product) {
    const includes = getProductIncludes(product);
    navContent = includes.nav;
    footerContent = includes.footer;
  } else {
    const includes = getDefaultIncludes();
    navContent = includes.nav;
    footerContent = includes.footer;
  }

  let content = fs.readFileSync(file, 'utf8');
  let changed = false;

  if (content.includes(NAV_PLACEHOLDER)) {
    content = content.replace(NAV_PLACEHOLDER, navContent);
    changed = true;
  }

  if (content.includes(FOOTER_PLACEHOLDER)) {
    content = content.replace(FOOTER_PLACEHOLDER, footerContent);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(file, content);
    updated++;
    console.log(`Updated: ${relativePath}`);
  }
}

console.log(`\nBuild complete: ${updated} files updated`);