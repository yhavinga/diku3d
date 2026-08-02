#!/usr/bin/env python3
"""Static server for the viewer. Serves the project root so that both the app
and merc21/area/*.are are reachable from the same origin.

    python3 serve.py [port]      # default 8173
"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8173
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.are': 'text/plain; charset=iso-8859-1',
        '.js': 'text/javascript',
        '': 'application/octet-stream',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Nothing here is worth caching while it is being worked on.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '404' in (fmt % args):
            sys.stderr.write(f'{self.address_string()} {fmt % args}\n')


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(('127.0.0.1', PORT), Handler) as httpd:
    print(f'diku3d on http://localhost:{PORT}/  (serving {ROOT})')
    httpd.serve_forever()
