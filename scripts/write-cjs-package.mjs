// The root package.json declares "type": "module", so the CommonJS build needs
// its own package.json to make Node treat dist/cjs/*.js as CommonJS.
import { writeFileSync } from 'node:fs';

writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
