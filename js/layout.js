// Picture Logic — pure screen-space helpers shared by the engine client and
// the node tests (moved from the browser build's js/ui.js, unchanged).
'use strict';

// Overlay geometry from projected cell centers (playfield-relative px).
// Perspective makes the projected board a trapezoid, so every cell gets its
// own quad (edges shared with its neighbors) instead of a slot in a uniform
// grid. The clue lines hug the projected board edge of their row/column.
export function overlayLayout(rows, cols, centers) {
  const idx = (r, c) => (r * cols + c) * 2;
  const quad = (r, c) => {
    const i = idx(r, c), cx = centers[i], cy = centers[i + 1];
    const x0 = c > 0 ? centers[i - 2] : 2 * cx - centers[i + 2];
    const x1 = c < cols - 1 ? centers[i + 2] : 2 * cx - centers[i - 2];
    const y0 = r > 0 ? centers[i - cols * 2 + 1] : 2 * cy - centers[i + cols * 2 + 1];
    const y1 = r < rows - 1 ? centers[i + cols * 2 + 1] : 2 * cy - centers[i - cols * 2 + 1];
    return { left: (cx + x0) / 2, top: (cy + y0) / 2, width: (x1 - x0) / 2, height: (y1 - y0) / 2 };
  };
  const cells = [];
  let cellW = 0, cellH = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const q = quad(r, c);
      cells.push(q);
      cellW += q.width; cellH += q.height;
    }
  }
  cellW /= rows * cols; cellH /= rows * cols;
  const colClues = [], rowClues = [];
  for (let c = 0; c < cols; c++) {
    const q = cells[c];
    colClues.push({ left: q.left, top: 0, width: q.width, height: Math.max(0, q.top - 6) });
  }
  for (let r = 0; r < rows; r++) {
    const q = cells[r * cols];
    rowClues.push({ left: 0, top: q.top, width: Math.max(0, q.left - 6), height: q.height });
  }
  return { cells, colClues, rowClues, cellW, cellH };
}

/** m:ss (ui.js formatMs). */
export function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
