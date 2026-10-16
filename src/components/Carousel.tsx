import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './icons';

/**
 * Carousel (WAI-ARIA APG "carousel" pattern, without auto-rotation).
 *
 * The track is a native horizontal scroller with scroll-snap, so swiping, trackpads and
 * the scrollbar all just work; the previous / next buttons and the dots move it by one
 * slide, and Left / Right arrows do the same while focus is inside. It never moves on its
 * own: a captain reading a slide is never pulled away from it.
 */
export function Carousel({
  label,
  kicker,
  slides,
  slideLabel,
}: {
  /** Accessible name and visible heading. */
  label: string;
  kicker?: string;
  slides: readonly { key: string; content: ReactNode }[];
  /** Accessible label per slide; defaults to "n / total". */
  slideLabel?: (index: number) => string;
}): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  /** Scrolled as far as it goes (several slides per view on wide screens). */
  const [atEnd, setAtEnd] = useState(false);
  const count = slides.length;

  const slideStep = useCallback((): number => {
    const track = trackRef.current;
    const first = track?.firstElementChild as HTMLElement | null;
    if (!track || !first) return 0;
    const gap = Number.parseFloat(getComputedStyle(track).columnGap || '0') || 0;
    return first.offsetWidth + gap;
  }, []);

  const goTo = useCallback(
    (target: number) => {
      const track = trackRef.current;
      if (!track) return;
      const next = Math.max(0, Math.min(count - 1, target));
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      // jsdom has no scrollTo on elements; the index still follows.
      track.scrollTo?.({ left: next * slideStep(), behavior: reduce ? 'auto' : 'smooth' });
      setIndex(next);
    },
    [count, slideStep],
  );

  /** Previous / next from the slide actually at the left edge (not the "last" dot). */
  const move = useCallback(
    (direction: 1 | -1) => {
      const track = trackRef.current;
      const step = slideStep();
      const start = track && step > 0 ? Math.round(track.scrollLeft / step) : index;
      goTo(start + direction);
    },
    [goTo, index, slideStep],
  );

  // Follow swipes: the slide closest to the left edge is the current one.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let frame = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const step = slideStep();
        const end = track.scrollWidth > 0 && track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
        setAtEnd(end);
        if (end) setIndex(count - 1);
        else if (step > 0) setIndex(Math.max(0, Math.min(count - 1, Math.round(track.scrollLeft / step))));
      });
    };
    track.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      track.removeEventListener('scroll', onScroll);
    };
  }, [count, slideStep]);

  // A shrinking list (an order deleted) must not leave the index past the end.
  useEffect(() => {
    if (index > count - 1) setIndex(Math.max(0, count - 1));
  }, [count, index]);

  return (
    <section
      className="carousel"
      aria-roledescription="carousel"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        // Arrow keys inside a text field keep moving the caret.
        if ((event.target as HTMLElement).closest('input, textarea, select')) return;
        event.preventDefault();
        move(event.key === 'ArrowRight' ? 1 : -1);
      }}
    >
      <div className="carousel-head">
        <h2 className="carousel-title">
          {kicker ? (
            <span className="kicker" aria-hidden="true">
              {kicker}
            </span>
          ) : null}
          <span>{label}</span>
        </h2>
        {count > 1 ? (
          <div className="carousel-controls">
            <button
              type="button"
              className="btn icon carousel-btn"
              onClick={() => move(-1)}
              disabled={index <= 0}
              aria-label="前のスライド"
            >
              <Icon name="chevronLeft" size={20} />
            </button>
            <button
              type="button"
              className="btn icon carousel-btn"
              onClick={() => move(1)}
              disabled={index >= count - 1 || atEnd}
              aria-label="次のスライド"
            >
              <Icon name="chevronRight" size={20} />
            </button>
          </div>
        ) : null}
      </div>
      <div className="carousel-track" ref={trackRef}>
        {slides.map((slide, slideIndex) => (
          <div
            key={slide.key}
            className="carousel-slide"
            role="group"
            aria-roledescription="slide"
            aria-label={slideLabel ? slideLabel(slideIndex) : `${slideIndex + 1} / ${count}`}
            style={{ '--i': Math.min(slideIndex, 6) } as CSSProperties}
          >
            {slide.content}
          </div>
        ))}
      </div>
      {count > 1 ? (
        <div className="carousel-dots">
          {slides.map((slide, slideIndex) => (
            <button
              type="button"
              key={slide.key}
              className="carousel-dot"
              aria-label={`スライド ${slideIndex + 1} を表示`}
              aria-current={slideIndex === index ? 'true' : undefined}
              onClick={() => goTo(slideIndex)}
            >
              <span aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
