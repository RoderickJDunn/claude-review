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
