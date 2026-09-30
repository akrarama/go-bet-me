// Запуск всех тестов. Каждый блок пишет только в свой файл *.test.js.

import { runSuites } from './harness.js';

const SUITES = ['geometry', 'reps', 'exercises', 'gestures', 'money', 'meditation'];

const inJsc = typeof document === 'undefined';
const out = inJsc ? null : document.querySelector('#out');
const log = inJsc ? print : (s) => {
  console.log(s);
  if (out) out.textContent += `${s}\n`;
};

const res = await runSuites(SUITES, (name) => import(`./${name}.test.js`), log);
globalThis.__TESTS__ = res;
if (!inJsc) document.title = `${res.fail ? 'FAIL' : 'PASS'} ${res.pass}/${res.pass + res.fail}`;
if (inJsc && res.fail) throw new Error(`упало тестов: ${res.fail}`);
