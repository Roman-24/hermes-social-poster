import * as React from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Network } from '@poster/core';
import { NETWORK_LABELS } from '@/lib/networks';
import { wsUrl } from '@/lib/ws';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/dialog';
import { PageHeader } from '@/components/layout';
import { remoteBrowserRoute } from '@/router';

const VIEW_W = 1280;
const VIEW_H = 800;

type SessionState = 'connecting' | 'started' | 'logged_in' | 'saved' | 'closed' | 'error';

interface ServerMsg {
  type: 'frame' | 'state' | 'url';
  data?: string;
  width?: number;
  height?: number;
  state?: Exclude<SessionState, 'connecting'>;
  message?: string;
  url?: string;
}

function modifiersOf(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

function buttonName(b: number): 'left' | 'middle' | 'right' | 'none' {
  return b === 0 ? 'left' : b === 1 ? 'middle' : b === 2 ? 'right' : 'none';
}

export function RemoteBrowserPage() {
  const { network, sessionId } = useParams({ from: remoteBrowserRoute.id });
  const qc = useQueryClient();
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const [state, setState] = React.useState<SessionState>('connecting');
  const [message, setMessage] = React.useState<string>('');
  const [url, setUrl] = React.useState('');
  const [urlInput, setUrlInput] = React.useState('');
  const [paste, setPaste] = React.useState('');
  const [frames, setFrames] = React.useState(0);
  const [confirmSave, setConfirmSave] = React.useState(false);
  const lastMoveRef = React.useRef(0);
  const lastUrlRef = React.useRef('');
  const label = NETWORK_LABELS[network as Network] ?? network;

  const send = React.useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  React.useEffect(() => {
    const ws = new WebSocket(wsUrl(`/ws/browser/${encodeURIComponent(sessionId)}`));
    wsRef.current = ws;
    ws.onopen = () => {
      setState((s) => (s === 'connecting' ? 'started' : s));
      setMessage('Connected to the remote browser.');
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.type === 'frame' && msg.data) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const img = new Image();
        img.onload = () => {
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          setFrames((n) => (n + 1) % 1_000_000);
        };
        img.src = `data:image/jpeg;base64,${msg.data}`;
      } else if (msg.type === 'state' && msg.state) {
        setState(msg.state);
        if (msg.message) setMessage(msg.message);
        else if (msg.state === 'logged_in')
          setMessage('Logged-in session detected. Click "Save login" to store it.');
        else if (msg.state === 'saved') setMessage('Login saved. The session is closed.');
        else if (msg.state === 'closed') setMessage('Session closed.');
        if (msg.state === 'saved' || msg.state === 'closed')
          void qc.invalidateQueries({ queryKey: ['accounts'] });
      } else if (msg.type === 'url' && msg.url) {
        const next = msg.url;
        const previous = lastUrlRef.current;
        lastUrlRef.current = next;
        setUrl(next);
        // Follow the page's URL unless the user has started editing the bar.
        setUrlInput((cur) => (cur === '' || cur === previous ? next : cur));
      }
    };
    ws.onclose = () => {
      setState((s) => (s === 'saved' || s === 'error' ? s : 'closed'));
    };
    ws.onerror = () => {
      setState('error');
      setMessage('WebSocket error. The session may have expired.');
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId, qc]);

  const live = state === 'started' || state === 'logged_in';

  const toViewport = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    const y = ((e.clientY - rect.top) / rect.height) * VIEW_H;
    return {
      x: Math.max(0, Math.min(VIEW_W, Math.round(x))),
      y: Math.max(0, Math.min(VIEW_H, Math.round(y))),
    };
  };

  const onMouse =
    (event: 'mousePressed' | 'mouseReleased' | 'mouseMoved') =>
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!live) return;
      if (event === 'mouseMoved') {
        const now = performance.now();
        if (now - lastMoveRef.current < 33) return;
        lastMoveRef.current = now;
      } else {
        e.preventDefault();
        e.currentTarget.focus();
      }
      const { x, y } = toViewport(e);
      send({
        type: 'mouse',
        event,
        x,
        y,
        button: event === 'mouseMoved' ? (e.buttons & 1 ? 'left' : 'none') : buttonName(e.button),
        clickCount: event === 'mouseMoved' ? 0 : Math.max(1, e.detail),
        modifiers: modifiersOf(e),
      });
    };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!live) return;
    const { x, y } = toViewport(e);
    send({
      type: 'mouse',
      event: 'mouseWheel',
      x,
      y,
      deltaX: Math.round(e.deltaX),
      deltaY: Math.round(e.deltaY),
      modifiers: modifiersOf(e),
    });
  };

  const onKey = (event: 'keyDown' | 'keyUp') => (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!live) return;
    // Keep browser shortcuts that would leave the page from firing; let copy/paste through to the remote page.
    const preventKeys = [
      'Tab',
      'Backspace',
      ' ',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'PageUp',
      'PageDown',
      'Home',
      'End',
      'Enter',
      '/',
      "'",
    ];
    if (preventKeys.includes(e.key) || e.key.startsWith('F')) e.preventDefault();
    const printable = e.key.length === 1;
    send({
      type: 'key',
      event,
      key: e.key,
      code: e.code,
      text:
        event === 'keyDown' && printable && !e.ctrlKey && !e.metaKey && !e.altKey
          ? e.key
          : undefined,
      modifiers: modifiersOf(e),
      windowsVirtualKeyCode: e.keyCode,
    });
  };

  const navigateTo = () => {
    const target = urlInput.trim();
    if (target)
      send({ type: 'navigate', url: target.startsWith('http') ? target : `https://${target}` });
  };

  const sendPaste = () => {
    if (paste) {
      send({ type: 'text', text: paste });
      setPaste('');
    }
  };

  const doSave = () => {
    setConfirmSave(false);
    send({ type: 'save' });
    setMessage('Saving the login…');
  };

  const doClose = () => {
    send({ type: 'close' });
  };

  return (
    <div>
      <PageHeader
        title={`${label} login`}
        description="Log in as usual, including 2FA. Nothing is stored until you click Save."
        actions={
          <>
            <Button
              onClick={() => (state === 'logged_in' ? doSave() : setConfirmSave(true))}
              disabled={!live}
              className={cn(state === 'logged_in' && 'ring-2 ring-ring')}
            >
              Save login
            </Button>
            <Button variant="outline" onClick={doClose} disabled={!live}>
              Cancel
            </Button>
            <Button variant="ghost" asChild>
              <Link to="/accounts">Back to accounts</Link>
            </Button>
          </>
        }
      />

      <div
        className={cn(
          'mb-3 rounded-md border p-2 text-sm',
          state === 'logged_in' && 'border-success/50 bg-success/10 text-success',
          state === 'error' && 'border-danger/50 bg-danger/10 text-danger',
          (state === 'saved' || state === 'closed') && 'border-border bg-accent',
          (state === 'connecting' || state === 'started') && 'border-border',
        )}
      >
        <span className="font-medium capitalize">{state.replace('_', ' ')}</span>
        {message ? <span className="text-muted"> · {message}</span> : null}
        {live && frames === 0 ? (
          <span className="text-muted"> · waiting for the first frame…</span>
        ) : null}
      </div>

      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <div className="flex flex-1 gap-2">
          <Input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigateTo();
            }}
            placeholder={url || 'https://'}
            spellCheck={false}
            disabled={!live}
            aria-label="URL"
          />
          <Button variant="secondary" onClick={navigateTo} disabled={!live}>
            Go
          </Button>
        </div>
        <div className="flex flex-1 gap-2">
          <Input
            type="password"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendPaste();
            }}
            placeholder="Text to paste into the focused field"
            autoComplete="off"
            disabled={!live}
            aria-label="Paste text"
          />
          <Button variant="secondary" onClick={sendPaste} disabled={!live || !paste}>
            Paste text
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-black">
        <canvas
          ref={canvasRef}
          width={VIEW_W}
          height={VIEW_H}
          tabIndex={0}
          className={cn(
            'block w-full select-none',
            live ? 'cursor-default' : 'cursor-not-allowed opacity-60',
          )}
          style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
          onMouseDown={onMouse('mousePressed')}
          onMouseUp={onMouse('mouseReleased')}
          onMouseMove={onMouse('mouseMoved')}
          onWheel={onWheel}
          onKeyDown={onKey('keyDown')}
          onKeyUp={onKey('keyUp')}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={`Remote ${label} browser`}
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        Click the view to focus it, then type. Use "Paste text" for passwords and codes. The session
        closes by itself after a few idle minutes. Only {label} hosts can be opened here.
      </p>
      {state === 'saved' || state === 'closed' ? (
        <div className="mt-4">
          <Button asChild>
            <Link to="/accounts">Back to accounts</Link>
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmSave}
        onOpenChange={setConfirmSave}
        title="Save login now?"
        description="A logged-in session was not detected yet. Saving anyway stores whatever cookies the browser currently has."
        confirmLabel="Save anyway"
        onConfirm={doSave}
      />
    </div>
  );
}
