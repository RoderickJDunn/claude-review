package main

import (
	"log"
	"strings"

	dmp "github.com/sergi/go-diff/diffmatchpatch"
)

// reanchorComments adjusts comment line numbers and selected_text after a file
// edit. It uses diff-match-patch to compute a line mapping from old to new
// content, then updates each unresolved comment in the database.
func reanchorComments(projectDir, filePath, oldContent, newContent string) {
	if oldContent == newContent {
		return
	}

	comments, err := getComments(projectDir, filePath, false)
	if err != nil {
		log.Printf("reanchor: failed to get comments: %v", err)
		return
	}
	if len(comments) == 0 {
		return
	}

	// Build line mapping from old to new
	lineMap := buildLineMap(oldContent, newContent)

	// Build character-level offset mapping for selected_text re-matching
	charMap := buildCharMap(oldContent, newContent)

	newLines := strings.Split(newContent, "\n")

	for i := range comments {
		c := &comments[i]
		if c.RootID != nil {
			continue
		}
		if c.LineStart == nil || c.LineEnd == nil {
			continue
		}

		updated := reanchorOneComment(c, lineMap, charMap, strings.Split(oldContent, "\n"), newLines, oldContent, newContent)
		if updated {
			if err := updateCommentAnchor(c.ID, c.LineStart, c.LineEnd, c.SelectedText); err != nil {
				log.Printf("reanchor: failed to update comment %d: %v", c.ID, err)
			}
		}
	}
}

// reanchorOneComment adjusts a single comment's anchors. Returns true if
// anything changed and the DB should be updated.
func reanchorOneComment(c *Comment, lineMap map[int]int, charMap []charMapping, oldLines, newLines []string, oldContent, newContent string) bool {
	changed := false
	origStart := *c.LineStart
	origEnd := *c.LineEnd

	// Step 1: Map line numbers through the diff
	newStart, startOk := lineMap[origStart]
	newEnd, endOk := lineMap[origEnd]

	if startOk && endOk {
		if newStart != origStart || newEnd != origEnd {
			*c.LineStart = newStart
			*c.LineEnd = newEnd
			changed = true
		}
	} else {
		newStart = nearestMappedLine(lineMap, origStart, len(oldLines))
		newEnd = nearestMappedLine(lineMap, origEnd, len(oldLines))
		if newStart > 0 && newEnd > 0 {
			*c.LineStart = newStart
			*c.LineEnd = newEnd
			changed = true
		}
	}

	// Step 2: Check if selected_text still exists at the new line range
	if c.SelectedText == "" {
		return changed
	}

	blockText := linesInRange(newLines, *c.LineStart, *c.LineEnd)
	if strings.Contains(blockText, c.SelectedText) {
		return changed
	}

	// Step 3: Use character-level offset mapping to find what the old text became
	oldIdx := strings.Index(oldContent, c.SelectedText)
	if oldIdx != -1 {
		newText := mapTextThroughCharMap(charMap, oldIdx, oldIdx+len(c.SelectedText), newContent)
		if newText != "" && newText != c.SelectedText {
			c.SelectedText = newText
			// Update line numbers to where the new text actually is
			newIdx := strings.Index(newContent, newText)
			if newIdx != -1 {
				*c.LineStart = lineAtOffset(newContent, newIdx)
				*c.LineEnd = lineAtOffset(newContent, newIdx+len(newText)-1)
			}
			changed = true
			return changed
		}
	}

	return changed
}

// charMapping represents a mapped character range from old to new content.
type charMapping struct {
	oldStart int
	oldEnd   int
	newStart int
	newEnd   int
}

// buildCharMap computes character-level offset mappings between old and new text
// using diff-match-patch. Each entry maps a range of equal characters.
func buildCharMap(oldContent, newContent string) []charMapping {
	patcher := dmp.New()
	diffs := patcher.DiffMain(oldContent, newContent, true)

	var mappings []charMapping
	oldPos := 0
	newPos := 0

	for _, d := range diffs {
		l := len(d.Text)
		switch d.Type {
		case dmp.DiffEqual:
			mappings = append(mappings, charMapping{
				oldStart: oldPos,
				oldEnd:   oldPos + l,
				newStart: newPos,
				newEnd:   newPos + l,
			})
			oldPos += l
			newPos += l
		case dmp.DiffDelete:
			oldPos += l
		case dmp.DiffInsert:
			newPos += l
		}
	}

	return mappings
}

