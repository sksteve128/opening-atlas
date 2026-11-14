"""Loopback-only Maia-2 Rapid inference for the local Vite app."""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from importlib.metadata import version
from pathlib import Path

import chess
from maia2 import inference, model


MODEL_ID = "maia2-rapid"
MODEL_VERSION = version("maia2")
MODEL_ROOT = Path(__file__).resolve().parent.parent / ".maia2-models"
maia = model.from_pretrained(type="rapid", device="cpu", save_root=str(MODEL_ROOT))
prepared = inference.prepare()


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "Not found"})
        self.reply(200, {"model": MODEL_ID, "version": MODEL_VERSION, "ready": True})

    def do_POST(self):
        if self.path != "/predict":
            return self.reply(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                raise ValueError("Invalid request size")
            request = json.loads(self.rfile.read(length))
            fen, rating = request["fen"], request["rating"]
            if not isinstance(fen, str) or type(rating) is not int or not 400 <= rating <= 3000:
                raise ValueError("Invalid FEN or rating")
            board = chess.Board(fen)
            if not board.is_valid() or board.is_game_over():
                raise ValueError("Position must be legal and nonterminal")
            # Maia-2 uses active and opponent Elo; the selected target rating models both.
            probabilities, _ = inference.inference_each(maia, prepared, fen, rating, rating)
            legal = {move.uci() for move in board.legal_moves}
            if set(probabilities) != legal:
                raise RuntimeError("Model did not return every legal move")
            self.reply(200, {"model": MODEL_ID, "version": MODEL_VERSION,
                             "rating": rating, "calibrated": False,
                             "moves": [{"uci": move, "probability": probability}
                                       for move, probability in probabilities.items()]})
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            self.reply(400, {"error": str(error)})
        except Exception as error:
            self.reply(503, {"error": str(error)})


if __name__ == "__main__":
    print(f"{MODEL_ID} {MODEL_VERSION} ready on http://127.0.0.1:8765", flush=True)
    HTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
