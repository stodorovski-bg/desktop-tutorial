// Събира файловете на приложението в папка www/ (за телефона и за уеб версията).
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const out = 'www';
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/vendor`, { recursive: true });
for (const f of ['index.html', 'styles.css', 'app.js', 'config.js', 'sw.js', 'manifest.webmanifest', 'icons']) {
  cpSync(f, `${out}/${f}`, { recursive: true });
}
cpSync('node_modules/@supabase/supabase-js/dist/umd/supabase.js', `${out}/vendor/supabase.js`);
console.log('Готово: www/');
