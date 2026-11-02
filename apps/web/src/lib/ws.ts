import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WsEvent } from '@poster/core';

export function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

/**
 * Keeps one `/ws/events` connection open for the app's lifetime and invalidates queries on events.
 * Reconnects with exponential backoff (1 s → 30 s).
 */
export function useLiveEvents(enabled = true): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl('/ws/events'));
      } catch {
        schedule();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (ev) => {
        let msg: WsEvent | null = null;
        try {
          msg = JSON.parse(String(ev.data)) as WsEvent;
        } catch {
          return;
        }
        if (!msg) return;
        switch (msg.type) {
          case 'post.updated':
          case 'target.updated':
            void qc.invalidateQueries({ queryKey: ['posts'] });
            void qc.invalidateQueries({ queryKey: ['post', msg.postId] });
            void qc.invalidateQueries({ queryKey: ['system'] });
            break;
          case 'account.updated':
            void qc.invalidateQueries({ queryKey: ['accounts'] });
            break;
          case 'notification.updated':
            void qc.invalidateQueries({ queryKey: ['notifications'] });
            break;
          case 'browser.session':
            void qc.invalidateQueries({ queryKey: ['accounts'] });
            break;
          case 'ping':
          default:
            break;
        }
      };
      ws.onclose = () => {
        ws = null;
        schedule();
      };
      ws.onerror = () => {
        ws?.close();
      };
    };

    const schedule = () => {
      if (closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt);
      attempt = Math.min(attempt + 1, 5);
      timer = setTimeout(connect, delay);
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [qc, enabled]);
}
