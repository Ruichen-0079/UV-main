import { useEffect, useRef, useState } from "react";
import { subscribeSubtitleProjection } from "./subtitle-bus.js";
import { paginateSubtitleText, subtitlePageDurationMs } from "./subtitle-projection.js";
import { isTauriRuntime, preloadTauriWindowApi, startWindowDragging } from "./tauri-window.js";

type VisiblePage = {
  messageId: string;
  pageIndex: number;
  text: string;
  language?: string | undefined;
};

/**
 * Subtitle Presentation surface: renders already-committed assistant text
 * only. No chat input, Memory writes, language choice, or TTS admission.
 */
export function SubtitlePage(): JSX.Element {
  const [page, setPage] = useState<VisiblePage | null>(null);
  const [visible, setVisible] = useState(false);
  const pagesRef = useRef<string[]>([]);
  const messageIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const languageRef = useRef<string | undefined>(undefined);
  const pageIndexRef = useRef(0);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);


  useEffect(() => {
    void preloadTauriWindowApi();
  }, []);

  useEffect(() => {
    return subscribeSubtitleProjection((message) => {
      if (message.kind === "clear") {
        clearTimer();
        pagesRef.current = [];
        messageIdRef.current = null;
        pageIndexRef.current = 0;
        setPage(null);
        setVisible(false);
        return;
      }

      const pages = paginateSubtitleText(message.text);
      if (pages.length === 0) {
        clearTimer();
        pagesRef.current = [];
        messageIdRef.current = null;
        setPage(null);
        setVisible(false);
        return;
      }

      clearTimer();
      pagesRef.current = pages;
      languageRef.current = message.language;
      messageIdRef.current = message.messageId;
      pageIndexRef.current = 0;
      presentPage(0);
    });

    function clearTimer(): void {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    function presentPage(index: number): void {
      const pages = pagesRef.current;
      const messageId = messageIdRef.current;
      const text = pages[index];
      if (!messageId || text === undefined) {
        setVisible(false);
        setPage(null);
        return;
      }
      pageIndexRef.current = index;
      setPage({ messageId, pageIndex: index, text, language: languageRef.current });
      setVisible(true);
      clearTimer();
      timerRef.current = setTimeout(() => {
        const next = index + 1;
        if (next < pages.length) {
          // Soft fade between pages: briefly hide then show next.
          setVisible(false);
          timerRef.current = setTimeout(() => presentPage(next), 120);
        } else {
          setVisible(false);
          timerRef.current = setTimeout(() => {
            setPage(null);
            timerRef.current = null;
          }, 280);
        }
      }, subtitlePageDurationMs(text));
    }
  }, []);

  return (
    <div
      className="yuvi-subtitle-root"
      data-testid="subtitle-surface"
      onPointerDown={(event) => {
        if (!isTauriRuntime() || event.button !== 0) return;
        event.preventDefault();
        void startWindowDragging();
      }}
    >
      <div
        className={`yuvi-subtitle-band${visible && page ? " is-visible" : ""}`}
        aria-live="polite"
        lang={page?.language}
        data-message-id={page?.messageId ?? undefined}
        data-page-index={page ? String(page.pageIndex) : undefined}
      >
        {page ? <p className="yuvi-subtitle-text">{page.text}</p> : null}
      </div>
    </div>
  );
}
