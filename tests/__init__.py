"""Test suites.

`*.test.mjs`  → `npm test`            (node --test, the browser/runtime code)
`py/test_*.py` → `npm run test:py`     (unittest, the tokenizer/model/training code)

Two runners because the project has two runtimes. Neither is optional: the
Python side owns the tokenizer contract, the parameter schema, the corpus
pipeline and the checkpoint/resume machinery; the JS side owns everything
that ships to a browser.
"""
