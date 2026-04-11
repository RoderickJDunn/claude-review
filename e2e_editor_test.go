package main_test

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// GET /api/content tests

func TestE2E_GetContent_HappyPath(t *testing.T) {
	env := setupE2E(t)
	_, err := env.runCLI(t, "register", "--project", env.ProjectDir)
	require.NoError(t, err)

	resp, err := http.Get(fmt.Sprintf("%s/api/content?project_directory=%s&file_path=test.md",
		env.BaseURL, url.QueryEscape(env.ProjectDir)))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "text/plain; charset=utf-8", resp.Header.Get("Content-Type"))

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	content := string(body)
	assert.Contains(t, content, "# Test Document")
	assert.Contains(t, content, "## Section 2")
	assert.Contains(t, content, "func main()")
}

func TestE2E_GetContent_MissingParams(t *testing.T) {
	env := setupE2E(t)
	_, err := env.runCLI(t, "register", "--project", env.ProjectDir)
	require.NoError(t, err)

	t.Run("missing both params", func(t *testing.T) {
		resp, err := http.Get(env.BaseURL + "/api/content")
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("missing file_path", func(t *testing.T) {
		resp, err := http.Get(fmt.Sprintf("%s/api/content?project_directory=%s",
			env.BaseURL, url.QueryEscape(env.ProjectDir)))
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("missing project_directory", func(t *testing.T) {
		resp, err := http.Get(env.BaseURL + "/api/content?file_path=test.md")
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})
}

func TestE2E_GetContent_UnregisteredProject(t *testing.T) {
	env := setupE2E(t)
	// Don't register any project

	resp, err := http.Get(fmt.Sprintf("%s/api/content?project_directory=%s&file_path=test.md",
		env.BaseURL, url.QueryEscape("/tmp/nonexistent-project")))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	body, _ := io.ReadAll(resp.Body)
	assert.Contains(t, string(body), "project not registered")
}

func TestE2E_GetContent_PathTraversal(t *testing.T) {
	env := setupE2E(t)
	_, err := env.runCLI(t, "register", "--project", env.ProjectDir)
	require.NoError(t, err)

	// Create a sensitive file outside the project
	sensitiveFile := filepath.Join(env.TempDir, "secret.md")
	require.NoError(t, os.WriteFile(sensitiveFile, []byte("SECRET DATA"), 0644))

	traversalPaths := []string{
		"../secret.md",
		"../../secret.md",
		"subdir/../../secret.md",
	}

	for _, maliciousPath := range traversalPaths {
		t.Run(maliciousPath, func(t *testing.T) {
			resp, err := http.Get(fmt.Sprintf("%s/api/content?project_directory=%s&file_path=%s",
				env.BaseURL, url.QueryEscape(env.ProjectDir), url.QueryEscape(maliciousPath)))
			require.NoError(t, err)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
			body, _ := io.ReadAll(resp.Body)
			assert.Contains(t, string(body), "path traversal rejected")
		})
	}
}

func TestE2E_GetContent_NonExistentFile(t *testing.T) {
	env := setupE2E(t)
	_, err := env.runCLI(t, "register", "--project", env.ProjectDir)
	require.NoError(t, err)

	resp, err := http.Get(fmt.Sprintf("%s/api/content?project_directory=%s&file_path=nonexistent.md",
		env.BaseURL, url.QueryEscape(env.ProjectDir)))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

// PUT /api/content tests

func TestE2E_SaveContent_HappyPath(t *testing.T) {
	env := setupE2E(t)
	_, err := env.runCLI(t, "register", "--project", env.ProjectDir)
	require.NoError(t, err)

	newContent := "# Updated Title\n\nNew paragraph content.\n"

	resp := env.putJSON(t, "/api/content", map[string]string{
		"project_directory": env.ProjectDir,
		"file_path":         "test.md",
		"content":           newContent,
	})
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var result map[string]string
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&result))
	assert.Equal(t, "saved", result["status"])

	// Verify the file was actually written to disk
	savedContent, err := os.ReadFile(filepath.Join(env.ProjectDir, "test.md"))
	require.NoError(t, err)
	assert.Equal(t, newContent, string(savedContent))
}

func TestE2E_SaveContent_ThenGetContent(t *testing.T) {
	env := setupE2E(t)
	_, err := env.runCLI(t, "register", "--project", env.ProjectDir)
	require.NoError(t, err)

	newContent := "# Round-trip Test\n\nThis content should survive a save and get.\n"

	// Save
	resp := env.putJSON(t, "/api/content", map[string]string{
		"project_directory": env.ProjectDir,
		"file_path":         "test.md",
		"content":           newContent,
	})
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	// Get it back
	getResp, err := http.Get(fmt.Sprintf("%s/api/content?project_directory=%s&file_path=test.md",
		env.BaseURL, url.QueryEscape(env.ProjectDir)))
	require.NoError(t, err)
	defer func() { _ = getResp.Body.Close() }()

	assert.Equal(t, http.StatusOK, getResp.StatusCode)
	body, err := io.ReadAll(getResp.Body)
	require.NoError(t, err)
	assert.Equal(t, newContent, string(body))
}

func TestE2E_SaveContent_MissingParams(t *testing.T) {
	env := setupE2E(t)
	_, err := env.runCLI(t, "register", "--project", env.ProjectDir)
	require.NoError(t, err)

	t.Run("missing project_directory", func(t *testing.T) {
		resp := env.putJSON(t, "/api/content", map[string]string{
			"file_path": "test.md",
			"content":   "hello",
		})
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("missing file_path", func(t *testing.T) {
		resp := env.putJSON(t, "/api/content", map[string]string{
			"project_directory": env.ProjectDir,
			"content":           "hello",
		})
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})
}

func TestE2E_SaveContent_UnregisteredProject(t *testing.T) {
	env := setupE2E(t)

	resp := env.putJSON(t, "/api/content", map[string]string{
		"project_directory": "/tmp/nonexistent-project",
		"file_path":         "test.md",
		"content":           "hello",
	})
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	body, _ := io.ReadAll(resp.Body)
	assert.Contains(t, string(body), "project not registered")
}

func TestE2E_SaveContent_PathTraversal(t *testing.T) {
	env := setupE2E(t)
	_, err := env.runCLI(t, "register", "--project", env.ProjectDir)
	require.NoError(t, err)

	traversalPaths := []string{
		"../evil.md",
		"../../evil.md",
		"subdir/../../evil.md",
	}

	for _, maliciousPath := range traversalPaths {
		t.Run(maliciousPath, func(t *testing.T) {
			resp := env.putJSON(t, "/api/content", map[string]string{
				"project_directory": env.ProjectDir,
				"file_path":         maliciousPath,
				"content":           "MALICIOUS CONTENT",
			})
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
			body, _ := io.ReadAll(resp.Body)
			assert.Contains(t, string(body), "path traversal rejected")

			// Verify no file was created outside the project
			evilPath := filepath.Join(env.TempDir, "evil.md")
			_, err := os.Stat(evilPath)
			assert.True(t, os.IsNotExist(err), "path traversal should not create file outside project")
		})
	}
}

func TestE2E_SaveContent_InvalidJSON(t *testing.T) {
	env := setupE2E(t)

	req, err := http.NewRequest(http.MethodPut, env.BaseURL+"/api/content",
		strings.NewReader("{invalid json}"))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestE2E_SaveContent_EmptyContent(t *testing.T) {
	env := setupE2E(t)
	_, err := env.runCLI(t, "register", "--project", env.ProjectDir)
	require.NoError(t, err)

	// Saving empty content should work (user might want to clear a file)
	resp := env.putJSON(t, "/api/content", map[string]string{
		"project_directory": env.ProjectDir,
		"file_path":         "test.md",
		"content":           "",
	})
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusOK, resp.StatusCode)

	// Verify file is empty
	content, err := os.ReadFile(filepath.Join(env.ProjectDir, "test.md"))
	require.NoError(t, err)
	assert.Empty(t, string(content))
}

func TestE2E_SaveContent_PreservesUnicode(t *testing.T) {
	env := setupE2E(t)
	_, err := env.runCLI(t, "register", "--project", env.ProjectDir)
	require.NoError(t, err)

	unicodeContent := "# Héllo Wörld\n\nEmoji test: 🎉🚀\n\nChinese: 你好世界\n\nJapanese: こんにちは\n"

	resp := env.putJSON(t, "/api/content", map[string]string{
		"project_directory": env.ProjectDir,
		"file_path":         "test.md",
		"content":           unicodeContent,
	})
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	// Read back via API
	getResp, err := http.Get(fmt.Sprintf("%s/api/content?project_directory=%s&file_path=test.md",
		env.BaseURL, url.QueryEscape(env.ProjectDir)))
	require.NoError(t, err)
	defer func() { _ = getResp.Body.Close() }()

	body, err := io.ReadAll(getResp.Body)
	require.NoError(t, err)
	assert.Equal(t, unicodeContent, string(body))
}

// Watcher suppression test

func TestE2E_SaveContent_SuppressesWatcher(t *testing.T) {
	env := setupE2E(t)
	_, err := env.runCLI(t, "register", "--project", env.ProjectDir)
	require.NoError(t, err)

	// Test 1: Save via API should NOT trigger file_updated event
	t.Run("api save is suppressed", func(t *testing.T) {
		sseURL := fmt.Sprintf("%s/api/events?project_directory=%s&file_path=test.md",
			env.BaseURL, url.QueryEscape(env.ProjectDir))

		client := &http.Client{Timeout: 5 * time.Second}
		sseResp, err := client.Get(sseURL)
		require.NoError(t, err)
		defer func() { _ = sseResp.Body.Close() }()

		require.NoError(t, waitForSSEConnected(sseResp, 3*time.Second))

		// Save content via API (should suppress the watcher)
		resp := env.putJSON(t, "/api/content", map[string]string{
			"project_directory": env.ProjectDir,
			"file_path":         "test.md",
			"content":           "# Saved via API\n\nThis should not trigger watcher.\n",
		})
		_ = resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)

		// Check that no file_updated event arrives within a short window
		scanner := bufio.NewScanner(sseResp.Body)
		eventReceived := false
		done := make(chan bool, 1)

		go func() {
			deadline := time.Now().Add(1500 * time.Millisecond)
			for time.Now().Before(deadline) && scanner.Scan() {
				line := scanner.Text()
				if strings.Contains(line, "event: file_updated") {
					done <- true
					return
				}
			}
			done <- false
		}()

		select {
		case result := <-done:
			eventReceived = result
		case <-time.After(2 * time.Second):
		}

		assert.False(t, eventReceived, "Save via API should NOT trigger file_updated SSE event")
	})

	// Test 2: External file edit SHOULD trigger file_updated event
	// (uses a fresh SSE connection to avoid scanner state issues)
	t.Run("external edit triggers event", func(t *testing.T) {
		sseURL := fmt.Sprintf("%s/api/events?project_directory=%s&file_path=test.md",
			env.BaseURL, url.QueryEscape(env.ProjectDir))

		client := &http.Client{Timeout: 5 * time.Second}
		sseResp, err := client.Get(sseURL)
		require.NoError(t, err)
		defer func() { _ = sseResp.Body.Close() }()

		require.NoError(t, waitForSSEConnected(sseResp, 3*time.Second))

		// Write file externally (no suppression)
		err = os.WriteFile(filepath.Join(env.ProjectDir, "test.md"), []byte("# External Edit\n"), 0644)
		require.NoError(t, err)

		scanner := bufio.NewScanner(sseResp.Body)
		eventReceived := false
		deadline := time.Now().Add(3 * time.Second)

		for time.Now().Before(deadline) && scanner.Scan() {
			line := scanner.Text()
			if strings.Contains(line, "event: file_updated") {
				eventReceived = true
				break
			}
		}

		assert.True(t, eventReceived, "External file edit SHOULD trigger file_updated SSE event")
	})
}

// Editor frontend asset tests

func TestE2E_EditorAssets_Served(t *testing.T) {
	env := setupE2E(t)

	t.Run("editor.js is served", func(t *testing.T) {
		resp, err := http.Get(env.BaseURL + "/static/editor.js")
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()

		assert.Equal(t, http.StatusOK, resp.StatusCode)
		body, _ := io.ReadAll(resp.Body)
		bodyStr := string(body)
		assert.Contains(t, bodyStr, "enterEditMode")
		assert.Contains(t, bodyStr, "saveContent")
		assert.Contains(t, bodyStr, "turndownService")
	})

	t.Run("turndown.js is served", func(t *testing.T) {
		resp, err := http.Get(env.BaseURL + "/static/vendor/turndown.js")
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()

		assert.Equal(t, http.StatusOK, resp.StatusCode)
		body, _ := io.ReadAll(resp.Body)
		bodyStr := string(body)
		assert.Contains(t, bodyStr, "TurndownService")
	})

	t.Run("keyboard-nav.js is served", func(t *testing.T) {
		resp, err := http.Get(env.BaseURL + "/static/keyboard-nav.js")
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusOK, resp.StatusCode)
	})

	t.Run("selection.js is served", func(t *testing.T) {
		resp, err := http.Get(env.BaseURL + "/static/selection.js")
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusOK, resp.StatusCode)
	})

	t.Run("keyboard-comments.js is served", func(t *testing.T) {
		resp, err := http.Get(env.BaseURL + "/static/keyboard-comments.js")
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusOK, resp.StatusCode)
	})
}

func TestE2E_ViewerHTML_IncludesEditorElements(t *testing.T) {
	env := setupE2E(t)
	_, err := env.runCLI(t, "register", "--project", env.ProjectDir)
	require.NoError(t, err)

	viewerURL := fmt.Sprintf("%s/projects%s/test.md", env.BaseURL, env.ProjectDir)
	resp, err := http.Get(viewerURL)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)

	// Editor toolbar elements
	assert.Contains(t, bodyStr, `id="editor-toolbar"`)
	assert.Contains(t, bodyStr, `id="editor-save-btn"`)
	assert.Contains(t, bodyStr, `id="editor-cancel-btn"`)
	assert.Contains(t, bodyStr, `id="editor-raw-toggle"`)
	assert.Contains(t, bodyStr, `id="editor-raw-textarea"`)

	// Editor script tags
	assert.Contains(t, bodyStr, `src="/static/vendor/turndown.js"`)
	assert.Contains(t, bodyStr, `src="/static/editor.js"`)

	// Editor toolbar should be hidden by default
	assert.Contains(t, bodyStr, `id="editor-toolbar" style="display: none;"`)
}
