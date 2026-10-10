import {afterEach,expect,it,vi} from 'vitest';
import {render,cleanup} from '@testing-library/react';
import {PresenceHeartbeat} from './PresenceHeartbeat';
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('foreground heartbeats pause in mobile background or offline, and resume on visibility',async()=>{
  vi.useFakeTimers();let visibility='visible',online=true;
  vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visibility as DocumentVisibilityState);
  vi.spyOn(navigator,'onLine','get').mockImplementation(()=>online);
  const fetchMock=vi.fn().mockResolvedValue(new Response('{}'));vi.stubGlobal('fetch',fetchMock);
  const component=render(<PresenceHeartbeat/>);await vi.advanceTimersByTimeAsync(25_000);expect(fetchMock).toHaveBeenCalledTimes(2);
  visibility='hidden';await vi.advanceTimersByTimeAsync(100_000);expect(fetchMock).toHaveBeenCalledTimes(2);
  visibility='visible';document.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(0);expect(fetchMock).toHaveBeenCalledTimes(3);
  online=false;await vi.advanceTimersByTimeAsync(25_000);expect(fetchMock).toHaveBeenCalledTimes(3);
  component.unmount();online=true;await vi.advanceTimersByTimeAsync(100_000);expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('releases a hung request and keeps its late completion from unlocking a newer heartbeat', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  let finishFirst!: (response: Response) => void;
  const fetchMock = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finishFirst = resolve; }))
    .mockImplementation(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetchMock);
  const component = render(<PresenceHeartbeat />);
  const firstSignal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(firstSignal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  finishFirst(new Response('{}'));
  await vi.advanceTimersByTimeAsync(0);
  window.dispatchEvent(new Event('online'));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const secondSignal = fetchMock.mock.calls[1]![1].signal as AbortSignal;
  component.unmount();
  expect(secondSignal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('cancels an in-flight heartbeat in the background and immediately resumes on return', async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetchMock);
  render(<PresenceHeartbeat />);
  const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
