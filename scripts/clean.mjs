import { rmSync } from 'node:fs';

for (const dir of ['dist', 'dist-test']) rmSync(dir, { recursive: true, force: true });
