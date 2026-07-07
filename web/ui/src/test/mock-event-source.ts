// A controllable EventSource for tests: components open streams normally, tests push events with
// MockEventSource.emit(url, event). Instances register by URL.
type Listener = (ev: MessageEvent) => void;

export class MockEventSource {
  static instances = new Map<string, MockEventSource[]>();
  static reset() { MockEventSource.instances.clear(); }
  /** Push a server event to every open stream whose URL contains `urlPart`. */
  static emit(urlPart: string, data: unknown) {
    for (const [url, list] of MockEventSource.instances) {
      if (!url.includes(urlPart)) continue;
      for (const es of list) es.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
  }
  static openCount(urlPart: string) {
    let n = 0;
    for (const [url, list] of MockEventSource.instances) if (url.includes(urlPart)) n += list.filter((e) => e.readyState === 1).length;
    return n;
  }

  url: string;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: Listener | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    const list = MockEventSource.instances.get(url) ?? [];
    list.push(this);
    MockEventSource.instances.set(url, list);
    queueMicrotask(() => this.onopen?.());
  }
  close() { this.readyState = 2; }
}
