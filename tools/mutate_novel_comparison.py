"""Mutation checks for the novel-answer comparison and the Stage B config claim.

    PYTHONUTF8=1 python tools/mutate_novel_comparison.py

Stage B v2 is the run that was supposed to show diverse questions teaching the
model to condition on the question. It did not: 8 prompts produced **4** distinct
answers against v1's 5. That verdict is only worth anything if the tool counting
it cannot silently flatter the model, so every way this can go wrong is attacked
directly - pooling the wrong block, comparing quoted against unquoted strings,
counting a leaked fact slot as an answer, and the `^` anchor that made the
auditor's config claim unmatchable on the very transcripts it audits.
"""

from __future__ import annotations

import sys
from pathlib import Path

import mutation_env

ROOT = Path(__file__).resolve().parents[1]
COMPARE = ROOT / "tools" / "compare_novel_answers.py"
AUDITOR = ROOT / "tools" / "audit_run_log.py"
SUITE = "tests.py.test_compare_novel_answers."

#: (label, target file, find, replace, test target, evidence phrase)
MUTATIONS = [
    (
        "N1 the config claim stops tolerating the transcript's own prefix",
        AUDITOR,
        r'r"^(?:\[[^\]]*\]\s*(?:\w+\s+)?)?"' "\n"
        '          r"(\\w+): vocab=',
        'r"^"' "\n" '          r"(\\w+): vocab=',
        SUITE + "ConfigClaimMatchesAPrefixedTranscript."
        "test_it_matches_the_line_as_the_transcript_prints_it",
        "cannot match a decorated transcript line",
    ),
    (
        "N2 the config claim matches anywhere in a line, not just at its start",
        AUDITOR,
        r'r"^(?:\[[^\]]*\]\s*(?:\w+\s+)?)?"' "\n"
        '          r"(\\w+): vocab=',
        r'r"(?:\[[^\]]*\]\s*(?:\w+\s+)?)?"' "\n"
        '          r"(\\w+): vocab=',
        SUITE + "ConfigClaimMatchesAPrefixedTranscript."
        "test_it_still_rejects_the_shape_in_the_middle_of_a_line",
        "must match a line, not",
    ),
    (
        # Aimed at the test that actually pins `ANSI`, not at the one that reads
        # as though it does. `PREFIX` handles the `[0016m11.22s] stdout ` form,
        # so `test_the_timestamp_prefix_is_removed` passes with `ANSI` replaced
        # by a pattern that matches nothing; the guard on `ANSI` is the real
        # escape sequence, which `PREFIX` cannot see because it has no `]`.
        "N3 real ANSI escapes stop being stripped",
        COMPARE,
        # The trailing newline is part of the anchor. Without it the
        # replacement leaves a stray backtick welded onto the following
        # docstring line, the mutant still compiles, and the guard passes for
        # a reason that has nothing to do with the guard. It looked like PREFIX
        # was absorbing real escape sequences; it was not - the replacement had
        # never been applied where anyone thought it was.
        'ANSI = re.compile(r"\\x1b\\[[0-9;]*m")\n',
        'ANSI = re.compile(r"(?!x)x")\n',
        SUITE + "TranscriptDecorationIsStripped."
        "test_a_real_escape_sequence_is_removed",
        "a real ANSI escape sequence is not removed",
    ),
    (
        "N4 a new block no longer clears the previous block's dangling question",
        COMPARE,
        '        if header:\n'
        '            name = line[2:].split()[0]\n'
        "            blocks.append((name, []))\n"
        "            question = None\n"
        "            continue",
        '        if header:\n'
        '            name = line[2:].split()[0]\n'
        "            blocks.append((name, []))\n"
        "            continue",
        SUITE + "SamplingBlocksAreKeptApart."
        "test_a_block_boundary_clears_a_dangling_question",
        "was paired with this block's answer",
    ),
    (
        "N4b the timestamp prefix stops being stripped, so nothing matches",
        COMPARE,
        # As with N3: the newline belongs to the anchor.
        'PREFIX = re.compile(r"^\\[[^\\]\\n]*\\]\\s*(?:stdout|stderr)?\\s*")\n',
        'PREFIX = re.compile(r"(?!x)x")\n',
        SUITE + "TranscriptDecorationIsStripped."
        "test_the_timestamp_prefix_is_removed",
        "every question in the transcript carries a prefix",
    ),
    (
        "N5 every sampling block after the first is dropped",
        COMPARE,
        '        if header:\n'
        '            name = line[2:].split()[0]\n'
        "            blocks.append((name, []))\n"
        "            question = None\n"
        "            continue",
        '        if header and not blocks:\n'
        '            name = line[2:].split()[0]\n'
        "            blocks.append((name, []))\n"
        "            question = None\n"
        "            continue",
        SUITE + "SamplingBlocksAreKeptApart.test_two_blocks_are_separate",
        "the two samplings were merged into one block",
    ),
    (
        "N6 answers are compared with their quotes still on",
        COMPARE,
        '    except (ValueError, SyntaxError):\n'
        "        return raw.strip()\n"
        '    return value if isinstance(value, str) else str(value)',
        "    except (ValueError, SyntaxError):\n"
        "        return raw.strip()\n"
        "    return raw.strip()",
        SUITE + "SamplingBlocksAreKeptApart."
        "test_both_quoted_and_single_quoted_answers_unquote",
        "the double-quoted answer kept its quotes",
    ),
]


def main() -> int:
    originals: dict[Path, str] = {}

    def source_of(path: Path) -> str:
        if path not in originals:
            originals[path] = path.read_text(encoding="utf-8")
        return originals[path]

    def restore(path: Path) -> None:
        if path in originals:
            path.write_text(originals[path], encoding="utf-8", newline="")

    mutation_env.clear_bytecode_caches()
    caught = uncaught = 0
    print(f"{len(MUTATIONS)} mutations against the novel-answer comparison")
    print("=" * 70)
    try:
        for label, path, find, replace, test, phrase in MUTATIONS:
            original = source_of(path)
            if find not in original:
                print(f"\nSKIP  {label}\n      anchor moved in "
                      f"{path.name}; update the mutation")
                uncaught += 1
                continue
            mutated = original.replace(find, replace, 1)
            syntax_error = mutation_env.check_parses(mutated, path)
            if syntax_error:
                print(f"\nMALFORMED  {label}\n      does not compile: "
                      f"{syntax_error}")
                uncaught += 1
                continue
            path.write_text(mutated, encoding="utf-8", newline="")
            try:
                code, combined = mutation_env.run_test(test)
            finally:
                restore(path)
            name = test.rsplit(".", 1)[-1]
            if code != 0 and name in combined and phrase in combined:
                print(f"\nCAUGHT    {label}\n      target: {name}")
                caught += 1
            else:
                print(f"\nNOT CAUGHT  {label}\n      target: {name} (exit {code}, "
                      f"phrase {phrase!r} "
                      f"{'present' if phrase in combined else 'absent'})")
                uncaught += 1
    finally:
        for path in list(originals):
            restore(path)

    print("\n" + "=" * 70)
    print(f"  {caught}/{len(MUTATIONS)} mutations caught for the right reason, "
          f"{uncaught} not")
    print("=" * 70)
    return 0 if uncaught == 0 else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())