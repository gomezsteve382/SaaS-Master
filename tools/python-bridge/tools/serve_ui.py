"""
Tiny local HTTP server for serving a built React app.

Web Serial API (used by SRTLabJailbreakEdition.jsx) requires a secure context —
either HTTPS or localhost. Loading the HTML via file:// in Chrome will cause
`Failed to open serial port` errors before you even touch the adapter.

This server serves the current directory on http://localhost:8000 which browsers
treat as secure. Useful if you've built the app with `npm run build` and want to
preview the dist/ folder.

USAGE:
    python serve_ui.py              # serve . on port 8000
    python serve_ui.py 9000         # custom port
    python serve_ui.py 8000 dist    # serve dist/ instead of .

NOTES:
    - Chrome/Edge 89+ only. Not Firefox, not Safari, not mobile.
    - USB adapters only; Bluetooth ELM327 on Windows is invisible to Web Serial.
    - On Linux, your user needs to be in the `dialout` group.
    - If you see "already open", close any other tab/app holding the adapter.
"""
import http.server
import socketserver
import sys
import os
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = sys.argv[2] if len(sys.argv) > 2 else '.'

abs_root = os.path.abspath(ROOT)
if not os.path.isdir(abs_root):
    print(f"error: not a directory: {abs_root}", file=sys.stderr)
    sys.exit(1)
os.chdir(abs_root)


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serve with no-cache headers so browser always pulls fresh code."""
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()
    
    def log_message(self, format, *args):
        sys.stderr.write(f"[{self.log_date_time_string()}] {format%args}\n")


with socketserver.TCPServer(("", PORT), Handler) as httpd:
    url = f"http://localhost:{PORT}/"
    print(f"Serving {abs_root} at {url}")
    print(f"(Ctrl+C to stop)")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutdown.")
