# pi-brief

Session at a glance for the [Pi coding agent](https://pi.dev): persistent timestamps in the
footer plus a `/brief` overlay that answers "what happened in this session and when".

Built for the workflow of keeping many long-lived Pi sessions open in
[herdr](https://github.com/badlogic/pi-mono) (or any terminal multiplexer) and switching back
to a tab days later.

## What you get

**Footer status segment** (always visible, zero cost):

```
创建 10-23 09:12 · 回复 10-25 19:20
```

- Session creation time and the time of the last assistant reply.
- Switches to `回复中…` while the agent is working.
- Purely local: no model calls, no polling. Purely cosmetic: it uses `ctx.ui.setStatus()`, so
  it coexists with the default footer and other extensions.

**`/brief` overlay** (on demand):

- Timeline: creation time, last reply, prompt/reply counts, and a per-day activity bar chart.
- Every user prompt you sent, oldest to newest, each with its timestamp.
- Local data only (session entries carry ISO timestamps). Scroll with `↑`/`↓`/`j`/`k`,
  `PgUp`/`PgDn`, `g`/`G`; close with `q` or `Esc`.

## Install

```bash
pi install npm:pi-brief
```

Or from a local checkout:

```bash
pi install /path/to/pi-brief
```

Already-running sessions need a one-shot `/reload` to pick it up; new sessions load it
automatically.

## Requirements

Works in interactive (TUI) mode; silently does nothing in RPC/JSON/print modes. Timestamps
are shown in the local timezone.

## License

MIT
