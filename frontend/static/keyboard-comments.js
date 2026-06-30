// Keyboard Comments - c key handler, context detection, panel scroll sync

(function () {
    'use strict';

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initKeyboardComments);
    } else {
        initKeyboardComments();
    }

    function initKeyboardComments() {
        document.addEventListener('keydown', handleCommentKey);
        document.addEventListener('keydown', handlePaneNav);
        setupPaneFocusClicks();
    }

    function setupPaneFocusClicks() {
        // Clicking on comment panel enters pane mode
        const panel = document.getElementById('comment-panel');
        if (panel) {
            panel.addEventListener('click', (e) => {
                // Don't enter pane mode if clicking buttons
                if (e.target.closest('.comment-badge-btn')) return;

                // If a specific thread was clicked, update pane index to match
                const threadContainer = e.target.closest('.thread-container');
                if (threadContainer) {
                    const viewer = window.crViewer;
                    if (viewer) {
                        const threads = viewer.getRootThreadContainers();
                        const idx = Array.prototype.indexOf.call(threads, threadContainer);
                        if (idx !== -1) {
                            window.crNav.paneCommentIndex = idx;
                        }
                    }
                }

                enterPaneMode();
            });
        }

        // Clicking on markdown content exits pane mode
        const content = document.getElementById('markdown-content');
        if (content) {
            content.addEventListener('click', () => {
                if (window.crNav.editMode) return;
                exitPaneMode();
            });
        }
    }

    function enterPaneMode() {
        const nav = window.crNav;
        const viewer = window.crViewer;
        if (!viewer) return;

        const threads = viewer.getRootThreadContainers();
        if (threads.length === 0) return;

        nav.paneFocus = true;
        if (nav.paneCommentIndex < 0) nav.paneCommentIndex = 0;

        // Deactivate document cursor
        if (window.crNavUtils) window.crNavUtils.hideCursor();

        const panel = document.getElementById('comment-panel');
        if (panel) panel.classList.add('pane-active');

        updatePaneFocusVisual();
        scrollToFocusedComment();
    }

    function exitPaneMode() {
        const nav = window.crNav;
        nav.paneFocus = false;

        const panel = document.getElementById('comment-panel');
        if (panel) panel.classList.remove('pane-active');

        clearPaneFocusVisual();
    }

    function updatePaneFocusVisual() {
        clearPaneFocusVisual();

        const viewer = window.crViewer;
        if (!viewer) return;

        const threads = viewer.getRootThreadContainers();
        const nav = window.crNav;
        if (nav.paneCommentIndex >= 0 && nav.paneCommentIndex < threads.length) {
            threads[nav.paneCommentIndex].classList.add('pane-focused');
            threads[nav.paneCommentIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    function clearPaneFocusVisual() {
        document.querySelectorAll('.thread-container.pane-focused').forEach(el => {
            el.classList.remove('pane-focused');
        });
    }

    function scrollToFocusedComment() {
        const viewer = window.crViewer;
        if (!viewer) return;

        const threads = viewer.getRootThreadContainers();
        const nav = window.crNav;
        if (nav.paneCommentIndex < 0 || nav.paneCommentIndex >= threads.length) return;

        const threadId = threads[nav.paneCommentIndex].dataset.threadId;
        const highlight = document.querySelector(`.comment-highlight[data-comment-id="${threadId}"]`);
        if (highlight) {
            highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Flash the highlight
            highlight.style.backgroundColor = '#ffeb99';
            setTimeout(() => {
                highlight.style.backgroundColor = '#fff8c5';
            }, 800);
        }
    }

    function handlePaneNav(e) {
        if (window.crNav.editMode) return;
        if (window.crNavUtils && window.crNavUtils.isInputFocused()) return;

        const nav = window.crNav;

        // Tab toggles between document nav and comment pane
        if (e.key === 'Tab') {
            e.preventDefault();
            if (nav.paneFocus) {
                exitPaneMode();
                if (window.crNavUtils) window.crNavUtils.activateIfNeeded();
                window.crNavUtils.updateCursorVisual();
            } else {
                enterPaneMode();
            }
            return;
        }

        // Only handle arrow keys when in pane mode
        if (!nav.paneFocus) return;

        const viewer = window.crViewer;
        if (!viewer) return;
        const threads = viewer.getRootThreadContainers();
        if (threads.length === 0) return;

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (nav.paneCommentIndex > 0) {
                nav.paneCommentIndex--;
                updatePaneFocusVisual();
                scrollToFocusedComment();
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (nav.paneCommentIndex < threads.length - 1) {
                nav.paneCommentIndex++;
                updatePaneFocusVisual();
                scrollToFocusedComment();
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            exitPaneMode();
        }
    }

    function handleCommentKey(e) {
        if (window.crNav.editMode) return;
        if (window.crNavUtils && window.crNavUtils.isInputFocused()) return;
        if (e.key !== 'c' && e.key !== 's') return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        const nav = window.crNav;
        if (!nav.active || !nav.cursor) return;

        e.preventDefault();

        // 's' = expand to sentence, then open comment
        if (e.key === 's') {
            // Expand to sentence level (level 2)
            nav.selection.level = 2;
            if (window.crSelection) window.crSelection.applySelectionLevel();
            if (nav.selection.range) {
                openNewComment();
            }
            return;
        }

        if (nav.selection.level > 0 && nav.selection.range) {
            openNewComment();
        } else {
            // Check if cursor is on existing comment
            const highlight = getCommentHighlightAtCursor();
            if (highlight) {
                openExistingComment(highlight);
            } else {
                // Comment on the current cursor word directly
                openCommentOnCursorWord();
            }
        }
    }

    function getCommentHighlightAtCursor() {
        const nav = window.crNav;
        if (!nav.cursor) return null;

        let node = nav.cursor.textNode;
        if (!node.parentElement) return null;
        return node.parentElement.closest('.comment-highlight');
    }

    function openCommentOnCursorWord() {
        const nav = window.crNav;
        const viewer = window.crViewer;
        if (!viewer || !nav.cursor) return;

        // Build a range for the current cursor word
        const range = document.createRange();
        try {
            range.setStart(nav.cursor.textNode, nav.cursor.wordStart);
            range.setEnd(nav.cursor.textNode, nav.cursor.wordEnd);
        } catch (e) {
            return;
        }

        const text = range.toString();
        const lines = viewer.extractLineNumbersFromRange(range);

        viewer.setCurrentSelection({
            text: text,
            range: range.cloneRange(),
            lineStart: lines.lineStart,
            lineEnd: lines.lineEnd,
        });

        const rect = range.getBoundingClientRect();
        viewer.showCommentPopup(rect.right, rect.bottom);

        nav.active = false;
        window.crNavUtils.hideCursor();

        nav._returnBlockIndex = nav.currentBlockIndex;
        nav._returnCursor = { ...nav.cursor };

        setupReturnToNav();
    }

    function openNewComment() {
        const nav = window.crNav;
        const viewer = window.crViewer;
        if (!viewer || !nav.selection.range) return;

        // Set the current selection so viewer.js can use it
        viewer.setCurrentSelection({
            text: nav.selection.text,
            range: nav.selection.range.cloneRange(),
            lineStart: nav.selection.lineStart,
            lineEnd: nav.selection.lineEnd,
        });

        // Position popup near the selection
        const rects = nav.selection.range.getClientRects();
        if (rects.length === 0) return;

        const lastRect = rects[rects.length - 1];
        viewer.showCommentPopup(lastRect.right, lastRect.bottom);

        // Deactivate nav (focus is now in textarea)
        nav.active = false;
        window.crNavUtils.hideCursor();

        // Store position for return
        nav._returnBlockIndex = nav.currentBlockIndex;
        nav._returnCursor = { ...nav.cursor };

        // Setup return-to-nav on Escape/submit
        setupReturnToNav();
    }

    function openExistingComment(highlightElement) {
        const nav = window.crNav;
        const viewer = window.crViewer;
        if (!viewer) return;

        const commentId = parseInt(highlightElement.dataset.commentId, 10);
        const allComments = viewer.getComments();
        if (!allComments) return;

        const comment = allComments.find((c) => c.id === commentId);
        if (!comment) return;

        // Scroll panel to this thread
        const threadItem = document.querySelector(`.thread-container[data-thread-id="${commentId}"]`);
        if (threadItem) {
            threadItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            threadItem.classList.add('thread-highlight-pulse');
            setTimeout(() => threadItem.classList.remove('thread-highlight-pulse'), 1000);
        }

        // Open for edit or reply depending on whether it has replies
        const hasReplies = viewer.commentHasReplies(commentId);
        const rect = highlightElement.getBoundingClientRect();

        if (hasReplies) {
            viewer.showReplyPopup(comment);
        } else {
            viewer.showEditCommentPopup(comment, highlightElement, rect.right, rect.bottom);
        }

        // Deactivate nav
        nav.active = false;
        window.crNavUtils.hideCursor();

        nav._returnBlockIndex = nav.currentBlockIndex;
        nav._returnCursor = { ...nav.cursor };

        setupReturnToNav();
    }

    function setupReturnToNav() {
        const textarea = document.getElementById('comment-text');
        if (!textarea) return;

        const handler = (e) => {
            if (e.key === 'Escape') {
                // hideCommentPopup is already called by viewer.js Escape handler
                // We just need to restore nav state
                setTimeout(returnToNav, 0);
                textarea.removeEventListener('keydown', handler);
            } else if (e.key === 'Enter' && !e.shiftKey) {
                // After submit, return to nav
                setTimeout(returnToNav, 100);
                textarea.removeEventListener('keydown', handler);
            }
        };

        textarea.addEventListener('keydown', handler);
    }

    function returnToNav() {
        const nav = window.crNav;

        // Restore cursor position
        if (nav._returnBlockIndex !== undefined) {
            nav.currentBlockIndex = nav._returnBlockIndex;
        }
        if (nav._returnCursor) {
            nav.cursor = nav._returnCursor;
        }

        // Reset selection
        nav.selection.level = 0;
        nav.selection.range = null;
        nav.selection.text = '';
        nav.selection.lineStart = null;
        nav.selection.lineEnd = null;

        if (window.crSelection) {
            window.crSelection.clearSelectionHighlight();
        }

        // Reactivate
        nav.active = true;
        window.crNavUtils.updateCursorVisual();

        // Remove focus from textarea
        document.activeElement?.blur();

        delete nav._returnBlockIndex;
        delete nav._returnCursor;
    }

})();
