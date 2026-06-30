// Keyboard help overlay — surfaces every shortcut in the viewer/scratch UI.
// Press `h` (or click the ? button) to toggle. `Esc` closes. Scratch-only
// shortcuts only render when window.crScratch is set.

(function () {
    'use strict';

    const SECTIONS = [
        {
            title: 'Navigation',
            keys: [
                ['↑ / ↓', 'Move cursor to previous / next block'],
                ['← / →', 'Move cursor word by word'],
                ['Tab', 'Toggle focus between document and annotations pane'],
                ['Esc (in pane)', 'Exit annotations pane back to document'],
            ],
        },
        {
            title: 'Selection',
            keys: [
                [']', 'Expand selection: word → clause → sentence → paragraph → block'],
                ['[', 'Shrink selection back down a level'],
            ],
        },
        {
            title: 'Commenting',
            keys: [
                ['c', 'Comment on current selection (or cursor word)'],
                ['s', 'Expand to sentence, then comment'],
            ],
        },
        {
            title: 'Annotate (scratch mode)',
            scratchOnly: true,
            keys: [
                ['a', 'Agree — reacts ✓ with no popup'],
                ['x', 'Reject (Skip) — reacts ✗ with no popup'],
                ['?', 'Question — opens popup with verb pre-set'],
                ['m', 'Stage current selection for multi-select'],
                ['⌘↩ / Ctrl↩', 'Send all annotations to the agent'],
                ['Esc', 'Clear staged selections'],
            ],
        },
        {
            title: 'Editor (when editing)',
            keys: [
                ['e', 'Enter edit mode (from document)'],
                ['⌘S / Ctrl S', 'Save changes'],
                ['Esc', 'Cancel and exit edit mode'],
                ['⌘0 / Ctrl 0', 'Format as paragraph'],
                ['⌘1 – ⌘4', 'Format as heading H1 – H4'],
            ],
        },
        {
            title: 'Help',
            keys: [
                ['h', 'Toggle this help panel'],
                ['Esc', 'Close this help panel'],
            ],
        },
    ];

    let overlay = null;
    let button = null;
    let visible = false;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        buildButton();
        buildOverlay();
        document.addEventListener('keydown', handleKey, true);
    }

    function isScratch() {
        return !!(window.crScratch && window.crScratch.id);
    }

    function buildButton() {
        button = document.createElement('button');
        button.id = 'keyboard-help-btn';
        button.type = 'button';
        button.title = 'Keyboard shortcuts (h)';
        button.textContent = '?';
        button.addEventListener('click', toggle);
        document.body.appendChild(button);
    }

    function buildOverlay() {
        overlay = document.createElement('div');
        overlay.id = 'keyboard-help-overlay';
        overlay.style.display = 'none';
        overlay.innerHTML = `
            <div class="keyboard-help-panel" role="dialog" aria-label="Keyboard shortcuts">
                <div class="keyboard-help-header">
                    <h2>Keyboard shortcuts</h2>
                    <button type="button" class="keyboard-help-close" aria-label="Close">×</button>
                </div>
                <div class="keyboard-help-body"></div>
                <div class="keyboard-help-footer">Press <kbd>h</kbd> or <kbd>Esc</kbd> to close</div>
            </div>
        `;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) hide();
        });
        overlay.querySelector('.keyboard-help-close').addEventListener('click', hide);
        document.body.appendChild(overlay);
    }

    function renderBody() {
        const body = overlay.querySelector('.keyboard-help-body');
        body.innerHTML = '';
        for (const section of SECTIONS) {
            if (section.scratchOnly && !isScratch()) continue;
            const sec = document.createElement('section');
            sec.className = 'keyboard-help-section';
            const h3 = document.createElement('h3');
            h3.textContent = section.title;
            sec.appendChild(h3);
            const dl = document.createElement('dl');
            for (const [key, desc] of section.keys) {
                const dt = document.createElement('dt');
                // Split a key spec like "⌘1 / Ctrl 1" into separate <kbd> spans
                for (const variant of key.split(' / ')) {
                    if (dt.children.length > 0) {
                        const sep = document.createElement('span');
                        sep.className = 'kbd-sep';
                        sep.textContent = '/';
                        dt.appendChild(sep);
                    }
                    const kbd = document.createElement('kbd');
                    kbd.textContent = variant;
                    dt.appendChild(kbd);
                }
                const dd = document.createElement('dd');
                dd.textContent = desc;
                dl.appendChild(dt);
                dl.appendChild(dd);
            }
            sec.appendChild(dl);
            body.appendChild(sec);
        }
    }

    function handleKey(e) {
        // Esc closes when visible — handle before any other key checks so
        // that nothing else swallows it.
        if (visible && e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            hide();
            return;
        }

        // Don't trigger 'h' while typing in an input/textarea or while
        // a popup/edit mode is consuming keys.
        if (window.crNavUtils && window.crNavUtils.isInputFocused()) return;
        if (window.crNav && window.crNav.editMode) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        if (e.key === 'h') {
            e.preventDefault();
            toggle();
        }
    }

    function toggle() {
        if (visible) hide(); else show();
    }

    function show() {
        renderBody();
        overlay.style.display = 'flex';
        visible = true;
    }

    function hide() {
        overlay.style.display = 'none';
        visible = false;
    }
})();
