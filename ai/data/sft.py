"""ai/data/sft.py — Stage B data: assistant-only loss masks (§7.4).

Stage A (`ai/data/dataset.py`) streams raw token blocks and learns language.
Stage B learns to *answer from the context*, and that only happens if the
loss is computed on the assistant's tokens and nothing else. Teaching a model
to predict the user's question and the system rules is not neutral: a small
model spends most of its capacity learning to write questions and to
reproduce the rules verbatim, and the rules are the one string a §9 injection
test checks it must not reproduce.

So the mask is the interesting part here, and the three things that are easy
to get wrong are each covered by a test:

1. **Char offsets → token offsets.** `tokenizers` reports character offsets
   per token, so a character span from `instruction.assistant_spans` maps to
   the tokens *fully contained* in it. A token that merely overlaps the
   boundary of a span is not supervised — half-supervising `<|asst|>` is a
   silent way to train the model to emit delimiters in the wrong places.

2. **The terminating `<|end|>` is supervised too.** `assistant_spans` stops
   before it, and generation stops by *emitting* it (§9: stop ids). A model
   that is never taught to end its turn rambles until the token ceiling,
   which is exactly the failure the runtime's stop list papers over. The
   choice is explicit here rather than implied: assistant content **plus**
   the `<|end|>` token that closes the turn, and the whitespace token between
   them is left unsupervised.

3. **Packing must not lose a mask.** Examples are far shorter than a training
   sequence (mean ≈ 400 tokens against a 1024 block), so a block-aligned
   stream — the same shape Stage A uses — is the packing strategy: examples
   are concatenated and cut into fixed windows, masks travelling with their
   tokens. Nothing is padded, nothing is dropped, and a window that straddles
   two examples simply has no supervised tokens for the straddling part.

`SftStream` therefore has the same guarantee as `TokenBatcher`: **resuming
from a saved state yields the identical continuation an uninterrupted run
would have produced**, and `tests/py/test_sft.py` checks it without torch.

Nothing here ships: `tools/build.mjs` excludes `ai/data`.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.data import instruction as inst  # noqa: E402
from ai.tokenizer import spec  # noqa: E402

# The model's loss uses this value for "do not train on this position"
# (`ai/model/model.py`, which is why -100 is chosen here and not 0).
IGNORE_INDEX = -100

END_TOKEN = inst.END
DEFAULT_SFT_PATH = inst.REPO_ROOT / "data" / "instruction" / "sft.jsonl"


@dataclass
class Example:
    """One serialised instruction example, with its supervision spans."""

    text: str
    spans: list[tuple[int, int]]      # char spans of assistant content
    category: str = ""
    lang: str = ""
    persona: str = ""
    counterfactual: bool = False


def read_examples(path: Path | str = DEFAULT_SFT_PATH, limit: int = 0) -> list[Example]:
    """Read `data/instruction/sft.jsonl` (one JSON object per line).

    The spans are read from the file rather than recomputed, and then
    *validated* against the text: a data file whose recorded spans have
    drifted away from its text would otherwise supervise the wrong tokens
    silently, which is the one failure mode of this whole module.
    """
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(
            f"no instruction data at {path}.\n  Build it first:\n"
            f"    npm run sft            # python -m training.scripts.make_instruction_data")
    out: list[Example] = []
    with path.open("r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:  # pragma: no cover - corrupt data
                raise ValueError(f"{path}:{lineno} is not valid JSON: {exc}") from exc
            text = row["text"]
            spans = [tuple(s) for s in row["assistant_spans"]]
            check_spans(text, spans)
            out.append(Example(
                text=text, spans=spans,
                category=row.get("category", ""), lang=row.get("lang", ""),
                persona=row.get("persona", ""),
                counterfactual=bool(row.get("counterfactual", False)),
            ))
            if limit and len(out) >= limit:
                break
    if not out:
        raise ValueError(f"{path} had no examples in it")
    return out


def check_spans(text: str, spans: list[tuple[int, int]]) -> None:
    """A recorded span must sit on an actual assistant turn of the text."""
    canonical = inst.assistant_spans(text)
    if canonical != [tuple(s) for s in spans]:
        raise ValueError(
            "assistant_spans in the data file disagree with the text they "
            f"describe.\n  recorded: {spans}\n  recomputed: {canonical}\n"
            "Supervising the wrong characters is invisible during training and "
            "shows up only as a model that answers in the wrong voice.")
    for start, end in spans:
        if not 0 <= start < end <= len(text):
            raise ValueError(f"span {start, end} is outside a {len(text)}-character example")


def end_offsets(text: str) -> list[int]:
    """Character offsets of every `<|end|>` token in `text`.

    These are the positions that close an assistant turn, and they are what
    the mask extends over (see the module docstring, point 2).
    """
    found: list[int] = []
    pos = 0
    while True:
        at = text.find(END_TOKEN, pos)
        if at == -1:
            return found
        found.append(at)
        pos = at + len(END_TOKEN)


def _in_span(text: str, tok_start: int, tok_end: int, start: int, end: int) -> bool:
    """Does this token belong to the assistant text of `[start, end)`?

    Containment is *not* the right test. Byte-level BPE folds a word's leading
    space into the word's own token (" My" is one token), and `assistant_spans`
    starts *after* that space — so every answer's first word would fail a
    containment test and go unsupervised. That is a silent one-word hole at the
    start of every answer, and it is exactly the word that names the value the
    answer exists to give ("My CGPA is …", "Here is …").

    So a token counts when it overlaps the span and everything it contributes
    *outside* the span is whitespace. `<|asst|>` and `<|end|>` are special
    tokens carried as their own ids, so they can never be absorbed here.
    """
    if tok_end <= tok_start:
        return False
    if tok_end <= start or tok_start >= end:
        return False
    before = text[tok_start:min(tok_end, start)]
    after = text[max(tok_start, end):tok_end]
    return not before.strip() and not after.strip()


def supervised_token_indices(tokenizer, example: Example) -> tuple[list[int], list[int]]:
    """`(ids, indices_of_supervised_tokens)` for one example.

    Exposed because "which positions does the loss touch" is the one thing
    about Stage B that has to be checkable on its own, without a model.
    """
    enc = tokenizer.encode(example.text)
    ids = list(enc.ids)
    ends = set(end_offsets(example.text))
    supervised: list[int] = []
    for i, (tok_start, tok_end) in enumerate(enc.offsets):
        for (start, end) in example.spans:
            if _in_span(example.text, tok_start, tok_end, start, end):
                supervised.append(i)
                break
        else:
            # `<|end|>` closes the turn: `assistant_spans` stops one character
            # before it (the space that separates it from the answer), so the
            # token to supervise starts at `end + 1` of the matching span.
            for (start, end) in example.spans:
                closer = end + 1
                if closer in ends and tok_start == closer:
                    supervised.append(i)
                    break
    return ids, supervised


def encode_example(tokenizer, example: Example) -> tuple[list[int], list[int]]:
    """`(input_ids, labels)` for one example — labels are -100 except on the
    assistant's tokens (and the `<|end|>` that closes each turn)."""
    ids, supervised = supervised_token_indices(tokenizer, example)
    if not supervised:
        raise ValueError(
            "an example produced no supervised tokens — the mask is empty, so the "
            f"example would be trained on nothing. Spans {example.spans} against "
            f"{len(example.text)} characters.")
    labels = [IGNORE_INDEX] * len(ids)
    for i in supervised:
        labels[i] = ids[i]
    return ids, labels


