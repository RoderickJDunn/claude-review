// Annotation mode — extends the viewer with quick-reaction verbs, multi-select
// staging, and a "Send to agent" commit that hits the daemon's scratch
// endpoint. Active only when window.crScratch is set by the viewer template.

(function () {
    'use strict';

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Staged extra selections (beyond the cursor's current one). Each entry:
    // { text, lineStart, lineEnd, range }.
    const stagedRanges = [];

    function inScratchMode() {
        return !!(window.crScratch && window.crScratch.id);
    }

    function init() {
        if (!inScratchMode()) return;

        wireSendButton();
        renameCommentPanel();
        buildStagedPanel();
        document.addEventListener('keydown', handleAnnotateKey, true);

        // Mirror the keyboard-comments Tab/Esc convention: clear staging on Esc
        // when not in pane/edit mode and no popup is open.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const popup = document.getElementById('comment-popup');
            if (popup && popup.style.display === 'block') return;
            if (stagedRanges.length > 0) {
                clearStaging();
                e.preventDefault();
            }
        });
    }

    function renameCommentPanel() {
        const header = document.querySelector('#comment-panel .comment-panel-header-left h3');
        if (header) header.textContent = 'Annotations';
    }

    function wireSendButton() {
        const btn = document.getElementById('scratch-send-btn');
        if (!btn) return;
        btn.addEventListener('click', commitAndClose);
    }

    function handleAnnotateKey(e) {
        if (!inScratchMode()) return;

        // ⌘↩ / Ctrl↩ commits regardless of focus context.
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            const popup = document.getElementById('comment-popup');
            if (popup && popup.style.display === 'block') return; // let popup handle it
            e.preventDefault();
            e.stopPropagation();
            // Defer one tick so any pending click handler on the focused
            // element doesn't race with our commit POST.
            setTimeout(commitAndClose, 0);
            return;
        }

        // Skip if a textarea/input is focused — those keys belong to the input.
        if (window.crNavUtils && window.crNavUtils.isInputFocused()) return;
        if (window.crNav && window.crNav.editMode) return;

        // Quick-react verbs only when something is selected via keyboard nav.
        const nav = window.crNav;
        if (!nav || !nav.active) return;

        if (e.metaKey || e.ctrlKey || e.altKey) return;

        switch (e.key) {
            case 'a':
                e.preventDefault();
                quickReact('agree');
                break;
            case 'x':
                e.preventDefault();
                quickReact('reject');
                break;
            case '?':
                e.preventDefault();
                openVerbComment('question');
                break;
            // 'c' is already handled by keyboard-comments.js for free comments;
            // we don't override it — letting it fall through preserves that path.
            case 'm':
                e.preventDefault();
                stageCurrentSelection();
                break;
        }
    }

    // currentSelectionRange returns the active keyboard-nav selection, falling
    // back to a single-word range at the cursor if nothing else is staged.
    function currentSelectionRange() {
        const nav = window.crNav;
        if (!nav) return null;

        if (nav.selection && nav.selection.range) {
            return {
                text: nav.selection.text,
                lineStart: nav.selection.lineStart,
                lineEnd: nav.selection.lineEnd,
                range: nav.selection.range.cloneRange(),
            };
        }

        if (!nav.cursor) return null;
        try {
            const r = document.createRange();
            r.setStart(nav.cursor.textNode, nav.cursor.wordStart);
            r.setEnd(nav.cursor.textNode, nav.cursor.wordEnd);
            const lines = window.crViewer.extractLineNumbersFromRange(r);
            return {
                text: r.toString(),
                lineStart: lines.lineStart,
                lineEnd: lines.lineEnd,
                range: r,
            };
        } catch (err) {
            return null;
        }
    }

    function stageCurrentSelection() {
        const sel = currentSelectionRange();
        if (!sel) return;
        // Wrap the range in a persistent marker so the user can see what's
        // staged. surroundContents() throws if the range crosses block
        // boundaries; in that case we fall back to wrapping each
        // contained text node individually.
        sel.markers = markStagedRange(sel.range);
        stagedRanges.push(sel);
        // Reset selection scope so the user can navigate to the next one.
        const nav = window.crNav;
        if (nav) {
            nav.selection.level = 0;
            nav.selection.range = null;
            nav.selection.text = '';
            nav.selection.lineStart = null;
            nav.selection.lineEnd = null;
        }
        if (window.crSelection && window.crSelection.clearSelectionHighlight) {
            window.crSelection.clearSelectionHighlight();
        }
        renderStagedPanel();
        announce(`Staged ${stagedRanges.length}. Press 'a' / 'x' / '?' / 'c' to apply, 'm' to add more.`);
    }

    function clearStaging() {
        for (const r of stagedRanges) {
            unmarkStaged(r);
        }
        stagedRanges.length = 0;
        renderStagedPanel();
        announce('Staged selections cleared.');
    }

    function removeStagedAt(index) {
        const r = stagedRanges[index];
        if (!r) return;
        unmarkStaged(r);
        stagedRanges.splice(index, 1);
        renderStagedPanel();
    }

    // markStagedRange wraps the range's content in <span class="staged-range">
    // so the user can see it persistently. Returns the wrapper element(s).
    function markStagedRange(range) {
        try {
            const wrapper = document.createElement('span');
            wrapper.className = 'staged-range';
            range.surroundContents(wrapper);
            return [wrapper];
        } catch (e) {
            // Range crosses element boundaries — wrap each text node it
            // partially or fully covers, instead.
            return wrapTextNodesInRange(range);
        }
    }

    function wrapTextNodesInRange(range) {
        const wrappers = [];
        const root = range.commonAncestorContainer;
        const walker = document.createTreeWalker(
            root.nodeType === Node.ELEMENT_NODE ? root : root.parentNode,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    return range.intersectsNode(node)
                        ? NodeFilter.FILTER_ACCEPT
                        : NodeFilter.FILTER_REJECT;
                },
            }
        );
        const nodes = [];
        let n = walker.nextNode();
        while (n) { nodes.push(n); n = walker.nextNode(); }
        for (const textNode of nodes) {
            const wrapper = document.createElement('span');
            wrapper.className = 'staged-range';
            // Only the portion of this text node inside the range is staged;
            // split off the leading/trailing bits if necessary.
            let target = textNode;
            const nodeRange = document.createRange();
            nodeRange.selectNodeContents(textNode);
            let start = 0;
            let end = textNode.nodeValue.length;
            if (range.startContainer === textNode) start = range.startOffset;
            if (range.endContainer === textNode) end = range.endOffset;
            if (end < textNode.nodeValue.length) {
                target.splitText(end);
            }
            if (start > 0) {
                target = target.splitText(start);
            }
            const parent = target.parentNode;
            parent.insertBefore(wrapper, target);
            wrapper.appendChild(target);
            wrappers.push(wrapper);
        }
        return wrappers;
    }

    function unmarkStaged(stagedEntry) {
        if (!stagedEntry.markers) return;
        for (const wrapper of stagedEntry.markers) {
            if (!wrapper || !wrapper.parentNode) continue;
            const parent = wrapper.parentNode;
            while (wrapper.firstChild) {
                parent.insertBefore(wrapper.firstChild, wrapper);
            }
            parent.removeChild(wrapper);
            parent.normalize(); // merge adjacent text nodes we split apart
        }
        stagedEntry.markers = null;
    }

    // Persistent staged-pill panel — always present but hidden when empty.
    let stagedPanel = null;
    function buildStagedPanel() {
        stagedPanel = document.createElement('div');
        stagedPanel.id = 'annotate-staged-panel';
        stagedPanel.style.display = 'none';
        stagedPanel.innerHTML = `
            <div class="staged-panel-header">
                <span class="staged-panel-title">Staged</span>
                <span class="staged-panel-count">0</span>
                <button class="staged-panel-clear" type="button" title="Clear all (Esc)">Clear</button>
            </div>
            <div class="staged-panel-list"></div>
            <div class="staged-panel-hint">Press a / x / ? / c to apply to all staged</div>
        `;
        document.body.appendChild(stagedPanel);
        stagedPanel.querySelector('.staged-panel-clear').addEventListener('click', clearStaging);
    }

    function renderStagedPanel() {
        if (!stagedPanel) return;
        if (stagedRanges.length === 0) {
            stagedPanel.style.display = 'none';
            return;
        }
        stagedPanel.style.display = 'block';
        stagedPanel.querySelector('.staged-panel-count').textContent = stagedRanges.length;
        const list = stagedPanel.querySelector('.staged-panel-list');
        list.innerHTML = '';
        stagedRanges.forEach((r, i) => {
            const chip = document.createElement('div');
            chip.className = 'staged-chip';
            const text = (r.text || '').replace(/\s+/g, ' ').trim();
            const truncated = text.length > 60 ? text.slice(0, 57) + '…' : text;
            const label = document.createElement('span');
            label.className = 'staged-chip-text';
            label.textContent = truncated;
            label.title = text;
            const remove = document.createElement('button');
            remove.className = 'staged-chip-remove';
            remove.type = 'button';
            remove.textContent = '×';
            remove.title = 'Remove from staging';
            remove.addEventListener('click', () => removeStagedAt(i));
            chip.appendChild(label);
            chip.appendChild(remove);
            list.appendChild(chip);
        });
    }

    function buildPayload(verb, body) {
        // Staging precedence: if the user staged anything with `m`, those are
        // the selections — the cursor word is NOT silently added as an extra.
        // Without staging, fall back to the current keyboard-nav selection or
        // cursor word.
        let root;
        let extras;
        if (stagedRanges.length > 0) {
            const staged = stagedRanges.slice();
            root = staged.shift();
            extras = staged;
        } else {
            root = currentSelectionRange();
            extras = [];
        }
        if (!root) return null;

        const payload = {
            project_directory: projectDir,
            file_path: filePath,
            line_start: root.lineStart,
            line_end: root.lineEnd,
            selected_text: root.text,
            comment_text: body || '',
            verb: verb,
        };
        if (extras.length > 0) {
            payload.extra_ranges = JSON.stringify(extras.map(e => ({
                line_start: e.lineStart,
                line_end: e.lineEnd,
                selected_text: e.text,
            })));
        }
        return payload;
    }

    async function quickReact(verb) {
        const payload = buildPayload(verb, '');
        if (!payload) return;
        try {
            const resp = await fetch('/api/comments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const saved = await resp.json();
            comments = comments || [];
            comments.push(saved);
            // Unmark and clear any staged ranges that were just consumed.
            for (const r of stagedRanges) unmarkStaged(r);
            stagedRanges.length = 0;
            renderStagedPanel();
            // Reset selection scope post-action.
            const nav = window.crNav;
            if (nav) {
                nav.selection.level = 0;
                nav.selection.range = null;
                nav.selection.text = '';
                nav.selection.lineStart = null;
                nav.selection.lineEnd = null;
            }
            if (window.crSelection && window.crSelection.clearSelectionHighlight) {
                window.crSelection.clearSelectionHighlight();
            }
            if (window.crViewer) {
                window.crViewer.updateCommentPanel();
            }
            announce(verb === 'agree' ? 'Agreed ✓' : 'Rejected ✗');
        } catch (err) {
            console.error('Quick-react failed:', err);
            alert('Failed to apply quick reaction. See console.');
        }
    }

    function openVerbComment(verb) {
        // Staging precedence matches buildPayload: if anything is staged,
        // use it as the basis; otherwise fall back to the cursor selection.
        let root;
        let extras;
        if (stagedRanges.length > 0) {
            const staged = stagedRanges.slice();
            root = staged.shift();
            extras = staged;
        } else {
            root = currentSelectionRange();
            extras = [];
        }
        if (!root) return;

        const viewer = window.crViewer;
        if (!viewer) return;

        viewer.setCurrentSelection(root);
        installVerbPatch(verb, extras);
        // Drop staging markers — the verb is now committed via the popup path.
        for (const r of stagedRanges) unmarkStaged(r);
        stagedRanges.length = 0;
        renderStagedPanel();

        // Position the popup near the root selection.
        const range = root.range;
        const rect = range && range.getBoundingClientRect ? range.getBoundingClientRect() : null;
        if (rect) {
            viewer.showCommentPopup(rect.right, rect.bottom);
        } else {
            viewer.showCommentPopup(window.innerWidth / 2, window.innerHeight / 3);
        }

        const nav = window.crNav;
        if (nav) {
            nav.active = false;
            if (window.crNavUtils && window.crNavUtils.hideCursor) {
                window.crNavUtils.hideCursor();
            }
        }
    }

    // installVerbPatch wraps fetch one time so the next POST to /api/comments
    // gets verb + extra_ranges injected into its JSON body. This avoids
    // editing viewer.js's handleAddComment for what is essentially a single
    // metadata addition.
    function installVerbPatch(verb, extras) {
        const origFetch = window.fetch;
        window.fetch = function (input, init) {
            let url = '';
            try {
                url = (typeof input === 'string') ? input : input.url;
            } catch (e) {}
            if (url && url.endsWith('/api/comments') && init && init.method === 'POST' && init.body) {
                try {
                    const body = JSON.parse(init.body);
                    if (!body.verb) body.verb = verb;
                    if (extras.length > 0 && !body.extra_ranges) {
                        body.extra_ranges = JSON.stringify(extras.map(e => ({
                            line_start: e.lineStart,
                            line_end: e.lineEnd,
                            selected_text: e.text,
                        })));
                    }
                    init.body = JSON.stringify(body);
                } catch (e) {
                    // Body wasn't JSON; leave alone.
                }
                window.fetch = origFetch; // single-shot
            }
            return origFetch.apply(this, arguments);
        };
        // Safety: revert after 30s if no comment was submitted.
        setTimeout(() => {
            if (window.fetch !== origFetch) window.fetch = origFetch;
        }, 30000);
    }

    async function commitAndClose() {
        const scratchId = window.crScratch && window.crScratch.id;
        if (!scratchId) return;

        try {
            const resp = await fetch(`/api/scratch/${scratchId}/commit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            showCommittedPanel(data.rendered || '');
        } catch (err) {
            console.error('Failed to commit annotation:', err);
            alert('Failed to commit annotation. See console.');
        }
    }

    function showCommittedPanel(rendered) {
        // Replace the article body with a confirmation pane so the user knows
        // the agent received their reply. The CLI on the other end will have
        // already received the same text.
        const article = document.querySelector('article');
        if (article) {
            article.innerHTML = '';
            const panel = document.createElement('div');
            panel.className = 'scratch-committed';
            panel.innerHTML = `
                <h2>Sent to agent ✓</h2>
                <p>The rendered annotation below was delivered. You can close this tab.</p>
                <pre style="white-space: pre-wrap; background: #f6f8fa; padding: 1em; border-radius: 6px;"></pre>
            `;
            panel.querySelector('pre').textContent = rendered;
            article.appendChild(panel);
        }
        const sendBtn = document.getElementById('scratch-send-btn');
        if (sendBtn) sendBtn.disabled = true;
    }

    function announce(msg) {
        // Lightweight toast — reuse if one already exists.
        let toast = document.getElementById('annotate-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'annotate-toast';
            toast.style.position = 'fixed';
            toast.style.bottom = '20px';
            toast.style.left = '50%';
            toast.style.transform = 'translateX(-50%)';
            toast.style.background = 'rgba(0, 0, 0, 0.85)';
            toast.style.color = '#fff';
            toast.style.padding = '8px 16px';
            toast.style.borderRadius = '6px';
            toast.style.zIndex = '10000';
            toast.style.fontSize = '13px';
            toast.style.transition = 'opacity 0.4s ease-out';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.style.opacity = '1';
        clearTimeout(toast._hideTimer);
        toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, 1800);
    }
})();
