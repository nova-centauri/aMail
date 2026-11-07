import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as normalize from './mail/normalize.js';

// App.jsx is not rendered in tests, so a missing import only shows up as a
// ReferenceError in the browser. Message bodies once failed to load that way.
describe('App.jsx', () => {
  it('imports every mail/normalize helper it calls', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/App.jsx'), 'utf8');
    const importLine = source.match(/import \{([^}]+)\} from '\.\/mail\/normalize\.js';/);
    const imported = new Set((importLine?.[1] || '').split(',').map((name) => name.trim()).filter(Boolean));
    const called = Object.keys(normalize).filter((name) => new RegExp(`\\b${name}\\(`).test(source));
    const missing = called.filter((name) => !imported.has(name) && !new RegExp(`(const|function) ${name}\\b`).test(source));
    expect(missing).toEqual([]);
  });
});
