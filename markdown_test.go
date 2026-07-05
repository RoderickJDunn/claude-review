package main

import (
	"strings"
	"testing"
)

func TestRenderThreadsToChat_SingleBlock(t *testing.T) {
	ls, le := 3, 3
	threads := [][]Comment{
		{{
			ID:           1,
			LineStart:    &ls,
			LineEnd:      &le,
			SelectedText: "the architecture is solid",
			CommentText:  "",
			Verb:         "agree",
		}},
	}
	got := RenderThreadsToChat("ignored", threads)
	want := "> the architecture is solid\n\nAgreed."
	if got != want {
		t.Fatalf("single block mismatch:\nwant:\n%q\ngot:\n%q", want, got)
	}
}

func TestRenderThreadsToChat_VerbFormats(t *testing.T) {
	ls, le := 1, 1
	cases := []struct {
		name string
		verb string
		body string
		want string
	}{
		{"agree empty", "agree", "", "Agreed."},
		{"agree with reason", "agree", "matches my model", "Agreed. matches my model"},
		{"reject empty", "reject", "", "Skip."},
		{"reject with reason", "reject", "out of scope", "Skip. out of scope"},
		{"question empty", "question", "", "Q:"},
		{"question with text", "question", "what about Pi?", "Q: what about Pi?"},
		{"free comment", "comment", "rewrite as a one-liner", "rewrite as a one-liner"},
		{"empty verb falls back to free comment", "", "do this exactly", "do this exactly"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			threads := [][]Comment{
				{{
					ID:           1,
					LineStart:    &ls,
					LineEnd:      &le,
					SelectedText: "x",
					Verb:         c.verb,
					CommentText:  c.body,
				}},
			}
			got := RenderThreadsToChat("ignored", threads)
			wantSuffix := c.want
			if !strings.HasSuffix(got, wantSuffix) {
				t.Fatalf("verb=%q body=%q: want suffix %q, got %q", c.verb, c.body, wantSuffix, got)
			}
		})
	}
}

func TestRenderThreadsToChat_MultiSelect(t *testing.T) {
	ls, le := 5, 5
	threads := [][]Comment{
		{{
			ID:           1,
			LineStart:    &ls,
			LineEnd:      &le,
			SelectedText: "first bullet",
			ExtraRanges:  `[{"line_start":7,"line_end":7,"selected_text":"second bullet"}]`,
			Verb:         "comment",
			CommentText:  "both of these need work",
		}},
	}
	got := RenderThreadsToChat("ignored", threads)
	want := "> first bullet\n\n> second bullet\n\nboth of these need work"
	if got != want {
		t.Fatalf("multi-select mismatch:\nwant:\n%q\ngot:\n%q", want, got)
	}
}

func TestRenderThreadsToChat_Truncation(t *testing.T) {
	ls, le := 1, 12
	// 10 lines triggers >6-line truncation
	long := strings.Join([]string{
		"line one",
		"line two",
		"line three",
		"line four",
		"line five",
		"line six",
		"line seven",
		"line eight",
		"line nine",
		"line ten",
	}, "\n")

	threads := [][]Comment{
		{{
			ID:           1,
			LineStart:    &ls,
			LineEnd:      &le,
			SelectedText: long,
			Verb:         "comment",
			CommentText:  "all of this",
		}},
	}
	got := RenderThreadsToChat("ignored", threads)
	wantStart := "> line one\n> line two\n> …\n> line nine\n> line ten"
	if !strings.HasPrefix(got, wantStart) {
		t.Fatalf("truncation prefix mismatch:\nwant prefix:\n%q\ngot:\n%q", wantStart, got)
	}
	if !strings.HasSuffix(got, "all of this") {
		t.Fatalf("expected trailing body, got: %q", got)
	}
}

func TestRenderThreadsToChat_TruncationByChars(t *testing.T) {
	ls, le := 1, 1
	// Six lines but well over 400 chars triggers char-based truncation.
	long := strings.Repeat("a", 200) + "\n" +
		strings.Repeat("b", 200) + "\n" +
		strings.Repeat("c", 50)
	threads := [][]Comment{
		{{
			ID:           1,
			LineStart:    &ls,
			LineEnd:      &le,
			SelectedText: long,
			Verb:         "comment",
			CommentText:  "x",
		}},
	}
	got := RenderThreadsToChat("ignored", threads)
	// Three lines < 2*head/tail (4), so truncation falls through to full quote.
	// This documents that behavior — the spec's head/tail guard prevents
	// pointless ellipses on short multi-line input.
	if strings.Contains(got, "…") {
		t.Fatalf("did not expect ellipsis for short multi-line input, got: %q", got)
	}

	// Now try a real long block: 8 long lines.
	long2 := strings.Repeat(strings.Repeat("x", 100)+"\n", 8)
	threads[0][0].SelectedText = long2
	got = RenderThreadsToChat("ignored", threads)
	if !strings.Contains(got, "> …") {
		t.Fatalf("expected ellipsis in long output, got: %q", got)
	}
}

