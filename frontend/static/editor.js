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

        document.querySelectorAll('.editor-format-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                formatBlock(btn.dataset.format);
            });
        });
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

        // Cmd+0..4 to format blocks in rich edit mode
        if (mode === 'rich' && (e.metaKey || e.ctrlKey)) {
            const formats = { '0': 'p', '1': 'h1', '2': 'h2', '3': 'h3', '4': 'h4' };
            if (formats[e.key]) {
                e.preventDefault();
                formatBlock(formats[e.key]);
                return;
            }
        }

        // 'e' to enter edit mode (when not in input and not already editing)
        if (mode === 'off' && e.key === 'e') {
            if (window.crNavUtils && window.crNavUtils.isInputFocused()) return;
            if (window.crNav.editMode) return;

            e.preventDefault();
            enterEditMode();
        }
    }

    function formatBlock(tag) {
        const content = document.getElementById('markdown-content');
        if (!content || mode !== 'rich') return;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;

        // Find the block element containing the selection
        let node = sel.anchorNode;
        if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;

        // Walk up to find the direct child of #markdown-content
        while (node && node.parentNode !== content) {
            node = node.parentNode;
        }
        if (!node || node.parentNode !== content) return;

        // Create the new element and transfer content
        const newEl = document.createElement(tag);
        while (node.firstChild) {
            newEl.appendChild(node.firstChild);
        }

        // Copy any data attributes (line tracking)
        Array.from(node.attributes).forEach(attr => {
            if (attr.name.startsWith('data-')) {
                newEl.setAttribute(attr.name, attr.value);
            }
        });

        content.replaceChild(newEl, node);

        // Restore caret inside the new element
        const range = document.createRange();
        range.selectNodeContents(newEl);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);

        isDirty = true;
        updateFormatButtonState();
    }

    function updateFormatButtonState() {
        const content = document.getElementById('markdown-content');
        const sel = window.getSelection();
        if (!content || !sel || sel.rangeCount === 0) {
            document.querySelectorAll('.editor-format-btn').forEach(b => b.classList.remove('active'));
            return;
        }

        let node = sel.anchorNode;
        if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
        while (node && node.parentNode !== content) {
            node = node.parentNode;
        }

        const currentTag = node ? node.tagName.toLowerCase() : '';
        document.querySelectorAll('.editor-format-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.format === currentTag);
        });
    }

    /** Find the first block child of `container` whose top edge is in or below the viewport. */
    function findVisualAnchor(container) {
        const blocks = container.querySelectorAll(':scope > *');
        for (const el of blocks) {
            if (el.getBoundingClientRect().top >= 0) return el;
        }
        // Fallback: last block (user scrolled past everything)
        return blocks.length ? blocks[blocks.length - 1] : null;
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

    /**
     * Strip viewer.js-added elements from the DOM before Turndown conversion.
     * Margin indicator <div>s inside <p> tags cause the HTML parser to split
     * the paragraph, producing unwanted newlines in the saved markdown.
     */
    function cleanDomForConversion(content) {
        // Remove margin indicator divs (appended inside block elements)
        content.querySelectorAll('.comment-margin-indicator').forEach(el => el.remove());

        // Unwrap any lingering .comment-highlight spans (safety net — they
        // should already have been replaced by anchors on edit-mode entry)
        content.querySelectorAll('.comment-highlight').forEach(span => {
            const parent = span.parentNode;
            while (span.firstChild) {
                parent.insertBefore(span.firstChild, span);
            }
            parent.removeChild(span);
        });

        // Remove inline styles added by addCommentMarginIndicators()
        content.querySelectorAll('[style]').forEach(el => {
            el.removeAttribute('style');
        });

        // Merge adjacent text nodes left behind by element removal
        content.normalize();
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

        // Deactivate keyboard nav
        if (window.crNavUtils) window.crNavUtils.deactivate();

        // Find a visual anchor: the first block element whose top is in or
        // below the viewport.  We record its viewport-relative position now
        // and restore it after all DOM changes (toolbar, anchors, contenteditable)
        // to prevent any perceived scroll jump.
        const anchorEl = findVisualAnchor(content);
        const anchorTop = anchorEl ? anchorEl.getBoundingClientRect().top : null;
        const scrollY = window.scrollY;

        // Show toolbar
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
            window.scrollTo(0, scrollY);
            return;
        }

        // Insert invisible anchors around comment highlights
        insertCommentAnchors();

        // Enable contenteditable (box-shadow only, no layout shift)
        content.setAttribute('contenteditable', 'true');

        // Place caret at the nav cursor position (or start of content)
        placeCaret(content, savedCursor);

        // Restore scroll so the visual anchor element stays at the same
        // viewport position it occupied before we showed the toolbar.
        if (anchorEl && anchorTop !== null) {
            const newTop = anchorEl.getBoundingClientRect().top;
            const drift = newTop - anchorTop;
            if (Math.abs(drift) > 1) {
                window.scrollTo(0, window.scrollY + drift);
            }
        }

        // Track changes and format button state
        content.addEventListener('input', onContentInput);
        document.addEventListener('selectionchange', onSelectionChange);
    }

    function onSelectionChange() {
        if (mode === 'rich') updateFormatButtonState();
    }

    function placeCaret(content, savedCursor) {
        const sel = window.getSelection();
        if (!sel) { content.focus({ preventScroll: true }); return; }

        if (savedCursor && savedCursor.textNode && content.contains(savedCursor.textNode)) {
            try {
                const range = document.createRange();
                range.setStart(savedCursor.textNode, savedCursor.wordStart);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
                return;
            } catch (e) {
                // Fall through to default
            }
        }

        content.focus({ preventScroll: true });
    }

    function onContentInput() {
        isDirty = true;
        if (mode === 'rich') handleMarkdownShortcuts();
    }

    /** Detect `# `, `## `, `### ` typed at the start of a block and convert to heading. */
    function handleMarkdownShortcuts() {
        const content = document.getElementById('markdown-content');
        const sel = window.getSelection();
        if (!content || !sel || sel.rangeCount === 0) return;

        let node = sel.anchorNode;
        if (!node) return;
        const textNode = node.nodeType === Node.TEXT_NODE ? node : null;
        if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;

        // Walk up to direct child of #markdown-content
        while (node && node.parentNode !== content) {
            node = node.parentNode;
        }
        if (!node || node.parentNode !== content) return;

        // Only trigger on paragraph-like elements, not if already a heading
        const tag = node.tagName.toLowerCase();
        if (tag.match(/^h[1-6]$/)) return;

        // Get text content of the block and check for heading prefix
        const text = node.textContent;
        const match = text.match(/^(#{1,3}) /);
        if (!match) return;

        const level = match[1].length; // 1, 2, or 3
        const headingTag = 'h' + level;
        const prefix = match[0]; // e.g. "## "

        // Remove the prefix from the DOM text
        // Walk text nodes to find and strip the prefix
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let remaining = prefix.length;
        const nodesToTrim = [];
        while (remaining > 0) {
            const tn = walker.nextNode();
            if (!tn) break;
            const take = Math.min(tn.length, remaining);
            nodesToTrim.push({ node: tn, chars: take });
            remaining -= take;
        }
        nodesToTrim.forEach(({ node: tn, chars }) => {
            tn.deleteData(0, chars);
        });

        // Convert the block to a heading
        const newEl = document.createElement(headingTag);
        while (node.firstChild) {
            newEl.appendChild(node.firstChild);
        }
        Array.from(node.attributes).forEach(attr => {
            if (attr.name.startsWith('data-')) {
                newEl.setAttribute(attr.name, attr.value);
            }
        });
        content.replaceChild(newEl, node);

        // Place caret at the start of the new heading
        const range = document.createRange();
        if (newEl.firstChild) {
            range.setStart(newEl.firstChild, 0);
        } else {
            range.selectNodeContents(newEl);
        }
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);

        updateFormatButtonState();
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
            // Remove anchors and viewer.js artifacts before conversion
            removeAnchors();
            cleanDomForConversion(content);
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

            // Clean up DOM elements added by viewer.js that would
            // corrupt the Turndown conversion (e.g. <div> inside <p>
            // causes the HTML parser to split the paragraph).
            cleanDomForConversion(content);

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
        document.removeEventListener('selectionchange', onSelectionChange);

        // Always reload to restore clean DOM (contenteditable can damage
        // comment highlight spans and other DOM structures)
        window.location.reload();
    }
})();
