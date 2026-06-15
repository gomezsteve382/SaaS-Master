#!/usr/bin/env python3
"""Tiny static file server that disables caching, so the browser never serves a
stale diag.html. Usage:  python nocache_server.py <port> <directory>"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *a):
        pass  # quiet


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8088
    directory = sys.argv[2] if len(sys.argv) > 2 else "."
    os.chdir(directory)
    print(f"SRT Lab no-cache web server on http://127.0.0.1:{port}  (dir: {directory})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()


if __name__ == "__main__":
    main()
