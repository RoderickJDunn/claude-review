package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// Scratch sessions are ephemeral documents the user annotates in the browser
// to produce a single rendered reply for piping back to an external agent.
// They live in memory only — the daemon never persists them. Threads/comments
// attached to a scratch session use the existing `comments` table but with a
// synthetic project_directory (scratchProjectDir) and a file_path equal to the
// session ID.

const (
	scratchProjectDir = "::scratch"
	scratchTTL        = 30 * time.Minute
)

type scratchSession struct {
	ID        string
	Label     string
	Content   string
	CreatedAt time.Time
	// commit is closed when the user commits the annotation in the browser.
	commit chan struct{}
	// rendered is the chat-formatted output produced at commit time; consumed
	// by the blocking CLI subcommand once commit fires.
	rendered string
	mu       sync.Mutex
}

var (
	scratchMu       sync.RWMutex
	scratchSessions = map[string]*scratchSession{}
)

func newScratchID() (string, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func createScratchSession(content, label string) (*scratchSession, error) {
	id, err := newScratchID()
	if err != nil {
		return nil, err
	}
	sess := &scratchSession{
		ID:        id,
		Label:     label,
		Content:   content,
		CreatedAt: time.Now(),
		commit:    make(chan struct{}),
	}
	scratchMu.Lock()
	scratchSessions[id] = sess
	scratchMu.Unlock()
	return sess, nil
}

func getScratchSession(id string) *scratchSession {
	scratchMu.RLock()
	defer scratchMu.RUnlock()
	return scratchSessions[id]
}

func deleteScratchSession(id string) {
	scratchMu.Lock()
	defer scratchMu.Unlock()
	delete(scratchSessions, id)
}

// commitScratchSession is called by the daemon when the browser POSTs to
// /scratch/:id/commit. It renders the annotations to chat format, caches the
// result on the session, signals any waiting CLI client by closing commit,
// and returns the rendered text. Calling commit twice is a no-op (the second
// call still returns the cached output).
func commitScratchSession(id string) (string, error) {
	sess := getScratchSession(id)
	if sess == nil {
		return "", fmt.Errorf("scratch session %s not found", id)
	}

	sess.mu.Lock()
	defer sess.mu.Unlock()

	// If already committed, just return the cached output.
	select {
	case <-sess.commit:
		return sess.rendered, nil
	default:
	}

	comments, err := getComments(scratchProjectDir, id, false)
	if err != nil {
		return "", fmt.Errorf("failed to read scratch comments: %w", err)
	}
	threads := groupCommentsByThread(comments)
	sess.rendered = RenderThreadsToChat(sess.Content, threads)

	close(sess.commit)
	return sess.rendered, nil
}

// waitForScratchCommit blocks until the session is committed or the timeout
// expires. Returns (rendered, true) on commit, ("", false) on timeout. A
// zero/negative timeout disables the timeout (waits forever).
func waitForScratchCommit(id string, timeout time.Duration) (string, bool) {
	sess := getScratchSession(id)
	if sess == nil {
		return "", false
	}
	if timeout <= 0 {
		<-sess.commit
		return sess.rendered, true
	}
	select {
	case <-sess.commit:
		return sess.rendered, true
	case <-time.After(timeout):
		return "", false
	}
}

// startScratchGC sweeps scratch sessions older than scratchTTL on an interval.
// Comments attached to expired sessions are also deleted so the database
// doesn't accumulate ephemeral data.
func startScratchGC() {
	go func() {
		t := time.NewTicker(scratchTTL / 2)
		defer t.Stop()
		for range t.C {
			pruneScratchSessions()
		}
	}()
}

func pruneScratchSessions() {
	cutoff := time.Now().Add(-scratchTTL)
	var expired []string
	scratchMu.RLock()
	for id, sess := range scratchSessions {
		if sess.CreatedAt.Before(cutoff) {
			expired = append(expired, id)
		}
	}
	scratchMu.RUnlock()

	for _, id := range expired {
		_, _ = deleteAllComments(scratchProjectDir, id)
		deleteScratchSession(id)
	}
}

// purgeAllScratchSessions removes every scratch session and its comments.
// Called on daemon shutdown to leave the DB clean.
func purgeAllScratchSessions() {
	scratchMu.RLock()
	ids := make([]string, 0, len(scratchSessions))
	for id := range scratchSessions {
		ids = append(ids, id)
	}
	scratchMu.RUnlock()

	for _, id := range ids {
		_, _ = deleteAllComments(scratchProjectDir, id)
		deleteScratchSession(id)
	}
}
