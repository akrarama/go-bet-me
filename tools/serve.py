#!/usr/bin/env python3
"""Локальный сервер без кэша, с Range-запросами (нужны для видео в ?debug=1).

Из папки репо:            python3 tools/serve.py              -> http://localhost:8000
Корень на уровень выше:   python3 tools/serve.py --root .. --port 8000
Камера в браузере работает на localhost без HTTPS.
"""
import argparse
import http.server
import os
import re
from functools import partial
from urllib.parse import parse_qs, urlparse


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.wasm': 'application/wasm',
        '.mp4': 'video/mp4',
        '.mov': 'video/mp4',
        '.m4v': 'video/mp4',
        '.webm': 'video/webm',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_head(self):
        self._left = None
        rng = self.headers.get('Range')
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            return super().send_head()
        m = re.match(r'bytes=(\d*)-(\d*)', rng)
        size = os.path.getsize(path)
        start = int(m.group(1)) if m and m.group(1) else 0
        end = min(int(m.group(2)) if m and m.group(2) else size - 1, size - 1)
        if start > end:
            self.send_error(416)
            return None
        f = open(path, 'rb')
        f.seek(start)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()
        self._left = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        try:
            if self._left is None:
                return super().copyfile(source, outputfile)
            while self._left > 0:
                chunk = source.read(min(256 * 1024, self._left))
                if not chunk:
                    break
                outputfile.write(chunk)
                self._left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # браузер оборвал загрузку видео, это нормально

    def do_POST(self):
        """/__save?path=fixtures/....json: tests/replay.js сохраняет итоги прогона. Только fixtures/*.json."""
        u = urlparse(self.path)
        rel = (parse_qs(u.query).get('path') or [''])[0].lstrip('/')
        if u.path != '/__save' or not rel.startswith('fixtures/') or not rel.endswith('.json') or '..' in rel.split('/'):
            self.send_error(400, 'only /__save?path=fixtures/*.json')
            return
        target = os.path.join(self.directory, rel)
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as f:
            f.write(body)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"ok": true}')

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--root', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), partial(Handler, directory=root))
    print(f'http://localhost:{args.port}/  (корень: {root})', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
