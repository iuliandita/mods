# Stack conventions checker

This directory holds a vendored copy of the shared stack checker from [iuliandita/agents](https://github.com/iuliandita/agents/tree/develop/.github/stack). See its README for the format and the list of checks.

Do not edit `canon.json` or `stack-check.py` here; re-vendor them from agents. `SOURCE` records the source commit and the sha256 of both files, and the checker fails when they differ. `repo.json` holds the settings for this repository.

Run it from the repository root:

```sh
python3 .github/stack/stack-check.py
```

The `stack-sync` workflow opens one issue when the files on agents `develop` differ from `SOURCE`.
