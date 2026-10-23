// A WebSocket that reconnects by itself.

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export class Connection {
  private ws: WebSocket | null = null;
  private retryDelay = 500;
  private retryTimer: number | null = null;
  status: ConnectionStatus = 'connecting';
  onMessage: (msg: Record<string, unknown>) => void = () => {};
  onOpen: () => void = () => {};
  onStatus: (status: ConnectionStatus) => void = () => {};

  start(): void {
    this.connect();
    // Phones suspend sockets in the background; reconnect right away on return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.status !== 'online') this.connectNow();
    });
    window.addEventListener('online', () => this.connectNow());
  }

  private connectNow(): void {
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
    this.retryDelay = 500;
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.connect();
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.onStatus(status);
  }

  private connect(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    const url = new URL('ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.hash = '';
    url.search = '';
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.retryDelay = 500;
      this.setStatus('online');
      this.onOpen();
    };
    ws.onmessage = (e) => {
      let msg: unknown;
      try { msg = JSON.parse(e.data as string); } catch { return; }
      if (msg && typeof msg === 'object') this.onMessage(msg as Record<string, unknown>);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus('offline');
      this.retryTimer = window.setTimeout(() => { this.retryTimer = null; this.connect(); }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 5000);
    };
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: unknown): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }
}
