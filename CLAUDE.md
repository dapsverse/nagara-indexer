# CLAUDE.md — nagara-indexer

Guidance for Claude Code (and any subagent it dispatches) working in this repository.

## Git — non-negotiable

**Never commit directly to `main`.** Every change, no matter how small or
well-tested, goes through a branch + pull request. If you notice you are
checked out on `main` with pending changes, stop, create a branch first,
then commit.

This applies to every agent touching this repo, not just the one that reads
this file first — if you dispatch a subagent to do git work here, carry this
rule into its instructions explicitly.
