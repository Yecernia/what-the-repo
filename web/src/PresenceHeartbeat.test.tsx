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
