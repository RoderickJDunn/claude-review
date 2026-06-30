package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// runScratch implements `claude-review scratch [flags]`. It posts the supplied
// content to the daemon, opens the resulting URL in a browser, then blocks on
// the await endpoint until the user commits annotations in the UI. The
// rendered output is written to the configured sink and the session is
// deleted from the daemon.
func runScratch() {
	cmd := flag.NewFlagSet("scratch", flag.ExitOnError)
	fromClipboard := cmd.Bool("from-clipboard", false, "Read scratch content from the system clipboard")
	fromStdin := cmd.Bool("from-stdin", false, "Read scratch content from stdin")
	fromFile := cmd.String("from-file", "", "Read scratch content from the given file path")
	label := cmd.String("label", "", "Optional label shown in the browser breadcrumb")
	toStdout := cmd.Bool("stdout", false, "Write rendered annotation to stdout")
	toClipboard := cmd.Bool("to-clipboard", false, "Write rendered annotation to the system clipboard")
	outPath := cmd.String("out", "", "Write rendered annotation to the given file path")
	noOpen := cmd.Bool("no-open", false, "Don't auto-open the browser (the URL is still printed to stderr)")
	timeoutSecs := cmd.Int("timeout", 0, "Give up waiting for commit after N seconds (0 = wait forever)")

	if err := cmd.Parse(os.Args[2:]); err != nil {
		log.Fatalf("Failed to parse flags: %v", err)
	}

	if err := runScratchFlow(*fromClipboard, *fromStdin, *fromFile, *label,
		*toStdout, *toClipboard, *outPath, *noOpen, *timeoutSecs); err != nil {
		log.Fatalf("%v", err)
	}
}

// runAnnotateClipboard is a thin convenience wrapper around scratch:
// read clipboard, render, write back to clipboard.
func runAnnotateClipboard() {
	cmd := flag.NewFlagSet("annotate-clipboard", flag.ExitOnError)
	label := cmd.String("label", "Clipboard", "Optional label shown in the browser breadcrumb")
	noOpen := cmd.Bool("no-open", false, "Don't auto-open the browser")
	timeoutSecs := cmd.Int("timeout", 0, "Give up waiting for commit after N seconds (0 = wait forever)")

	if err := cmd.Parse(os.Args[2:]); err != nil {
		log.Fatalf("Failed to parse flags: %v", err)
	}

	if err := runScratchFlow(true, false, "", *label,
		false, true, "", *noOpen, *timeoutSecs); err != nil {
		log.Fatalf("%v", err)
	}
}

// runAnnotateSession resolves the most recent assistant message from the
// current Claude Code session's JSONL transcript and pipes it through the
// scratch flow, writing the rendered annotation to stdout (so the /annotate
// slash command can capture it).
func runAnnotateSession() {
	cmd := flag.NewFlagSet("annotate-session", flag.ExitOnError)
	sessionID := cmd.String("session-id", "", "Claude Code session UUID (auto-detected from newest JSONL if omitted)")
	projectDir := cmd.String("project-dir", "", "Claude Code project directory (defaults to current working directory)")
	label := cmd.String("label", "Response from Claude Code", "Optional label shown in the browser breadcrumb")
	noOpen := cmd.Bool("no-open", false, "Don't auto-open the browser")
	timeoutSecs := cmd.Int("timeout", 0, "Give up waiting for commit after N seconds (0 = wait forever)")

	if err := cmd.Parse(os.Args[2:]); err != nil {
		log.Fatalf("Failed to parse flags: %v", err)
	}

	if *projectDir == "" {
		cwd, err := os.Getwd()
		if err != nil {
			log.Fatalf("Failed to get current directory: %v", err)
		}
		*projectDir = cwd
	}

	transcript, err := resolveTranscriptPath(*projectDir, *sessionID)
	if err != nil {
		log.Fatalf("%v", err)
	}

	content, err := extractLastAssistantMessage(transcript)
	if err != nil {
		log.Fatalf("Failed to extract last assistant message: %v", err)
	}
	if strings.TrimSpace(content) == "" {
		log.Fatalf("No assistant text found in transcript %s", transcript)
	}

	// Pipe content directly through scratch flow → stdout.
	if err := runScratchFlowWithContent(content, *label,
		true, false, "", *noOpen, *timeoutSecs); err != nil {
		log.Fatalf("%v", err)
	}
}

