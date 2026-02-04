import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const NAV_PLACEHOLDER = '<!-- NAV_PLACEHOLDER -->';
const FOOTER_PLACEHOLDER = '<!-- FOOTER_PLACEHOLDER -->';

const navContent = fs.readFileSync(path.join(ROOT, 'therollracademy/includes/nav.html'), 'utf8').trim();
const footerContent = fs.readFileSync(path.join(ROOT, 'therollracademy/includes/footer.html'), 'utf8').trim();

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

let restored = 0;
for (const file of findHtmlFiles(ROOT)) {
    let content = fs.readFileSync(file, 'utf8');
    let changed = false;

    if (content.includes(navContent)) {
        content = content.replace(navContent, NAV_PLACEHOLDER);
        changed = true;
    }
    if (content.includes(footerContent)) {
        content = content.replace(footerContent, FOOTER_PLACEHOLDER);
        changed = true;
    }

    if (changed) {
        fs.writeFileSync(file, content);
        restored++;
        console.log(`Restored: ${path.relative(ROOT, file)}`);
    }
}

console.log(`\nRestore complete: ${restored} files`);
