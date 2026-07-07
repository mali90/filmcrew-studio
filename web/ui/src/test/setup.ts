import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { server } from './msw';
import { MockEventSource } from './mock-event-source';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); cleanup(); MockEventSource.reset(); });
afterAll(() => server.close());

// jsdom has no EventSource — every test drives SSE through the controllable mock
(globalThis as Record<string, unknown>).EventSource = MockEventSource;

// jsdom media elements can't play — stub the methods the player calls
Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: () => Promise.resolve() });
Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: () => {} });
