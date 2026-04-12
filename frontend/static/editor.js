// Editor Mode - contenteditable rich editing with Turndown.js HTML-to-Markdown conversion
// Uses invisible anchors to track comment positions through edits.

(function () {
    'use strict';

    let mode = 'off'; // 'off', 'rich', 'raw'
    let isDirty = false;
    let originalMarkdown = '';

    const turndownService = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
    });

    // Strip .cr-anchor elements during conversion (safety net)
    turndownService.addRule('stripAnchors', {
        filter: function (node) {
            return node.classList && node.classList.contains('cr-anchor');
        },
        replacement: function () {
            return '';
        },
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initEditor);
    } else {
        initEditor();
    }

    function initEditor() {
        document.addEventListener('keydown', handleEditorKeys);

        const saveBtn = document.getElementById('editor-save-btn');
        const cancelBtn = document.getElementById('editor-cancel-btn');
        const rawToggle = document.getElementById('editor-raw-toggle');

        if (saveBtn) saveBtn.addEventListener('click', saveContent);
        if (cancelBtn) cancelBtn.addEventListener('click', () => exitEditMode(false));
        if (rawToggle) rawToggle.addEventListener('click', toggleRawRich);
    }

    function handleEditorKeys(e) {
        // Cmd+S / Ctrl+S to save (when in edit mode)
        if (mode !== 'off' && (e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            saveContent();
            return;
        }

        // Escape to exit edit mode
        if (mode !== 'off' && e.key === 'Escape') {
            e.preventDefault();
            exitEditMode(false);
            return;
        }

        // 'e' to enter edit mode (when not in input and not already editing)
        if (mode === 'off' && e.key === 'e') {
            if (window.crNavUtils && window.crNavUtils.isInputFocused()) return;
            if (window.crNav.editMode) return;

            e.preventDefault();
            enterEditMode();
        }
    }

    // --- Anchor Management ---

    /**
     * Insert invisible anchors around each .comment-highlight span.
     * Each highlight gets a start anchor before and end anchor after it,
     * then the highlight span is unwrapped (children moved out, span removed).
     * This preserves the text in-place while marking comment boundaries.
     */
    function insertCommentAnchors() {
        const content = document.getElementById('markdown-content');
        if (!content) return;

        const highlights = content.querySelectorAll('.comment-highlight');
        highlights.forEach(highlight => {
            const commentId = highlight.dataset.commentId;
            if (!commentId) return;

            // Create start anchor
            const startAnchor = document.createElement('span');
            startAnchor.className = 'cr-anchor';
            startAnchor.dataset.commentId = commentId;
            startAnchor.dataset.anchorType = 'start';

            // Create end anchor
            const endAnchor = document.createElement('span');
            endAnchor.className = 'cr-anchor';
            endAnchor.dataset.commentId = commentId;
            endAnchor.dataset.anchorType = 'end';

            // Insert start anchor before the highlight
            highlight.parentNode.insertBefore(startAnchor, highlight);

            // Insert end anchor after the highlight
            if (highlight.nextSibling) {
                highlight.parentNode.insertBefore(endAnchor, highlight.nextSibling);
            } else {
                highlight.parentNode.appendChild(endAnchor);
            }

            // Unwrap the highlight span (move children out, remove span)
            const parent = highlight.parentNode;
            while (highlight.firstChild) {
                parent.insertBefore(highlight.firstChild, highlight);
            }
            parent.removeChild(highlight);
        });
    }

    /**
     * Extract comment anchor positions from the DOM.
     * Returns an array of {comment_id, selected_text} for each anchor pair found.
     */
    function extractAnchorPositions() {
        const content = document.getElementById('markdown-content');
        if (!content) return [];

        const anchors = content.querySelectorAll('.cr-anchor');

        // Group by comment ID
        const anchorPairs = {};
        anchors.forEach(anchor => {
            const id = anchor.dataset.commentId;
            const type = anchor.dataset.anchorType;
            if (!id || !type) return;
            if (!anchorPairs[id]) anchorPairs[id] = {};
            anchorPairs[id][type] = anchor;
        });

        const updates = [];
        for (const [commentId, pairs] of Object.entries(anchorPairs)) {
            if (!pairs.start || !pairs.end) continue;

            // Create a range between start and end anchors
            const range = document.createRange();
            try {
                range.setStartAfter(pairs.start);
                range.setEndBefore(pairs.end);
            } catch (e) {
                continue;
            }

            const selectedText = range.toString().trim();
            if (selectedText) {
                updates.push({
                    comment_id: parseInt(commentId, 10),
                    selected_text: selectedText,
                });
            }
        }

        return updates;
    }

    /**
     * Remove all .cr-anchor elements from the DOM.
     */
    function removeAnchors() {
        const anchors = document.querySelectorAll('#markdown-content .cr-anchor');
        anchors.forEach(anchor => anchor.remove());
    }

    // --- Edit Mode Lifecycle ---

    async function enterEditMode() {
        const content = document.getElementById('markdown-content');
        const toolbar = document.getElementById('editor-toolbar');
        if (!content || !toolbar) return;

        // Capture nav cursor position before deactivating
        const nav = window.crNav;
        const savedCursor = nav.cursor ? { textNode: nav.cursor.textNode, wordStart: nav.cursor.wordStart } : null;

        // Set edit mode EARLY so keyboard/click handlers bail out immediately
        mode = 'rich';
        isDirty = false;
        nav.editMode = true;

        // Deactivate keyboard nav and show toolbar as loading indicator
        if (window.crNavUtils) window.crNavUtils.deactivate();
        toolbar.style.display = 'flex';

        // Fetch raw markdown
        try {
            const params = new URLSearchParams({
                project_directory: projectDir,
                file_path: filePath,
            });
            const resp = await fetch('/api/content?' + params);
            if (!resp.ok) throw new Error('Failed to fetch content');
            originalMarkdown = await resp.text();
        } catch (err) {
            console.error('Failed to enter edit mode:', err);
            mode = 'off';
            nav.editMode = false;
            toolbar.style.display = 'none';
            return;
        }

        // Insert invisible anchors around comment highlights
        insertCommentAnchors();

        // Enable contenteditable
        content.setAttribute('contenteditable', 'true');

        // Place caret at the nav cursor position (or start of content)
        placeCaret(content, savedCursor);

        // Track changes
        content.addEventListener('input', onContentInput);
    }

    function placeCaret(content, savedCursor) {
        const sel = window.getSelection();
        if (!sel) { content.focus(); return; }

        if (savedCursor && savedCursor.textNode && content.contains(savedCursor.textNode)) {
            try {
                const range = document.createRange();
                range.setStart(savedCursor.textNode, savedCursor.wordStart);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
                // Scroll the cursor into view
                savedCursor.textNode.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            } catch (e) {
                // Fall through to default
            }
        }

        content.focus();
    }

    function onContentInput() {
        isDirty = true;
    }

    function toggleRawRich() {
        if (mode === 'rich') {
            switchToRaw();
        } else if (mode === 'raw') {
            switchToRich();
        }
    }

    function switchToRaw() {
        const content = document.getElementById('markdown-content');
        const textarea = document.getElementById('editor-raw-textarea');
        const rawToggle = document.getElementById('editor-raw-toggle');
        if (!content || !textarea) return;

        // Convert current HTML to markdown if dirty, otherwise use original
        let md;
        if (isDirty) {
            // Remove anchors before conversion (they'll be re-inserted if user switches back)
            removeAnchors();
            md = turndownService.turndown(content.innerHTML);
        } else {
            md = originalMarkdown;
        }

        content.removeAttribute('contenteditable');
        content.removeEventListener('input', onContentInput);
        content.style.display = 'none';

        textarea.value = md;
        textarea.style.display = 'block';
        textarea.focus();
        textarea.addEventListener('input', onContentInput);

        if (rawToggle) rawToggle.textContent = 'Rich';
        mode = 'raw';
    }

    function switchToRich() {
        const content = document.getElementById('markdown-content');
        const textarea = document.getElementById('editor-raw-textarea');
        const rawToggle = document.getElementById('editor-raw-toggle');
        if (!content || !textarea) return;

        textarea.removeEventListener('input', onContentInput);
        textarea.style.display = 'none';

        content.style.display = '';
        content.setAttribute('contenteditable', 'true');
        content.focus();
        content.addEventListener('input', onContentInput);

        if (rawToggle) rawToggle.textContent = 'Raw';
        mode = 'rich';
    }

    async function saveContent() {
        let markdown;
        let anchorUpdates = [];

        if (mode === 'rich') {
            // Extract anchor positions before stripping
            anchorUpdates = extractAnchorPositions();

            // Remove anchors before Turndown conversion
            removeAnchors();

            const content = document.getElementById('markdown-content');
            if (!content) return;
            markdown = turndownService.turndown(content.innerHTML);
        } else if (mode === 'raw') {
            // In raw mode, no anchors — diff-based reanchoring handles this
            const textarea = document.getElementById('editor-raw-textarea');
            if (!textarea) return;
            markdown = textarea.value;
        } else {
            return;
        }

        try {
            const resp = await fetch('/api/content', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project_directory: projectDir,
                    file_path: filePath,
                    content: markdown,
                    anchor_updates: anchorUpdates.length > 0 ? anchorUpdates : undefined,
                }),
            });

            if (!resp.ok) throw new Error('Failed to save');

            isDirty = false;
            exitEditMode(true);
        } catch (err) {
            console.error('Failed to save content:', err);
            alert('Failed to save. Please try again.');
        }
    }

    async function exitEditMode(saved) {
        if (isDirty && !saved) {
            // Use the custom confirm dialog from viewer.js if available
            const confirmFn = window.showConfirmDialog || window.confirm;
            const confirmed = await confirmFn('Discard unsaved changes?');
            if (!confirmed) return;
        }

        mode = 'off';
        isDirty = false;
        window.crNav.editMode = false;

        // Always reload to restore clean DOM (contenteditable can damage
        // comment highlight spans and other DOM structures)
        window.location.reload();
    }
})();
