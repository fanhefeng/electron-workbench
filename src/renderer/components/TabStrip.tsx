import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { Globe2, LoaderCircle, Plus, X } from 'lucide-react';
import type { Snapshot, Tab } from '../../shared/model.ts';
import type { Translate } from '../i18n';
import { Button, IconButton } from './Primitives';

const tabDragType = 'application/x-workbench-tab';
type DropTarget = { id: string; edge: 'before' | 'after'; to: string };

export function TabStrip({
  state,
  t,
  run,
  newTab,
  showAllTabs,
}: {
  state: Snapshot;
  t: Translate;
  run: (task: Promise<unknown>) => void;
  newTab: () => void;
  showAllTabs: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const overflowTrigger = useRef<HTMLButtonElement>(null);
  const dragId = useRef<string | null>(null);
  const pointerX = useRef<number | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [overflow, setOverflow] = useState(false);
  const { tabs, activeTabId, page } = state;
  const order = tabs.map((tab) => tab.id).join(',');

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const trigger = overflowTrigger.current;
      const gap = parseFloat(getComputedStyle(element.closest('.tab-strip')!).columnGap) || 0;
      // Compare with the width available without the trigger, so it cannot sustain its own overflow.
      const available = element.clientWidth + (trigger ? trigger.offsetWidth + gap : 0);
      setOverflow(element.scrollWidth > available + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (overflowTrigger.current) observer.observe(overflowTrigger.current);
    return () => observer.disconnect();
  }, [order, overflow]);

  const clearDrag = useCallback(() => {
    dragId.current = null;
    pointerX.current = null;
    setDragging(null);
    setDropTarget(null);
  }, []);

  const findDrop = useCallback(
    (x: number): DropTarget | null => {
      const remaining = Array.from(
        scroller.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [],
      ).filter((element) => element.dataset.tabId !== dragId.current);
      if (!remaining.length || !tabs.some((tab) => tab.id === dragId.current)) return null;
      const before = remaining.findIndex((element) => {
        const rect = element.getBoundingClientRect();
        return x < rect.x + rect.width / 2;
      });
      const slot = before < 0 ? remaining.length : before;
      // Resolve the final index against the order that still includes the source.
      const to = tabs[slot]?.id;
      if (!to || to === dragId.current) return null;
      const anchor = remaining[before < 0 ? remaining.length - 1 : before];
      return { id: anchor.dataset.tabId!, edge: before < 0 ? 'after' : 'before', to };
    },
    [tabs],
  );

  const showDrop = useCallback((target: DropTarget | null) => {
    setDropTarget((previous) =>
      previous?.id === target?.id && previous?.edge === target?.edge && previous?.to === target?.to
        ? previous
        : target,
    );
  }, []);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      // Horizontal trackpad gestures retain native scrolling; ordinary mouse wheels
      // scroll the strip horizontally. Pinch-to-zoom remains a browser gesture.
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      if (element.scrollWidth <= element.clientWidth) return;
      const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? element.clientWidth : 1;
      event.preventDefault();
      element.scrollLeft += event.deltaY * unit;
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const reveal = () => {
      if (dragId.current || page !== 'workspace') return;
      document.getElementById(`tab-${activeTabId}`)?.parentElement?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      });
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeTabId, page, order]);

  useEffect(() => {
    if (!dragging) return;
    const animation = {
      frame: 0,
      previousTime: 0,
      previousScroll: undefined as number | undefined,
    };
    const tick = (time: number) => {
      const element = scroller.current;
      if (!element || !tabs.some((tab) => tab.id === dragging)) {
        clearDrag();
        return;
      }
      const x = pointerX.current;
      const elapsed = Math.min(32, animation.previousTime ? time - animation.previousTime : 16);
      animation.previousTime = time;
      if (x !== null) {
        const rect = element.getBoundingClientRect();
        const edge = 44;
        const speed =
          x < rect.left + edge
            ? -Math.min(1, (rect.left + edge - x) / edge)
            : x > rect.right - edge
              ? Math.min(1, (x - rect.right + edge) / edge)
              : 0;
        element.scrollLeft += speed * elapsed * 0.6;
        if (element.scrollLeft !== animation.previousScroll) showDrop(findDrop(x));
        animation.previousScroll = element.scrollLeft;
      }
      animation.frame = requestAnimationFrame(tick);
    };
    animation.frame = requestAnimationFrame(tick);
    // Native dragend also covers Escape and drops outside the strip/window.
    window.addEventListener('dragend', clearDrag);
    return () => {
      cancelAnimationFrame(animation.frame);
      window.removeEventListener('dragend', clearDrag);
    };
  }, [dragging, tabs, clearDrag, findDrop, showDrop]);

  const focusTab = (id: string) => {
    const button = document.getElementById(`tab-${id}`);
    button?.focus({ preventScroll: true });
    button?.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const moveTab = (from: string, to: string) => {
    const focused = document.activeElement;
    run(
      window.desktop.reorderTabs(from, to).then(() => {
        if (
          document.activeElement === focused ||
          (document.activeElement === document.body && focused && !focused.isConnected)
        )
          focusTab(from);
      }),
    );
  };
  const closeTab = (id: string, restoreFocus = false) => {
    const trigger = document.getElementById(`tab-${id}`);
    run(
      window.desktop.closeTab(id).then(async (closed) => {
        if (!closed || !restoreFocus) return;
        const current = await window.desktop.getSnapshot();
        if (document.activeElement === trigger || document.activeElement === document.body)
          focusTab(current.page === 'workspace' ? current.activeTabId : 'home');
      }),
    );
  };
  const tabKey = (event: KeyboardEvent, id: string) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Delete') {
      if (id !== 'home') closeTab(id, true);
      return;
    }
    const ids = ['home', ...tabs.map((tab) => tab.id)];
    const index = ids.indexOf(id);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? ids.length - 1
          : Math.max(0, Math.min(ids.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
    if (event.altKey) {
      const destination = ids[Math.max(1, next)];
      if (id !== 'home' && destination && destination !== id) moveTab(id, destination);
    } else {
      run(window.desktop.activateTab(ids[next]));
      focusTab(ids[next]);
    }
  };

  const renderTab = (tab?: Tab) => {
    const id = tab?.id ?? 'home';
    const selected = activeTabId === id && page === 'workspace';
    return (
      <div
        className={`tab ${selected ? 'selected' : ''}`}
        data-kind={tab ? 'page' : 'home'}
        data-tab-id={tab?.id}
        data-dragging={dragging === id || undefined}
        data-drop-edge={dropTarget?.id === id ? dropTarget.edge : undefined}
        key={id}
      >
        <button
          id={`tab-${id}`}
          role="tab"
          aria-selected={selected}
          aria-busy={tab?.loading || undefined}
          aria-controls="workspace-panel"
          aria-keyshortcuts={tab ? 'Alt+ArrowLeft Alt+ArrowRight' : undefined}
          tabIndex={selected || (page !== 'workspace' && id === 'home') ? 0 : -1}
          title={tab ? `${tab.title} · ${t('dragHint')}` : t('home')}
          draggable={!!tab}
          onDragStart={(event) => {
            if (!tab) return;
            event.dataTransfer.setData(tabDragType, id);
            event.dataTransfer.effectAllowed = 'move';
            const element = event.currentTarget.parentElement!;
            const rect = element.getBoundingClientRect();
            event.dataTransfer.setDragImage(
              element,
              event.clientX - rect.x,
              event.clientY - rect.y,
            );
            dragId.current = id;
            setDragging(id);
          }}
          onDragEnd={clearDrag}
          onKeyDown={(event) => tabKey(event, id)}
          onClick={() => run(window.desktop.activateTab(id))}
          onFocus={(event) =>
            event.currentTarget.parentElement?.scrollIntoView({
              block: 'nearest',
              inline: 'nearest',
            })
          }
        >
          {tab && (
            <span className="tab-leading" aria-hidden="true">
              <TabIcon tab={tab} />
            </span>
          )}
          <span className="tab-label">{tab?.title ?? t('home')}</span>
        </button>
        {tab && (
          <button
            className="tab-close"
            aria-label={`${t('close')} ${tab.title}`}
            onClick={() => closeTab(id)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };
  const acceptDrag = (event: DragEvent<HTMLDivElement>) => {
    if (!dragId.current || !event.dataTransfer.types.includes(tabDragType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    pointerX.current = event.clientX;
    showDrop(findDrop(event.clientX));
  };

  return (
    <div className="tab-strip">
      <div
        className="tab-list"
        role="tablist"
        aria-label={t('pages')}
        aria-description={t('tabScrollHint')}
      >
        {renderTab()}
        <div
          ref={scroller}
          className="tab-scroll"
          onDragEnter={acceptDrag}
          onDragOver={acceptDrag}
          onDragLeave={(event) => {
            if (
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            )
              return;
            pointerX.current = null;
            showDrop(null);
          }}
          onDrop={(event) => {
            const from = dragId.current;
            if (!from || event.dataTransfer.getData(tabDragType) !== from) return;
            event.preventDefault();
            const target = findDrop(event.clientX);
            clearDrag();
            if (target) moveTab(from, target.to);
          }}
        >
          {tabs.map((tab) => renderTab(tab))}
        </div>
      </div>
      {overflow && (
        <Button
          ref={overflowTrigger}
          id="all-tabs-trigger"
          className="tab-overflow-trigger"
          variant="ghost"
          size="small"
          aria-haspopup="dialog"
          onClick={showAllTabs}
        >
          {t('allTabs')} ({tabs.length})
        </Button>
      )}
      <IconButton label={t('newTab')} onClick={newTab}>
        <Plus size={16} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

function TabIcon({ tab }: { tab: Tab }) {
  const [failedIcon, setFailedIcon] = useState<string>();
  if (tab.loading) return <LoaderCircle size={13} className="spinner" />;
  if (tab.favicon && tab.favicon !== failedIcon)
    return (
      <img src={tab.favicon} alt="" draggable={false} onError={() => setFailedIcon(tab.favicon)} />
    );
  return <Globe2 size={13} />;
}
