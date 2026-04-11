// Editor Mode - contenteditable rich editing with Turndown.js HTML-to-Markdown conversion

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

    async function enterEditMode() {
        const content = document.getElementById('markdown-content');
        const toolbar = document.getElementById('editor-toolbar');
        if (!content || !toolbar) return;

        // Capture nav cursor position before deactivating
        const nav = window.crNav;
        const savedCursor = nav.cursor ? { textNode: nav.cursor.textNode, wordStart: nav.cursor.wordStart } : null;

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
            return;
        }

        mode = 'rich';
        isDirty = false;
        nav.editMode = true;

        // Deactivate keyboard nav
        if (window.crNavUtils) window.crNavUtils.deactivate();

        // Enable contenteditable
        content.setAttribute('contenteditable', 'true');

        // Place caret at the nav cursor position (or start of content)
        placeCaret(content, savedCursor);

        // Show toolbar
        toolbar.style.display = 'flex';

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

        if (mode === 'rich') {
            const content = document.getElementById('markdown-content');
            if (!content) return;
            markdown = turndownService.turndown(content.innerHTML);
        } else if (mode === 'raw') {
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
