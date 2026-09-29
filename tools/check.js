// Проверка синтаксиса JS-модулей без Node: встроенный в macOS JavaScriptCore.
// Запуск: sh tools/check.sh

let bad = 0;
for (const file of arguments) {
  try {
    checkModuleSyntax(readFile(file));
  } catch (err) {
    bad++;
    print(`✗ ${file}: ${err}`);
  }
}
print(bad ? `Синтаксис: ошибки в ${bad} файл(ах)` : `Синтаксис: ок, файлов ${arguments.length}`);
if (bad) throw new Error('синтаксис');
