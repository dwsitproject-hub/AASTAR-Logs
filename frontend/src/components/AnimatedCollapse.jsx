import React, { useRef, useEffect, useState } from 'react';

// 60fps smooth collapse:
// - Measures content height with ResizeObserver
// - Animates `height` (compositor-optimized when paired with `will-change: height`)
// - On the open-end, sets height to 'auto' so the content adapts to internal changes
//   (e.g. typing in an input that grows the layout)
export default function AnimatedCollapse({ open, children, duration = 280 }) {
  const ref = useRef(null);
  const innerRef = useRef(null);
  const [height, setHeight] = useState(open ? 'auto' : 0);
  // Only promote to its own compositor layer *while* animating. Keeping
  // `will-change: height` on permanently forces the browser to retain a GPU
  // layer per collapse element even when idle, which is a large, unnecessary
  // memory cost when many collapses are mounted (e.g. Expand-All). We release
  // it back to 'auto' as soon as the transition finishes.
  const [animating, setAnimating] = useState(false);
  const isFirst = useRef(true);

  useEffect(() => {
    const el = ref.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    let frame = 0;
    let timer = 0;

    // Skip transition on first render — set state directly
    if (isFirst.current) {
      isFirst.current = false;
      setHeight(open ? 'auto' : 0);
      return;
    }

    setAnimating(true);
    if (open) {
      // From 0 -> measured height -> 'auto'
      const targetH = inner.scrollHeight;
      setHeight(0);
      // Force reflow so the browser registers the 0 before animating
      // eslint-disable-next-line no-unused-expressions
      el.offsetHeight;
      frame = requestAnimationFrame(() => {
        setHeight(targetH);
      });
      // After transition completes, switch to 'auto' so content can change size
      // and drop the compositor layer.
      timer = setTimeout(() => { setHeight('auto'); setAnimating(false); }, duration);
    } else {
      // From whatever (often 'auto') -> measured height -> 0
      // Have to first set the explicit height (can't transition from 'auto'),
      // then on next frame transition to 0.
      const currentH = inner.scrollHeight;
      setHeight(currentH);
      // eslint-disable-next-line no-unused-expressions
      el.offsetHeight;
      frame = requestAnimationFrame(() => {
        setHeight(0);
      });
      timer = setTimeout(() => setAnimating(false), duration);
    }

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [open, duration]);

  return (
    <div
      ref={ref}
      style={{
        height: typeof height === 'number' ? `${height}px` : height,
        overflow: 'hidden',
        transition: `height ${duration}ms cubic-bezier(0.4, 0, 0.2, 1)`,
        willChange: animating ? 'height' : 'auto'
      }}
    >
      <div ref={innerRef}>
        {children}
      </div>
    </div>
  );
}
