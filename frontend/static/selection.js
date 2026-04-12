// Selection Expansion - ] to expand, [ to shrink selection scope

(function () {
    'use strict';

    const CLAUSE_DELIMITERS = /[,;:()\u2014\-]/;
    const MAX_LEVEL = 4;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSelection);
    } else {
        initSelection();
    }

    function initSelection() {
        document.addEventListener('keydown', handleSelectionKeys);
    }

    function handleSelectionKeys(e) {
        if (window.crNav.editMode) return;
        if (window.crNavUtils && window.crNavUtils.isInputFocused()) return;

        const nav = window.crNav;
        if (!nav.active || !nav.cursor) return;

        if (e.key === ']') {
            e.preventDefault();
            expandSelection();
        } else if (e.key === '[') {
            e.preventDefault();
            shrinkSelection();
        }
    }

    function expandSelection() {
        const nav = window.crNav;
        if (nav.selection.level >= MAX_LEVEL) return;

        nav.selection.level++;
        applySelectionLevel();
    }

    function shrinkSelection() {
        const nav = window.crNav;
        if (nav.selection.level <= 0) return;

        nav.selection.level--;
        applySelectionLevel();
    }

    function applySelectionLevel() {
        const nav = window.crNav;
        const level = nav.selection.level;

        // Remove existing selection highlight
        clearSelectionHighlight();

        if (level === 0) {
            nav.selection.range = null;
            nav.selection.text = '';
            nav.selection.lineStart = null;
            nav.selection.lineEnd = null;
            window.crNavUtils.updateCursorVisual();
            return;
        }

        let range = null;

        switch (level) {
            case 1:
                range = getClauseRange();
                break;
            case 2:
                range = getSentenceRange();
                break;
            case 3:
                range = getParagraphRange();
                break;
            case 4:
                range = getSectionRange();
                break;
        }

        if (range) {
            nav.selection.range = range;
            nav.selection.text = range.toString();

            // Compute line numbers from the range
            if (window.crViewer) {
                const lines = window.crViewer.extractLineNumbersFromRange(range);
                nav.selection.lineStart = lines.lineStart;
                nav.selection.lineEnd = lines.lineEnd;
            }

            highlightSelection(range);
        }
    }

    function getClauseRange() {
        const nav = window.crNav;
        const block = nav.blocks[nav.currentBlockIndex];
        const text = block.element.textContent;

        // Find cursor position in block text
        const cursorPos = getCursorPositionInBlock();
        if (cursorPos === -1) return getParagraphRange();

        // Scan left for clause delimiter or sentence boundary
        let left = cursorPos;
        while (left > 0) {
            if (CLAUSE_DELIMITERS.test(text[left - 1])) break;
            if (isSentenceBoundary(text, left - 1)) break;
            left--;
        }

        // Scan right for clause delimiter or sentence boundary
        let right = cursorPos;
        while (right < text.length) {
            if (CLAUSE_DELIMITERS.test(text[right])) break;
            if (isSentenceBoundary(text, right)) {
                right++; // Include the punctuation
                break;
            }
            right++;
        }

        // Trim whitespace
        while (left < right && /\s/.test(text[left])) left++;
        while (right > left && /\s/.test(text[right - 1])) right--;

        if (left >= right) return getParagraphRange();

        return createRangeFromBlockOffsets(block.element, left, right);
    }

    function getSentenceRange() {
        const nav = window.crNav;
        const block = nav.blocks[nav.currentBlockIndex];
        const text = block.element.textContent;

        const cursorPos = getCursorPositionInBlock();
        if (cursorPos === -1) return getParagraphRange();

        // Scan left for sentence boundary
        let left = cursorPos;
        while (left > 0) {
            if (isSentenceBoundary(text, left - 1)) {
                break;
            }
            left--;
        }

        // Scan right for sentence boundary
        let right = cursorPos;
        while (right < text.length) {
            if (isSentenceBoundary(text, right)) {
                // Include the punctuation
                right++;
                break;
            }
            right++;
        }

        // Trim whitespace
        while (left < right && /\s/.test(text[left])) left++;
        while (right > left && /\s/.test(text[right - 1])) right--;

        if (left >= right) return getParagraphRange();

        return createRangeFromBlockOffsets(block.element, left, right);
    }

    function isSentenceBoundary(text, pos) {
        const ch = text[pos];
        if (ch !== '.' && ch !== '?' && ch !== '!') return false;

        // Must be followed by whitespace + capital letter, or end of text
        if (pos + 1 >= text.length) return true;

        const next = text[pos + 1];
        if (!/\s/.test(next)) return false;

        // Find next non-whitespace character
        let i = pos + 2;
        while (i < text.length && /\s/.test(text[i])) i++;
        if (i >= text.length) return true;

        const afterSpace = text[i];

        // Single capital letter after period is likely an abbreviation (U.S., Dr. S.)
        if (ch === '.' && /[A-Z]/.test(afterSpace)) {
            if (i + 1 >= text.length || /[.\s]/.test(text[i + 1])) {
                return false;
            }
        }

        return /[A-Z]/.test(afterSpace);
    }

    function getParagraphRange() {
        const nav = window.crNav;
        const block = nav.blocks[nav.currentBlockIndex];
        const range = document.createRange();
        range.selectNodeContents(block.element);
        return range;
    }

    function getSectionRange() {
        const nav = window.crNav;
        const blocks = nav.blocks;
        const currentIdx = nav.currentBlockIndex;

        // Find nearest preceding heading
        let headingIdx = -1;
        let headingLevel = Infinity;

        for (let i = currentIdx; i >= 0; i--) {
            if (blocks[i].headingLevel !== null) {
                headingIdx = i;
                headingLevel = blocks[i].headingLevel;
                break;
            }
        }

        // If no heading found, expand from document start to first heading
        let startIdx, endIdx;

        if (headingIdx === -1) {
            startIdx = 0;
            endIdx = 0;
            for (let i = 0; i < blocks.length; i++) {
                if (blocks[i].headingLevel !== null) {
                    endIdx = i - 1;
                    break;
                }
                endIdx = i;
            }
        } else {
            startIdx = headingIdx;
            endIdx = blocks.length - 1;

            // Find next heading of same or higher level
            for (let i = headingIdx + 1; i < blocks.length; i++) {
                if (blocks[i].headingLevel !== null && blocks[i].headingLevel <= headingLevel) {
                    endIdx = i - 1;
                    break;
                }
            }
        }

        if (startIdx > endIdx) endIdx = startIdx;

        const range = document.createRange();
        range.setStartBefore(blocks[startIdx].element);
        range.setEndAfter(blocks[endIdx].element);
        return range;
    }

    function getCursorPositionInBlock() {
        const nav = window.crNav;
        if (!nav.cursor) return -1;

        const block = nav.blocks[nav.currentBlockIndex];
        const walker = document.createTreeWalker(block.element, NodeFilter.SHOW_TEXT, null, false);
        let offset = 0;
        let node;

        while ((node = walker.nextNode())) {
            if (node === nav.cursor.textNode) {
                return offset + nav.cursor.wordStart;
            }
            offset += node.textContent.length;
        }

        return -1;
    }

    function createRangeFromBlockOffsets(element, startOffset, endOffset) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
        let pos = 0;
        let startNode = null, startOff = 0;
        let endNode = null, endOff = 0;
        let node;

        while ((node = walker.nextNode())) {
            const len = node.textContent.length;

            if (!startNode && pos + len > startOffset) {
                startNode = node;
                startOff = startOffset - pos;
            }

            if (pos + len >= endOffset) {
                endNode = node;
                endOff = endOffset - pos;
                break;
            }

            pos += len;
        }

        if (!startNode || !endNode) return null;

        const range = document.createRange();
        range.setStart(startNode, startOff);
        range.setEnd(endNode, endOff);
        return range;
    }

    function highlightSelection(range) {
        clearSelectionHighlight();

        const highlight = document.createElement('div');
        highlight.id = 'selection-highlight';
        highlight.style.position = 'absolute';
        highlight.style.top = '0';
        highlight.style.left = '0';
        highlight.style.pointerEvents = 'none';
        highlight.style.zIndex = '5';

        // Use multiple rects for multi-line selections
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

        // Hide the word cursor when we have a selection
        const cursor = document.getElementById('word-cursor');
        if (cursor) cursor.style.display = 'none';
    }

    function clearSelectionHighlight() {
        const existing = document.getElementById('selection-highlight');
        if (existing) existing.remove();
    }

    // Expose for keyboard-comments
    window.crSelection = {
        clearSelectionHighlight,
        applySelectionLevel,
    };
})();
