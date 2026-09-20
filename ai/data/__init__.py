"""Corpus pipeline: clean → normalize → dedupe → language-ID → filter → shard.

`langid` is a faithful port of the runtime detector (§8.3) so the corpus
is tagged the same way the browser will answer. `pipeline` holds the
transformations; `training/scripts/prepare_data.py` drives them.
"""
