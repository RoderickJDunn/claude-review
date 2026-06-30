// Keyboard Navigation - Block index, cursor state, arrow key movement, word boundary scanning

(function () {
    'use strict';

    const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, li, pre, td, blockquote';
    const WORD_BOUNDARY = /[\s.,;:!?()[\]{}"'`\-\u2014]/;

    let cursorOverlay = null;
    let blockHighlight = null;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initKeyboardNav);
    } else {
        initKeyboardNav();
    }

    function initKeyboardNav() {
        createCursorOverlay();
        buildBlockIndex();
        setupKeyboardListeners();
        setupClickToJump();
        setupDeactivation();

        window.addEventListener('resize', refreshBlockRects);
    }

    function createCursorOverlay() {
        cursorOverlay = document.createElement('div');
        cursorOverlay.id = 'word-cursor';
        cursorOverlay.style.display = 'none';
        document.body.appendChild(cursorOverlay);

        blockHighlight = document.createElement('div');
        blockHighlight.id = 'block-highlight';
        blockHighlight.style.display = 'none';
        document.body.appendChild(blockHighlight);
    }

    function buildBlockIndex() {
        const content = document.getElementById('markdown-content');
        if (!content) return;

        const nav = window.crNav;
        nav.blocks = [];

        const elements = content.querySelectorAll(BLOCK_SELECTORS);
        elements.forEach((el) => {
            // Skip blockquote children that are already indexed as p/li
            if (el.tagName === 'BLOCKQUOTE') {
                const hasIndexedChildren = el.querySelector('p, li');
                if (hasIndexedChildren) return;
            }

            // Skip elements nested inside already-indexed blockquotes
            if (el.parentElement && el.parentElement.closest('blockquote') &&
                el.tagName !== 'BLOCKQUOTE') {
                // Allow p/li inside blockquote but skip the blockquote itself
            }

            const lineStart = parseInt(el.getAttribute('data-line-start'), 10) || 0;
            const lineEnd = parseInt(el.getAttribute('data-line-end'), 10) || 0;
            const heading = el.tagName.match(/^H([1-6])$/);

            nav.blocks.push({
                element: el,
                lineStart,
                lineEnd,
                rect: el.getBoundingClientRect(),
                headingLevel: heading ? parseInt(heading[1], 10) : null,
            });
        });
    }

    function refreshBlockRects() {
        const nav = window.crNav;
        nav.blocks.forEach((block) => {
            block.rect = block.element.getBoundingClientRect();
        });
        if (nav.active && nav.cursor) {
            updateCursorVisual();
        }
    }

    function setupKeyboardListeners() {
        document.addEventListener('keydown', (e) => {
            // Don't capture when in editor mode - let browser handle natively
            if (window.crNav.editMode) return;

            // Don't capture when typing in an input
            if (isInputFocused()) return;

            // Don't capture arrow keys when comment pane has focus
            if (window.crNav.paneFocus && e.key !== 'Escape') return;

            switch (e.key) {
                case 'Escape':
                    e.preventDefault();
                    dismissHighlights();
                    return;
                case 'ArrowLeft':
                    e.preventDefault();
                    activateIfNeeded();
                    if (e.metaKey && e.shiftKey) {
                        extendWordSelection(-1);
                    } else {
                        dismissHighlights();
                        if (e.altKey) {
                            moveCursorSentence(-1);
                        } else {
                            moveCursorLeft();
                        }
                    }
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    activateIfNeeded();
                    if (e.metaKey && e.shiftKey) {
                        extendWordSelection(1);
                    } else {
                        dismissHighlights();
                        if (e.altKey) {
                            moveCursorSentence(1);
                        } else {
                            moveCursorRight();
                        }
                    }
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    dismissHighlights();
                    activateIfNeeded();
                    if (e.shiftKey) {
                        moveCursorBlock(-1);
                    } else {
                        moveCursorUp();
                    }
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    dismissHighlights();
                    activateIfNeeded();
                    if (e.shiftKey) {
                        moveCursorBlock(1);
                    } else {
                        moveCursorDown();
                    }
                    break;
                case 'PageUp':
                    e.preventDefault();
                    dismissHighlights();
                    activateIfNeeded();
                    moveCursorPage(-1);
                    break;
                case 'PageDown':
                    e.preventDefault();
                    dismissHighlights();
                    activateIfNeeded();
                    moveCursorPage(1);
                    break;
                default:
                    return;
            }
        });
    }

    function setupClickToJump() {
        const content = document.getElementById('markdown-content');
        if (!content) return;

        content.addEventListener('click', (e) => {
            // Don't interfere during editor mode - let browser handle clicks natively
            if (window.crNav.editMode) return;

            // Don't interfere with comment highlights or popups
            if (e.target.closest('.comment-highlight')) return;
            if (e.target.closest('#comment-popup')) return;

            // Find the nearest word to the click position
            const clickX = e.clientX;
            const clickY = e.clientY;

            const nav = window.crNav;

            // Find the block containing the click (containment first,
            // then nearest-center as fallback for clicks in margins)
            let bestBlockIdx = -1;
            for (let i = 0; i < nav.blocks.length; i++) {
                const rect = nav.blocks[i].element.getBoundingClientRect();
                if (clickY >= rect.top && clickY <= rect.bottom) {
                    bestBlockIdx = i;
                    break;
                }
            }
            if (bestBlockIdx === -1) {
                bestBlockIdx = 0;
                let bestBlockDist = Infinity;
                for (let i = 0; i < nav.blocks.length; i++) {
                    const rect = nav.blocks[i].element.getBoundingClientRect();
                    const blockCenterY = rect.top + rect.height / 2;
                    const dist = Math.abs(blockCenterY - clickY);
                    if (dist < bestBlockDist) {
                        bestBlockDist = dist;
                        bestBlockIdx = i;
                    }
                }
            }

            nav.currentBlockIndex = bestBlockIdx;
            const block = nav.blocks[bestBlockIdx];
            const words = getWordsInBlock(block);

            if (words.length === 0) return;

            // Find the word closest to the click position.
            // Two-pass: find the visual line closest to clickY, then
            // pick the closest word on that line by X distance only.
            // This prevents words on adjacent lines from stealing clicks.
            const wordRects = words.map(word => {
                const range = document.createRange();
                range.setStart(word.textNode, word.wordStart);
                range.setEnd(word.textNode, word.wordEnd);
                return range.getBoundingClientRect();
            });

            // Pass 1: find the line Y closest to click
            let closestLineY = 0;
            let closestLineDist = Infinity;
            for (let i = 0; i < words.length; i++) {
                const centerY = wordRects[i].top + wordRects[i].height / 2;
                const dist = Math.abs(centerY - clickY);
                if (dist < closestLineDist) {
                    closestLineDist = dist;
                    closestLineY = centerY;
                }
            }

            // Pass 2: among words on that line, find closest by X
            const LINE_TOLERANCE = 4;
            let bestWord = words[0];
            let bestXDist = Infinity;
            for (let i = 0; i < words.length; i++) {
                const centerY = wordRects[i].top + wordRects[i].height / 2;
                if (Math.abs(centerY - closestLineY) <= LINE_TOLERANCE) {
                    const xDist = Math.abs((wordRects[i].left + wordRects[i].width / 2) - clickX);
                    if (xDist < bestXDist) {
                        bestXDist = xDist;
                        bestWord = words[i];
                    }
                }
            }

            nav.cursor = bestWord;
            nav.targetX = null;
            nav.active = true;

            // Reset selection
            if (nav.selection.level > 0) {
                nav.selection.level = 0;
                nav.selection.range = null;
                nav.selection.text = '';
                if (window.crSelection) window.crSelection.clearSelectionHighlight();
            }

            updateCursorVisual();
            syncCommentPanel();

            // Prevent default text selection behavior
            e.preventDefault();
        });
    }

    function setupDeactivation() {
        // Deactivate on clicks outside markdown content
        document.addEventListener('mousedown', (e) => {
            const nav = window.crNav;
            if (nav.editMode) return;
            if (!nav.active) return;

            // Don't deactivate if clicking in markdown content (handled by click-to-jump),
            // comment panel, or popup
            const content = document.getElementById('markdown-content');
            if (content && content.contains(e.target)) return;
            if (e.target.closest('#comment-panel') || e.target.closest('#comment-popup')) return;

            deactivate();
        });
    }

    function isInputFocused() {
        const active = document.activeElement;
        if (!active) return false;
        const tag = active.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable;
    }

    function activateIfNeeded() {
        const nav = window.crNav;
        if (!nav.active) {
            nav.active = true;
            if (!nav.cursor && nav.blocks.length > 0) {
                nav.currentBlockIndex = 0;
                moveCursorToFirstWord(nav.blocks[0]);
            }
            updateCursorVisual();
        }
    }

    function deactivate() {
        const nav = window.crNav;
        nav.active = false;
        hideCursor();
    }

    function hideCursor() {
        if (cursorOverlay) cursorOverlay.style.display = 'none';
        if (blockHighlight) blockHighlight.style.display = 'none';
    }

    // Word boundary scanning

    function getTextContent(block) {
        return block.element.textContent || '';
    }

    function getWordsInBlock(block) {
        const words = [];
        const walker = document.createTreeWalker(block.element, NodeFilter.SHOW_TEXT, null, false);
        let node;

        while ((node = walker.nextNode())) {
            const text = node.textContent;
            let i = 0;

            while (i < text.length) {
                // Skip whitespace/boundaries
                while (i < text.length && WORD_BOUNDARY.test(text[i])) i++;
                if (i >= text.length) break;

                const wordStart = i;
                // Scan to end of word
                while (i < text.length && !WORD_BOUNDARY.test(text[i])) {
                    // Handle contractions: don't, it's, etc.
                    if (text[i] === '\'' && i + 1 < text.length && !WORD_BOUNDARY.test(text[i + 1])) {
                        i++;
                        continue;
                    }
                    i++;
                }

                words.push({
                    textNode: node,
                    wordStart,
                    wordEnd: i,
                    text: text.slice(wordStart, i),
                });
            }
        }

        return words;
    }

    function moveCursorToFirstWord(block) {
        const nav = window.crNav;
        const words = getWordsInBlock(block);
        if (words.length > 0) {
            nav.cursor = words[0];
            nav.targetX = null;
        }
    }

    function getCurrentWordIndex() {
        const nav = window.crNav;
        if (!nav.cursor) return -1;

        const block = nav.blocks[nav.currentBlockIndex];
        const words = getWordsInBlock(block);

        for (let i = 0; i < words.length; i++) {
            if (words[i].textNode === nav.cursor.textNode &&
                words[i].wordStart === nav.cursor.wordStart) {
                return i;
            }
        }
        return -1;
    }

    function moveCursorLeft() {
        const nav = window.crNav;
        if (!nav.cursor) return;

        nav.targetX = null;
        clearSelection();

        const block = nav.blocks[nav.currentBlockIndex];
        const words = getWordsInBlock(block);
        const idx = getCurrentWordIndex();

        if (idx > 0) {
            nav.cursor = words[idx - 1];
        } else if (nav.currentBlockIndex > 0) {
            // Wrap to previous block
            nav.currentBlockIndex--;
            const prevBlock = nav.blocks[nav.currentBlockIndex];
            const prevWords = getWordsInBlock(prevBlock);
            if (prevWords.length > 0) {
                nav.cursor = prevWords[prevWords.length - 1];
            }
        }

        updateCursorVisual();
        scrollCursorIntoView();
        syncCommentPanel();
    }

    function moveCursorRight() {
        const nav = window.crNav;
        if (!nav.cursor) return;

        nav.targetX = null;
        clearSelection();

        const block = nav.blocks[nav.currentBlockIndex];
        const words = getWordsInBlock(block);
        const idx = getCurrentWordIndex();

        if (idx < words.length - 1) {
            nav.cursor = words[idx + 1];
        } else if (nav.currentBlockIndex < nav.blocks.length - 1) {
            nav.currentBlockIndex++;
            moveCursorToFirstWord(nav.blocks[nav.currentBlockIndex]);
        }

        updateCursorVisual();
        scrollCursorIntoView();
        syncCommentPanel();
    }

    function getVisualLines(block) {
        const words = getWordsInBlock(block);
        if (words.length === 0) return [];

        const lines = [];
        let currentLine = [];
        let currentY = null;
        const tolerance = 3; // pixels - accounts for baseline variance

        for (const word of words) {
            const range = document.createRange();
            range.setStart(word.textNode, word.wordStart);
            range.setEnd(word.textNode, word.wordEnd);
            const rect = range.getBoundingClientRect();
            const wordY = rect.top;

            if (currentY === null || Math.abs(wordY - currentY) > tolerance) {
                if (currentLine.length > 0) {
                    lines.push(currentLine);
                }
                currentLine = [word];
                currentY = wordY;
            } else {
                currentLine.push(word);
            }
        }
        if (currentLine.length > 0) {
            lines.push(currentLine);
        }

        return lines;
    }

    function getCurrentVisualLineIndex(block) {
        const nav = window.crNav;
        if (!nav.cursor) return -1;

        const lines = getVisualLines(block);
        for (let i = 0; i < lines.length; i++) {
            for (const word of lines[i]) {
                if (word.textNode === nav.cursor.textNode &&
                    word.wordStart === nav.cursor.wordStart) {
                    return i;
                }
            }
        }
        return -1;
    }

    function moveCursorToNearestXInLine(lineWords, targetX) {
        const nav = window.crNav;
        if (lineWords.length === 0) return;

        let bestWord = lineWords[0];
        let bestDist = Infinity;

        for (const word of lineWords) {
            const range = document.createRange();
            range.setStart(word.textNode, word.wordStart);
            range.setEnd(word.textNode, word.wordEnd);
            const rect = range.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const dist = Math.abs(centerX - targetX);
            if (dist < bestDist) {
                bestDist = dist;
                bestWord = word;
            }
        }

        nav.cursor = bestWord;
    }

    function clearSelection() {
        const nav = window.crNav;
        if (nav.selection.level > 0 || nav.selection.anchor) {
            nav.selection.level = 0;
            nav.selection.range = null;
            nav.selection.text = '';
            nav.selection.anchor = null;
        }
    }

    function dismissHighlights() {
        // Clear selection highlight overlay
        if (window.crSelection) window.crSelection.clearSelectionHighlight();
        // Clear browser native text selection
        window.getSelection().removeAllRanges();
    }

    function moveCursorUp() {
        const nav = window.crNav;
        if (!nav.cursor) return;

        clearSelection();

        if (nav.targetX === null) {
            nav.targetX = getCursorX();
        }

        const block = nav.blocks[nav.currentBlockIndex];
        const lines = getVisualLines(block);
        const lineIdx = getCurrentVisualLineIndex(block);

        if (lineIdx > 0) {
            // Move to previous visual line within same block
            moveCursorToNearestXInLine(lines[lineIdx - 1], nav.targetX);
        } else if (nav.currentBlockIndex > 0) {
            // Move to last visual line of previous block
            nav.currentBlockIndex--;
            const prevBlock = nav.blocks[nav.currentBlockIndex];
            const prevLines = getVisualLines(prevBlock);
            if (prevLines.length > 0) {
                moveCursorToNearestXInLine(prevLines[prevLines.length - 1], nav.targetX);
            }
        }

        updateCursorVisual();
        scrollCursorIntoView();
        syncCommentPanel();
    }

    function moveCursorDown() {
        const nav = window.crNav;
        if (!nav.cursor) return;

        clearSelection();

        if (nav.targetX === null) {
            nav.targetX = getCursorX();
        }

        const block = nav.blocks[nav.currentBlockIndex];
        const lines = getVisualLines(block);
        const lineIdx = getCurrentVisualLineIndex(block);

        if (lineIdx < lines.length - 1) {
            // Move to next visual line within same block
            moveCursorToNearestXInLine(lines[lineIdx + 1], nav.targetX);
        } else if (nav.currentBlockIndex < nav.blocks.length - 1) {
            // Move to first visual line of next block
            nav.currentBlockIndex++;
            const nextBlock = nav.blocks[nav.currentBlockIndex];
            const nextLines = getVisualLines(nextBlock);
            if (nextLines.length > 0) {
                moveCursorToNearestXInLine(nextLines[0], nav.targetX);
            }
        }

        updateCursorVisual();
        scrollCursorIntoView();
        syncCommentPanel();
    }

    function moveCursorBlock(direction) {
        const nav = window.crNav;
        if (!nav.cursor) return;

        clearSelection();
        nav.targetX = null;

        if (direction < 0 && nav.currentBlockIndex > 0) {
            nav.currentBlockIndex--;
        } else if (direction > 0 && nav.currentBlockIndex < nav.blocks.length - 1) {
            nav.currentBlockIndex++;
        } else {
            return;
        }

        moveCursorToFirstWord(nav.blocks[nav.currentBlockIndex]);
        updateCursorVisual();
        scrollCursorIntoView();
        syncCommentPanel();
    }

    function moveCursorPage(direction) {
        const nav = window.crNav;
        if (!nav.cursor) return;

        clearSelection();
        if (window.crSelection) window.crSelection.clearSelectionHighlight();

        if (nav.targetX === null) {
            nav.targetX = getCursorX();
        }

        // Jump roughly one viewport height worth of blocks
        const viewportHeight = window.innerHeight;
        const startRect = nav.blocks[nav.currentBlockIndex].element.getBoundingClientRect();
        const startY = startRect.top + startRect.height / 2;
        const targetY = startY + (direction * viewportHeight * 0.8);

        // Find the block closest to the target Y
        let bestIdx = nav.currentBlockIndex;
        let bestDist = Infinity;
        for (let i = 0; i < nav.blocks.length; i++) {
            const rect = nav.blocks[i].element.getBoundingClientRect();
            const centerY = rect.top + rect.height / 2;
            const dist = Math.abs(centerY - targetY);
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }

        // Ensure we move at least one block
        if (bestIdx === nav.currentBlockIndex) {
            bestIdx = direction > 0
                ? Math.min(nav.currentBlockIndex + 1, nav.blocks.length - 1)
                : Math.max(nav.currentBlockIndex - 1, 0);
        }

        nav.currentBlockIndex = bestIdx;
        moveCursorToNearestX(nav.blocks[nav.currentBlockIndex], nav.targetX);
        updateCursorVisual();
        scrollCursorIntoView();
        syncCommentPanel();
    }

    function isFollowedBySentenceEnd(word) {
        const text = word.textNode.textContent;
        // Check characters between word end and next non-boundary char (or end of node)
        for (let i = word.wordEnd; i < text.length; i++) {
            const ch = text[i];
            if (ch === '.' || ch === '!' || ch === '?') return true;
            if (ch === ' ' || ch === '\t' || ch === '\n') continue;
            // Hit a non-punctuation, non-whitespace char - no sentence end
            break;
        }
        return false;
    }

    function moveCursorSentence(direction) {
        const nav = window.crNav;
        if (!nav.cursor) return;

        nav.targetX = null;
        clearSelection();

        const block = nav.blocks[nav.currentBlockIndex];
        const words = getWordsInBlock(block);
        const idx = getCurrentWordIndex();

        if (direction > 0) {
            // Forward: find next word after a sentence-ending word
            for (let i = idx; i < words.length - 1; i++) {
                if (isFollowedBySentenceEnd(words[i])) {
                    nav.cursor = words[i + 1];
                    updateCursorVisual();
                    scrollCursorIntoView();
                    syncCommentPanel();
                    return;
                }
            }
            // No sentence boundary found - jump to first word of next block
            if (nav.currentBlockIndex < nav.blocks.length - 1) {
                nav.currentBlockIndex++;
                moveCursorToFirstWord(nav.blocks[nav.currentBlockIndex]);
            }
        } else {
            // Backward: find the start of the current or previous sentence
            for (let i = idx - 1; i >= 0; i--) {
                if (i === 0) {
                    nav.cursor = words[0];
                    updateCursorVisual();
                    scrollCursorIntoView();
                    syncCommentPanel();
                    return;
                }
                if (isFollowedBySentenceEnd(words[i - 1])) {
                    nav.cursor = words[i];
                    updateCursorVisual();
                    scrollCursorIntoView();
                    syncCommentPanel();
                    return;
                }
            }
            // No sentence boundary found - jump to start of previous block
            if (nav.currentBlockIndex > 0) {
                nav.currentBlockIndex--;
                moveCursorToFirstWord(nav.blocks[nav.currentBlockIndex]);
            }
        }

        updateCursorVisual();
        scrollCursorIntoView();
        syncCommentPanel();
    }

    function extendWordSelection(direction) {
        const nav = window.crNav;
        if (!nav.cursor) return;

        nav.targetX = null;

        const block = nav.blocks[nav.currentBlockIndex];
        const words = getWordsInBlock(block);
        const idx = getCurrentWordIndex();
        if (idx < 0) return;

        // Initialize anchor on first extend
        if (!nav.selection.anchor) {
            nav.selection.anchor = {
                blockIndex: nav.currentBlockIndex,
                wordIndex: idx,
            };
        }

        // Move cursor by one word in the given direction
        if (direction > 0) {
            if (idx < words.length - 1) {
                nav.cursor = words[idx + 1];
            } else if (nav.currentBlockIndex < nav.blocks.length - 1) {
                nav.currentBlockIndex++;
                const nextWords = getWordsInBlock(nav.blocks[nav.currentBlockIndex]);
                if (nextWords.length > 0) nav.cursor = nextWords[0];
            }
        } else {
            if (idx > 0) {
                nav.cursor = words[idx - 1];
            } else if (nav.currentBlockIndex > 0) {
                nav.currentBlockIndex--;
                const prevWords = getWordsInBlock(nav.blocks[nav.currentBlockIndex]);
                if (prevWords.length > 0) nav.cursor = prevWords[prevWords.length - 1];
            }
        }

        // Build DOM range from anchor to cursor (or cursor to anchor if reversed)
        const anchor = nav.selection.anchor;
        const anchorBlock = nav.blocks[anchor.blockIndex];
        const anchorWords = getWordsInBlock(anchorBlock);
        const anchorWord = anchorWords[anchor.wordIndex];
        if (!anchorWord) return;

        const cursorWord = nav.cursor;
        if (!cursorWord) return;

        // Determine order: which comes first in the document?
        let startWord, endWord;
        if (anchor.blockIndex < nav.currentBlockIndex ||
            (anchor.blockIndex === nav.currentBlockIndex &&
             anchor.wordIndex <= getCurrentWordIndex())) {
            startWord = anchorWord;
            endWord = cursorWord;
        } else {
            startWord = cursorWord;
            endWord = anchorWord;
        }

        const range = document.createRange();
        range.setStart(startWord.textNode, startWord.wordStart);
        range.setEnd(endWord.textNode, endWord.wordEnd);

        // Store in nav.selection so 'c' key picks it up
        nav.selection.level = 1;
        nav.selection.range = range;
        nav.selection.text = range.toString();

        if (window.crViewer) {
            const lines = window.crViewer.extractLineNumbersFromRange(range);
            nav.selection.lineStart = lines.lineStart;
            nav.selection.lineEnd = lines.lineEnd;
        }

        // Visual highlight
        if (window.crSelection) {
            window.crSelection.clearSelectionHighlight();
        }
        highlightWordSelection(range);

        updateCursorVisual();
        scrollCursorIntoView();
    }

    function highlightWordSelection(range) {
        if (window.crSelection) window.crSelection.clearSelectionHighlight();

        const highlight = document.createElement('div');
        highlight.id = 'selection-highlight';
        highlight.style.position = 'absolute';
        highlight.style.top = '0';
        highlight.style.left = '0';
        highlight.style.pointerEvents = 'none';
        highlight.style.zIndex = '5';

        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i++) {
            const rect = rects[i];
            const line = document.createElement('div');
            line.className = 'selection-highlight-line';
            line.style.position = 'absolute';
            line.style.left = (rect.left + window.scrollX) + 'px';
            line.style.top = (rect.top + window.scrollY) + 'px';
            line.style.width = rect.width + 'px';
            line.style.height = rect.height + 'px';
            highlight.appendChild(line);
        }

        document.body.appendChild(highlight);
    }

    function getCursorX() {
        const nav = window.crNav;
        if (!nav.cursor) return 0;

        const range = document.createRange();
        range.setStart(nav.cursor.textNode, nav.cursor.wordStart);
        range.setEnd(nav.cursor.textNode, nav.cursor.wordEnd);
        const rect = range.getBoundingClientRect();
        return rect.left + rect.width / 2;
    }

    function moveCursorToNearestX(block, targetX) {
        const nav = window.crNav;
        const words = getWordsInBlock(block);
        if (words.length === 0) {
            nav.cursor = null;
            return;
        }

        let bestWord = words[0];
        let bestDist = Infinity;

        for (const word of words) {
            const range = document.createRange();
            range.setStart(word.textNode, word.wordStart);
            range.setEnd(word.textNode, word.wordEnd);
            const rect = range.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const dist = Math.abs(centerX - targetX);
            if (dist < bestDist) {
                bestDist = dist;
                bestWord = word;
            }
        }

        nav.cursor = bestWord;
    }

    function updateCursorVisual() {
        const nav = window.crNav;
        if (!nav.active || !nav.cursor) {
            hideCursor();
            return;
        }

        const range = document.createRange();
        try {
            range.setStart(nav.cursor.textNode, nav.cursor.wordStart);
            range.setEnd(nav.cursor.textNode, nav.cursor.wordEnd);
        } catch (e) {
            hideCursor();
            return;
        }

        const rect = range.getBoundingClientRect();

        cursorOverlay.style.display = 'block';
        cursorOverlay.style.left = (rect.left + window.scrollX) + 'px';
        cursorOverlay.style.top = (rect.top + window.scrollY) + 'px';
        cursorOverlay.style.width = rect.width + 'px';
        cursorOverlay.style.height = rect.height + 'px';

        // Block highlight
        const block = nav.blocks[nav.currentBlockIndex];
        if (block) {
            const blockRect = block.element.getBoundingClientRect();
            blockHighlight.style.display = 'block';
            blockHighlight.style.left = (blockRect.left + window.scrollX - 16) + 'px';
            blockHighlight.style.top = (blockRect.top + window.scrollY) + 'px';
            blockHighlight.style.width = '0';
            blockHighlight.style.height = blockRect.height + 'px';
        }
    }

    function scrollCursorIntoView() {
        const nav = window.crNav;
        if (!nav.cursor) return;

        const range = document.createRange();
        try {
            range.setStart(nav.cursor.textNode, nav.cursor.wordStart);
            range.setEnd(nav.cursor.textNode, nav.cursor.wordEnd);
        } catch (e) {
            return;
        }

        const rect = range.getBoundingClientRect();
        const margin = 80;

        if (rect.top < margin) {
            window.scrollBy(0, rect.top - margin);
        } else if (rect.bottom > window.innerHeight - margin) {
            window.scrollBy(0, rect.bottom - window.innerHeight + margin);
        }
    }

    function syncCommentPanel() {
        const nav = window.crNav;
        if (!nav.cursor) return;

        // Check if cursor is on a comment highlight
        let node = nav.cursor.textNode;
        const highlight = node.parentElement ? node.parentElement.closest('.comment-highlight') : null;

        if (highlight) {
            const commentId = highlight.dataset.commentId;
            const threadItem = document.querySelector(`.thread-container[data-thread-id="${commentId}"]`);
            if (threadItem) {
                threadItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                threadItem.classList.add('thread-highlight-pulse');
                setTimeout(() => threadItem.classList.remove('thread-highlight-pulse'), 1000);
            }
        }
    }

    // Expose for other modules
    window.crNavUtils = {
        getWordsInBlock,
        getVisualLines,
        getCurrentWordIndex,
        buildBlockIndex,
        updateCursorVisual,
        hideCursor,
        deactivate,
        activateIfNeeded,
        isInputFocused,
        scrollCursorIntoView,
        syncCommentPanel,
    };
})();
