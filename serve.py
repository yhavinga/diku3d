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

# The same headers nginx sends (tools/deploy/nginx-diku3d.conf), so that every
# local and headless run is under the policy production has; tools/csp-check.mjs
# holds the two copies, and the inline scripts' hashes, to each other. Each
# source beyond 'self', found by running the page under the policy:
#   script-src  the hashes: index.html's import map and its inline module;
#               blob: a texture worker (bakery.js) imports textures.js from a
#               Blob URL, and a worker is under the policy of its own response
#   style-src   'unsafe-inline': index.html's <style>, the <style> elements the
#               modules make, and style="" in the dashboard's markup
#   img-src     data: the favicon, and SMAAPass's two lookup textures
#   connect-src ws: wss: the connect form reaches any server a player types in
# The rest only forbid; form-action 'none' because every form here is sent by
# script, so a form that would post a password anywhere is not one of ours.
SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self' blob: 'sha256-1yvnH29VT6SvG/tGoNfuKL3PfgQC2PuybzkQ2c6rgyA=' 'sha256-8f5ZzUv7TCHcPTZ6l7JVotLJHlOylp6VkAgZrWGIxmo='; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
}


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
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
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
