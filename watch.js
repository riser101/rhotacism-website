import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const watchFiles = [
    path.join(__dirname, 'therollracademy/includes/nav.html'),
    path.join(__dirname, 'therollracademy/includes/footer.html')
];

function build() {
    console.log(`\n[${new Date().toLocaleTimeString()}] Building...`);
    try {
        execSync('node build.js', { cwd: __dirname, stdio: 'inherit' });
    } catch (err) {
        console.error('Build failed:', err.message);
    }
}

build();

console.log('\nWatching nav.html and footer.html... (Ctrl+C to stop)\n');

watchFiles.forEach(file => {
    fs.watchFile(file, { interval: 500 }, (curr, prev) => {
        if (curr.mtime !== prev.mtime) {
            console.log(`Changed: ${path.basename(file)}`);
            build();
        }
    });
});