def encode_examples(tokenizer, examples: list[Example]) -> list[tuple[list[int], list[int]]]:
    return [encode_example(tokenizer, ex) for ex in examples]


def masked_text(tokenizer, ids: list[int], labels: list[int]) -> str:
    """Decode only the supervised tokens — what the loss is actually on.

    Used by the tests and by `--pipeline-only` to *show* the mask instead of
    claiming it: the string this returns must be the assistant's answers plus
    their `<|end|>` tokens, with no part of the question or the rules.

    Special tokens are decoded rather than skipped, so a masked abstention
    (whose whole answer is `<|abstain|><|end|>`) prints as that instead of as
    an empty string — a diagnostic that shows nothing is worse than none.
    """
    supervised = [i for i, label in enumerate(labels) if label != IGNORE_INDEX]
    return tokenizer.decode([ids[i] for i in supervised], skip_special_tokens=False)


class SftStream:
    """Fixed-length windows over a packed, shuffled stream of examples.

    `tokens_consumed` counts *supervised* positions as well as total ones, so
    a run's manifest can report how many tokens the loss actually saw — with
    a 1024 block and one assistant turn per example that is a small fraction
    of the window, and reporting the window size as "trained tokens" would
    overstate the run by an order of magnitude.
    """

    def __init__(self, examples: list[Example], tokenizer, block: int = 1024,
                 batch: int = 8, seed: int = 1337, val_every: int = 50):
        if block < 8:
            raise ValueError("block must be at least 8 tokens")
        self.examples = examples
        self.tokenizer = tokenizer
        self.block = block
        self.batch = batch
        self.seed = seed
        # Validation is a deterministic slice, not a reshuffled draw: a val
        # loss that changes because the *evaluation set* changed is not a
        # measurement of anything.
        self.val_indices = [i for i in range(len(examples)) if val_every and i % val_every == 0]
        self.train_indices = [i for i in range(len(examples)) if i not in set(self.val_indices)]
        if len(self.train_indices) < batch:
            raise ValueError(f"only {len(self.train_indices)} training examples for batch {batch}")
        self.encoded: dict[int, tuple[list[int], list[int]]] = {}
        self.rng = np.random.default_rng(seed)
        self.epoch = 0
        self.offset = 0
        self.tokens_consumed = 0
        self.supervised_consumed = 0
        self.skipped_windows = 0
        self.max_skips = 8
        self.epoch_rng_state = self.rng.bit_generator.state
        self._build_epoch()

    # ── epoch construction ───────────────────────────────────────────
    def _build_epoch(self) -> None:
        """Flatten the epoch's examples into one token stream.

        The order is drawn from the RNG *captured at the start of the epoch*,
        which is what makes a mid-epoch resume reproducible: the state saved
        with a checkpoint is the pre-shuffle state, so loading it replays the
        same permutation.
        """
        self.epoch_rng_state = self.rng.bit_generator.state
        order = self.rng.permutation(len(self.train_indices))
        ids: list[int] = []
        labels: list[int] = []
        for position in order:
            index = self.train_indices[int(position)]
            pair = self.encoded.get(index)
            if pair is None:
                pair = encode_example(self.tokenizer, self.examples[index])
                self.encoded[index] = pair
            ids.extend(pair[0])
            labels.extend(pair[1])
        self.flat_ids = np.asarray(ids, dtype=np.int32)
        self.flat_labels = np.asarray(labels, dtype=np.int32)
        # Prefix count of supervised positions, so "does this window carry any
        # loss?" is an O(1) question. It matters more than it looks: a window
        # with no supervised token makes `cross_entropy` return NaN over an
        # all-ignored target, and one NaN step poisons every weight in the run.
        self._prefix = np.concatenate(
            [[0], np.cumsum(self.flat_labels != IGNORE_INDEX)]).astype(np.int64)
        self.offset = 0

    def supervised_in(self, start: int, length: int | None = None) -> int:
        """How many supervised positions a window starting at `start` has."""
        length = self.block if length is None else length
        end = min(start + length, self.epoch_tokens)
        return int(self._prefix[end] - self._prefix[start])

    @property
    def epoch_tokens(self) -> int:
        return int(len(self.flat_ids))

    def _window(self, start: int) -> tuple[np.ndarray, np.ndarray]:
        window = self.flat_ids[start:start + self.block]
        return window, self.flat_labels[start:start + self.block]

    # ── batches ──────────────────────────────────────────────────────
    def next_batch(self) -> tuple[np.ndarray, np.ndarray]:
        """One `(batch, block)` pair, plus the final shorter batch of an epoch.

        A ragged last batch is emitted rather than dropped: the last examples
        of an epoch are data like any other, and silently discarding up to a
        batch per epoch is how a run trains on less than it reports.
        """
        rows_x: list[np.ndarray] = []
        rows_y: list[np.ndarray] = []
        for _ in range(self.batch):
            x, y = self._supervised_window()
            rows_x.append(x)
            rows_y.append(y)
        return self._stack(rows_x), self._stack(rows_y)

    def _supervised_window(self) -> tuple[np.ndarray, np.ndarray]:
        """The next window that carries any loss at all.

        Windows with no supervised token are skipped and counted rather than
        returned: they are the stretches of context and question between
        answers, they would contribute nothing anyway, and an epoch that
        happened to be *entirely* context would turn the loss into NaN.
        """
        for _ in range(self.max_skips):
            if self.offset + 1 >= self.epoch_tokens:
                self.epoch += 1
                self._build_epoch()
            start = self.offset
            x, y = self._window(start)
            self.offset += self.block
            if self.supervised_in(start) > 0:
                return x, y
            self.skipped_windows += 1
        raise ValueError(
            f"{self.max_skips} windows in a row carried no supervised token — this "
            f"stream has no assistant text to train on. Check that the data file "
            f"contains assistant turns (`--pipeline-only` prints the mask).")

    @staticmethod
    def _stack(rows: list[np.ndarray]) -> np.ndarray:
        width = max(len(row) for row in rows)
        out = np.zeros((len(rows), width), dtype=np.int32)
        for i, row in enumerate(rows):
            out[i, :len(row)] = row
        return out

    def validation_batches(self, count: int, seed: int = 0) -> list[tuple[np.ndarray, np.ndarray]]:
        """Fixed windows drawn from the held-out examples.

        A val loss that is averaged over windows with no supervised tokens is
        not comparable between runs — those windows score 0 (or NaN) and the
        average moves with how much of the val slice happens to be answer
        text. So windows are drawn from the ones that carry supervision.
        """
        rng = np.random.default_rng(seed)
        flat_x, flat_y = self._flatten(self.val_indices)
        if len(flat_x) <= self.block + 1:
            raise ValueError(
                f"the held-out slice has {len(flat_x)} tokens, too few for a block of "
                f"{self.block}: read more examples so validation can measure something")
        supervised = np.concatenate(
            [[0], np.cumsum(flat_y != IGNORE_INDEX)]).astype(np.int64)
        starts = np.arange(0, len(flat_x) - self.block - 1)
        usable = [int(s) for s in starts if supervised[s + self.block] > supervised[s]]
        if not usable:
            raise ValueError(
                "no validation window carries a supervised token — the held-out "
                "slice has no assistant text in it")
        picked = [usable[int(i)] for i in rng.integers(0, len(usable), size=count)]
        # `(1, block)` like `TokenBatcher.validation_batches`: the model forward
        # wants (batch, time), and a 1-D eval batch is a shape error, not a
        # silently different measurement.
        return [(flat_x[s:s + self.block][None, :], flat_y[s:s + self.block][None, :])
                for s in picked]

    def _flatten(self, indices: list[int]) -> tuple[np.ndarray, np.ndarray]:
        ids: list[int] = []
        labels: list[int] = []
        for index in indices:
            pair = self.encoded.get(index)
            if pair is None:
                pair = encode_example(self.tokenizer, self.examples[index])
                self.encoded[index] = pair
            ids.extend(pair[0])
            labels.extend(pair[1])
        return np.asarray(ids, dtype=np.int32), np.asarray(labels, dtype=np.int32)

    def count_supervised(self, xs: np.ndarray, ys: np.ndarray) -> int:
        return int((ys != IGNORE_INDEX).sum())

    # ── cursor ───────────────────────────────────────────────────────
    def state(self) -> dict:
        """Everything needed to continue this stream identically."""
        return {
            "epoch": self.epoch,
            "offset": self.offset,
            "tokens_consumed": self.tokens_consumed,
            "supervised_consumed": self.supervised_consumed,
            "skipped_windows": self.skipped_windows,
            "rng": self.epoch_rng_state,
            "seed": self.seed,
            "block": self.block,
            "batch": self.batch,
        }

    def load_state(self, state: dict) -> None:
        if int(state.get("block", self.block)) != self.block:
            raise ValueError(
                f"the saved cursor was written for block {state.get('block')}, this run "
                f"uses {self.block} — the windows would not line up")
        if int(state.get("batch", self.batch)) != self.batch:
            raise ValueError(f"the saved cursor was written for batch {state.get('batch')}, "
                             f"this run uses {self.batch}")
        self.epoch = int(state["epoch"])
        self.epoch_rng_state = state["rng"]
        self.rng.bit_generator.state = dict(self.epoch_rng_state)
        self._build_epoch()
        self.offset = int(state["offset"])
        self.tokens_consumed = int(state.get("tokens_consumed", 0))
        self.supervised_consumed = int(state.get("supervised_consumed", 0))
        self.skipped_windows = int(state.get("skipped_windows", 0))


