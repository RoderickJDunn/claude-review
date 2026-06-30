// Claude Review - Markdown Viewer with Custom Text Selection and Commenting

(function () {
    'use strict';

    let currentSelection = null;
    let commentButton = null;
    let commentPopup = null;
    let commentPanel = null;

    // Initialize shared navigation state
    window.crNav = {
        blocks: [],
        currentBlockIndex: 0,
        cursor: null,
        targetX: null,
        active: false,
        editMode: false,        // true when editor is active
        paneFocus: false,       // true when comment pane has focus
        paneCommentIndex: -1,   // index into root comments in pane
        selection: {
            level: 0,
            range: null,
            lineStart: null,
            lineEnd: null,
            text: '',
        },
    };

    function showConfirmDialog(message) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.id = 'confirm-dialog-overlay';

            const dialog = document.createElement('div');
            dialog.id = 'confirm-dialog';

            const msg = document.createElement('p');
            msg.textContent = message;
            dialog.appendChild(msg);

            const buttons = document.createElement('div');
            buttons.className = 'confirm-dialog-buttons';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'comment-btn';
            cancelBtn.textContent = 'Cancel';

            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'comment-btn comment-btn-primary';
            confirmBtn.textContent = 'Confirm';

            buttons.appendChild(cancelBtn);
            buttons.appendChild(confirmBtn);
            dialog.appendChild(buttons);

            const hint = document.createElement('div');
            hint.className = 'confirm-dialog-hint';
            hint.textContent = 'Enter to confirm · Escape to cancel';
            dialog.appendChild(hint);

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            confirmBtn.focus();

            function cleanup(result) {
                document.removeEventListener('keydown', onKey);
                overlay.remove();
                resolve(result);
            }

            function onKey(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    cleanup(true);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cleanup(false);
                }
            }

            document.addEventListener('keydown', onKey);
            cancelBtn.addEventListener('click', () => cleanup(false));
            confirmBtn.addEventListener('click', () => cleanup(true));
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) cleanup(false);
            });
        });
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        initTextSelection();
        initCopyButton();
        createCommentButton();
        createCommentPopup();
        createCommentPanel();
        loadExistingComments();
        setupSSE();

        // Expose functions for keyboard modules
        window.crViewer = {
            showCommentPopup,
            showEditCommentPopup,
            showReplyPopup,
            hideCommentPopup,
            updateCommentPanel,
            extractLineNumbersFromRange,
            commentHasReplies,
            getComments: () => comments,
            getRootThreadContainers: () => Array.from(document.querySelectorAll('.thread-container')),
            getCurrentSelection: () => currentSelection,
            setCurrentSelection: (sel) => { currentSelection = sel; },
        };

        // Expose confirm dialog globally for editor.js
        window.showConfirmDialog = showConfirmDialog;
    }

    function initCopyButton() {
        const btn = document.getElementById('copy-markdown-btn');
        if (!btn) return;

        // Pre-fetch markdown so the tap handler can copy synchronously
        // (iOS Safari requires clipboard ops within the user gesture)
        let cachedMarkdown = null;
        const params = new URLSearchParams({
            project_directory: projectDir,
            file_path: filePath,
        });
        fetch('/api/content?' + params)
            .then(r => r.ok ? r.text() : Promise.reject('fetch failed'))
            .then(md => { cachedMarkdown = md; })
            .catch(err => console.error('Pre-fetch markdown failed:', err));

        btn.addEventListener('click', async () => {
            try {
                let markdown = cachedMarkdown;
                if (!markdown) {
                    const resp = await fetch('/api/content?' + params);
                    if (!resp.ok) throw new Error('Failed to fetch');
                    markdown = await resp.text();
                    cachedMarkdown = markdown;
                }
                await copyToClipboard(markdown);

                btn.classList.add('copied');
                btn.querySelector('.copy-label').textContent = 'Copied!';
                setTimeout(() => {
                    btn.classList.remove('copied');
                    btn.querySelector('.copy-label').textContent = 'Copy';
                }, 2000);
            } catch (err) {
                console.error('Copy failed:', err);
            }
        });
    }

    // Clipboard API requires HTTPS; fall back to execCommand for HTTP/local.
    // iOS Safari needs special handling: the element must be in-viewport,
    // readOnly must be false, and setSelectionRange is required.
    async function copyToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.readOnly = false;
        textarea.contentEditable = 'true';
        textarea.style.position = 'fixed';
        textarea.style.top = '0';
        textarea.style.left = '0';
        textarea.style.width = '1px';
        textarea.style.height = '1px';
        textarea.style.padding = '0';
        textarea.style.border = 'none';
        textarea.style.outline = 'none';
        textarea.style.background = 'transparent';
        textarea.style.clip = 'rect(0,0,0,0)';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!ok) throw new Error('execCommand copy failed');
    }

    function initTextSelection() {
        const container = document.getElementById('markdown-content');
        if (!container) {
            console.error('Markdown content container not found');
            return;
        }

        // Listen for text selection
        document.addEventListener('mouseup', handleTextSelection);
    }

    function handleTextSelection(event) {
        // Don't interfere during edit mode
        if (window.crNav.editMode) return;

        const selection = window.getSelection();
        const selectedText = selection.toString().trim();

        // Don't interfere if clicking inside the popup or button
        if (commentPopup && commentPopup.contains(event.target)) {
            return;
        }
        if (commentButton && commentButton.contains(event.target)) {
            return;
        }

        // Hide button if no text selected
        if (!selectedText) {
            hideCommentButton();
            hideCommentPopup();
            return;
        }

        // Check if selection is within markdown-content
        const container = document.getElementById('markdown-content');
        if (!container.contains(selection.anchorNode)) {
            return;
        }

        // Check if selection is within an existing comment highlight
        const range = selection.getRangeAt(0);
        let node = range.commonAncestorContainer;
        if (node.nodeType === Node.TEXT_NODE) {
            node = node.parentElement;
        }
        if (node && node.closest('.comment-highlight')) {
            // Already highlighted - don't show button
            hideCommentButton();
            return;
        }

        // Store selection info
        const { lineStart, lineEnd } = extractLineNumbersFromRange(range);

        currentSelection = {
            text: selectedText,
            range: range.cloneRange(),
            lineStart,
            lineEnd,
        };

        // Get selection bounding rect to position button at top-right
        const rect = range.getBoundingClientRect();
        showCommentButton(rect.right + window.scrollX, rect.top + window.scrollY);
    }

    function createCommentButton() {
        commentButton = document.createElement('div');
        commentButton.id = 'comment-button';
        commentButton.style.display = 'none';
        commentButton.innerHTML = `
            <button class="comment-add-btn">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="comment-icon">
                    <path fill-rule="evenodd" d="M4.848 2.771A49.144 49.144 0 0 1 12 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97-1.94.284-3.916.455-5.922.505a.39.39 0 0 0-.266.112L8.78 21.53A.75.75 0 0 1 7.5 21v-3.955a48.842 48.842 0 0 1-2.652-.316c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97Z" clip-rule="evenodd" />
                </svg>
            </button>
        `;
        document.body.appendChild(commentButton);

        // Click handler
        commentButton.querySelector('.comment-add-btn').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = commentButton.getBoundingClientRect();
            // Use viewport coordinates directly since popup is position: fixed
            const x = rect.left;
            const y = rect.bottom;
            showCommentPopup(x, y);
            hideCommentButton();
        });

        // Close button when clicking outside
        document.addEventListener('mousedown', (e) => {
            if (commentButton.style.display === 'block' && !commentButton.contains(e.target)) {
                // Check if there's still a text selection
                const selection = window.getSelection();
                if (!selection.toString().trim()) {
                    hideCommentButton();
                }
            }
        });
    }

    function showCommentButton(x, y) {
        commentButton.style.display = 'block';
        // Position so bottom-left corner of button touches top-right corner of selection
        commentButton.style.left = x + 'px';
        // Offset by button height to align bottom of button with top of selection
        const buttonHeight = 40; // 32px icon + 2*4px padding
        commentButton.style.top = y - buttonHeight + 'px';
    }

    function hideCommentButton() {
        if (commentButton) {
            commentButton.style.display = 'none';
        }
    }

    function createCommentPanel() {
        // Get the existing panel from HTML (no longer creating it dynamically)
        commentPanel = document.getElementById('comment-panel');
        if (!commentPanel) {
            console.error('Comment panel not found in HTML');
            return;
        }

        // On mobile (< 768px), default to collapsed unless user explicitly saved a state
        const isMobile = window.innerWidth < 768;
        const savedState = localStorage.getItem('claude-review-panel-state');
        const defaultState = isMobile ? 'collapsed' : 'expanded';
        commentPanel.className = (savedState || defaultState) + ' ready';

        // Click on resize button to cycle through widths
        commentPanel.querySelector('.panel-resize-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (commentPanel.classList.contains('expanded')) {
                commentPanel.classList.remove('expanded');
                commentPanel.classList.add('expanded-wide');
                savePanelState('expanded-wide');
            } else if (commentPanel.classList.contains('expanded-wide')) {
                commentPanel.classList.remove('expanded-wide');
                commentPanel.classList.add('expanded');
                savePanelState('expanded');
            }
        });

        // Minimize button collapses the panel
        commentPanel.querySelector('.panel-minimize-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            commentPanel.classList.remove('expanded', 'expanded-wide');
            commentPanel.classList.add('collapsed');
            savePanelState('collapsed');
        });

        // Click on collapsed panel header to expand
        commentPanel.querySelector('.comment-panel-header').addEventListener('click', () => {
            if (commentPanel.classList.contains('collapsed')) {
                commentPanel.classList.remove('collapsed');
                commentPanel.classList.add('expanded');
                savePanelState('expanded');
            }
        });
    }

    function savePanelState(state) {
        localStorage.setItem('claude-review-panel-state', state);
    }

    function updateCommentPanel() {
        addCommentMarginIndicators();
        if (!commentPanel) return;

        const listContainer = commentPanel.querySelector('.comment-panel-list');
        const countElement = commentPanel.querySelector('.comment-count');

        // Group comments by thread
        const threads = groupCommentsByThread();

        countElement.textContent = threads.length;

        // Clear existing list
        listContainer.innerHTML = '';

        // Add each thread to the panel
        threads.forEach((thread) => {
            const rootComment = thread.root;
            const replies = thread.replies;

            // Check if thread is awaiting user response (last reply is from agent)
            const isAwaitingResponse = replies.length > 0 && replies[replies.length - 1].author === 'agent';

            const threadItem = document.createElement('div');
            threadItem.className = 'thread-container';
            threadItem.dataset.threadId = rootComment.id;

            // Create root comment display
            const rootItem = createCommentPanelItem(rootComment, true, replies.length, isAwaitingResponse);

            threadItem.appendChild(rootItem);

            // Add replies container (initially hidden if collapsed)
            if (replies.length > 0) {
                const repliesContainer = document.createElement('div');
                repliesContainer.className = 'thread-replies';

                replies.forEach((reply) => {
                    const replyItem = createCommentPanelItem(reply, false, 0, false);
                    repliesContainer.appendChild(replyItem);
                });

                threadItem.appendChild(repliesContainer);
            }

            listContainer.appendChild(threadItem);
        });

        // Show the panel now that it's populated
        commentPanel.classList.add('ready');
    }

    function createCommentPanelItem(comment, isRoot, replyCount, isAwaitingResponse) {
        const item = document.createElement('div');
        item.className = isRoot ? 'thread-item comment-root' : 'thread-item comment-reply';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'thread-item-content';

        // Add author label with timestamp
        const authorDiv = document.createElement('div');
        authorDiv.className = 'comment-author';
        if (comment.author === 'agent') {
            authorDiv.classList.add('author-agent');
        }

        // Wrap author name and timestamp together
        const authorInfoDiv = document.createElement('div');
        authorInfoDiv.className = 'comment-author-info';

        const authorSpan = document.createElement('span');
        authorSpan.textContent = capitalizeFirst(comment.author);
        authorInfoDiv.appendChild(authorSpan);

        if (comment.created_at) {
            const timeSpan = document.createElement('span');
            timeSpan.className = 'comment-timestamp';
            timeSpan.textContent = formatRelativeTime(comment.created_at);
            authorInfoDiv.appendChild(timeSpan);
        }

        authorDiv.appendChild(authorInfoDiv);

        // Add badges to author row for root comments
        if (isRoot) {
            const badgesDiv = document.createElement('div');
            badgesDiv.className = 'comment-badges';

            // Add status dot for awaiting response
            if (isAwaitingResponse) {
                const statusDot = document.createElement('div');
                statusDot.className = 'comment-status-dot';
                statusDot.title = 'Awaiting your response';
                badgesDiv.appendChild(statusDot);
            }

            // Add edit button for root comments without replies
            if (replyCount === 0) {
                const editBtn = document.createElement('button');
                editBtn.className = 'comment-badge-btn comment-badge-edit';
                editBtn.textContent = 'Edit';
                editBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const highlight = document.querySelector(`.comment-highlight[data-comment-id="${comment.id}"]`);
                    if (highlight) {
                        highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        // Position popup near the panel
                        const rect = commentPanel.getBoundingClientRect();
                        showEditCommentPopup(comment, highlight, rect.left - 520, rect.top + 40);
                    }
                });
                badgesDiv.appendChild(editBtn);
            }

            // Add reply button as badge
            const replyBtn = document.createElement('button');
            replyBtn.className = 'comment-badge-btn comment-badge-reply';
            replyBtn.textContent = 'Reply';
            replyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showReplyPopup(comment);
            });
            badgesDiv.appendChild(replyBtn);

            // Add resolve button as badge
            const resolveBtn = document.createElement('button');
            resolveBtn.className = 'comment-badge-btn comment-badge-resolve';
            resolveBtn.textContent = 'Resolve';
            resolveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleResolveThread(comment);
            });
            badgesDiv.appendChild(resolveBtn);

            authorDiv.appendChild(badgesDiv);
        }

        contentDiv.appendChild(authorDiv);

        // Show selected text for root comments
        if (isRoot && comment.selected_text) {
            const textDiv = document.createElement('div');
            textDiv.className = 'thread-item-text';
            textDiv.textContent = `"${comment.selected_text}"`;
            contentDiv.appendChild(textDiv);
        }

        // Show a verb badge for annotations with a verb set. Quick-react
        // verbs (agree/reject) often have empty comment_text, so without this
        // badge they'd render blank in the panel.
        if (isRoot && comment.verb) {
            const verbDiv = document.createElement('div');
            verbDiv.className = 'thread-item-verb verb-' + comment.verb;
            verbDiv.textContent = verbLabel(comment.verb);
            contentDiv.appendChild(verbDiv);
        }

        const commentDiv = document.createElement('div');
        commentDiv.className = 'thread-item-comment';

        // Store raw markdown in data attribute for editing
        commentDiv.dataset.rawText = comment.comment_text;

        // Use pre-rendered HTML from backend (all comments have this now)
        commentDiv.innerHTML = comment.rendered_html;

        contentDiv.appendChild(commentDiv);

        item.appendChild(contentDiv);

        // Click to scroll to root comment highlight (only for root comments)
        if (isRoot) {
            item.addEventListener('click', (e) => {
                // Don't scroll if clicking on badge buttons
                if (e.target.closest('.comment-badge-btn')) return;

                const highlight = document.querySelector(`.comment-highlight[data-comment-id="${comment.id}"]`);
                if (highlight) {
                    highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    highlight.style.backgroundColor = '#ffeb99';
                    setTimeout(() => {
                        highlight.style.backgroundColor = '#fff8c5';
                    }, 1000);
                }
            });
        }

        return item;
    }

    function groupCommentsByThread() {
        if (typeof comments === 'undefined' || comments === null || comments.length === 0) {
            return [];
        }

        const threadMap = new Map();

        // First pass: create map of root comments
        comments.forEach((comment) => {
            if (!comment.root_id) {
                threadMap.set(comment.id, {
                    root: comment,
                    replies: [],
                });
            }
        });

        // Second pass: add replies to their threads
        comments.forEach((comment) => {
            if (comment.root_id) {
                const thread = threadMap.get(comment.root_id);
                if (thread) {
                    thread.replies.push(comment);
                }
            }
        });

        // Convert to array and sort by root comment line number
        return Array.from(threadMap.values()).sort((a, b) => {
            const lineA = a.root.line_start || 0;
            const lineB = b.root.line_start || 0;
            return lineA - lineB;
        });
    }

    function capitalizeFirst(s) {
        if (!s) return '';
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function verbLabel(verb) {
        switch (verb) {
            case 'agree': return '✓ Agreed';
            case 'reject': return '✗ Skip';
            case 'question': return '? Question';
            case 'comment': return '💬 Comment';
            default: return verb;
        }
    }

    function formatRelativeTime(timestamp) {
        if (!timestamp) return '';

        const now = new Date();
        const then = new Date(timestamp);

        // Check if date is valid
        if (isNaN(then.getTime())) {
            console.warn('Invalid timestamp:', timestamp);
            return '';
        }

        const diffMs = now - then;
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffSecs / 60);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffSecs < 60) {
            return 'just now';
        } else if (diffMins < 60) {
            return `${diffMins}m ago`;
        } else if (diffHours < 24) {
            return `${diffHours}h ago`;
        } else if (diffDays < 7) {
            return `${diffDays}d ago`;
        } else {
            return then.toLocaleDateString();
        }
    }

    function createCommentPopup() {
        commentPopup = document.createElement('div');
        commentPopup.id = 'comment-popup';
        commentPopup.style.display = 'none';
        commentPopup.innerHTML = `
            <div class="comment-popup-content">
                <textarea id="comment-text" placeholder="Add your comment..." rows="4"></textarea>
                <div class="comment-popup-buttons">
                    <button id="comment-save" class="comment-btn comment-btn-primary">Add</button>
                    <button id="comment-delete" class="comment-btn comment-btn-danger" style="display: none;">Delete</button>
                    <button id="comment-cancel" class="comment-btn">Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(commentPopup);

        // Add keyboard handler for textarea (Enter to submit, Shift+Enter for newline, Escape to cancel)
        const textarea = document.getElementById('comment-text');
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const saveBtn = document.getElementById('comment-save');
                if (saveBtn) {
                    saveBtn.click();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hideCommentPopup();
            }
        });

        // Close popup when clicking outside (but not on text selection)
        document.addEventListener('mousedown', (e) => {
            if (commentPopup.style.display === 'block' && !commentPopup.contains(e.target)) {
                // Check if there's a text selection - if so, don't close
                const selection = window.getSelection();
                if (!selection.toString().trim()) {
                    hideCommentPopup();
                }
            }
        });
    }

    function showCommentPopup(x, y) {
        // Setup for adding new comment
        const saveBtn = document.getElementById('comment-save');
        const deleteBtn = document.getElementById('comment-delete');
        const cancelBtn = document.getElementById('comment-cancel');

        saveBtn.textContent = 'Add';
        deleteBtn.style.display = 'none';

        // Remove old listeners
        saveBtn.replaceWith(saveBtn.cloneNode(true));
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));

        // Add new listeners
        document.getElementById('comment-save').addEventListener('click', handleAddComment);
        document.getElementById('comment-cancel').addEventListener('click', hideCommentPopup);

        commentPopup.style.display = 'block';
        commentPopup.style.left = x + 'px';
        commentPopup.style.top = y + 10 + 'px';

        // Focus textarea without scrolling
        const textarea = document.getElementById('comment-text');
        textarea.value = '';
        textarea.focus({ preventScroll: true });
    }

    function showEditCommentPopup(comment, highlightElement, x, y) {
        // Setup for editing existing comment
        const saveBtn = document.getElementById('comment-save');
        const deleteBtn = document.getElementById('comment-delete');
        const cancelBtn = document.getElementById('comment-cancel');

        saveBtn.textContent = 'Save';
        deleteBtn.style.display = 'inline-block';

        // Remove old listeners
        saveBtn.replaceWith(saveBtn.cloneNode(true));
        deleteBtn.replaceWith(deleteBtn.cloneNode(true));
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));

        // Add new listeners
        document
            .getElementById('comment-save')
            .addEventListener('click', () => handleUpdateComment(comment, highlightElement));
        document
            .getElementById('comment-delete')
            .addEventListener('click', () => handleDeleteComment(comment, highlightElement));
        document.getElementById('comment-cancel').addEventListener('click', hideCommentPopup);

        commentPopup.style.display = 'block';
        commentPopup.style.left = x + 'px';
        commentPopup.style.top = y + 10 + 'px';

        // Pre-fill textarea with existing comment
        const textarea = document.getElementById('comment-text');
        textarea.value = comment.comment_text;
        textarea.focus({ preventScroll: true });
    }

    function hideCommentPopup(clearSelection = true) {
        if (commentPopup) {
            commentPopup.style.display = 'none';
        }
        currentSelection = null;
        if (clearSelection) {
            window.getSelection().removeAllRanges();
        }
    }

    function showReplyPopup(rootComment) {
        const saveBtn = document.getElementById('comment-save');
        const deleteBtn = document.getElementById('comment-delete');
        const cancelBtn = document.getElementById('comment-cancel');

        saveBtn.textContent = 'Reply';
        deleteBtn.style.display = 'none';

        // Remove old listeners
        saveBtn.replaceWith(saveBtn.cloneNode(true));
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));

        // Add new listeners
        document.getElementById('comment-save').addEventListener('click', () => handleAddReply(rootComment));
        document.getElementById('comment-cancel').addEventListener('click', hideCommentPopup);

        commentPopup.style.display = 'block';
        // Position near the center of the screen
        commentPopup.style.left = '50%';
        commentPopup.style.top = '30%';
        commentPopup.style.transform = 'translateX(-50%)';

        // Focus textarea
        const textarea = document.getElementById('comment-text');
        textarea.value = '';
        textarea.focus({ preventScroll: true });
    }

    async function handleAddReply(rootComment) {
        const replyText = document.getElementById('comment-text').value.trim();
        if (!replyText) {
            alert('Please enter a reply');
            return;
        }

        const payload = {
            project_directory: projectDir,
            file_path: filePath,
            comment_text: replyText,
            root_id: rootComment.id,
            author: 'user',
        };

        try {
            const response = await fetch('/api/comments', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const savedReply = await response.json();

            // Add reply to comments array
            if (typeof comments === 'undefined' || comments === null) {
                comments = [];
            }
            comments.push(savedReply);

            // Update comment panel to show new reply
            updateCommentPanel();

            // Hide popup
            hideCommentPopup();
        } catch (error) {
            console.error('Failed to save reply:', error);
            alert('Failed to save reply. Please try again.');
        }
    }

    async function handleResolveThread(rootComment) {
        if (!(await showConfirmDialog('Resolve this thread?'))) {
            return;
        }

        try {
            const response = await fetch(`/api/comments/${rootComment.id}/resolve`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({}),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            // Remove the thread from the comments array (root + all replies)
            if (typeof comments !== 'undefined' && comments !== null) {
                // Remove root comment and all its replies by filtering in reverse
                for (let i = comments.length - 1; i >= 0; i--) {
                    const c = comments[i];
                    if (c.id === rootComment.id || c.root_id === rootComment.id) {
                        comments.splice(i, 1);
                    }
                }
            }

            // Remove highlight from document
            const highlight = document.querySelector(`.comment-highlight[data-comment-id="${rootComment.id}"]`);
            if (highlight) {
                const parent = highlight.parentNode;
                while (highlight.firstChild) {
                    parent.insertBefore(highlight.firstChild, highlight);
                }
                parent.removeChild(highlight);
            }

            // Update comment panel
            updateCommentPanel();
        } catch (error) {
            console.error('Failed to resolve thread:', error);
            alert('Failed to resolve thread. Please try again.');
        }
    }

    /**
     * Extract line numbers from a DOM Range by finding parent elements
     * with data-line-start and data-line-end attributes
     */
    function extractLineNumbersFromRange(range) {
        let lineStart = null;
        let lineEnd = null;

        // Find all block elements with line numbers that intersect with the range
        const content = document.getElementById('markdown-content');
        const blockElements = content.querySelectorAll('[data-line-start]');

        for (const element of blockElements) {
            // Check if this element contains any part of the selection
            if (range.intersectsNode(element)) {
                const start = parseInt(element.getAttribute('data-line-start'), 10);
                const end = parseInt(element.getAttribute('data-line-end'), 10);

                if (lineStart === null || start < lineStart) {
                    lineStart = start;
                }
                if (lineEnd === null || end > lineEnd) {
                    lineEnd = end;
                }
            }
        }

        return { lineStart, lineEnd };
    }

    /**
     * Handle adding a new comment
     */
    async function handleAddComment() {
        if (!currentSelection) {
            return;
        }

        const commentText = document.getElementById('comment-text').value.trim();
        if (!commentText) {
            alert('Please enter a comment');
            return;
        }

        // Prepare comment payload
        const payload = {
            project_directory: projectDir,
            file_path: filePath,
            line_start: currentSelection.lineStart,
            line_end: currentSelection.lineEnd,
            selected_text: currentSelection.text,
            comment_text: commentText,
        };

        try {
            const response = await fetch('/api/comments', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const savedComment = await response.json();

            // Add comment to comments array
            if (typeof comments === 'undefined' || comments === null) {
                comments = [];
            }
            comments.push(savedComment);

            // Find and highlight the text in the document
            highlightCommentByText(savedComment);

            // Update comment panel
            updateCommentPanel();

            // Hide popup and clear selection
            hideCommentPopup(true);
        } catch (error) {
            console.error('Failed to save comment:', error);
            alert('Failed to save comment. Please try again.');
        }
    }

    /**
     * Handle updating an existing comment
     */
    async function handleUpdateComment(comment, highlightElement) {
        const commentText = document.getElementById('comment-text').value.trim();
        if (!commentText) {
            alert('Please enter a comment');
            return;
        }

        try {
            const response = await fetch(`/api/comments/${comment.id}`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    comment_text: commentText,
                }),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const updatedComment = await response.json();

            // Update the comment in the comments array with all returned data
            if (typeof comments !== 'undefined' && comments !== null) {
                const index = comments.findIndex((c) => c.id === comment.id);
                if (index !== -1) {
                    comments[index] = updatedComment;
                }
            }

            // Update the highlight element
            highlightElement.dataset.commentText = updatedComment.comment_text;
            highlightElement.title = updatedComment.comment_text;

            // Update comment panel
            updateCommentPanel();

            // Hide popup
            hideCommentPopup();
        } catch (error) {
            console.error('Failed to update comment:', error);
            alert('Failed to update comment. Please try again.');
        }
    }

    /**
     * Handle deleting a comment
     */
    async function handleDeleteComment(comment, highlightElement) {
        if (!(await showConfirmDialog('Delete this comment?'))) {
            return;
        }

        try {
            const response = await fetch(`/api/comments/${comment.id}`, {
                method: 'DELETE',
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            // Remove the highlight from the DOM
            const parent = highlightElement.parentNode;
            while (highlightElement.firstChild) {
                parent.insertBefore(highlightElement.firstChild, highlightElement);
            }
            parent.removeChild(highlightElement);

            // Remove comment from comments array
            if (typeof comments !== 'undefined' && comments !== null) {
                const index = comments.findIndex((c) => c.id === comment.id);
                if (index !== -1) {
                    comments.splice(index, 1);
                }
            }

            // Update comment panel
            updateCommentPanel();

            // Hide popup
            hideCommentPopup();
        } catch (error) {
            console.error('Failed to delete comment:', error);
            alert('Failed to delete comment. Please try again.');
        }
    }

    /**
     * Check if a comment has replies
     */
    function commentHasReplies(commentId) {
        if (typeof comments === 'undefined' || comments === null) {
            return false;
        }
        return comments.some((c) => c.root_id === commentId);
    }

    /**
     * Highlight a comment in the document
     */
    function highlightComment(range, comment) {
        // Create a span to wrap the selected text
        const highlight = document.createElement('span');
        highlight.className = 'comment-highlight';
        highlight.dataset.commentId = comment.id;
        highlight.dataset.commentText = comment.comment_text;
        highlight.dataset.selectedText = comment.selected_text;
        highlight.dataset.lineStart = comment.line_start;
        highlight.dataset.lineEnd = comment.line_end;
        highlight.title = comment.comment_text;

        // Check if this comment has replies and add class accordingly
        const hasReply = commentHasReplies(comment.id);
        if (hasReply) {
            highlight.classList.add('has-replies');
        }

        // Click handler to edit comment (only if it has no replies)
        highlight.addEventListener('click', (e) => {
            e.stopPropagation();
            // Only allow editing root comments without replies
            if (!comment.root_id && !hasReply) {
                // Convert page coordinates to viewport coordinates for position: fixed popup
                const x = e.clientX;
                const y = e.clientY;
                showEditCommentPopup(comment, highlight, x, y);
            }
        });

        try {
            range.surroundContents(highlight);
        } catch (e) {
            // If surroundContents fails (e.g., range spans multiple elements like inline code),
            // use a more robust approach by extracting and re-inserting the contents
            try {
                const fragment = range.extractContents();
                highlight.appendChild(fragment);
                range.insertNode(highlight);
            } catch (e2) {
                console.error('Could not highlight comment:', e2);
            }
        }
    }

    /**
     * Load existing comments from backend and display them
     */
    function loadExistingComments() {
        if (typeof comments === 'undefined') {
            console.warn('No comments data found in page');
            return;
        }

        if (!comments || comments.length === 0) {
            return;
        }

        // Highlight root comments by finding their text in the document
        // (replies have no selected_text and don't get their own highlight)
        comments.forEach((comment) => {
            if (!comment.root_id && comment.selected_text) {
                highlightExistingComment(comment);
            }
        });

        // Update comment panel after loading all comments
        updateCommentPanel();
    }

    function addCommentMarginIndicators() {
        // Remove existing indicators
        document.querySelectorAll('.comment-margin-indicator').forEach(el => el.remove());

        const highlights = document.querySelectorAll('.comment-highlight');
        const processedBlocks = new Set();

        highlights.forEach(highlight => {
            // Find the containing block element (p, li, h1-h6, etc.)
            const block = highlight.closest('[data-line-start]');
            if (!block || processedBlocks.has(block)) return;
            processedBlocks.add(block);

            // Count comments in this block
            const commentIds = new Set();
            block.querySelectorAll('.comment-highlight').forEach(h => {
                commentIds.add(h.dataset.commentId);
            });

            block.style.position = 'relative';
            const indicator = document.createElement('div');
            indicator.className = 'comment-margin-indicator';
            indicator.title = `${commentIds.size} comment${commentIds.size > 1 ? 's' : ''}`;
            if (commentIds.size > 1) {
                indicator.dataset.count = commentIds.size;
            }
            block.appendChild(indicator);
        });
    }

    /**
     * Highlight a comment by finding its text in the document within the specified line range
     */
    function highlightCommentByText(comment) {
        const content = document.getElementById('markdown-content');
        const text = comment.selected_text;

        // Find the block element(s) that contain the line range
        const blockElements = content.querySelectorAll('[data-line-start]');
        const relevantBlocks = [];

        for (const element of blockElements) {
            const lineStart = parseInt(element.getAttribute('data-line-start'), 10);
            const lineEnd = parseInt(element.getAttribute('data-line-end'), 10);

            // Check if this block overlaps with the comment's line range
            if (lineStart <= comment.line_end && lineEnd >= comment.line_start) {
                relevantBlocks.push(element);
            }
        }

        // Search in line-matched blocks first, then fall back to all blocks
        if (relevantBlocks.length > 0 && searchBlocksForText(relevantBlocks, text, comment)) return;

        // Fallback: line numbers may be stale — search the entire document
        if (searchBlocksForText(Array.from(blockElements), text, comment)) return;

        console.warn('Could not find text to highlight:', text);
    }

    function searchBlocksForText(blocks, text, comment) {
        for (const block of blocks) {
            // First try: find text in a single text node (not inside existing highlights)
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
                acceptNode: function (node) {
                    // Skip text nodes inside existing comment highlights
                    if (node.parentElement && node.parentElement.closest('.comment-highlight')) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }, false);
            let node;
            while ((node = walker.nextNode())) {
                const index = node.textContent.indexOf(text);
                if (index !== -1) {
                    const range = document.createRange();
                    range.setStart(node, index);
                    range.setEnd(node, index + text.length);
                    highlightComment(range, comment);
                    return true;
                }
            }

            // Second try: text may span multiple nodes (e.g., across inline code)
            // Build a text-content string that excludes already-highlighted regions
            const blockText = getUnhighlightedText(block);
            const textIndex = blockText.text.indexOf(text);
            if (textIndex !== -1) {
                const range = findTextRangeInMappedNodes(blockText.nodes, text, textIndex);
                if (range) {
                    highlightComment(range, comment);
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Build a concatenated text string from a block's text nodes, skipping
     * nodes inside existing .comment-highlight spans. Returns the text and
     * a mapping of character positions to {node, offset} for range creation.
     */
    function getUnhighlightedText(block) {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                if (node.parentElement && node.parentElement.closest('.comment-highlight')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        }, false);

        let text = '';
        const nodes = []; // [{node, startPos, endPos}]
        let node;
        while ((node = walker.nextNode())) {
            const startPos = text.length;
            text += node.textContent;
            nodes.push({ node, startPos, endPos: text.length });
        }

        return { text, nodes };
    }

    /**
     * Find a range for text at a given offset in a mapped node list.
     */
    function findTextRangeInMappedNodes(nodes, searchText, textIndex) {
        const searchEnd = textIndex + searchText.length;
        let startNode = null, startOffset = 0;
        let endNode = null, endOffset = 0;

        for (const entry of nodes) {
            if (!startNode && entry.endPos > textIndex) {
                startNode = entry.node;
                startOffset = textIndex - entry.startPos;
            }
            if (entry.endPos >= searchEnd) {
                endNode = entry.node;
                endOffset = searchEnd - entry.startPos;
                break;
            }
        }

        if (!startNode || !endNode) return null;

        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        return range;
    }

    /**
     * Highlight an existing comment by finding its text in the document
     */
    function highlightExistingComment(comment) {
        highlightCommentByText(comment);
    }

    /**
     * Trigger a page reload
     */
    function triggerReload() {
        if (window.crNav.editMode) return;
        window.location.reload();
    }

    /**
     * Setup Server-Sent Events for live updates
     */
    function setupSSE() {
        const params = new URLSearchParams({
            project_directory: projectDir,
            file_path: filePath,
        });

        const eventSource = new EventSource(`/api/events?${params}`);

        eventSource.addEventListener('file_updated', (event) => {
            console.log('File updated event received:', event.data);
            triggerReload();
        });

        eventSource.addEventListener('comments_resolved', (event) => {
            console.log('Comments resolved event received:', event.data);
            const data = JSON.parse(event.data);
            triggerReload();
        });

        eventSource.addEventListener('reload', (event) => {
            console.log('Reload event received:', event.data);
            triggerReload();
        });

        eventSource.onerror = (error) => {
            console.error('SSE error:', error);
            eventSource.close();

            // Attempt to reconnect after 5 seconds
            setTimeout(setupSSE, 5000);
        };
    }
})();
