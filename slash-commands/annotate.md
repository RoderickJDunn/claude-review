---
description: Annotate my previous response in the claude-review browser, then treat your annotations as my next message
argument-hint: []
allowed-tools: Bash(claude-review annotate-session:*), Read
---

Below is shell output from `claude-review annotate-session`. Interpret it as follows.

**If the output starts with `Command running in background with ID:`** — the command
exceeded Claude Code's inline-execution threshold. Do not respond yet. Wait silently for
the task-completion notification (do not output anything in the meantime). When notified,
Read the output file path provided in the notification, then apply the rules below to
that file's contents.

**Rules for interpreting the output (whether inline or from the file):**

1. Ignore the daemon banner lines (`Server started as daemon`, `Port: ...`, `PID file: ...`,
   `Log file: ...`, `Annotate at: ...`) — they are setup noise, not the user's response.

2. Look for lines starting with `> ` (quoted selections) and verb responses (`Agreed.`,
   `Skip.`, `Q: ...`, or free-form text after a quote). If any are present, treat THE
   USER'S MESSAGE as just those quoted-block sections — read them as if I typed them
   directly and act on what I'm asking for.

3. If the output contains ONLY the daemon banner (no quoted blocks, no verb responses),
   I closed the annotation browser without committing. Say nothing about it — do not
   apologize, do not explain the tool, do not summarize what happened. Just wait for my
   next real message.

4. Never quote the backgrounding notice or the daemon banner back to me.

--- OUTPUT START ---

!`claude-review annotate-session`

--- OUTPUT END ---
