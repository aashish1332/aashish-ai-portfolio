"""tests/py/test_voice_eval.py — §11.2, the voice decision kit.

`evaluation/voice/` exists to replace an opinion with a number, so the two
things worth testing are (a) that the number is computed the way it is
described and (b) that the file which *records* and the file which *judges*
cannot drift apart.

The subtle assertions are the ones that keep the result honest in the
pessimistic direction as well as the optimistic one:

  · an unrecorded clip is MISSING DATA, never a 100 % word error — scoring it
    as a failure would let a half-finished recording session manufacture a bad
    result for a stack that was never tested;
  · the language figure is the corpus WER, not the mean of per-clip
    percentages, so one catastrophic clip cannot hide behind nine clean ones;
  · the band cut-points are read from `phrases.json`, so the thresholds the
    owner reads while recording are the thresholds that judge the result.
"""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VOICE = ROOT / "evaluation" / "voice"

_spec = importlib.util.spec_from_file_location("voice_score", VOICE / "score.py")
voice = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(voice)

PHRASES = json.loads((VOICE / "phrases.json").read_text(encoding="utf-8"))
PHRASE_LIST = PHRASES["phrases"]


class Normalisation(unittest.TestCase):
    def test_devanagari_is_kept_whole(self):
        """Matras are combining marks, not punctuation (this was R7 once)."""
        out = voice.normalize_text("पढ़ाई कहाँ से हुई है?")
        self.assertIn("पढ़ाई", [t for t in out.split()])
        self.assertIn("कहाँ", out.split())

    def test_latin_is_lowercased_and_punctuation_removed(self):
        self.assertEqual(voice.normalize_text("What is your CGPA?"),
                         "what is your cgpa")

    def test_punctuation_does_not_glue_words_together(self):
        self.assertEqual(voice.normalize_text("a,b"), "a b")

    def test_apostrophes_inside_words_do_not_merge_tokens(self):
        """`who's` must not become `whos` — a recognizer dropping the apostrophe
        is the common case, and it must COUNT as an error, not be normalised
        away into a pass."""
        self.assertNotEqual(voice.tokenize("who's this"), voice.tokenize("whos this"))


class Tokenizing(unittest.TestCase):
    def test_devanagari_digits_fold_to_ascii(self):
        self.assertEqual(voice.tokenize("सीजीपीए ९.१४"), ["सीजीपीए", "9.14"])

    def test_a_decimal_number_stays_one_token(self):
        """\u201c9.14\u201d is one spoken word. Splitting it into 9 and 14 would also
        make it indistinguishable from \u201c9 14\u201d, so the point is inside digits."""
        self.assertIn("9.14", voice.tokenize("CGPA 9.14."))
        self.assertNotEqual(voice.tokenize("9.14"), voice.tokenize("9 14"))

    def test_empty_text_yields_no_tokens(self):
        self.assertEqual(voice.tokenize("  ...  "), [])


class EditOperations(unittest.TestCase):
    def test_substitution(self):
        self.assertEqual(voice.edit_ops(["a", "b", "c"], ["a", "x", "c"]), (1, 0, 0))

    def test_deletion(self):
        self.assertEqual(voice.edit_ops(["a", "b", "c"], ["a", "c"]), (0, 1, 0))

    def test_insertion_the_recognizer_invented_words(self):
        """§11.2's phantom transcripts are insertions, and they must be visible."""
        self.assertEqual(voice.edit_ops(["hello"], ["hello", "thank", "you"]), (0, 0, 2))

    def test_identical_is_free(self):
        self.assertEqual(voice.edit_ops(["a", "b"], ["a", "b"]), (0, 0, 0))


class WordErrorRate(unittest.TestCase):
    def test_perfect_transcript_is_zero(self):
        self.assertEqual(voice.wer("What is your CGPA?", "what is your cgpa")["wer"], 0.0)

    def test_one_wrong_word_of_four(self):
        self.assertAlmostEqual(voice.wer("what is your cgpa", "what is your name")["wer"], 0.25)

    def test_empty_reference_has_no_rate(self):
        """A reference with no tokens cannot have a rate — None, never 0 or 1."""
        self.assertIsNone(voice.wer("   ", "anything")["wer"])

    def test_empty_hypothesis_is_a_total_error(self):
        r = voice.wer("what is your cgpa", "")
        self.assertEqual(r["wer"], 1.0)
        self.assertEqual(r["deletions"], 4)

    def test_rate_reported_as_ops_over_reference_tokens(self):
        r = voice.wer("a b c d", "a b c d e")
        self.assertEqual(r["insertions"], 1)
        self.assertAlmostEqual(r["wer"], 0.25)


