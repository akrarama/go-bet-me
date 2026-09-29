#!/bin/sh
# Проверка без установки: синтаксис всех JS-модулей + тесты чистой логики.
# Использует JavaScriptCore, который уже есть в macOS. Запуск: sh tools/check.sh
cd "$(dirname "$0")/.." || exit 1
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
"$JSC" tools/check.js -- $(find src tests -name '*.js' | sort) || exit 1
"$JSC" -m tests/run.js
