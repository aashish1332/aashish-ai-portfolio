"""tests/py/test_extract.py — the fetch → `.txt` step §7.3 assumed existed.

Two of these tests matter more than the rest:

* `test_a_fetched_dump_becomes_a_corpus_the_pipeline_accepts` runs the real
  `prepare_data.prepare` over the real extractor's output. The gap being closed
  was that two components each looked tested while the *seam between them* did
  not exist, and only a test that crosses the seam can say otherwise.
* `test_markup_does_not_reach_the_output` is a negative assertion. A stripper
  that leaves templates behind still emits plausible-looking prose, so a test
  that only checks for the presence of words would pass on garbage.

Fixtures are generated here: a genuine `bz2` MediaWiki export (with the real
namespace, escaped `<ref>` markup and all) and a genuine parquet file. Nothing
is downloaded.
"""

from __future__ import annotations

import bz2
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai.data import extract  # noqa: E402

MEDIAWIKI_NS = "http://www.mediawiki.org/xml/export-0.11/"
HINDI = "दिल्ली भारत की राजधानी है और यह एक बहुत पुराना शहर है। "


def page(title: str, namespace: str, text: str, redirect: bool = False) -> str:
    """One `<page>` element, with the text escaped as a real dump escapes it."""
    redir = '<redirect title="Other" />' if redirect else ""
    return (f"  <page>\n    <title>{escape(title)}</title>\n    <ns>{namespace}</ns>\n"
            f"    <id>1</id>\n    {redir}\n    <revision>\n      <id>2</id>\n"
            f'      <text bytes="100" xml:space="preserve">{escape(text)}</text>\n'
            f"    </revision>\n  </page>")


def dump(pages: list[str]) -> str:
    body = "\n".join(pages)
    return (f'<mediawiki xmlns="{MEDIAWIKI_NS}" version="0.11" xml:lang="hi">\n'
            f"{body}\n</mediawiki>")


def write_dump(directory: Path, pages: list[str], name: str = "hiwiki-test.xml.bz2") -> Path:
    path = directory / name
    path.write_bytes(bz2.compress(dump(pages).encode("utf-8")))
    return path


class Wikitext(unittest.TestCase):
    def test_templates_are_removed_including_nesting(self):
        self.assertEqual(extract.strip_wikitext("a {{b|c={{d}}}} e").split(), ["a", "e"])

    def test_an_unbalanced_template_loses_its_tail_rather_than_leaking(self):
        self.assertEqual(extract.strip_wikitext("keep {{oops never closed").split(), ["keep"])

    def test_links_keep_their_label_not_their_target(self):
        self.assertEqual(extract.strip_wikitext("See [[Delhi|the capital]] now").strip(),
                         "See the capital now")
        self.assertEqual(extract.strip_wikitext("See [[Delhi]]").strip(), "See Delhi")

    def test_media_and_category_links_disappear_entirely(self):
        self.assertEqual(extract.strip_wikitext("x [[File:A.png|thumb|a caption]] y").split(),
                         ["x", "y"])
        self.assertEqual(extract.strip_wikitext("x [[Category:Cities]] y").split(), ["x", "y"])

    def test_refs_comments_tables_and_stray_tags_go(self):
        text = "keep <!-- gone --><ref name=a>gone</ref><ref name=b/> here"
        self.assertEqual(extract.strip_wikitext(text).split(), ["keep", "here"])
        self.assertEqual(extract.strip_wikitext("a {| ! h |-\n| cell |} b").split(), ["a", "b"])

    def test_bold_italic_and_headings_lose_their_markers(self):
        self.assertEqual(extract.strip_wikitext("'''bold''' and ''italic''"), "bold and italic")
        self.assertEqual(extract.strip_wikitext("== History ==").strip(), "History")

    def test_external_links_keep_a_label_and_bare_urls_vanish(self):
        self.assertEqual(extract.strip_wikitext("see [http://example.com/a the page]").strip(),
                         "see the page")
        self.assertNotIn("example.com", extract.strip_wikitext("see https://example.com/a here"))

    def test_the_known_limitations_are_real_and_recorded(self):
        r"""Asserts the limitation list is honest rather than decorative.

        `<math>` content comes through as its own source, not as prose — and
        that is written down in `MARKUP_LIMITATIONS`, so a reader is not left to
        discover it in the samples.
        """
        self.assertIn("2+2", extract.strip_wikitext("sum <math>2+2</math> end"))
        self.assertTrue(any("math" in item for item in extract.MARKUP_LIMITATIONS))