class Bands(unittest.TestCase):
    def test_thresholds_come_from_the_phrases_file(self):
        bands = voice.bands_from(PHRASES)
        self.assertAlmostEqual(bands["ship"], 0.20)
        self.assertAlmostEqual(bands["disclose"], 0.35)

    def test_a_missing_band_block_falls_back_instead_of_passing_everything(self):
        bands = voice.bands_from({})
        self.assertEqual(bands, voice.DEFAULT_BANDS)

    def test_a_broken_band_block_cannot_invert_into_a_free_pass(self):
        bands = voice.bands_from({"what_the_numbers_decide": {
            "under_80_percent_wer": "x", "20_to_35_percent_wer": "y"}})
        self.assertGreaterEqual(bands["disclose"], bands["ship"])

    def test_verdict_boundaries(self):
        bands = {"ship": 0.20, "disclose": 0.35}
        self.assertEqual(voice.verdict(0.199, bands), "ship")
        self.assertEqual(voice.verdict(0.20, bands), "ship-with-disclosure")
        self.assertEqual(voice.verdict(0.35, bands), "ship-with-disclosure")
        self.assertEqual(voice.verdict(0.351, bands), "english-only-honesty-rule")
        self.assertEqual(voice.verdict(None, bands), "no-reference")


class Scoring(unittest.TestCase):
    def bands(self):
        return voice.bands_from(PHRASES)

    def test_corpus_wer_is_token_weighted_not_a_mean_of_percentages(self):
        """One long bad clip must dominate a short good one, or a weak language
        looks healthy. Mean-of-percentages would give 50 %; corpus gives ~11 %."""
        phrases = [
            {"id": "a", "lang": "hi", "text": "one two three four five six seven eight nine"},
            {"id": "b", "lang": "hi", "text": "ten"},
        ]
        transcripts = {"a": "wrong", "b": "ten"}
        res = voice.score(phrases, transcripts, self.bands())
        self.assertAlmostEqual(res["languages"]["hi"]["wer"], 9 / 10)

    def test_unrecorded_clips_are_missing_not_failed(self):
        phrases = [{"id": "a", "lang": "en", "text": "hello world"},
                   {"id": "b", "lang": "en", "text": "hello world"}]
        res = voice.score(phrases, {"a": "hello world"}, self.bands())
        self.assertEqual(res["counts"], {"phrases": 2, "recorded": 1, "missing": 1})
        b = [c for c in res["clips"] if c["id"] == "b"][0]
        self.assertIsNone(b["wer"])
        self.assertEqual(b["verdict"], "not-recorded")
        self.assertEqual(res["languages"]["en"]["wer"], 0.0)

    def test_language_bands_are_reported_per_language(self):
        phrases = [{"id": "hi-1", "lang": "hi", "text": "एक दो"},
                   {"id": "en-1", "lang": "en", "text": "one two"}]
        res = voice.score(phrases, {"hi-1": "अलग", "en-1": "one two"}, self.bands())
        self.assertEqual(res["languages"]["en"]["verdict"], "ship")
        self.assertEqual(res["languages"]["hi"]["verdict"], "english-only-honesty-rule")

    def test_a_band_change_changes_the_verdict(self):
        phrases = [{"id": "a", "lang": "hi", "text": "एक दो तीन चार"}]
        transcripts = {"a": "एक दो"}
        strict = voice.score(phrases, transcripts, {"ship": 0.2, "disclose": 0.35})
        lenient = voice.score(phrases, transcripts, {"ship": 0.6, "disclose": 0.9})
        self.assertEqual(strict["languages"]["hi"]["verdict"], "english-only-honesty-rule")
        self.assertEqual(lenient["languages"]["hi"]["verdict"], "ship")


class Transcripts(unittest.TestCase):
    def write(self, data):
        fh = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(data, fh, ensure_ascii=False)
        fh.close()
        return Path(fh.name)

    def test_record_html_export_shape(self):
        path = self.write({"clips": [
            {"id": "en-01", "hypothesis": "what is your cgpa"},
            {"id": "en-02", "hypothesis": "   "},
        ]})
        self.assertEqual(voice.read_transcripts(path), {"en-01": "what is your cgpa"})

    def test_hand_written_map_shape(self):
        path = self.write({"en-01": "what is your cgpa", "hi-01": "आपका सीजीपीए"})
        self.assertEqual(set(voice.read_transcripts(path)), {"en-01", "hi-01"})

    def test_blank_hypotheses_are_dropped(self):
        path = self.write({"en-01": "", "en-02": "  "})
        self.assertEqual(voice.read_transcripts(path), {})

    def test_a_non_object_transcripts_file_is_an_error(self):
        path = self.write(["not", "an", "object"])
        with self.assertRaises(ValueError):
            voice.read_transcripts(path)

    def test_missing_file_raises(self):
        with self.assertRaises(FileNotFoundError):
            voice.read_transcripts(VOICE / "does-not-exist.json")


