import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const NAV_PLACEHOLDER = '<!-- NAV_PLACEHOLDER -->';
const FOOTER_PLACEHOLDER = '<!-- FOOTER_PLACEHOLDER -->';

const PRODUCTS = ['therollracademy', 'lispspeechclinic', 'stutterfluencycentre'];

const includesByProduct = {};
for (const product of PRODUCTS) {
    includesByProduct[product] = {
        nav: fs.readFileSync(path.join(ROOT, `${product}/includes/nav.html`), 'utf8').trim(),
        footer: fs.readFileSync(path.join(ROOT, `${product}/includes/footer.html`), 'utf8').trim(),
    };
}

function productFor(relativePath) {
    const top = relativePath.split(path.sep)[0];
    if (top === 'lispspeechclinic' || top === 'stutterfluencycentre') return top;
    return 'therollracademy';
}

function navVariantsFor(relativePath, product) {
    const base = includesByProduct[product].nav;
    const variants = [base];
    if (product === 'lispspeechclinic' && relativePath === path.join('lispspeechclinic', 'index.html')) {
        variants.unshift(base.replace(/Get Started/g, 'Purchase Now'));
    }
    return variants;
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

function replaceFirst(haystack, candidates, placeholder) {
    for (const candidate of candidates) {
        if (haystack.includes(candidate)) return { content: haystack.replace(candidate, placeholder), changed: true };
    }
    return { content: haystack, changed: false };
}

let restored = 0;
for (const file of findHtmlFiles(ROOT)) {
    const relativePath = path.relative(ROOT, file);
    const product = productFor(relativePath);
    const navCandidates = navVariantsFor(relativePath, product);
    const footerCandidates = [includesByProduct[product].footer];

    let content = fs.readFileSync(file, 'utf8');
    let changed = false;

    const navResult = replaceFirst(content, navCandidates, NAV_PLACEHOLDER);
    content = navResult.content;
    changed = changed || navResult.changed;

    const footerResult = replaceFirst(content, footerCandidates, FOOTER_PLACEHOLDER);
    content = footerResult.content;
    changed = changed || footerResult.changed;

    if (changed) {
        fs.writeFileSync(file, content);
        restored++;
        console.log(`Restored: ${relativePath}`);
    }
}

console.log(`\nRestore complete: ${restored} files`);