class Documents(unittest.TestCase):
    def test_whitespace_is_collapsed_and_blank_lines_dropped(self):
        self.assertEqual(extract.normalise_document("a\n\n\n  b\t\tc  \n"), "a\nb c")

    def test_lines_with_no_letters_are_dropped(self):
        """Table and figure residue: punctuation, numerals, nothing to learn."""
        self.assertEqual(extract.normalise_document("good line\n|| |\n12345 678"), "good line")

    def test_devanagari_counts_as_letters(self):
        self.assertEqual(extract.normalise_document("दिल्ली"), "दिल्ली")


class WikipediaDump(unittest.TestCase):
    def pages(self) -> list[str]:
        return [
            page("दिल्ली", "0", HINDI * 6),
            page("Talk:दिल्ली", "1", "discussion about the article " * 20),
            page("पुराना", "0", "redirection target", redirect=True),
            page("Markup", "0", "The city {{cite web|url=x}} has [[Old Delhi|an old quarter]] "
                                "and <ref name=a>a source</ref> a fort. " * 8),
        ]

    def test_articles_are_extracted_and_non_articles_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_dump(Path(tmp), self.pages())
            result = extract.extract_wikipedia_dump(path, min_chars=50, log=lambda *a: None)
            text = "\n".join(result["documents"])
            self.assertIn("राजधानी", text)
            self.assertNotIn("discussion about the article", text)
            self.assertEqual(result["counts"]["redirects"], 1)
            self.assertEqual(result["counts"]["other_namespace"], 1)

    def test_markup_does_not_reach_the_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_dump(Path(tmp), self.pages())
            text = "\n".join(extract.extract_wikipedia_dump(path, min_chars=50,
                                                           log=lambda *a: None)["documents"])
            for leftover in ("{{", "}}", "[[", "]]", "<ref", "'''", "=="):
                self.assertNotIn(leftover, text, f"{leftover!r} survived the stripper")
            self.assertIn("an old quarter", text, "the label should survive the link")

    def test_short_documents_are_counted_not_silently_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_dump(Path(tmp), self.pages())
            result = extract.extract_wikipedia_dump(path, min_chars=10_000,
                                                    log=lambda *a: None)
            self.assertEqual(result["documents"], [])
            self.assertGreater(result["counts"]["dropped_short"], 0)

    def test_keep_markup_is_honestly_noisy(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_dump(Path(tmp), self.pages())
            text = "\n".join(extract.extract_wikipedia_dump(
                path, min_chars=50, strip=False, log=lambda *a: None)["documents"])
            self.assertIn("{{cite", text)

    def test_a_limit_stops_early(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_dump(Path(tmp), [page("A", "0", HINDI * 6)])
            result = extract.extract_wikipedia_dump(path, min_chars=50, limit=1,
                                                    log=lambda *a: None)
            self.assertEqual(len(result["documents"]), 1)


class Parquet(unittest.TestCase):
    def write(self, directory: Path, column: str, rows: int = 20, name="part-000.parquet"):
        import pyarrow as pa
        import pyarrow.parquet as pq

        table = pa.table({
            column: [f"Story number {i} about a small robot who learns to paint." for i in range(rows)],
            "meta": list(range(rows)),
        })
        path = directory / name
        pq.write_table(table, path)
        return path

    def test_the_text_column_is_detected_by_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(Path(tmp), "content")
            self.assertEqual(extract.pick_text_column(extract.parquet_columns(path)), "content")

    def test_a_corpus_with_no_recognisable_column_is_an_error_not_a_guess(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(Path(tmp), "payload")
            self.assertIsNone(extract.pick_text_column(extract.parquet_columns(path)))
            with self.assertRaises(SystemExit) as ctx:
                extract.extract_file(path, "parquet", None, min_chars=10, strip=True,
                                     limit=None, log=lambda *a: None)
            self.assertIn("no obvious text column", str(ctx.exception))
            self.assertIn("payload", str(ctx.exception), "it should list what it did find")

    def test_an_explicit_column_that_does_not_exist_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(Path(tmp), "text")
            with self.assertRaises(SystemExit) as ctx:
                extract.extract_file(path, "parquet", "nope", min_chars=10, strip=True,
                                     limit=None, log=lambda *a: None)
            self.assertIn("no column", str(ctx.exception))

    def test_rows_are_streamed_and_filtered_by_length(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(Path(tmp), "text", rows=20)
            result = extract.extract_file(path, "parquet", None, min_chars=10, strip=True,
                                          limit=None, log=lambda *a: None)
            self.assertEqual(len(result["documents"]), 20)
            result = extract.extract_file(path, "parquet", None, min_chars=10_000, strip=True,
                                          limit=None, log=lambda *a: None)
            self.assertEqual(result["documents"], [])
            self.assertEqual(result["counts"]["dropped_short"], 20)

    def test_a_limit_does_not_read_the_whole_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(Path(tmp), "text", rows=500)
            result = extract.extract_file(path, "parquet", None, min_chars=10, strip=True,
                                          limit=7, log=lambda *a: None)
            self.assertEqual(len(result["documents"]), 7)


class Cli(unittest.TestCase):
    """Every test passes `--out` explicitly: the default is the repository's
    own `data/extracted`, and a test that wrote there would be a side effect
    outside its temp directory."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source_dir = self.root / "hindi_wikipedia"
        self.source_dir.mkdir(parents=True)
        (self.source_dir / "fetch_manifest.json").write_text(
            json.dumps({"source": "hindi_wikipedia", "files": []}), encoding="utf-8")
        write_dump(self.source_dir,
                   [page("दिल्ली", "0", HINDI * 6),
                    page("Markup", "0", "A city with {{a template}} and "
                                        "[[a link|a label]] in it. " * 8)])
        self.out_dir = self.root / "extracted"

    def tearDown(self):
        self.tmp.cleanup()

    def run_extract(self, *extra: str) -> int:
        return extract.main(["--in", str(self.source_dir), "--out", str(self.out_dir),
                             *extra])

    @property
    def text_path(self) -> Path:
        return self.out_dir / "hindi_wikipedia.txt"

    def test_the_kind_is_detected_from_the_files_present(self):
        self.assertEqual(self.run_extract("--min-chars", "40"), 0)
        self.assertTrue(self.text_path.exists())

    def test_the_output_is_one_document_per_line(self):
        self.run_extract("--min-chars", "40")
        lines = self.text_path.read_text(encoding="utf-8").splitlines()
        self.assertTrue(lines)
        self.assertTrue(all(line.strip() for line in lines), "no blank documents")
        self.assertTrue(all("\n" not in line for line in lines))

    def test_the_manifest_records_that_the_filters_have_not_run(self):
        self.run_extract("--min-chars", "40")
        manifest = json.loads(
            (self.out_dir / extract.MANIFEST_NAME).read_text(encoding="utf-8"))
        entry = manifest["hindi_wikipedia"]
        self.assertEqual(entry["filters_applied"], [])
        self.assertIn("pii", entry["filters_pending"])
        self.assertTrue(entry["markup_stripped"])
        self.assertEqual(entry["kind"], "wikipedia-dump")
        self.assertGreater(entry["documents"], 0)

    def test_two_sources_share_one_output_directory(self):
        """How a multi-source Stage A corpus is assembled: prepare_data --raw
        reads a single directory, so the sources have to meet somewhere."""
        self.run_extract("--min-chars", "40")
        second = self.root / "simple_english_wikipedia"
        second.mkdir()
        (second / "simplewiki-test.xml.bz2").write_bytes(
            self.source_dir.joinpath("hiwiki-test.xml.bz2").read_bytes())
        extract.main(["--in", str(second), "--out", str(self.out_dir), "--min-chars", "40"])
        self.assertTrue((self.out_dir / "simple_english_wikipedia.txt").exists())
        manifest = json.loads(
            (self.out_dir / extract.MANIFEST_NAME).read_text(encoding="utf-8"))
        self.assertEqual(sorted(manifest), ["hindi_wikipedia", "simple_english_wikipedia"])

    def test_extracting_zero_documents_is_a_named_failure_not_an_empty_file(self):
        with self.assertRaises(SystemExit) as ctx:
            self.run_extract("--min-chars", "99999")
        self.assertIn("0 documents", str(ctx.exception))
        self.assertIn("--min-chars", str(ctx.exception))
        self.assertFalse(self.text_path.exists())

    def test_list_columns_prints_parquet_schema(self):
        Parquet().write(self.root, "text", rows=3)
        self.assertEqual(extract.main(["--in", str(self.root), "--list-columns"]), 0)


class ConnectsToThePipeline(unittest.TestCase):
    """The seam: a *fetched* source becomes a corpus `prepare_data` accepts.

    `fetch_corpus` was tested, `prepare_data` was tested, and between them a
    fetched Wikipedia dump is a `.bz2` archive that `prepare_data` would never
    find, because it globs for `*.txt`. Both halves passed while the pipeline
    could not run.
    """

    def test_a_fetched_dump_becomes_a_corpus_the_pipeline_accepts(self):
        from training.scripts.prepare_data import prepare

        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "hindi_wikipedia"
            source_dir.mkdir(parents=True)
            (source_dir / "fetch_manifest.json").write_text(
                json.dumps({"source": "hindi_wikipedia",
                            "license": {"spdx": "CC-BY-SA-4.0"}}), encoding="utf-8")
            write_dump(source_dir, [page("दिल्ली", "0", HINDI * 8),
                                    page("भारत", "0", HINDI * 8)])

            extracted = Path(tmp) / "extracted"
            self.assertEqual(extract.main(["--in", str(source_dir), "--out", str(extracted),
                                           "--min-chars", "40"]), 0)

            out_dir = Path(tmp) / "processed"
            summary = prepare(extracted, out_dir)

            self.assertGreater(summary["stats"]["kept"], 0,
                               "the pipeline must find text where the fetcher left a dump")
            self.assertTrue(summary["leakage"]["clean"])
            # No --tokenizer, so no shards: the stats/leakage pass is the one
            # worth running before a tokenizer exists.
            self.assertIsNone(summary["shards"])

    def test_prepare_data_writes_the_train_split_as_the_tokenizer_input(self):
        """The tokenizer must learn merges from the *train* split of the
        *processed* text. Val text shaping the vocabulary it is scored against
        is leakage; raw text shaping it describes a corpus that never existed."""
        from training.scripts.prepare_data import PIPELINE_TEXT, prepare

        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "hindi_wikipedia"
            source_dir.mkdir(parents=True)
            # 20 genuinely distinct documents, and a 50/50 split so both sides
            # are populated. Each page uses its own prefixed vocabulary: an
            # earlier version varied one word inside repeated sentences and the
            # dedupe stage (correctly) collapsed all 20 into 3, which left the
            # split empty on one side. The split is a content hash, so this is
            # stable across runs.
            digits = "०१२३४५६७८९"
            pages = []
            for i in range(20):
                number = "".join(digits[int(d)] for d in str(i))
                words = " ".join(f"पृष्ठ{number}शब्द{j}" for j in range(30))
                pages.append(page(f"पृष्ठ {number}", "0", words + "।"))
            write_dump(source_dir, pages)
            extracted = Path(tmp) / "extracted"
            extract.main(["--in", str(source_dir), "--out", str(extracted),
                          "--min-chars", "40"])

            out_dir = Path(tmp) / "processed"
            summary = prepare(extracted, out_dir, val_percent=50)

            text_path = out_dir / PIPELINE_TEXT
            self.assertTrue(text_path.exists(), "the tokenizer needs a plain-text input")
            lines = text_path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), summary["corpus_txt_docs"])
            self.assertTrue(all(line.strip() for line in lines))

            records = [json.loads(line) for line in
                       (out_dir / "corpus.jsonl").read_text(encoding="utf-8").splitlines()]
            val_texts = {r["text"] for r in records if r["split"] == "val"}
            train_texts = {r["text"] for r in records if r["split"] == "train"}
            self.assertTrue(val_texts and train_texts, "the fixture should exercise both splits")
            self.assertFalse(set(lines) & val_texts,
                             "val text must not shape the vocabulary it is scored against")
            self.assertTrue(set(lines) <= train_texts)

    def test_prepare_data_still_fails_loudly_on_a_directory_with_only_a_dump(self):
        """The behaviour the seam used to produce, kept as a regression guard:
        the error must still name the fix rather than complaining about .txt."""
        from training.scripts.prepare_data import prepare

        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "hindi_wikipedia"
            source_dir.mkdir(parents=True)
            write_dump(source_dir, [page("दिल्ली", "0", HINDI * 8)])
            with self.assertRaises(SystemExit) as ctx:
                prepare(source_dir, Path(tmp) / "processed")
            message = str(ctx.exception)
            self.assertIn("no .txt files", message)
            self.assertIn("ai.data.extract", message,
                          "the error must name the step that fixes it")


if __name__ == "__main__":
    unittest.main()
