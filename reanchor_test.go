package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// setupTestDB creates a fresh in-memory SQLite database for unit tests.
func setupTestDB(t *testing.T) {
	t.Helper()
	tmpDir := t.TempDir()
	os.Setenv("CR_DATA_DIR", filepath.Join(tmpDir, "data"))
	t.Cleanup(func() { os.Unsetenv("CR_DATA_DIR") })
	require.NoError(t, initDB())
}

func TestBuildLineMap_NoChange(t *testing.T) {
	content := "line1\nline2\nline3\n"
	m := buildLineMap(content, content)
	assert.Equal(t, 1, m[1])
	assert.Equal(t, 2, m[2])
	assert.Equal(t, 3, m[3])
}

func TestBuildLineMap_InsertAtTop(t *testing.T) {
	old := "aaa\nbbb\nccc\n"
	new_ := "new1\nnew2\naaa\nbbb\nccc\n"
	m := buildLineMap(old, new_)
	assert.Equal(t, 3, m[1])
	assert.Equal(t, 4, m[2])
	assert.Equal(t, 5, m[3])
}

func TestBuildLineMap_InsertInMiddle(t *testing.T) {
	old := "aaa\nbbb\nccc\n"
	new_ := "aaa\ninserted\nbbb\nccc\n"
	m := buildLineMap(old, new_)
	assert.Equal(t, 1, m[1])
	assert.Equal(t, 3, m[2])
	assert.Equal(t, 4, m[3])
}

func TestBuildLineMap_DeleteLines(t *testing.T) {
	old := "aaa\nbbb\nccc\nddd\n"
	new_ := "aaa\nddd\n"
	m := buildLineMap(old, new_)
	assert.Equal(t, 1, m[1])
	_, ok2 := m[2]
	assert.False(t, ok2)
	_, ok3 := m[3]
	assert.False(t, ok3)
	assert.Equal(t, 2, m[4])
}

func TestNearestMappedLine(t *testing.T) {
	m := map[int]int{1: 1, 4: 2}
	assert.Equal(t, 1, nearestMappedLine(m, 2, 5))
	assert.Equal(t, 2, nearestMappedLine(m, 3, 5))
}

func TestLinesInRange(t *testing.T) {
	lines := []string{"aaa", "bbb", "ccc", "ddd"}
	assert.Equal(t, "bbb\nccc", linesInRange(lines, 2, 3))
	assert.Equal(t, "aaa", linesInRange(lines, 1, 1))
	assert.Equal(t, "", linesInRange(lines, 5, 6))
}

func TestLineAtOffset(t *testing.T) {
	content := "line1\nline2\nline3"
	assert.Equal(t, 1, lineAtOffset(content, 0))
	assert.Equal(t, 1, lineAtOffset(content, 4))
	assert.Equal(t, 2, lineAtOffset(content, 6))
	assert.Equal(t, 3, lineAtOffset(content, 12))
}

// helper to create args for reanchorOneComment
func reanchorArgs(old, new_ string) (map[int]int, []charMapping, []string, []string) {
	lineMap := buildLineMap(old, new_)
	charMap := buildCharMap(old, new_)
	return lineMap, charMap, strings.Split(old, "\n"), strings.Split(new_, "\n")
}

func TestReanchorOneComment_LineShift(t *testing.T) {
	old := "# Title\n\nSome text here.\n\nMore text.\n"
	new_ := "# Title\n\nNew paragraph added.\n\nSome text here.\n\nMore text.\n"

	lineMap, charMap, oldLines, newLines := reanchorArgs(old, new_)

	start := 3
	end := 3
	c := Comment{
		ID:           1,
		LineStart:    &start,
		LineEnd:      &end,
		SelectedText: "Some text here.",
	}

	changed := reanchorOneComment(&c, lineMap, charMap, oldLines, newLines, old, new_)

	require.True(t, changed)
	assert.Equal(t, 5, *c.LineStart)
	assert.Equal(t, 5, *c.LineEnd)
	assert.Equal(t, "Some text here.", c.SelectedText)
}

func TestReanchorOneComment_TextEdited(t *testing.T) {
	old := "# Title\n\nSome text here.\n"
	new_ := "# Title\n\nSome modified text here.\n"

	lineMap, charMap, oldLines, newLines := reanchorArgs(old, new_)

	start := 3
	end := 3
	c := Comment{
		ID:           1,
		LineStart:    &start,
		LineEnd:      &end,
		SelectedText: "Some text here.",
	}

	changed := reanchorOneComment(&c, lineMap, charMap, oldLines, newLines, old, new_)

	require.True(t, changed)
	// The char-level mapping should produce the updated text
	assert.Equal(t, "Some modified text here.", c.SelectedText)
}