func TestRenderThreadsToChat_DocumentOrder(t *testing.T) {
	mk := func(line int, body string) []Comment {
		l := line
		return []Comment{{
			ID:           line,
			LineStart:    &l,
			LineEnd:      &l,
			SelectedText: body,
			Verb:         "agree",
		}}
	}
	threads := [][]Comment{
		mk(15, "bottom"),
		mk(3, "top"),
		mk(8, "middle"),
	}
	got := RenderThreadsToChat("ignored", threads)
	topIdx := strings.Index(got, "top")
	midIdx := strings.Index(got, "middle")
	botIdx := strings.Index(got, "bottom")
	if !(topIdx < midIdx && midIdx < botIdx) {
		t.Fatalf("expected document order top < middle < bottom, got %q", got)
	}
}

func TestRenderThreadsToChat_Empty(t *testing.T) {
	if got := RenderThreadsToChat("ignored", nil); got != "" {
		t.Fatalf("expected empty render for no threads, got: %q", got)
	}
}

func TestRenderThreadsToDirective_SingleThread(t *testing.T) {
	ls, le := 3, 3
	threads := [][]Comment{
		{{
			ID:           42,
			LineStart:    &ls,
			LineEnd:      &le,
			SelectedText: "the architecture is solid",
			Author:       "user",
			Verb:         "agree",
			CommentText:  "",
		}},
	}
	got := RenderThreadsToDirective("sess-abc", threads)

	for _, want := range []string{
		"claude-review scratch session `sess-abc`",
		"─── thread 42 ",
		"Selection:",
		"> the architecture is solid",
		"User agreed: Agreed.",
		"claude-review reply --comment-id",
		"/annotate resume=sess-abc",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("directive missing %q:\n%s", want, got)
		}
	}
}

func TestRenderThreadsToDirective_MultiThreadTruncation(t *testing.T) {
	ls, le := 1, 20
	long := strings.Repeat("this is a long line of content\n", 10)
	l2, e2 := 30, 30
	threads := [][]Comment{
		{{
			ID:           5,
			LineStart:    &ls,
			LineEnd:      &le,
			SelectedText: long,
			Author:       "user",
			Verb:         "question",
			CommentText:  "why?",
		}},
		{{
			ID:           6,
			LineStart:    &l2,
			LineEnd:      &e2,
			SelectedText: "short",
			Author:       "user",
			Verb:         "reject",
			CommentText:  "no thanks",
		}},
	}
	got := RenderThreadsToDirective("sess-xyz", threads)

	if !strings.Contains(got, "─── thread 5 ") {
		t.Fatalf("missing thread 5 header:\n%s", got)
	}
	if !strings.Contains(got, "─── thread 6 ") {
		t.Fatalf("missing thread 6 header:\n%s", got)
	}
	if !strings.Contains(got, "> …") {
		t.Fatalf("expected ellipsis in truncated long selection:\n%s", got)
	}
	if !strings.Contains(got, "User asked: Q: why?") {
		t.Fatalf("expected question intro:\n%s", got)
	}
	if !strings.Contains(got, "User rejected: Skip. no thanks") {
		t.Fatalf("expected reject intro:\n%s", got)
	}
}

func TestRenderThreadsToDirective_EmptyDelta(t *testing.T) {
	got := RenderThreadsToDirective("sess-empty", nil)
	if !strings.Contains(got, "Nothing new since last sync") {
		t.Fatalf("expected empty-delta message:\n%s", got)
	}
	if !strings.Contains(got, "/annotate resume=sess-empty") {
		t.Fatalf("expected resume instruction:\n%s", got)
	}
	if strings.Contains(got, "─── thread") {
		t.Fatalf("did not expect any thread header for empty delta:\n%s", got)
	}
}

func TestRenderThreadsToDirective_UsesLatestUserReply(t *testing.T) {
	// A thread whose most recent user comment is a reply, not the root.
	// The directive should surface the reply text — the root text and any
	// agent replies in between are noise the agent has already seen.
	ls, le := 1, 1
	rootID := 100
	threads := [][]Comment{
		{
			{
				ID:           100,
				LineStart:    &ls,
				LineEnd:      &le,
				SelectedText: "some bullet",
				Author:       "user",
				Verb:         "question",
				CommentText:  "why?",
			},
			{
				ID:          101,
				Author:      "agent",
				CommentText: "because Y",
				RootID:      &rootID,
			},
			{
				ID:          102,
				Author:      "user",
				CommentText: "but what about Z?",
				RootID:      &rootID,
			},
		},
	}
	got := RenderThreadsToDirective("sess-thread", threads)
	if !strings.Contains(got, "User said: but what about Z?") {
		t.Fatalf("expected latest user reply text:\n%s", got)
	}
	// The root's original question text shouldn't be the intro line — the
	// agent has already replied to it.
	if strings.Contains(got, "User asked: Q: why?") {
		t.Fatalf("root question text should not reappear once replied to:\n%s", got)
	}
}

