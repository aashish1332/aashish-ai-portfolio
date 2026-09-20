"""ai/data/facts.py — the §1 public gate, mirrored for the training side.

`ai/knowledge/view.mjs` decides what the browser may answer with:
anything whose `public` flag is not exactly `false`. Training data has to
be built from the same set, for a reason that is easy to get wrong — if
a `public:false` value (the withheld phone number) ends up in the corpus,
the model *learns it*, and no runtime filter can un-learn it. The value
would then be one prompt away from being emitted.

So this module refuses to hand out a private value at all, and the
pipeline masks the public ones into placeholders.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.tokenizer import spec  # noqa: E402


def is_public(fact) -> bool:
    """`public:false` means no; absent means yes — identical to view.mjs."""
    return not (isinstance(fact, dict) and fact.get("public") is False)


def slug(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(label or "").strip().lower()).strip("_")


def iter_facts(kb: dict):
    """Yield `{id, value, public, source}` for every fact carrying a value.

    Composed project-link ids (`project.volunteer.live`) match the
    placeholder ids the tokenizer reserves, so a URL in the corpus
    becomes the same token the model will be asked to emit.
    """
    seen: set[str] = set()
    found: list[dict] = []

    def emit(node, fact_id: str, value, source) -> None:
        if fact_id in seen or not isinstance(value, str) or not value.strip():
            return
        seen.add(fact_id)
        found.append({"id": fact_id, "value": value.strip(),
                      "public": is_public(node), "source": source})

    def walk(node):
        if isinstance(node, dict):
            fid = node.get("id")
            if isinstance(fid, str):
                emit(node, fid, node.get("value"), node.get("source"))
                emit(node, fid, node.get("url"), node.get("source"))
                for link in node.get("links", []) or []:
                    if isinstance(link, dict) and link.get("url"):
                        slugged = slug(link.get("label", ""))
                        if slugged:
                            emit(node, f"{fid}.{slugged}", link["url"],
                                 link.get("source", node.get("source")))
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(kb)
    yield from found


def all_values(kb: dict, kinds: tuple[str, ...] = ("url", "email")) -> dict[str, str]:
    """Public `{fact_id: value}` for the requested kinds, id-ordered.

    Numbers and dates are deliberately absent: masking `8.28` inside a
    sentence is §7.4's job at instruction-data build time, where the fact
    ids exist per value. Masking a *label* like the person's name would be
    actively wrong — §8.4's persona requires the assistant to say it.
    """
    url_re = re.compile(r"^https?://", re.I)
    email_re = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")

    out: dict[str, str] = {}
    for fact in iter_facts(kb):
        if not fact["public"]:
            continue
        value = fact["value"]
        if "url" in kinds and url_re.match(value):
            out[fact["id"]] = value
        elif "email" in kinds and email_re.match(value):
            out[fact["id"]] = value
    return out


def withheld(kb: dict) -> list[str]:
    """Ids the gate removed. Metadata only — never a value."""
    return [f["id"] for f in iter_facts(kb) if not f["public"]]


def kb_values_for_masking(kb: dict | None = None) -> dict[str, str]:
    kb = kb if kb is not None else spec.load_kb()
    return all_values(kb)
