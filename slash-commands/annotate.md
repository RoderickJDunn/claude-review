---
description: Annotate my previous response in the claude-review browser, then treat your annotations as my next message
argument-hint: [resume=<session-id>]
allowed-tools: Bash(claude-review annotate-session:*), Bash(claude-review reply:*), Bash(mktemp:*), Bash(rm:*), Bash(cat:*), Write, Read, SlashCommand(annotate)
---

`$ARGUMENTS` may be empty (normal case) or `resume=<session-id>` (agent
resumes a live scratch session after posting per-thread replies). Follow
the branch that matches, then interpret stdout per the rules at the
bottom.

## Branch A — Resume (arguments start with `resume=`)

Run this single Bash command and interpret the output:

    claude-review annotate-session $ARGUMENTS

No content is needed — the session is already live on the daemon; you're
just attaching to it.

## Branch B — Normal `/annotate` (no arguments)

The user is annotating your *immediately previous* assistant message —
the one that appears directly above this `/annotate` turn in your own
context. Do NOT read the transcript file; after `/rewind` the JSONL still
contains rewound-away branches, but your context is trustworthy.

1. Get a temp path:

       mktemp -t cr-annotate.XXXXXX

   Capture that path — call it `TMPFILE`.

2. Use the **Write** tool to write your previous assistant message text
   to `TMPFILE`. Include markdown formatting verbatim. Exclude thinking
   blocks and tool-use JSON — only the visible assistant text the user
   would see in Claude Code's output. If your previous message was
   split across multiple `text` parts, concatenate them separated by
   blank lines.

3. Run:

       claude-review annotate-session --from-file "$TMPFILE"

   Interpret its stdout per the rules below.

4. Clean up after interpretation:

       rm -f "$TMPFILE"

## Rules for interpreting `claude-review annotate-session` stdout

1. Ignore the daemon banner lines (`Server started as daemon`,
   `Port: ...`, `PID file: ...`, `Log file: ...`, `Annotate at: ...`) —
   they are setup noise, not the user's response.

2. Look for lines starting with `> ` (quoted selections) and verb
   responses (`Agreed.`, `Skip.`, `Q: ...`, or free-form text after a
   quote). If any are present, treat THE USER'S MESSAGE as just those
   quoted-block sections — read them as if I typed them directly and
   act on what I'm asking for.

3. If the output contains ONLY the daemon banner (no quoted blocks, no
   verb responses), I closed the annotation browser without committing.
   Say nothing about it — do not apologize, do not explain the tool, do
   not summarize what happened. Just wait for my next real message.

4. Never quote the backgrounding notice or the daemon banner back to me.

5. **Thread-reply directive.** If the output contains a block beginning
   with `You have unread annotations from the user in claude-review
   scratch session ` and a list of numbered threads, do NOT treat it as
   the user's chat message. Instead:

   a. For each `─── thread <N> ───` block, extract the thread ID
      (`<N>`) and the user's message (the `User said:` / `User asked:`
      / `User rejected:` / `User agreed:` line following the quoted
      selection). Call `claude-review reply --comment-id <N> --message
      "<your reply to that thread>"` — one shell call per thread. Reply
      to each thread on its own merits; do not conflate threads.

   b. Do NOT print any of the agent-facing reply text to the terminal —
      the browser is the source of truth, and my next round of
      annotations depends on seeing your replies land in the threads.

   c. After all thread replies are posted, immediately invoke
      `/annotate resume=<sessionID>` (the session ID is on the first
      line of the directive, inside backticks) so the review loop
      stays open.

6. **Empty-delta continuation.** If the directive says `Nothing new
   since last sync; no per-thread replies needed.`, skip step 5a
   entirely and go straight to `/annotate resume=<sessionID>`.
