"""Local dev server for DocLock: serves app/ on 127.0.0.1:8080 with caching
off, so the browser always runs the current files.

    python3 dev/serve.py            # http://localhost:8080
    python3 dev/serve.py --lan      # also reachable on the LAN (no sign-in there)
"""
import functools
import http.server
import pathlib
import sys

APP = pathlib.Path(__file__).resolve().parent.parent / "app"


class NoCache(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".svg": "image/svg+xml"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    host = "0.0.0.0" if "--lan" in sys.argv else "127.0.0.1"
    handler = functools.partial(NoCache, directory=str(APP))
    with http.server.ThreadingHTTPServer((host, 8080), handler) as httpd:
        print(f"Serving {APP} on http://{host}:8080 (no cache)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
