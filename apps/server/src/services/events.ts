import { EventEmitter } from 'node:events';
import type { WsEvent } from '@poster/core';

/** In-process event bus feeding /ws/events and internal listeners. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: WsEvent): void {
    this.emitter.emit('event', event);
  }

  on(listener: (event: WsEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
