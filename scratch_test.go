package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func setupScratchTestDB(t *testing.T) {
	t.Helper()
	tmpDir := t.TempDir()
	os.Setenv("CR_DATA_DIR", filepath.Join(tmpDir, "data"))
	t.Cleanup(func() { os.Unsetenv("CR_DATA_DIR") })
	require.NoError(t, initDB())
	t.Cleanup(func() {
		if db != nil {
			_ = db.Close()
			db = nil
		}
	})
}

// TestCommitScratchSession_DeltaAcrossRounds verifies that a keep_alive commit
// only forwards user comments that haven't been sent before, and that a
// second commit sees only newly-added user comments.
func TestCommitScratchSession_DeltaAcrossRounds(t *testing.T) {
	setupScratchTestDB(t)

	sess, err := createScratchSession("some doc", "test")
	require.NoError(t, err)

	// Round 1: two root user comments (as if the user annotated 2 bullets).
	ls, le := 1, 1
	c1 := &Comment{
		ProjectDirectory: scratchProjectDir,
		FilePath:         sess.ID,
		LineStart:        &ls,
		LineEnd:          &le,
		SelectedText:     "bullet one",
		CommentText:      "",
		Verb:             "agree",
		Author:           "user",
	}
	require.NoError(t, createComment(c1))

	c2 := &Comment{
		ProjectDirectory: scratchProjectDir,
		FilePath:         sess.ID,
		LineStart:        &ls,
		LineEnd:          &le,
		SelectedText:     "bullet two",
		CommentText:      "why?",
		Verb:             "question",
		Author:           "user",
	}
	require.NoError(t, createComment(c2))

	// First keep_alive commit: both threads should be in the directive.
	rendered1, err := commitScratchSession(sess.ID, true)
	require.NoError(t, err)
	if !strings.Contains(rendered1, "> bullet one") {
		t.Fatalf("round 1 directive missing bullet one:\n%s", rendered1)
	}
	if !strings.Contains(rendered1, "> bullet two") {
		t.Fatalf("round 1 directive missing bullet two:\n%s", rendered1)
	}

	// Confirm the delta tracker now contains both root IDs.
	sess = getScratchSession(sess.ID)
	if _, ok := sess.sentCommentIDs[int64(c1.ID)]; !ok {
		t.Fatalf("expected c1 (%d) in sentCommentIDs", c1.ID)
	}
	if _, ok := sess.sentCommentIDs[int64(c2.ID)]; !ok {
		t.Fatalf("expected c2 (%d) in sentCommentIDs", c2.ID)
	}

	// Simulate the agent posting a reply into thread 1. That reply is
	// agent-authored and should NOT trigger inclusion in the next delta.
	agentReply := &Comment{
		ProjectDirectory: scratchProjectDir,
		FilePath:         sess.ID,
		CommentText:      "ok, changed",
		Author:           "agent",
		RootID:           &c1.ID,
	}
	require.NoError(t, createComment(agentReply))

	// Round 2: no new user comments → empty-delta directive.
	rendered2, err := commitScratchSession(sess.ID, true)
	require.NoError(t, err)
	if !strings.Contains(rendered2, "Nothing new since last sync") {
		t.Fatalf("round 2 expected empty-delta message:\n%s", rendered2)
	}
	if strings.Contains(rendered2, "─── thread") {
		t.Fatalf("round 2 should not contain any thread header:\n%s", rendered2)
	}

	// Now user replies to thread 1. Only that thread should be in round 3.
	userReply := &Comment{
		ProjectDirectory: scratchProjectDir,
		FilePath:         sess.ID,
		CommentText:      "still confused",
		Author:           "user",
		RootID:           &c1.ID,
	}
	require.NoError(t, createComment(userReply))

	rendered3, err := commitScratchSession(sess.ID, true)
	require.NoError(t, err)
	if !strings.Contains(rendered3, "> bullet one") {
		t.Fatalf("round 3 should include thread 1:\n%s", rendered3)
	}
	if strings.Contains(rendered3, "> bullet two") {
		t.Fatalf("round 3 should NOT re-send thread 2:\n%s", rendered3)
	}
	if !strings.Contains(rendered3, "User said: still confused") {
		t.Fatalf("round 3 should surface latest user reply:\n%s", rendered3)
	}
}

// TestCommitScratchSession_SingleShotUnchanged verifies that keep_alive=false
// still emits the classic chat blob and does not touch the delta tracker.
func TestCommitScratchSession_SingleShotUnchanged(t *testing.T) {
	setupScratchTestDB(t)

	sess, err := createScratchSession("some doc", "test")
	require.NoError(t, err)

	ls, le := 1, 1
	c := &Comment{
		ProjectDirectory: scratchProjectDir,
		FilePath:         sess.ID,
		LineStart:        &ls,
		LineEnd:          &le,
		SelectedText:     "the bullet",
		CommentText:      "",
		Verb:             "agree",
		Author:           "user",
	}
	require.NoError(t, createComment(c))

	rendered, err := commitScratchSession(sess.ID, false)
	require.NoError(t, err)
	if !strings.Contains(rendered, "> the bullet") {
		t.Fatalf("expected quoted selection:\n%s", rendered)
	}
	if !strings.Contains(rendered, "Agreed.") {
		t.Fatalf("expected chat-mode verb:\n%s", rendered)
	}
	if strings.Contains(rendered, "─── thread") {
		t.Fatalf("single-shot should not emit thread directive:\n%s", rendered)
	}

	// Delta tracker must remain untouched — single-shot doesn't consume it.
	sess = getScratchSession(sess.ID)
	if len(sess.sentCommentIDs) != 0 {
		t.Fatalf("single-shot should not populate sentCommentIDs, got %v", sess.sentCommentIDs)
	}
}

// TestCommitScratchSession_EventDelivered verifies the browser POST wakes up
// a long-polling CLI: commit emits an event that waitForScratchCommit reads.
func TestCommitScratchSession_EventDelivered(t *testing.T) {
	setupScratchTestDB(t)

	sess, err := createScratchSession("doc", "label")
	require.NoError(t, err)

	rendered, err := commitScratchSession(sess.ID, true)
	require.NoError(t, err)

	got, keepAlive, ok := waitForScratchCommit(sess.ID, 1_000_000_000) // 1s in ns
	if !ok {
		t.Fatalf("waitForScratchCommit did not receive the event")
	}
	if !keepAlive {
		t.Fatalf("expected keep_alive true")
	}
	if got != rendered {
		t.Fatalf("channel payload mismatch:\nwant: %q\ngot:  %q", rendered, got)
	}
}