// mapTextThroughCharMap finds what the old character range [oldStart, oldEnd)
// became in the new content. For characters that were preserved (equal in the
// diff), it maps them directly. For characters that were deleted/modified, it
// expands to the nearest surviving boundaries and returns the new text between
// those boundaries.
func mapTextThroughCharMap(mappings []charMapping, oldStart, oldEnd int, newContent string) string {
	// Find the new positions for the boundaries of our old range
	newStart := -1
	newEnd := -1

	for _, m := range mappings {
		// Find the first mapping that overlaps or comes after oldStart
		if newStart == -1 && m.oldEnd > oldStart {
			if m.oldStart <= oldStart {
				// oldStart falls within this equal region
				offset := oldStart - m.oldStart
				newStart = m.newStart + offset
			} else {
				// oldStart was in a deleted region; use the start of next equal region
				newStart = m.newStart
			}
		}

		// Find the last mapping that overlaps or comes before oldEnd
		if m.oldStart < oldEnd {
			if m.oldEnd >= oldEnd {
				// oldEnd falls within this equal region
				offset := oldEnd - m.oldStart
				newEnd = m.newStart + offset
			} else {
				// oldEnd extends past this region; use the end of this region
				newEnd = m.newEnd
			}
		}
	}

	if newStart == -1 || newEnd == -1 || newStart >= newEnd {
		return ""
	}

	if newEnd > len(newContent) {
		newEnd = len(newContent)
	}

	return newContent[newStart:newEnd]
}

// buildLineMap computes a mapping from old line numbers (1-based) to new line
// numbers using diff-match-patch's line-level diff.
func buildLineMap(oldContent, newContent string) map[int]int {
	patcher := dmp.New()

	oldRunes, newRunes, lines := patcher.DiffLinesToRunes(oldContent, newContent)
	diffs := patcher.DiffMainRunes(oldRunes, newRunes, false)
	_ = lines

	lineMap := make(map[int]int)
	oldLine := 1
	newLine := 1

	for _, d := range diffs {
		lineCount := len([]rune(d.Text))
		switch d.Type {
		case dmp.DiffEqual:
			for i := 0; i < lineCount; i++ {
				lineMap[oldLine+i] = newLine + i
			}
			oldLine += lineCount
			newLine += lineCount
		case dmp.DiffDelete:
			oldLine += lineCount
		case dmp.DiffInsert:
			newLine += lineCount
		}
	}

	return lineMap
}

// nearestMappedLine finds the closest old line that has a mapping, searching
// outward from the target. Returns 0 if nothing found.
func nearestMappedLine(lineMap map[int]int, target, maxLine int) int {
	for delta := 0; delta <= maxLine; delta++ {
		if v, ok := lineMap[target+delta]; ok {
			return v
		}
		if target-delta >= 1 {
			if v, ok := lineMap[target-delta]; ok {
				return v
			}
		}
	}
	return 0
}

// linesInRange returns the text for 1-based line range [start, end].
func linesInRange(lines []string, start, end int) string {
	if start < 1 {
		start = 1
	}
	if end > len(lines) {
		end = len(lines)
	}
	if start > end {
		return ""
	}
	return strings.Join(lines[start-1:end], "\n")
}

// lineAtOffset returns the 1-based line number for a character offset.
func lineAtOffset(content string, offset int) int {
	if offset < 0 || offset > len(content) {
		return 0
	}
	return strings.Count(content[:offset], "\n") + 1
}

// applyAnchorUpdates uses the precise anchor positions sent by the frontend's
// rich editor to update comment positions. For each anchor update, it searches
// for the selected_text in the new markdown content to compute line numbers.
func applyAnchorUpdates(projectDir, filePath, newContent string, updates []AnchorUpdate) {
	for _, u := range updates {
		if u.SelectedText == "" {
			continue
		}

		// Find the position of selected_text in the new markdown.
		// The text from the DOM is plain text (no markdown formatting), so
		// we search the markdown source which will contain the same words
		// (possibly with surrounding formatting like ** or _).
		idx := strings.Index(newContent, u.SelectedText)
		if idx == -1 {
			log.Printf("anchor update: text not found for comment %d: %q", u.CommentID, truncate(u.SelectedText, 50))
			continue
		}

		lineStart := lineAtOffset(newContent, idx)
		lineEnd := lineAtOffset(newContent, idx+len(u.SelectedText)-1)

		if err := updateCommentAnchor(u.CommentID, &lineStart, &lineEnd, u.SelectedText); err != nil {
			log.Printf("anchor update: failed to update comment %d: %v", u.CommentID, err)
		}
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// updateCommentAnchor updates line numbers and selected text for a comment.
func updateCommentAnchor(commentID int, lineStart, lineEnd *int, selectedText string) error {
	query := `
		UPDATE comments
		SET line_start = ?, line_end = ?, selected_text = ?
		WHERE id = ?`
	logQuery(query, lineStart, lineEnd, selectedText, commentID)
	_, err := db.Exec(query, lineStart, lineEnd, selectedText, commentID)
	return err
}