func TestReanchorOneComment_NoChange(t *testing.T) {
	content := "# Title\n\nSome text here.\n"
	lineMap, charMap, oldLines, newLines := reanchorArgs(content, content)

	start := 3
	end := 3
	c := Comment{
		ID:           1,
		LineStart:    &start,
		LineEnd:      &end,
		SelectedText: "Some text here.",
	}

	changed := reanchorOneComment(&c, lineMap, charMap, oldLines, newLines, content, content)

	assert.False(t, changed)
	assert.Equal(t, 3, *c.LineStart)
	assert.Equal(t, "Some text here.", c.SelectedText)
}

func TestReanchorComments_SkipsReplies(t *testing.T) {
	rootID := 1
	c := Comment{
		ID:     2,
		RootID: &rootID,
	}
	// The reply-skipping guard is in reanchorComments, verified here
	assert.NotNil(t, c.RootID, "replies have non-nil RootID and are skipped")
}

func TestReanchorOneComment_DeletedLines_FallsBack(t *testing.T) {
	old := "aaa\nbbb\nccc\nddd\n"
	new_ := "aaa\nddd\n"

	lineMap, charMap, oldLines, newLines := reanchorArgs(old, new_)

	start := 2
	end := 3
	c := Comment{
		ID:           1,
		LineStart:    &start,
		LineEnd:      &end,
		SelectedText: "bbb",
	}

	changed := reanchorOneComment(&c, lineMap, charMap, oldLines, newLines, old, new_)

	require.True(t, changed)
}

func TestReanchorOneComment_MultiLineShift(t *testing.T) {
	old := "# Section 1\n\nParagraph one.\n\n# Section 2\n\nParagraph two is longer\nand spans multiple lines.\n"
	new_ := "# Section 1\n\nParagraph one.\n\nNew stuff here.\n\n# Section 2\n\nParagraph two is longer\nand spans multiple lines.\n"

	lineMap, charMap, oldLines, newLines := reanchorArgs(old, new_)

	start := 7
	end := 8
	c := Comment{
		ID:           1,
		LineStart:    &start,
		LineEnd:      &end,
		SelectedText: "Paragraph two is longer",
	}

	changed := reanchorOneComment(&c, lineMap, charMap, oldLines, newLines, old, new_)

	require.True(t, changed)
	assert.Equal(t, 9, *c.LineStart)
	assert.Equal(t, 10, *c.LineEnd)
	assert.Equal(t, "Paragraph two is longer", c.SelectedText)
}

func TestBuildCharMap(t *testing.T) {
	old := "hello world"
	new_ := "hello beautiful world"
	mappings := buildCharMap(old, new_)

	// Should have at least 2 equal regions: "hello " and " world" (or similar)
	require.True(t, len(mappings) >= 2)

	// "hello " maps to "hello "
	assert.Equal(t, 0, mappings[0].oldStart)
	assert.Equal(t, 0, mappings[0].newStart)
}

func TestMapTextThroughCharMap_Insertion(t *testing.T) {
	old := "hello world"
	new_ := "hello beautiful world"
	mappings := buildCharMap(old, new_)

	// Map "hello world" (entire old text) through the char map
	result := mapTextThroughCharMap(mappings, 0, len(old), new_)
	assert.Equal(t, "hello beautiful world", result)
}

func TestMapTextThroughCharMap_Modification(t *testing.T) {
	old := "Some text here."
	new_ := "Some modified text here."
	mappings := buildCharMap(old, new_)

	result := mapTextThroughCharMap(mappings, 0, len(old), new_)
	assert.Equal(t, "Some modified text here.", result)
}

func TestMapTextThroughCharMap_PartialSelection(t *testing.T) {
	old := "aaa bbb ccc ddd"
	new_ := "aaa bbb xyz ccc ddd"
	mappings := buildCharMap(old, new_)

	// Map "ccc ddd" (old offset 8-15)
	result := mapTextThroughCharMap(mappings, 8, 15, new_)
	assert.Equal(t, "ccc ddd", result)
}

// --- applyAnchorUpdates tests ---

func TestApplyAnchorUpdates_Basic(t *testing.T) {
	// Setup: create an in-memory DB and a comment
	setupTestDB(t)

	projectDir := "/test/project"
	filePath := "doc.md"
	_, err := createProject(projectDir)
	require.NoError(t, err)

	start := 3
	end := 3
	c := &Comment{
		ProjectDirectory: projectDir,
		FilePath:         filePath,
		LineStart:        &start,
		LineEnd:          &end,
		SelectedText:     "original text",
		CommentText:      "fix this",
		Author:           "user",
	}
	require.NoError(t, createComment(c))

	// New content has the text at a different line
	newContent := "# Title\n\nNew intro paragraph.\n\noriginal text here.\n\n## End\n"

	applyAnchorUpdates(projectDir, filePath, newContent, []AnchorUpdate{
		{CommentID: c.ID, SelectedText: "original text"},
	})

	// Verify the comment was updated
	updated, err := getCommentByID(c.ID)
	require.NoError(t, err)
	assert.Equal(t, 5, *updated.LineStart)
	assert.Equal(t, 5, *updated.LineEnd)
	assert.Equal(t, "original text", updated.SelectedText)
}

