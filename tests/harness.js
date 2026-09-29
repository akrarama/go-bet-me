// Мини-раннер тестов без зависимостей. Работает в браузере (tests/index.html)
// и во встроенном в macOS JavaScriptCore (sh tools/check.sh).
//
// Файл тестов: export default (t) => { t.test('название', (a) => { a.eq(1 + 1, 2); }); };

const fmt = (v) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

export const assert = {
  ok(v, msg = 'ожидали true') {
    if (!v) throw new Error(msg);
  },
  eq(actual, expected, msg = '') {
    if (!Object.is(actual, expected)) throw new Error(`${msg} ожидали ${fmt(expected)}, получили ${fmt(actual)}`.trim());
  },
  near(actual, expected, eps = 1e-6, msg = '') {
    if (!(Math.abs(actual - expected) <= eps)) throw new Error(`${msg} ожидали ${expected} ± ${eps}, получили ${actual}`.trim());
  },
  deep(actual, expected, msg = '') {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg} ожидали ${fmt(expected)}, получили ${fmt(actual)}`.trim());
  },
};

export async function runSuites(names, load, log) {
  const res = { pass: 0, fail: 0, failures: [] };
  for (const name of names) {
    const tests = [];
    try {
      const mod = await load(name);
      mod.default({ test: (title, fn) => tests.push([title, fn]) });
    } catch (err) {
      res.fail++;
      res.failures.push(`${name}: не загрузился: ${err}`);
      log(`✗ ${name}: не загрузился: ${err}`);
      continue;
    }
    for (const [title, fn] of tests) {
      try {
        await fn(assert);
        res.pass++;
        log(`✓ ${name}: ${title}`);
      } catch (err) {
        res.fail++;
        res.failures.push(`${name}: ${title}: ${err.message}`);
        log(`✗ ${name}: ${title}\n    ${err.message}`);
      }
    }
  }
  log(`\n${res.fail ? 'FAIL' : 'PASS'} ${res.pass}/${res.pass + res.fail}`);
  return res;
}