func TestComputeUserCommentDelta(t *testing.T) {
	rootID := 10
	threads := [][]Comment{
		{
			{ID: 10, Author: "user", CommentText: "one"},
			{ID: 11, Author: "agent", CommentText: "ack", RootID: &rootID},
		},
		{
			{ID: 20, Author: "user", CommentText: "two"},
		},
	}

	// Round 1: nothing sent yet → both threads in delta.
	sent := map[int64]struct{}{}
	got, newlySent := computeUserCommentDelta(threads, sent)
	if len(got) != 2 {
		t.Fatalf("round 1 expected 2 threads, got %d", len(got))
	}
	if len(newlySent) != 2 {
		t.Fatalf("round 1 expected 2 newly-sent user comments, got %d", len(newlySent))
	}

	// Mark them sent, then re-run: no new user comments → empty delta.
	for _, id := range newlySent {
		sent[id] = struct{}{}
	}
	got, newlySent = computeUserCommentDelta(threads, sent)
	if len(got) != 0 || len(newlySent) != 0 {
		t.Fatalf("round 2 expected empty delta, got %d threads / %d ids", len(got), len(newlySent))
	}

	// Add a user reply to thread 1 → only that thread appears in the delta.
	replyRoot := 10
	threads[0] = append(threads[0], Comment{ID: 12, Author: "user", CommentText: "follow up", RootID: &replyRoot})
	got, newlySent = computeUserCommentDelta(threads, sent)
	if len(got) != 1 {
		t.Fatalf("round 3 expected 1 thread, got %d", len(got))
	}
	if got[0][0].ID != 10 {
		t.Fatalf("round 3 expected thread rooted at 10, got %d", got[0][0].ID)
	}
	if len(newlySent) != 1 || newlySent[0] != 12 {
		t.Fatalf("round 3 expected id 12 in newlySent, got %v", newlySent)
	}
}

func TestHTMLEscapingInCodeBlocks(t *testing.T) {
	tests := []struct {
		name     string
		markdown string
		want     string
		notWant  string
	}{
		{
			name:     "angle brackets",
			markdown: "```\n<project-hash>\n```",
			want:     "&lt;project-hash&gt;",
			notWant:  "<code><project-hash>",
		},
		{
			name:     "ampersand",
			markdown: "```\nfoo & bar\n```",
			want:     "foo &amp; bar",
			notWant:  "<code>foo & bar</code>",
		},
		{
			name:     "quotes",
			markdown: "```\n\"quoted\"\n```",
			want:     "&quot;quoted&quot;",
			notWant:  "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			html, err := RenderMarkdownWithLineNumbers([]byte(tt.markdown))
			if err != nil {
				t.Fatalf("RenderMarkdownWithLineNumbers failed: %v", err)
			}

			htmlStr := string(html)

			if !strings.Contains(htmlStr, tt.want) {
				t.Errorf("Expected %q in HTML, got: %s", tt.want, htmlStr)
			}

			if tt.notWant != "" && strings.Contains(htmlStr, tt.notWant) {
				t.Errorf("Did not expect %q in HTML, got: %s", tt.notWant, htmlStr)
			}
		})
	}
}

func TestInlineCodeLineNumbers(t *testing.T) {
	tests := []struct {
		name     string
		markdown string
		want     string
	}{
		{
			name:     "inline code in list item",
			markdown: "1. If `--remote` provided: add git remote",
			want:     "data-line-start=\"1\"",
		},
		{
			name:     "multiple inline code blocks",
			markdown: "Use `foo` and `bar` together",
			want:     "data-line-start=\"1\"",
		},
		{
			name:     "inline code with special chars",
			markdown: "The `<code>` element is special",
			want:     "data-line-start=\"1\"",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			html, err := RenderMarkdownWithLineNumbers([]byte(tt.markdown))
			if err != nil {
				t.Fatalf("RenderMarkdownWithLineNumbers failed: %v", err)
			}

			htmlStr := string(html)

			if !strings.Contains(htmlStr, tt.want) {
				t.Errorf("Expected %q in HTML, got: %s", tt.want, htmlStr)
			}
		})
	}
}

