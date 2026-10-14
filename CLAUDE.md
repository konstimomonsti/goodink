@AGENTS.md

## Claude-specific notes

- Working with sub-agents: the owner likes work fanned out to parallel sub-agents, each owning a
  separate set of files (see the ownership table in `docs/live-ink/SPEC.md`). The owner also likes
  harsh, independent critic agents that review screenshots and try to break things, with fixes
  looped back until the critics are genuinely impressed. Builders never grade their own work as
  final.
- Sub-agents must not commit or touch `.git`; the lead commits feature by feature after verifying
  (typecheck, unit tests, and for UI, screenshots).
- Verify agent claims yourself (re-run the tests, look at the screenshots) before reporting them as
  done.
- Long runs hit API rate limits. Agents stop mid-task with their files intact. Commit a checkpoint,
  restart the dev server if it died, and resume each agent with a message saying where it stopped.