class Cli(unittest.TestCase):
    def test_no_transcripts_prints_instructions_and_exits_2(self):
        code = voice.main(["--transcripts", str(VOICE / "nope.json")])
        self.assertEqual(code, 2)

    def test_json_output_is_written_and_re_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = Path(tmp)
            (paths / "phrases.json").write_text(json.dumps(
                {"phrases": [{"id": "en-1", "lang": "en", "text": "hello world"}]}),
                encoding="utf-8")
            (paths / "tr.json").write_text(
                json.dumps({"clips": [{"id": "en-1", "hypothesis": "hello world"}]}),
                encoding="utf-8")
            out = paths / "wer.json"
            code = voice.main(["--phrases", str(paths / "phrases.json"),
                               "--transcripts", str(paths / "tr.json"),
                               "--json", str(out)])
            self.assertEqual(code, 0)
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["languages"]["en"]["verdict"], "ship")
            self.assertEqual(data["bands"], {"ship": 0.2, "disclose": 0.35})


class ThePhraseSet(unittest.TestCase):
    """The recording plan itself: §11.2 asks for ~30 EN/HI/Hinglish clips."""

    def test_every_phrase_is_complete_and_unique(self):
        ids = [p["id"] for p in PHRASE_LIST]
        self.assertEqual(len(ids), len(set(ids)), "duplicate phrase id")
        for p in PHRASE_LIST:
            for key in ("id", "lang", "text", "probes"):
                self.assertIn(key, p, p.get("id"))
            self.assertTrue(p["text"].strip())
            self.assertIn(p["lang"], {"en", "hi", "hinglish"})

    def test_three_languages_and_at_least_thirty_clips(self):
        self.assertGreaterEqual(len(PHRASE_LIST), 30)
        langs = {p["lang"] for p in PHRASE_LIST}
        self.assertEqual(langs, {"en", "hi", "hinglish"})
        for lang in langs:
            self.assertGreaterEqual(
                len([p for p in PHRASE_LIST if p["lang"] == lang]), 8,
                f"{lang} is under-sampled — one clip cannot decide a language")

    def test_the_bands_are_named_not_only_described(self):
        """score.py parses these keys, so their shape is a contract."""
        keys = PHRASES["what_the_numbers_decide"]
        self.assertTrue(any(k.startswith("under_") and k.endswith("_wer") for k in keys))
        self.assertTrue(any("_to_" in k and k.endswith("_wer") for k in keys))

    def test_devanagari_phrases_carry_a_real_reference_not_transliteration(self):
        for p in PHRASE_LIST:
            if p["lang"] != "hi":
                continue
            deva = sum(1 for ch in p["text"] if "\u0900" <= ch <= "\u097f")
            self.assertGreater(deva, len(p["text"]) * 0.5,
                               f"{p['id']}: declared hi but is mostly not Devanagari")


class TheRecorderAndTheScorerAgree(unittest.TestCase):
    """record.html and score.py are two halves of one format. If either moves,
    this fails instead of the owner discovering it after recording 30 clips."""

    def setUp(self):
        self.html = (VOICE / "record.html").read_text(encoding="utf-8")

    def test_the_recorder_reads_the_phrase_file_the_scorer_reads(self):
        self.assertIn("phrases.json", self.html)

    def test_the_export_shape_is_the_one_score_py_parses(self):
        for token in ("clips,", "id:", "hypothesis:", "reference:"):
            self.assertIn(token, self.html, token)

    def test_the_recorder_asks_for_a_microphone(self):
        self.assertIn("getUserMedia", self.html)

    def test_the_recorder_is_honest_about_where_the_audio_goes(self):
        """§2/N3: the page must say the audio stays in the tab."""
        low = self.html.lower()
        self.assertIn("nothing is uploaded", low)

    def test_the_recorder_names_the_dev_server_and_its_path(self):
        self.assertIn("/evaluation/voice/record.html", self.html)
        self.assertIn("npm run dev", self.html)

    def test_the_scorer_tells_you_how_to_produce_transcripts(self):
        src = (VOICE / "score.py").read_text(encoding="utf-8")
        self.assertIn("record.html", src)
        self.assertIn("transcripts.json", src)

    def test_the_instructions_point_at_both_files(self):
        text = " ".join(PHRASES["instructions"])
        self.assertIn("record.html", text)
        self.assertIn("score.py", text)

    def test_the_recorder_can_never_be_sold_as_shipped(self):
        """A page that asks for a microphone must not be in the build allow-list."""
        build = (ROOT / "tools" / "build.mjs").read_text(encoding="utf-8")
        self.assertNotIn("evaluation/voice", build)
        self.assertNotIn("record.html", build)


if __name__ == "__main__":
    unittest.main()
