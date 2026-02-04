import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const NAV_FILE = path.join(ROOT, 'therollracademy/includes/nav.html');
const FOOTER_FILE = path.join(ROOT, 'therollracademy/includes/footer.html');

const NAV_PLACEHOLDER = '<!-- NAV_PLACEHOLDER -->';
const FOOTER_PLACEHOLDER = '<!-- FOOTER_PLACEHOLDER -->';

const navContent = fs.readFileSync(NAV_FILE, 'utf8');
const footerContent = fs.readFileSync(FOOTER_FILE, 'utf8');

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
        console.log(`Updated: ${path.relative(ROOT, file)}`);
    }
}

console.log(`\nBuild complete: ${updated} files updated`);
