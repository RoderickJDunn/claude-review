package main

import (
	"log"
	"os"
	"path/filepath"
	"sync"

	"github.com/fsnotify/fsnotify"
)

type FileWatcher struct {
	watcher      *fsnotify.Watcher
	watches      map[string]bool   // Track watched files
	mu           sync.RWMutex
	callbacks    map[string]func() // Callbacks per file path
	suppressNext map[string]bool   // One-shot reload suppression per file
	lastContent  map[string]string // Last-known content per file (for diff-based reanchoring)
	fileMeta     map[string]fileMeta // Project/file metadata for reanchoring
}

type fileMeta struct {
	projectDir string
	filePath   string
}

var fileWatcher *FileWatcher

func initFileWatcher() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	fileWatcher = &FileWatcher{
		watcher:      watcher,
		watches:      make(map[string]bool),
		callbacks:    make(map[string]func()),
		suppressNext: make(map[string]bool),
		lastContent:  make(map[string]string),
		fileMeta:     make(map[string]fileMeta),
	}

	// Start event processing in background
	go fileWatcher.processEvents()

	return nil
}

func (fw *FileWatcher) SuppressNext(absPath string) {
	fw.mu.Lock()
	defer fw.mu.Unlock()
	fw.suppressNext[absPath] = true
}

func (fw *FileWatcher) processEvents() {
	for {
		select {
		case event, ok := <-fw.watcher.Events:
			if !ok {
				return
			}

			// Only care about write/create events
			if event.Op&fsnotify.Write == fsnotify.Write || event.Op&fsnotify.Create == fsnotify.Create {
				// Check one-shot suppression (e.g., our own save)
				fw.mu.Lock()
				if fw.suppressNext[event.Name] {
					delete(fw.suppressNext, event.Name)
					fw.mu.Unlock()
					continue
				}
				fw.mu.Unlock()

				// Reanchor comments based on file content diff before notifying
				fw.reanchorOnExternalChange(event.Name)

				fw.mu.RLock()
				callback, exists := fw.callbacks[event.Name]
				fw.mu.RUnlock()

				if exists && callback != nil {
					callback()
				}
			}

		case err, ok := <-fw.watcher.Errors:
			if !ok {
				return
			}
			log.Printf("File watcher error: %v", err)
		}
	}
}

func (fw *FileWatcher) watchFile(projectDir, filePath string, callback func()) error {
	absPath := filepath.Join(projectDir, filePath)

	fw.mu.Lock()
	defer fw.mu.Unlock()

	// Check if already watching
	if fw.watches[absPath] {
		// Update callback
		fw.callbacks[absPath] = callback
		return nil
	}

	// Add watch
	if err := fw.watcher.Add(absPath); err != nil {
		return err
	}

	fw.watches[absPath] = true
	fw.callbacks[absPath] = callback
	fw.fileMeta[absPath] = fileMeta{projectDir: projectDir, filePath: filePath}

	// Snapshot current content for future diff-based reanchoring
	if content, err := os.ReadFile(absPath); err == nil {
		fw.lastContent[absPath] = string(content)
	}

	log.Printf("Started watching file: %s", absPath)
	return nil
}

// reanchorOnExternalChange reads the new file content, compares with the
// last-known snapshot, and runs diff-based reanchoring to update comment
// positions in the database. This handles edits from external editors.
func (fw *FileWatcher) reanchorOnExternalChange(absPath string) {
	fw.mu.RLock()
	meta, hasMeta := fw.fileMeta[absPath]
	oldContent, hasOld := fw.lastContent[absPath]
	fw.mu.RUnlock()

	if !hasMeta {
		return
	}

	newBytes, err := os.ReadFile(absPath)
	if err != nil {
		log.Printf("watcher reanchor: failed to read %s: %v", absPath, err)
		return
	}
	newContent := string(newBytes)

	// Update stored snapshot
	fw.mu.Lock()
	fw.lastContent[absPath] = newContent
	fw.mu.Unlock()

	if !hasOld || oldContent == newContent {
		return
	}

	reanchorComments(meta.projectDir, meta.filePath, oldContent, newContent)
}

// UpdateContentSnapshot updates the stored content snapshot for a file.
// Called after the save endpoint writes a file, so the watcher has the
// correct baseline for future external change diffs.
func (fw *FileWatcher) UpdateContentSnapshot(absPath, content string) {
	fw.mu.Lock()
	defer fw.mu.Unlock()
	fw.lastContent[absPath] = content
}

func (fw *FileWatcher) unwatchFile(projectDir, filePath string) error {
	absPath := filepath.Join(projectDir, filePath)

	fw.mu.Lock()
	defer fw.mu.Unlock()

	if !fw.watches[absPath] {
		return nil
	}

	if err := fw.watcher.Remove(absPath); err != nil {
		return err
	}

	delete(fw.watches, absPath)
	delete(fw.callbacks, absPath)

	log.Printf("Stopped watching file: %s", absPath)
	return nil
}

func (fw *FileWatcher) close() error {
	if fw.watcher != nil {
		return fw.watcher.Close()
	}
	return nil
}
