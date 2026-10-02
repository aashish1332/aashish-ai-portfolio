"""Watch the Stage A kernel and pull its log the moment it reaches a terminal state.

    python tools/watch_kernel.py --tag v3 --every 120 --max-minutes 8

`kernels output` is useless here — it downloads all of `/kaggle/working`, which
is ~600 MB of Wikipedia — so this uses `KaggleApi.kernels_logs`, the same call
that recovered version 1's log. It decodes the JSON stream into a readable
transcript and prints the tail, so the interesting cells can be read without
downloading anything else.

Terminal states: COMPLETE, ERROR, CANCELLED. RUNNING keeps waiting.

Lives in `tools/` rather than in the gitignored `kaggle-push/` working
directory, for the reason `verify_checkpoint.py` does: when it turned out to be
one bug away from destroying the log it exists to save, that made it part of the
project's evidence rather than its scratch. Its *output* (the log it saves) is
still scratch and still lands in `kaggle-push/out/`.

Two things learned the hard way on 2026-10-02, both about how this tool fails:

* It is the only thing standing between a finished kernel and a log that can no
  longer be fetched, and a watch does not always end on purpose. The first
  version of this file was started with an 11 h window, ran 88 healthy polls,
  and then vanished at 20:45:43 with no exit message — killed, not timed out,
  since 88 polls × 150 s (220 min) is short of any window it was given. A tool
  that can be killed silently must say what it is doing *at the start*, so the
  atmosphere is recorded rather than reconstructed. Hence the header.
* The exit message is therefore best-effort, not a guarantee. Treat the header
  plus the last poll timestamp as the record; treat silence as "stopped", never
  as "still fine". The safe usage is a short window run in the foreground, so
  every run ends in something readable.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

REF = "aashishkumarrajput/training-stage-a-v2"
# tools/ sits at the repo root; the saved logs are still scratch, so they stay in
# the gitignored kaggle-push/ directory next to the rest of the run artifacts.
OUT = Path(__file__).resolve().parents[1] / "kaggle-push" / "out"
TERMINAL = {"COMPLETE", "ERROR", "CANCELLED"}


def log_paths(ref: str, tag: str | None = None, out: Path = OUT) -> tuple[Path, Path]:
    """Where this ref's raw log and decoded transcript go — never over an old one.

    Both names used to be hardcoded to `kaggle-v2.*`. Since `ref` names the
    *kernel* and the run is a *version* of it, that meant watching version 3
    would write its raw log straight over version 2's — while this file's own
    comment calls the raw log "the irreplaceable artifact", because it exists
    only while the `kernels_logs` call can still be made. A tool whose whole job
    is not to lose a log was one invocation away from erasing one.

    So the name carries a tag, and an untagged watch gets a timestamp rather
    than a bare slug. Two reasons it is a caller-supplied tag and not the
    kernel's version number, which would have been the obvious source:
    `ApiKernelMetadata.current_version_number` reads back as `0` from
    `kernels_list` (checked 2026-10-02), and `kernels_status`'s response has no
    version field at all — `ApiGetKernelSessionStatusResponse` exposes only
    `status`. There is no API to ask. An inferred name with no source to infer
    from would be a guess wearing a version number's clothes.

    The caller must still pass `--tag`, and `_free_path` still refuses to
    clobber: a second watch of the same run lands beside the first rather than
    on top of it.
    """
    slug = ref.split("/")[-1].replace(".", "-")
    if not tag:
        tag = time.strftime("%Y%m%d-%H%M%S")
    # Both separators, always, not `os.sep`. Sanitising only the *platform*
    # separator meant a tag of `../x` passed straight through on Windows, where
    # `os.sep` is `\` and `/` is also a directory separator: the log would have
    # been written to a sibling directory instead of beside its siblings. Found
    # by a test that asked for `../escaped` and got a path whose parent was no
    # longer the output directory.
    tag = tag.strip().replace("/", "-").replace("\\", "-")
    tag = tag.replace("\x00", "").replace(" ", "-") or "untagged"
    if tag in (".", ".."):
        tag = "untagged"
    base = out / f"kaggle-{slug}-{tag}"
    return base.with_suffix(".log"), base.with_suffix(".txt")


def _free_path(path: Path) -> Path:
    """A path that is safe to write: `path` if unused, else `path.2`, `.3`, ...

    Exists because the failure this guards against is silent. `write_text` on an
    existing path is not an error and leaves no evidence of what was there, so a
    130 KB log can be replaced by a 3-line one and nothing anywhere says so. A
    timestamped name alone only moves that window from "same run twice" to
    "same second twice"; this closes it.
    """
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    for n in range(2, 1000):
        candidate = path.with_name(f"{stem}.{n}{suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"no free path beside {path} after 998 tries")


def status(api) -> str:
    """The status as a bare word.

    `kernels_status` returns an `ApiGetKernelSessionStatusResponse` in this CLI
    version, whose repr is the whole object — so read its field, and fall back
    to the repr rather than calling `.strip()` on something that has no `strip`.
    """
    raw = api.kernels_status(REF)
    for attribute in ("status", "session_status", "kernel_session_status"):
        value = getattr(raw, attribute, None)
        if isinstance(value, str) and value:
            return value
    text = str(raw)
    for candidate in TERMINAL | {"RUNNING", "STARTING"}:
        if candidate in text:
            return candidate
    return text


def use_utf8_stdout() -> None:
    """Make stdout UTF-8 so that what is redirected is what was printed.

    Redirected stdout on this box defaults to cp1252, and the first version of
    the header proved it: the `·` in it was written as byte 0xB7 and read back
    as `\ufffd`, so the log file already was not a verbatim record of the run it
    describes. Reconfiguring at the *top* of `main` is the whole fix - it was
    already being called, but only inside `decode`, which runs after every
    header line has been written. Errors are `replace` rather than `strict`
    because a watch that dies on an unprintable byte in a Kaggle log would be
    failing at the one job it has.
    """
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def decode(raw: str) -> str:
    use_utf8_stdout()
    records = json.loads(raw)
    # Version 1's log is a JSON *array* of records. A dict wrapper would be a
    # different shape; say so rather than iterating its keys and printing
    # nonsense that looks like a transcript.
    if isinstance(records, dict):
        for key in ("log", "data", "records", "logs"):
            if isinstance(records.get(key), (list, str)):
                records = records[key]
                break
        if isinstance(records, str):
            return records
        if not isinstance(records, list):
            raise ValueError(f"unexpected log shape: dict with keys "
                             f"{sorted(records)}")
    if not isinstance(records, list):
        raise ValueError(f"unexpected log shape: {type(records).__name__}")
    lines = []
    for rec in records:
        data = rec.get("data") or ""
        if not data:
            continue
        stamp = f"[{int(rec.get('time', 0)) // 60:04d}m{rec.get('time', 0) % 60:05.2f}s]"
        for chunk in data.splitlines():
            lines.append(f"{stamp} {rec.get('stream_name', '?'):6s} {chunk}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--every", type=int, default=120, help="seconds between polls")
    ap.add_argument("--max-minutes", type=float, default=180.0)
    ap.add_argument("--tag", default=None,
                    help="which run this is watching, e.g. v3 - goes in the log "
                         "filename; default is a timestamp")
    ap.add_argument("--tolerate-failures", type=int, default=50,
                    help="consecutive transient failures to ride out before giving up")
    ap.add_argument("--out", type=Path, default=OUT,
                    help="directory to write the log into")
    args = ap.parse_args(argv)
    use_utf8_stdout()

    from kaggle.api.kaggle_api_extended import KaggleApi

    api = KaggleApi()
    api.authenticate()
    args.out.mkdir(parents=True, exist_ok=True)

    # Resolved once, here, and then *held*. Asking again at write time would
    # let a timestamped name change name mid-watch, so the header would promise
    # one file and the run would deliver another.
    raw_target, text_target = log_paths(REF, args.tag, args.out)

    deadline = time.time() + args.max_minutes * 60
    # A header, because its absence made a stopped watcher indistinguishable
    # from a running one: the log simply stopped growing, with nothing to say
    # whether the deadline was reached, the process was killed, or the kernel
    # was still going. Every one of those happened on 2026-10-02.
    print(f"watch {REF}", flush=True)
    print(f"  started   {time.strftime('%Y-%m-%d %H:%M:%S')}", flush=True)
    print(f"  pid       {os.getpid()}", flush=True)
    print(f"  tag       {args.tag or '<timestamp>'}", flush=True)
    # `use_utf8_stdout` above already makes a `·` here round-trip correctly, so
    # this is not the fix - it is the belt to that pair of braces. The header is
    # the one thing that has to survive being read years later by a tool that
    # guesses the encoding, and nothing about a pipe and a dash is worth that
    # risk. (Comments and docstrings keep their punctuation; they never print.)
    print(f"  every     {args.every}s | window {args.max_minutes:g} min "
          f"(until {time.strftime('%H:%M:%S', time.localtime(deadline))})", flush=True)
    print(f"  will write {raw_target}", flush=True)
    # `state` is read by the exhausted-window message below, which a zero-poll
    # watch (max-minutes <= 0) reaches without ever assigning it.
    state = "<no poll yet>"
    polls = 0
    failures = 0
    while time.time() < deadline:
        polls += 1
        # A poll must never be the thing that ends the watch. The first version
        # let one `RemoteDisconnected` propagate and the process died — and the
        # watcher is the only thing standing between a finished kernel and a log
        # that can no longer be fetched. Ride out blips, print them, keep going.
        try:
            state = status(api)
        except Exception as exc:  # noqa: BLE001 - any failure is transient here
            failures += 1
            print(f"[{time.strftime('%H:%M:%S')}] poll {polls}: "
                  f"{exc.__class__.__name__}: {exc} "
                  f"({failures}/{args.tolerate_failures} consecutive)", flush=True)
            if failures >= args.tolerate_failures:
                print("giving up after repeated failures")
                return 1
            time.sleep(min(args.every, 30))
            continue
        failures = 0
        print(f"[{time.strftime('%H:%M:%S')}] poll {polls}: {state}", flush=True)
        if any(state.endswith(s) for s in TERMINAL):
            raw = ""
            fetch_failed = ""
            for attempt in range(1, 6):
                try:
                    raw = api.kernels_logs(REF)
                    break
                except Exception as exc:  # noqa: BLE001
                    fetch_failed = f"{exc.__class__.__name__}: {exc}"
                    print(f"log fetch attempt {attempt} failed: {fetch_failed}",
                          flush=True)
                    time.sleep(10 * attempt)

            print(f"\nterminal state: {state}")

            # Two failures that look identical on disk and are not the same
            # thing, so they must not share a message. "The server returned an
            # empty log" is a claim about Kaggle; "all five fetches failed" is a
            # claim about us. Saying the first when the second is true is how a
            # network blip gets recorded as a fact about the run.
            if fetch_failed and not raw:
                print(f"could not fetch the log at all (last: {fetch_failed})."
                      f" {raw_target} was NOT created - nothing was written, so "
                      f"the name is still free. The run IS terminal, so re-run "
                      f"this watch; it will fetch on the first poll.")
                return 1
            if not raw.strip():
                # Writing an empty file here would consume the name and leave a
                # 0-byte "log" that looks exactly like a lost one. Better to
                # write nothing and say so.
                print(f"Kaggle returned an EMPTY log for a terminal run, so "
                      f"{raw_target} was not created (an empty file would be "
                      f"indistinguishable from a lost log). Fetch it again "
                      f"before this version is replaced.")
                return 1

            # Raw bytes to disk BEFORE decoding. The raw log is the
            # irreplaceable artifact — it only exists while this call can be
            # made — while the transcript is reproducible from it. Writing the
            # decoded text first means a decoder bug loses the only copy, which
            # is exactly what happened to version 1's raw log.
            raw_path = _free_path(raw_target)
            raw_path.write_text(raw, encoding="utf-8")
            print(f"raw  {raw_path} ({len(raw):,} bytes)")
            try:
                text = decode(raw)
            except Exception as exc:  # noqa: BLE001 - the raw log is already safe
                print(f"decode failed ({exc.__class__.__name__}: {exc}); "
                      f"{raw_path} is intact")
                return 1
            # Written beside the raw log, under the same tag-free-name rule, so a
            # transcript can never land on top of another run's either.
            text_path = _free_path(text_target.with_name(raw_path.stem).with_suffix(".txt"))
            text_path.write_text(text, encoding="utf-8")
            print(f"text {text_path} ({len(text.splitlines())} lines)")
            print("\n--- last 40 lines ---\n")
            print("\n".join(text.splitlines()[-40:]))
            return 0
        time.sleep(args.every)

    # Reached only by running out of window. Said plainly, and said with the
    # fact that matters: the kernel is *not* terminal, so the log is not
    # fetchable yet and this watch should be restarted rather than believed.
    print(f"\nwindow exhausted after {args.max_minutes:g} min and {polls} polls, "
          f"still {state}. NOT terminal - no log to fetch yet. Restart this "
          f"watch (the run is unaffected; this only stops the polling).",
          flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