func runScratchFlow(fromClipboard, fromStdin bool, fromFile, label string,
	toStdout, toClipboard bool, outPath string, noOpen bool, timeoutSecs int) error {

	sources := 0
	if fromClipboard {
		sources++
	}
	if fromStdin {
		sources++
	}
	if fromFile != "" {
		sources++
	}
	if sources == 0 {
		return fmt.Errorf("one of --from-clipboard, --from-stdin, --from-file is required")
	}
	if sources > 1 {
		return fmt.Errorf("only one input source may be specified")
	}

	var content string
	switch {
	case fromClipboard:
		c, err := readClipboard()
		if err != nil {
			return fmt.Errorf("read clipboard: %w", err)
		}
		content = c
	case fromStdin:
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return fmt.Errorf("read stdin: %w", err)
		}
		content = string(b)
	case fromFile != "":
		b, err := os.ReadFile(fromFile)
		if err != nil {
			return fmt.Errorf("read file: %w", err)
		}
		content = string(b)
	}

	if strings.TrimSpace(content) == "" {
		return fmt.Errorf("scratch content is empty")
	}

	return runScratchFlowWithContent(content, label, toStdout, toClipboard, outPath, noOpen, timeoutSecs)
}

func runScratchFlowWithContent(content, label string,
	toStdout, toClipboard bool, outPath string, noOpen bool, timeoutSecs int) error {

	sinks := 0
	if toStdout {
		sinks++
	}
	if toClipboard {
		sinks++
	}
	if outPath != "" {
		sinks++
	}
	if sinks == 0 {
		return fmt.Errorf("one of --stdout, --to-clipboard, --out is required")
	}
	if sinks > 1 {
		return fmt.Errorf("only one output sink may be specified")
	}

	// Make sure the daemon is up before we try to POST.
	if !isServerRunning() {
		if err := daemonize(); err != nil {
			return fmt.Errorf("failed to start daemon: %w", err)
		}
		// Give the daemon a brief moment to bind its port.
		if err := waitForDaemonReady(5 * time.Second); err != nil {
			return err
		}
	}

	base := daemonBaseURL()

	createBody, _ := json.Marshal(map[string]string{
		"content": content,
		"label":   label,
	})
	resp, err := http.Post(base+"/api/scratch", "application/json", bytes.NewReader(createBody))
	if err != nil {
		return fmt.Errorf("create scratch session: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return fmt.Errorf("create scratch session: %s: %s", resp.Status, string(body))
	}
	var created struct {
		ID  string `json:"id"`
		URL string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		_ = resp.Body.Close()
		return fmt.Errorf("decode scratch response: %w", err)
	}
	_ = resp.Body.Close()

	// URL goes to stderr so it never contaminates stdout-mode output.
	fmt.Fprintf(os.Stderr, "Annotate at: %s\n", created.URL)

	if !noOpen {
		_ = openBrowser(created.URL)
	}

	rendered, err := awaitCommit(base, created.ID, timeoutSecs)
	if err != nil {
		return err
	}

	// Best-effort cleanup; failure here is non-fatal.
	if req, err := http.NewRequest(http.MethodDelete, base+"/api/scratch/"+created.ID, nil); err == nil {
		if dresp, derr := http.DefaultClient.Do(req); derr == nil {
			_ = dresp.Body.Close()
		}
	}

	switch {
	case toStdout:
		_, err = os.Stdout.WriteString(rendered)
		if err != nil {
			return err
		}
		if !strings.HasSuffix(rendered, "\n") {
			_, _ = os.Stdout.WriteString("\n")
		}
	case toClipboard:
		if err := writeClipboard(rendered); err != nil {
			return fmt.Errorf("write clipboard: %w", err)
		}
		fmt.Fprintln(os.Stderr, "Rendered annotation copied to clipboard.")
	case outPath != "":
		if err := os.WriteFile(outPath, []byte(rendered), 0644); err != nil {
			return fmt.Errorf("write file: %w", err)
		}
		fmt.Fprintf(os.Stderr, "Rendered annotation written to %s.\n", outPath)
	}

	return nil
}

func awaitCommit(base, id string, timeoutSecs int) (string, error) {
	deadline := time.Time{}
	if timeoutSecs > 0 {
		deadline = time.Now().Add(time.Duration(timeoutSecs) * time.Second)
	}

	// Long-poll the daemon in 60s chunks so we don't tie up a TCP connection
	// forever and so a hung daemon eventually surfaces.
	for {
		chunk := 60
		if timeoutSecs > 0 {
			remaining := int(time.Until(deadline).Seconds())
			if remaining <= 0 {
				return "", fmt.Errorf("scratch session %s: timed out waiting for commit", id)
			}
			if remaining < chunk {
				chunk = remaining
			}
		}

		url := fmt.Sprintf("%s/api/scratch/%s/await?timeout=%d", base, id, chunk)
		client := &http.Client{Timeout: time.Duration(chunk+5) * time.Second}
		resp, err := client.Get(url)
		if err != nil {
			return "", fmt.Errorf("await scratch commit: %w", err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()

		switch resp.StatusCode {
		case http.StatusOK:
			var data struct {
				Rendered string `json:"rendered"`
			}
			if err := json.Unmarshal(body, &data); err != nil {
				return "", fmt.Errorf("decode commit response: %w", err)
			}
			return data.Rendered, nil
		case http.StatusRequestTimeout:
			// daemon returned without commit — loop again (or exit if deadline hit)
			continue
		case http.StatusNotFound:
			return "", fmt.Errorf("scratch session %s vanished from daemon", id)
		default:
			return "", fmt.Errorf("await scratch commit: %s: %s", resp.Status, string(body))
		}
	}
}

func daemonBaseURL() string {
	port := os.Getenv("CR_LISTEN_PORT")
	if port == "" {
		port = "4779"
	}
	return "http://localhost:" + port
}

func waitForDaemonReady(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := http.Get(daemonBaseURL() + "/")
		if err == nil {
			_ = resp.Body.Close()
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("daemon did not become ready within %v", timeout)
}

func readClipboard() (string, error) {
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command("pbpaste").Output()
		return string(out), err
	case "linux":
		// Try wl-paste then xclip then xsel.
		for _, candidate := range [][]string{
			{"wl-paste"},
			{"xclip", "-selection", "clipboard", "-o"},
			{"xsel", "--clipboard", "--output"},
		} {
			if _, err := exec.LookPath(candidate[0]); err == nil {
				out, err := exec.Command(candidate[0], candidate[1:]...).Output()
				return string(out), err
			}
		}
		return "", fmt.Errorf("no clipboard reader found (install wl-clipboard, xclip, or xsel)")
	default:
		return "", fmt.Errorf("clipboard not supported on %s", runtime.GOOS)
	}
}

func writeClipboard(s string) error {
	switch runtime.GOOS {
	case "darwin":
		cmd := exec.Command("pbcopy")
		cmd.Stdin = strings.NewReader(s)
		return cmd.Run()
	case "linux":
		for _, candidate := range [][]string{
			{"wl-copy"},
			{"xclip", "-selection", "clipboard"},
			{"xsel", "--clipboard", "--input"},
		} {
			if _, err := exec.LookPath(candidate[0]); err == nil {
				cmd := exec.Command(candidate[0], candidate[1:]...)
				cmd.Stdin = strings.NewReader(s)
				return cmd.Run()
			}
		}
		return fmt.Errorf("no clipboard writer found (install wl-clipboard, xclip, or xsel)")
	default:
		return fmt.Errorf("clipboard not supported on %s", runtime.GOOS)
	}
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "linux":
		return exec.Command("xdg-open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return fmt.Errorf("don't know how to open a browser on %s", runtime.GOOS)
	}
}

// resolveTranscriptPath finds the JSONL transcript for a Claude Code session.
// Project directories are stored under ~/.claude/projects/<sanitized> where
// "/" in the cwd is replaced with "-". If sessionID is empty, the most
// recently modified *.jsonl in that directory is used.
func resolveTranscriptPath(projectDir, sessionID string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	// Claude Code's project hash collapses path separators to "-". An absolute
	// path "/Users/x/Work/y" becomes "-Users-x-Work-y" (note the leading "-").
	sanitized := strings.ReplaceAll(projectDir, "/", "-")
	if !strings.HasPrefix(sanitized, "-") {
		sanitized = "-" + sanitized
	}
	projectsDir := filepath.Join(home, ".claude", "projects", sanitized)

	if sessionID != "" {
		path := filepath.Join(projectsDir, sessionID+".jsonl")
		if _, err := os.Stat(path); err != nil {
			return "", fmt.Errorf("session transcript not found: %s", path)
		}
		return path, nil
	}

	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return "", fmt.Errorf("read projects dir %s: %w", projectsDir, err)
	}

	type entryInfo struct {
		path    string
		modTime time.Time
	}
	var jsonls []entryInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		jsonls = append(jsonls, entryInfo{
			path:    filepath.Join(projectsDir, e.Name()),
			modTime: info.ModTime(),
		})
	}
	if len(jsonls) == 0 {
		return "", fmt.Errorf("no .jsonl transcripts under %s", projectsDir)
	}
	sort.Slice(jsonls, func(i, j int) bool { return jsonls[i].modTime.After(jsonls[j].modTime) })
	return jsonls[0].path, nil
}

// extractLastAssistantMessage reads a Claude Code JSONL transcript and returns
// the concatenated text of the most recent assistant message. Each line is a
// JSON object whose `type` is either "user" or "assistant"; assistant entries
// carry a `message` with a `content` array of {type:"text",text:"..."} parts.
func extractLastAssistantMessage(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	lines := strings.Split(string(data), "\n")

	type contentPart struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	type messagePayload struct {
		Role    string        `json:"role"`
		Content []contentPart `json:"content"`
	}
	type transcriptEntry struct {
		Type    string         `json:"type"`
		Message messagePayload `json:"message"`
	}

	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		var entry transcriptEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.Type != "assistant" {
			continue
		}
		var parts []string
		for _, c := range entry.Message.Content {
			if c.Type == "text" && c.Text != "" {
				parts = append(parts, c.Text)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n\n"), nil
		}
	}
	return "", nil
}
