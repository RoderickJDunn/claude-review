package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// Scratch sessions are ephemeral documents the user annotates in the browser
// to produce a rendered reply for piping back to an external agent. They live
// in memory only — the daemon never persists them. Threads/comments attached
// to a scratch session use the existing `comments` table but with a synthetic
// project_directory (scratchProjectDir) and a file_path equal to the session
// ID.
//
// A session outlives a single commit when the browser sends keep_alive=true
// (⌥↩ "Send & Continue"). Subsequent commits emit deltas — only the user
// comments not yet forwarded to the agent are re-rendered. Each keep_alive
// commit also touches CreatedAt so an active review isn't GC'd mid-loop.

const (
	scratchProjectDir = "::scratch"
	scratchTTL        = 30 * time.Minute
	scratchEventBuf   = 32
)

// scratchCommit is a single delivery from the browser to whichever CLI is
// currently long-polling this session. keepAlive mirrors the request flag so
// the CLI (and the front-end that receives the echoed response) can pick the
// right behaviour: single-shot chat blob vs per-thread directive with follow-up
// resume.
type scratchCommit struct {
	rendered  string
	keepAlive bool
}

type scratchSession struct {
	ID        string
	Label     string
	Content   string
	CreatedAt time.Time
	// events carries scratchCommit values from the browser to the waiting CLI.
	// Buffered so a burst of Send & Continue clicks without an attached CLI
	// doesn't deadlock the HTTP handler.
	events chan scratchCommit
	// sentCommentIDs tracks user-authored comment IDs already forwarded to the
	// agent. On each keep_alive commit we render only the threads with at
	// least one unsent user comment.
	sentCommentIDs map[int64]struct{}
	mu             sync.Mutex
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
		ID:             id,
		Label:          label,
		Content:        content,
		CreatedAt:      time.Now(),
		events:         make(chan scratchCommit, scratchEventBuf),
		sentCommentIDs: map[int64]struct{}{},
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
// /scratch/:id/commit. When keepAlive is false it renders the full chat blob
// (single-shot mode — same as the pre-Send&Continue behaviour). When keepAlive
// is true it renders a thread-reply directive covering only the user comments
// not yet forwarded, marks those comments as sent, and touches CreatedAt so
// the session survives the TTL sweep for another window.
func commitScratchSession(id string, keepAlive bool) (string, error) {
	sess := getScratchSession(id)
	if sess == nil {
		return "", fmt.Errorf("scratch session %s not found", id)
	}

	sess.mu.Lock()
	defer sess.mu.Unlock()

	comments, err := getComments(scratchProjectDir, id, false)
	if err != nil {
		return "", fmt.Errorf("failed to read scratch comments: %w", err)
	}
	threads := groupCommentsByThread(comments)

	var rendered string
	if !keepAlive {
		rendered = RenderThreadsToChat(sess.Content, threads)
	} else {
		deltaThreads, newlySent := computeUserCommentDelta(threads, sess.sentCommentIDs)
		rendered = RenderThreadsToDirective(id, deltaThreads)
		for _, cid := range newlySent {
			sess.sentCommentIDs[cid] = struct{}{}
		}
		sess.CreatedAt = time.Now()
	}

	// Non-blocking send with a small fallback: the buffer is generous
	// enough that dropping only happens under runaway click-spam, and even
	// then the browser sees the rendered payload in the HTTP response so
	// nothing is silently lost on the user side.
	select {
	case sess.events <- scratchCommit{rendered: rendered, keepAlive: keepAlive}:
	default:
	}
	return rendered, nil
}

// computeUserCommentDelta walks each thread and finds user-authored comments
// whose ID is not yet in `sent`. Threads with no new user comments are
// dropped. Returns the surviving threads (in their original order) and the
// flat list of newly-included comment IDs so the caller can update `sent`.
func computeUserCommentDelta(threads [][]Comment, sent map[int64]struct{}) ([][]Comment, []int64) {
	var out [][]Comment
	var newlySent []int64
	for _, thread := range threads {
		var freshIDs []int64
		for _, c := range thread {
			if c.Author != "user" {
				continue
			}
			if _, ok := sent[int64(c.ID)]; ok {
				continue
			}
			freshIDs = append(freshIDs, int64(c.ID))
		}
		if len(freshIDs) == 0 {
			continue
		}
		out = append(out, thread)
		newlySent = append(newlySent, freshIDs...)
	}
	return out, newlySent
}

// waitForScratchCommit blocks until the session emits a commit event or the
// timeout expires. Returns (rendered, keepAlive, true) on commit; ("", false,
// false) on timeout or missing session. A zero/negative timeout waits forever.
func waitForScratchCommit(id string, timeout time.Duration) (string, bool, bool) {
	sess := getScratchSession(id)
	if sess == nil {
		return "", false, false
	}
	if timeout <= 0 {
		ev := <-sess.events
		return ev.rendered, ev.keepAlive, true
	}
	select {
	case ev := <-sess.events:
		return ev.rendered, ev.keepAlive, true
	case <-time.After(timeout):
		return "", false, false
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