func TestSyntaxHighlighting(t *testing.T) {
	tests := []struct {
		name     string
		markdown string
		want     string
		notWant  string
	}{
		{
			name:     "go code block",
			markdown: "```go\nfunc main() {\n    fmt.Println(\"hello\")\n}\n```",
			want:     "style=",
			notWant:  "",
		},
		{
			name:     "javascript code block",
			markdown: "```javascript\nconst foo = 'bar';\nconsole.log(foo);\n```",
			want:     "style=",
			notWant:  "",
		},
		{
			name:     "python code block",
			markdown: "```python\ndef greet():\n    print('hello')\n```",
			want:     "style=",
			notWant:  "",
		},
		{
			name:     "code block without language",
			markdown: "```\nplain text code\n```",
			want:     "<pre",
			notWant:  "",
		},
		{
			name:     "inline styles not classes",
			markdown: "```go\nfunc test() {}\n```",
			want:     "style=",
			notWant:  "class=\"chroma\"",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			html, err := RenderMarkdownWithLineNumbers([]byte(tt.markdown))
			if err != nil {
				t.Fatalf("RenderMarkdownWithLineNumbers failed: %v", err)
			}

			htmlStr := string(html)

			if !strings.Contains(htmlStr, tt.want) {
				t.Errorf("Expected %q in HTML, got: %s", tt.want, htmlStr)
			}

			if tt.notWant != "" && strings.Contains(htmlStr, tt.notWant) {
				t.Errorf("Did not expect %q in HTML, got: %s", tt.notWant, htmlStr)
			}
		})
	}
}

func TestCodeBlockLineNumbers(t *testing.T) {
	tests := []struct {
		name     string
		markdown string
		want     string
		notWant  string
	}{
		{
			name:     "code block with language has line numbers",
			markdown: "```go\nfunc main() {\n    fmt.Println(\"hello\")\n}\n```",
			want:     "data-line-start=\"1\"",
		},
		{
			name:     "code block without language has line numbers",
			markdown: "```\nplain text\ncode\n```",
			want:     "data-line-start=\"1\"",
		},
		{
			name:     "code block after other content has correct line numbers",
			markdown: "# Heading\n\nSome text.\n\n```go\nfunc test() {}\n```",
			want:     "data-line-start=\"5\"",
		},
		{
			name:     "code block has end line number",
			markdown: "```go\nfunc main() {\n    fmt.Println(\"hello\")\n}\n```",
			want:     "data-line-end=\"6\"",
		},
		{
			name:     "code block has closing pre tag",
			markdown: "```go\nfunc test() {}\n```",
			want:     "</pre>",
		},
		{
			name:     "multiline code block has correct end line",
			markdown: "```python\ndef greet():\n    print('hello')\n    print('world')\n```",
			want:     "data-line-end=\"6\"",
		},
		{
			name:     "single line code block",
			markdown: "```js\nconsole.log('test')\n```",
			want:     "data-line-start=\"1\" data-line-end=\"4\"",
		},
		{
			name:     "code block without double pre tags",
			markdown: "```go\nfunc test() {}\n```",
			notWant:  "<pre><pre",
		},
		{
			name:     "highlighted code block has chroma styles",
			markdown: "```go\nfunc test() {}\n```",
			want:     "style=",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			html, err := RenderMarkdownWithLineNumbers([]byte(tt.markdown))
			if err != nil {
				t.Fatalf("RenderMarkdownWithLineNumbers failed: %v", err)
			}

			htmlStr := string(html)

			if !strings.Contains(htmlStr, tt.want) {
				t.Errorf("Expected %q in HTML, got: %s", tt.want, htmlStr)
			}

			if tt.notWant != "" && strings.Contains(htmlStr, tt.notWant) {
				t.Errorf("Did not expect %q in HTML, got: %s", tt.notWant, htmlStr)
			}
		})
	}
}

func TestCustomWrapperRenderer(t *testing.T) {
	tests := []struct {
		name     string
		markdown string
		want     []string
	}{
		{
			name:     "wrapper includes data-line-start and data-line-end",
			markdown: "```go\nfunc test() {}\n```",
			want:     []string{"<pre", "data-line-start=", "data-line-end=", ">"},
		},
		{
			name:     "wrapper includes closing tag",
			markdown: "```go\nfunc test() {}\n```",
			want:     []string{"</pre>"},
		},
		{
			name:     "plain code block without highlighting still has attributes",
			markdown: "```\nplain\n```",
			want:     []string{"<pre", "data-line-start=", "data-line-end="},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			html, err := RenderMarkdownWithLineNumbers([]byte(tt.markdown))
			if err != nil {
				t.Fatalf("RenderMarkdownWithLineNumbers failed: %v", err)
			}

			htmlStr := string(html)

			for _, want := range tt.want {
				if !strings.Contains(htmlStr, want) {
					t.Errorf("Expected %q in HTML, got: %s", want, htmlStr)
				}
			}
		})
	}
}
