package main

import (
	"encoding/json"
	"fmt"
	"html/template"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

var templates *template.Template

// escapePathComponents escapes each component of a path individually,
// preserving the forward slashes between components.
func escapePathComponents(path string) string {
	parts := strings.Split(path, "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}

func initTemplates() error {
	funcMap := template.FuncMap{
		"urlquery":   url.QueryEscape,
		"pathescape": escapePathComponents,
		"base":       filepath.Base,
		"json": func(v interface{}) (template.JS, error) {
			b, err := json.Marshal(v)
			if err != nil {
				return "", err
			}
			return template.JS(b), nil
		},
	}

	// Parse templates from embedded FS
	templatesSubFS, err := fs.Sub(templatesFS, "frontend/templates")
	if err != nil {
		return err
	}

	templates, err = template.New("").Funcs(funcMap).ParseFS(templatesSubFS, "*.html")
	return err
}

// HTML Route Handlers

func handleHome(w http.ResponseWriter, r *http.Request) {
	projects, err := getAllProjects()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	data := map[string]interface{}{
		"Projects": projects,
	}

	if err := templates.ExecuteTemplate(w, "index.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func handleProjectFiles(w http.ResponseWriter, r *http.Request) {
	// Get everything after /projects/
	fullPath := strings.TrimPrefix(r.URL.Path, "/projects/")

	// Ensure leading slash for absolute paths
	if !strings.HasPrefix(fullPath, "/") {
		fullPath = "/" + fullPath
	}

	// URL decode the full path (may already be decoded by Go's http server)
	decodedPath, err := url.PathUnescape(fullPath)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	// Find the first registered project that matches the beginning of the path
	projects, err := getAllProjects()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var project string
	var childPath string

	for _, p := range projects {
		if decodedPath == p.Directory || strings.HasPrefix(decodedPath, p.Directory+"/") {
			project = p.Directory
			childPath = strings.TrimPrefix(decodedPath, p.Directory)
			childPath = strings.TrimPrefix(childPath, "/")
			break
		}
	}

	if project == "" {
		http.NotFound(w, r)
		return
	}

	// Build absolute path
	absPath := filepath.Join(project, childPath)

	// Check if path exists
	info, err := os.Stat(absPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	// If directory, show markdown file listing
	if info.IsDir() {
		// Redirect to add trailing slash if needed (for proper relative URLs)
		if !strings.HasSuffix(r.URL.Path, "/") {
			http.Redirect(w, r, r.URL.Path+"/", http.StatusMovedPermanently)
			return
		}
		renderDirectoryListing(w, r, project, childPath)
		return
	}

	// If markdown file, render viewer
	if strings.HasSuffix(strings.ToLower(info.Name()), ".md") {
		renderViewer(w, r, project, childPath)
		return
	}

	// Otherwise serve raw file
	prefix := "/projects/" + url.PathEscape(project)
	fs := http.FileServer(http.Dir(project))
	http.StripPrefix(prefix, fs).ServeHTTP(w, r)
}

func renderViewer(w http.ResponseWriter, r *http.Request, projectDir, filePath string) {
	absPath := filepath.Join(projectDir, filePath)

	// Read markdown file
	content, err := os.ReadFile(absPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Render markdown to HTML
	html, err := RenderMarkdownWithLineNumbers(content)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Get comments for this file
	comments, err := getComments(projectDir, filePath, false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Render comment markdown to HTML for web UI
	if err := renderCommentsAsHTML(comments); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	data := map[string]interface{}{
		"ProjectDir":  projectDir,
		"FilePath":    filePath,
		"HTMLContent": template.HTML(html),
		"Comments":    comments,
		"Version":     Version,
		"CommitHash":  CommitHash,
	}

	if err := templates.ExecuteTemplate(w, "viewer.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func handleScratchViewer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	sess := getScratchSession(id)
	if sess == nil {
		http.NotFound(w, r)
		return
	}

	html, err := RenderMarkdownWithLineNumbers([]byte(sess.Content))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	comments, err := getComments(scratchProjectDir, id, false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := renderCommentsAsHTML(comments); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	data := map[string]interface{}{
		"ProjectDir":   scratchProjectDir,
		"FilePath":     id,
		"HTMLContent":  template.HTML(html),
		"Comments":     comments,
		"Version":      Version,
		"CommitHash":   CommitHash,
		"ScratchMode":  true,
		"ScratchID":    id,
		"ScratchLabel": sess.Label,
	}

	if err := templates.ExecuteTemplate(w, "viewer.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleCreateScratch creates a new scratch session and returns its URL plus ID.
func handleCreateScratch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Content string `json:"content"`
		Label   string `json:"label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Content == "" {
		http.Error(w, "content is required", http.StatusBadRequest)
		return
	}

	sess, err := createScratchSession(req.Content, req.Label)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	port := os.Getenv("CR_LISTEN_PORT")
	if port == "" {
		port = "4779"
	}
	resp := map[string]interface{}{
		"id":  sess.ID,
		"url": fmt.Sprintf("http://localhost:%s/scratch/%s", port, sess.ID),
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// handleCommitScratch fires the commit signal for a scratch session. The
// blocking CLI client gets unblocked and receives the rendered output. The
// browser receives the same rendered text so it can display a confirmation.
// The optional {keep_alive:true} body flips the session into thread-reply
// mode: the session outlives this commit, the rendered payload is a
// directive rather than a chat blob, and only the user comments not yet
// forwarded are included.
func handleCommitScratch(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req struct {
		KeepAlive bool `json:"keep_alive"`
	}
	if r.Body != nil {
		// Missing / malformed body → keep_alive=false, matching the pre-flag
		// behaviour where callers just POST an empty payload.
		_ = json.NewDecoder(r.Body).Decode(&req)
	}

	rendered, err := commitScratchSession(id, req.KeepAlive)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "committed",
		"rendered":   rendered,
		"keep_alive": req.KeepAlive,
	})
}

// handleAwaitScratch long-polls for the session to be committed. The CLI uses
// this to block until the browser fires a commit. Default timeout 60s; the
// CLI loops as needed. The response includes keep_alive so the CLI knows
// whether to exit for good (single-shot) or hand off to a resume cycle.
func handleAwaitScratch(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if getScratchSession(id) == nil {
		http.NotFound(w, r)
		return
	}

	timeout := 60 * time.Second
	if t := r.URL.Query().Get("timeout"); t != "" {
		if secs, err := strconv.Atoi(t); err == nil && secs > 0 {
			timeout = time.Duration(secs) * time.Second
		}
	}

	rendered, keepAlive, ok := waitForScratchCommit(id, timeout)
	w.Header().Set("Content-Type", "application/json")
	if !ok {
		w.WriteHeader(http.StatusRequestTimeout)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "timeout"})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "committed",
		"rendered":   rendered,
		"keep_alive": keepAlive,
	})
}

// handleDeleteScratch removes a scratch session and its comments. Called by
// the CLI after the rendered output is delivered, so the daemon doesn't
// accumulate ephemeral data.
func handleDeleteScratch(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	_, _ = deleteAllComments(scratchProjectDir, id)
	deleteScratchSession(id)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

var skipDirs = map[string]bool{
	".git":          true,
	"node_modules":  true,
	"vendor":        true,
	".next":         true,
	".nuxt":         true,
	"dist":          true,
	"build":         true,
	"target":        true,
	".venv":         true,
	"venv":          true,
	"__pycache__":   true,
	".pytest_cache": true,
	".idea":         true,
	".vscode":       true,
	".DS_Store":     true,
	".direnv":       true,
	".mypy_cache":   true,
	".vim":          true,
	".ruff_cache":   true,
}

func shouldSkipDir(name string) bool {
	return skipDirs[name]
}

func hasMarkdownFiles(dirPath string) bool {
	// Use filepath.WalkDir for efficient traversal
	found := false
	_ = filepath.WalkDir(dirPath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return filepath.SkipDir
		}
		// Skip common directories
		if d.IsDir() && shouldSkipDir(d.Name()) {
			return filepath.SkipDir
		}
		if !d.IsDir() && strings.HasSuffix(strings.ToLower(d.Name()), ".md") {
			found = true
			return filepath.SkipAll // Stop walking once we find one
		}
		return nil
	})
	return found
}

func renderDirectoryListing(w http.ResponseWriter, r *http.Request, projectDir, childPath string) {
	absPath := filepath.Join(projectDir, childPath)

	// Read directory contents
	entries, err := os.ReadDir(absPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Filter for directories and markdown files
	type Entry struct {
		Name  string
		IsDir bool
		Path  string
	}

	var filteredEntries []Entry
	for _, entry := range entries {
		if entry.IsDir() {
			// Skip common directories
			if shouldSkipDir(entry.Name()) {
				continue
			}
			// Only include directories that contain markdown files
			dirFullPath := filepath.Join(absPath, entry.Name())
			if hasMarkdownFiles(dirFullPath) {
				filteredEntries = append(filteredEntries, Entry{
					Name:  entry.Name(),
					IsDir: true,
					Path:  filepath.Join(childPath, entry.Name()),
				})
			}
		} else if strings.HasSuffix(strings.ToLower(entry.Name()), ".md") {
			// Include only markdown files
			filteredEntries = append(filteredEntries, Entry{
				Name:  entry.Name(),
				IsDir: false,
				Path:  filepath.Join(childPath, entry.Name()),
			})
		}
	}

	data := map[string]interface{}{
		"ProjectDir": projectDir,
		"ChildPath":  childPath,
		"Entries":    filteredEntries,
	}

	if err := templates.ExecuteTemplate(w, "directory.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// API Handlers

func handleCreateComment(w http.ResponseWriter, r *http.Request) {
	var comment Comment

	if err := json.NewDecoder(r.Body).Decode(&comment); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Validate required fields
	if comment.ProjectDirectory == "" {
		http.Error(w, "project_directory is required", http.StatusBadRequest)
		return
	}
	if comment.FilePath == "" {
		http.Error(w, "file_path is required", http.StatusBadRequest)
		return
	}

	// For root comments, line numbers and selected text are required
	// For replies (root_id is set), they are optional
	if comment.RootID == nil {
		if comment.LineStart == nil || *comment.LineStart <= 0 {
			http.Error(w, "line_start must be positive", http.StatusBadRequest)
			return
		}
		if comment.LineEnd == nil || *comment.LineEnd <= 0 {
			http.Error(w, "line_end must be positive", http.StatusBadRequest)
			return
		}
		if *comment.LineEnd < *comment.LineStart {
			http.Error(w, "line_end must be >= line_start", http.StatusBadRequest)
			return
		}
		if comment.SelectedText == "" {
			http.Error(w, "selected_text is required for root comments", http.StatusBadRequest)
			return
		}
	}

	// CommentText is required EXCEPT for quick-reaction verbs (agree/reject)
	// which carry meaning even without free-form text.
	if comment.CommentText == "" && comment.Verb != "agree" && comment.Verb != "reject" {
		http.Error(w, "comment_text is required", http.StatusBadRequest)
		return
	}

	if comment.Verb != "" {
		switch comment.Verb {
		case "agree", "reject", "question", "comment":
		default:
			http.Error(w, "verb must be one of agree|reject|question|comment", http.StatusBadRequest)
			return
		}
	}

	// Default author to 'user' if not provided (for API calls from web UI)
	if comment.Author == "" {
		comment.Author = "user"
	}

	if err := createComment(&comment); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Render comment markdown to HTML for web UI response
	rendered, err := RenderMarkdown([]byte(comment.CommentText))
	if err != nil {
		http.Error(w, fmt.Sprintf("failed to render markdown: %v", err), http.StatusInternalServerError)
		return
	}
	comment.RenderedHTML = strings.TrimSpace(string(rendered))

	// Don't broadcast reload for comment creation - the frontend handles it locally
	// Only broadcast for external changes (CLI resolve, file updates)

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(comment); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func handleUpdateComment(w http.ResponseWriter, r *http.Request) {
	// Extract comment ID from URL path
	commentIDStr := chi.URLParam(r, "id")

	// Parse comment ID
	var commentID int
	if _, err := fmt.Sscanf(commentIDStr, "%d", &commentID); err != nil {
		http.Error(w, "Invalid comment ID", http.StatusBadRequest)
		return
	}

	// Check if comment has replies
	hasReply, err := hasReplies(commentID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if hasReply {
		http.Error(w, "Cannot edit comment with replies", http.StatusBadRequest)
		return
	}

	var req struct {
		CommentText string `json:"comment_text"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := updateComment(commentIDStr, req.CommentText); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Get the updated comment
	comment, err := getCommentByID(commentID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if comment == nil {
		http.Error(w, "Comment not found", http.StatusNotFound)
		return
	}

	// Render comment markdown to HTML for web UI response
	rendered, err := RenderMarkdown([]byte(comment.CommentText))
	if err != nil {
		http.Error(w, fmt.Sprintf("failed to render markdown: %v", err), http.StatusInternalServerError)
		return
	}
	comment.RenderedHTML = strings.TrimSpace(string(rendered))

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(comment); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func handleDeleteComment(w http.ResponseWriter, r *http.Request) {
	// Extract comment ID from URL path
	commentID := chi.URLParam(r, "id")

	if err := deleteComment(commentID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{"status": "deleted"}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func handleResolveThread(w http.ResponseWriter, r *http.Request) {
	// Extract comment ID from URL path
	commentIDStr := chi.URLParam(r, "id")

	// Parse comment ID
	var commentID int
	if _, err := fmt.Sscanf(commentIDStr, "%d", &commentID); err != nil {
		http.Error(w, "Invalid comment ID", http.StatusBadRequest)
		return
	}

	// Get comment to retrieve project_directory and file_path for SSE broadcast
	comment, err := getCommentByID(commentID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if comment == nil {
		http.Error(w, "Comment not found", http.StatusNotFound)
		return
	}

	// Resolve the thread (marked as resolved by 'user' since it's from web UI)
	count, err := resolveThread(commentID, "user")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Don't broadcast reload for web UI resolution - the frontend handles it locally
	// Only broadcast for CLI resolution (via notify endpoint)

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "resolved",
		"count":  count,
	}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func validateContentPath(projectDir, filePath string) (string, error) {
	projects, err := getAllProjects()
	if err != nil {
		return "", fmt.Errorf("failed to get projects: %w", err)
	}

	found := false
	for _, p := range projects {
		if p.Directory == projectDir {
			found = true
			break
		}
	}
	if !found {
		return "", fmt.Errorf("project not registered: %s", projectDir)
	}

	absPath := filepath.Clean(filepath.Join(projectDir, filePath))
	if !strings.HasPrefix(absPath, filepath.Clean(projectDir)+string(filepath.Separator)) {
		return "", fmt.Errorf("path traversal rejected")
	}

	return absPath, nil
}

func handleGetContent(w http.ResponseWriter, r *http.Request) {
	projectDir := r.URL.Query().Get("project_directory")
	filePath := r.URL.Query().Get("file_path")

	if projectDir == "" || filePath == "" {
		http.Error(w, "project_directory and file_path are required", http.StatusBadRequest)
		return
	}

	absPath, err := validateContentPath(projectDir, filePath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	content, err := os.ReadFile(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(content)
}

// AnchorUpdate represents a comment position update from the frontend's
// invisible anchor system. When the editor extracts anchor positions on save,
// it sends these updates so we can precisely reposition comments.
type AnchorUpdate struct {
	CommentID    int    `json:"comment_id"`
	SelectedText string `json:"selected_text"`
}

func handleSaveContent(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProjectDirectory string         `json:"project_directory"`
		FilePath         string         `json:"file_path"`
		Content          string         `json:"content"`
		AnchorUpdates    []AnchorUpdate `json:"anchor_updates"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.ProjectDirectory == "" || req.FilePath == "" {
		http.Error(w, "project_directory and file_path are required", http.StatusBadRequest)
		return
	}

	absPath, err := validateContentPath(req.ProjectDirectory, req.FilePath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Read old content before overwriting (for comment re-anchoring)
	oldContent, _ := os.ReadFile(absPath)

	// Suppress the file watcher reload for our own save, and update the
	// content snapshot so future external-change diffs have the right baseline.
	if fileWatcher != nil {
		fileWatcher.SuppressNext(absPath)
		fileWatcher.UpdateContentSnapshot(absPath, req.Content)
	}

	if err := os.WriteFile(absPath, []byte(req.Content), 0644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Re-anchor comments: use anchor-based updates from the rich editor when
	// available (precise), fall back to diff-based reanchoring (for raw mode
	// or when no anchors were sent).
	if len(req.AnchorUpdates) > 0 {
		applyAnchorUpdates(req.ProjectDirectory, req.FilePath, req.Content, req.AnchorUpdates)
	} else if len(oldContent) > 0 {
		reanchorComments(req.ProjectDirectory, req.FilePath, string(oldContent), req.Content)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "saved"})
}