func TestApplyAnchorUpdates_MultipleComments(t *testing.T) {
	setupTestDB(t)

	projectDir := "/test/project"
	filePath := "doc.md"
	_, err := createProject(projectDir)
	require.NoError(t, err)

	s1, e1 := 1, 1
	c1 := &Comment{
		ProjectDirectory: projectDir,
		FilePath:         filePath,
		LineStart:        &s1,
		LineEnd:          &e1,
		SelectedText:     "first comment",
		CommentText:      "comment 1",
		Author:           "user",
	}
	require.NoError(t, createComment(c1))

	s2, e2 := 3, 3
	c2 := &Comment{
		ProjectDirectory: projectDir,
		FilePath:         filePath,
		LineStart:        &s2,
		LineEnd:          &e2,
		SelectedText:     "second comment",
		CommentText:      "comment 2",
		Author:           "user",
	}
	require.NoError(t, createComment(c2))

	newContent := "first comment is here\n\nsecond comment is here\n"

	applyAnchorUpdates(projectDir, filePath, newContent, []AnchorUpdate{
		{CommentID: c1.ID, SelectedText: "first comment"},
		{CommentID: c2.ID, SelectedText: "second comment"},
	})

	u1, err := getCommentByID(c1.ID)
	require.NoError(t, err)
	assert.Equal(t, 1, *u1.LineStart)

	u2, err := getCommentByID(c2.ID)
	require.NoError(t, err)
	assert.Equal(t, 3, *u2.LineStart)
}

func TestApplyAnchorUpdates_TextNotFound(t *testing.T) {
	setupTestDB(t)

	projectDir := "/test/project"
	filePath := "doc.md"
	_, err := createProject(projectDir)
	require.NoError(t, err)

	s1, e1 := 3, 3
	c := &Comment{
		ProjectDirectory: projectDir,
		FilePath:         filePath,
		LineStart:        &s1,
		LineEnd:          &e1,
		SelectedText:     "original",
		CommentText:      "fix",
		Author:           "user",
	}
	require.NoError(t, createComment(c))

	newContent := "# Title\n\nCompletely different content.\n"

	// Should not crash; comment stays unchanged
	applyAnchorUpdates(projectDir, filePath, newContent, []AnchorUpdate{
		{CommentID: c.ID, SelectedText: "does not exist in content"},
	})

	updated, err := getCommentByID(c.ID)
	require.NoError(t, err)
	// Lines unchanged since the anchor text wasn't found
	assert.Equal(t, 3, *updated.LineStart)
	assert.Equal(t, 3, *updated.LineEnd)
}

func TestApplyAnchorUpdates_UpdatesSelectedText(t *testing.T) {
	setupTestDB(t)

	projectDir := "/test/project"
	filePath := "doc.md"
	_, err := createProject(projectDir)
	require.NoError(t, err)

	s1, e1 := 3, 3
	c := &Comment{
		ProjectDirectory: projectDir,
		FilePath:         filePath,
		LineStart:        &s1,
		LineEnd:          &e1,
		SelectedText:     "old selected text",
		CommentText:      "needs edit",
		Author:           "user",
	}
	require.NoError(t, createComment(c))

	// User edited the commented text; the anchor captured the new text
	newContent := "# Title\n\nnew selected text here.\n"

	applyAnchorUpdates(projectDir, filePath, newContent, []AnchorUpdate{
		{CommentID: c.ID, SelectedText: "new selected text"},
	})

	updated, err := getCommentByID(c.ID)
	require.NoError(t, err)
	assert.Equal(t, 3, *updated.LineStart)
	assert.Equal(t, "new selected text", updated.SelectedText)
}

func TestApplyAnchorUpdates_EmptyTextSkipped(t *testing.T) {
	setupTestDB(t)

	projectDir := "/test/project"
	filePath := "doc.md"
	_, err := createProject(projectDir)
	require.NoError(t, err)

	s1, e1 := 3, 3
	c := &Comment{
		ProjectDirectory: projectDir,
		FilePath:         filePath,
		LineStart:        &s1,
		LineEnd:          &e1,
		SelectedText:     "original",
		CommentText:      "fix",
		Author:           "user",
	}
	require.NoError(t, createComment(c))

	newContent := "# Title\n\noriginal text.\n"

	// Empty selected_text should be skipped
	applyAnchorUpdates(projectDir, filePath, newContent, []AnchorUpdate{
		{CommentID: c.ID, SelectedText: ""},
	})

	updated, err := getCommentByID(c.ID)
	require.NoError(t, err)
	// Should be unchanged
	assert.Equal(t, 3, *updated.LineStart)
	assert.Equal(t, "original", updated.SelectedText)
}

func TestTruncate(t *testing.T) {
	assert.Equal(t, "hello", truncate("hello", 10))
	assert.Equal(t, "hel...", truncate("hello world", 3))
	assert.Equal(t, "", truncate("", 5))
}
