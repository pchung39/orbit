"""Local document embeddings. No paid API.

Assumption: BAAI/bge-small-en-v1.5 via fastembed (384-d). First ingest
downloads the model from Hugging Face; later runs use the local cache.
"""

from __future__ import annotations

_model = None
DIM = 384
MODEL_ID = "BAAI/bge-small-en-v1.5"


def embed_texts(texts: list[str]) -> list[list[float]]:
    global _model
    if _model is None:
        from fastembed import TextEmbedding

        _model = TextEmbedding(MODEL_ID)
    vectors = []
    for vec in _model.embed(texts):
        vectors.append([float(x) for x in vec])
    return vectors


def as_pgvector(vec: list[float]) -> str:
    return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"