def summarise(examples: list[Example]) -> dict:
    """Counts recorded in the run manifest (measured, not requested)."""
    categories: dict[str, int] = {}
    languages: dict[str, int] = {}
    for ex in examples:
        categories[ex.category] = categories.get(ex.category, 0) + 1
        languages[ex.lang] = languages.get(ex.lang, 0) + 1
    return {
        "examples": len(examples),
        "characters": sum(len(ex.text) for ex in examples),
        "categories": dict(sorted(categories.items())),
        "languages": dict(sorted(languages.items())),
        "counterfactual": sum(1 for ex in examples if ex.counterfactual),
        "assistant_turns": sum(len(ex.spans) for ex in examples),
    }


def measured_token_counts(tokenizer, examples: list[Example]) -> dict:
    """Token counts with the *shipping* tokenizer, masks included.

    `make_instruction_data.py` reports an ESTIMATED count (characters / 3.4)
    because it runs where the tokenizer may not exist yet. This is the
    measured number: total tokens, supervised tokens, and the share of each
    window the loss actually sees.
    """
    total = 0
    supervised = 0
    longest = 0
    for ex in examples:
        ids, labels = encode_example(tokenizer, ex)
        total += len(ids)
        supervised += sum(1 for value in labels if value != IGNORE_INDEX)
        longest = max(longest, len(ids))
    return {
        "tokens": total,
        "supervised_tokens": supervised,
        "supervised_share": round(supervised / total, 4) if total else 0.0,
        "longest_example": longest,
        "method": "MEASURED — encoded with the shipping tokenizer",
    }


def special_token_ids(tokenizer) -> dict:
    return {token: tokenizer.token_to_id(token) for token in spec.SPECIAL_TOKENS}
