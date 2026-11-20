// The chat transcript's scrolling. It takes the place of p2's virtual list (apps/p2/src/web/use-chat-scroll.ts) and
// keeps its rules: at the bottom the transcript follows the answer, a reader who scrolled up keeps their place, and
// the composer's dock floating over the transcript's bottom gets room.
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/** Nearer to the top than this, the entries before the first one shown are asked for. */
const NEAR_TOP_PX = 400;

/** Where `element`'s top is on screen, from the scroller's top. */
function screenTop(scroller: HTMLElement, element: Element): number {
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

/**
 * `content` is what the scroller shows: a new value says its rows changed. `onNearTop` runs when the reader comes near
 * the top, and after a change of `content` that leaves them there.
 */
export function useFollow(
  content: unknown,
  onNearTop: () => void,
): {
  scroller: RefObject<HTMLDivElement | null>;
  dock: RefObject<HTMLDivElement | null>;
  /** The transcript follows the answer; false once the reader scrolled up. */
  atBottom: boolean;
  toBottom: () => void;
} {
  const scroller = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const nearTop = useRef(onNearTop);
  nearTop.current = onNearTop;
  const scroll = useRef<{ follow(following: boolean): void; settle(): void; watch(): void }>(null);

  useLayoutEffect(() => {
    const element = scroller.current!;
    let following = true;
    let lastTop = 0;
    /** The first row in view and where it was, for a reader who is not at the bottom. */
    let anchor: { row: Element; top: number } | undefined;
    let watched: Element | null = null;
    // The browser's scroll anchoring does nothing at the very top (Chromium), where earlier entries arrive, and not
    // every browser has it: the anchor row below keeps the place everywhere.
    element.style.overflowAnchor = "none";

    const capture = (): void => {
      const top = element.getBoundingClientRect().top;
      const row = following ? undefined : [...element.querySelectorAll(".row")].find((row) => row.getBoundingClientRect().bottom > top);
      anchor = row && { row, top: screenTop(element, row) };
    };
    const follow = (value: boolean): void => {
      following = value;
      setAtBottom(value);
    };
    /** After any change of layout: stay at the end, or keep the anchor row where it was. */
    const settle = (): void => {
      if (following) element.scrollTop = element.scrollHeight;
      else if (anchor?.row.isConnected) element.scrollTop += screenTop(element, anchor.row) - anchor.top;
      lastTop = element.scrollTop;
      capture();
    };
    const onScroll = (): void => {
      const top = element.scrollTop;
      // Reaching the bottom follows the answer, scrolling up stops; our own corrections only ever move down.
      if (element.scrollHeight - top - element.clientHeight < 2) follow(true);
      else if (top < lastTop) follow(false);
      lastTop = top;
      capture();
      if (top < NEAR_TOP_PX) nearTop.current();
    };

    const sizes = new ResizeObserver(settle);
    sizes.observe(element);
    // The composer dock floats over the transcript's bottom: the transcript keeps room for it.
    const docked = new ResizeObserver(() => {
      element.style.paddingBottom = `${dock.current!.offsetHeight}px`;
      settle();
    });
    docked.observe(dock.current!);
    element.addEventListener("scroll", onScroll, { passive: true });
    scroll.current = {
      follow,
      settle,
      // The scroller's child is the loading state, the empty state, or the messages: the one there now is observed.
      watch: () => {
        if (watched === element.firstElementChild) return;
        if (watched) sizes.unobserve(watched);
        watched = element.firstElementChild;
        if (watched) sizes.observe(watched);
      },
    };
    return () => {
      sizes.disconnect();
      docked.disconnect();
      element.removeEventListener("scroll", onScroll);
    };
  }, []);

  useLayoutEffect(() => {
    scroll.current!.watch();
    scroll.current!.settle();
    if (scroller.current!.scrollTop < NEAR_TOP_PX) nearTop.current();
  }, [content]);

  return {
    scroller,
    dock,
    atBottom,
    toBottom: () => {
      scroll.current!.follow(true);
      scroll.current!.settle();
    },
  };
}
