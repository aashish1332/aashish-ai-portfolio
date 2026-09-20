"""Python test suite (tokenizer, model schema, data pipeline, checkpoints).

Run everything:   python -m unittest discover -s tests/py -t .
Run one file:     python -m unittest tests.py.test_checkpoint -v

Tests that need torch (the materialised parameter comparison, the real
training loop) *skip* with a printed reason instead of passing silently —
on this development machine torch is not installed, so a green run must not
be mistaken for a verified training loop.
"""
