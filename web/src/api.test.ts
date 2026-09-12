import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './api';
import { setUiLanguage } from './ui-language';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setUiLanguage('zh-CN');
});

describe('streamed messages', () => {
  it('also includes the selected language in non-streaming requests', async () => {
    setUiLanguage('en');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await apiClient.sendMessage('project-1', 'hello', null);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toMatchObject({ content: 'hello', display_language: 'en' });
  });
  it('returns the final answer after the stream sends its done frame', async () => {
    setUiLanguage('en');
    const payload = {
      user_message: { message_id: 'user-1' },
      assistant_message: { message_id: 'assistant-1' },
      teaching_phase: 'orienting',
      validation_errors: [],
      tools_used: [],
      state_changed: false,
    };
    const cancel = vi.fn();
    const read = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode(
          `event: result\ndata: ${JSON.stringify(payload)}\n\n`,
        ),
      })
      .mockResolvedValueOnce({ done: true, value: new Uint8Array() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => ({ read, cancel }) },
    }));

    await expect(apiClient.sendMessageStream(
      'project-1',
      '你好',
      null,
      () => undefined,
      false,
      'last-user',
      'previous-run',
    )).resolves.toMatchObject(payload);
    const request = vi.mocked(fetch).mock.calls[0]![1];
    expect(JSON.parse(request!.body as string)).toMatchObject({
      replace_message_id: 'last-user', retry_run_id: 'previous-run', content: '你好', display_language: 'en',
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('forwards the connected run id before model progress arrives', async () => {
    const payload = {
      user_message: { message_id: 'user-1' },
      assistant_message: { message_id: 'assistant-1' },
      teaching_phase: 'orienting',
      validation_errors: [],
      tools_used: [],
      state_changed: false,
    };
    const onProgress = vi.fn();
    const read = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode(
          `event: connected\ndata: {"project_id":"project-1","run_id":"run-1"}\n\n`
          + `event: result\ndata: ${JSON.stringify(payload)}\n\n`,
        ),
      })
      .mockResolvedValueOnce({ done: true, value: new Uint8Array() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => ({ read, cancel: vi.fn().mockResolvedValue(undefined) }) },
    }));

    await apiClient.sendMessageStream('project-1', '你好', null, onProgress);

    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      run_id: 'run-1',
      stage: 'run_connected',
    }));
  });

  it('preserves the server cancellation code from an error frame', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode(
          'event: error\ndata: {"message":"本轮回答已取消。","code":"cancelled"}\n\n',
        ),
      })
      .mockResolvedValueOnce({ done: true, value: new Uint8Array() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => ({ read, cancel: vi.fn() }) },
    }));

    await expect(apiClient.sendMessageStream(
      'project-1',
      '取消测试',
      null,
      () => undefined,
    )).rejects.toMatchObject({
      message: '已取消。',
      code: 'cancelled',
    });
  });

  it('retries the original POST when the first network failure happened before connected', async () => {
    vi.useFakeTimers();
    const payload = {
      user_message: { message_id: 'user-1' },
      assistant_message: { message_id: 'assistant-1' },
      teaching_phase: 'orienting',
      validation_errors: [],
      tools_used: [],
      state_changed: false,
    };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(
                  `event: connected\ndata: {"project_id":"project-1","run_id":"run-1"}\n\n`
                  + `event: result\ndata: ${JSON.stringify(payload)}\n\n`,
                ),
              })
              .mockResolvedValueOnce({ done: true, value: new Uint8Array() }),
          }),
        },
      });
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = apiClient.sendMessageStream('project-1', '你好', null, () => undefined);
    await vi.advanceTimersByTimeAsync(500);
    await expect(resultPromise).resolves.toMatchObject(payload);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/projects/project-1/messages/stream');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/api/projects/project-1/messages/stream');
    expect(secondInit.method).toBe('POST');
    expect(JSON.parse(String(secondInit.body)).run_id).toBe(JSON.parse(String(firstInit.body)).run_id);
  });

  it('switches to GET after a connected stream is interrupted and resumes after the last sequence', async () => {
    vi.useFakeTimers();
    const payload = {
      user_message: { message_id: 'user-1' },
      assistant_message: { message_id: 'assistant-1' },
      teaching_phase: 'orienting',
      validation_errors: [],
      tools_used: [],
      state_changed: false,
    };
    const progress = vi.fn();
    const firstRead = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode(
          'event: connected\ndata: {"project_id":"project-1","run_id":"run-1"}\n\n'
          + 'event: progress\ndata: {"run_id":"run-1","sequence":1,"stage":"one","label":"one","status":"running","elapsed_ms":1}\n\n',
        ),
      })
      .mockRejectedValueOnce(new TypeError('socket closed'));
    const secondRead = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode(
          'event: connected\ndata: {"project_id":"project-1","run_id":"run-1","resumed":true}\n\n'
          + 'event: progress\ndata: {"run_id":"run-1","sequence":2,"stage":"two","label":"two","status":"completed","elapsed_ms":2}\n\n'
          + `event: result\ndata: ${JSON.stringify(payload)}\n\n`
          + 'event: done\ndata: {}\n\n',
        ),
      })
      .mockResolvedValueOnce({ done: true, value: new Uint8Array() });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: { getReader: () => ({ read: firstRead }) } })
      .mockResolvedValueOnce({ ok: true, status: 200, body: { getReader: () => ({ read: secondRead }) } });
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = apiClient.sendMessageStream('project-1', '你好', null, progress);
    await vi.advanceTimersByTimeAsync(500);
    await expect(resultPromise).resolves.toMatchObject(payload);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/api/projects/project-1/runs/run-1/stream?after=1');
    const getInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(getInit.headers).get('Last-Event-ID')).toBe('1');
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'reconnecting' }));
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'run_reconnected' }));
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ sequence: 2 }));
  });

  it('stops after five transport retries and exposes a client network error', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = apiClient.sendMessageStream('project-1', '你好', null, () => undefined);
    const rejection = expect(resultPromise).rejects.toMatchObject({ code: 'client_network_error' });
    await vi.runAllTimersAsync();
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe('JSON request headers', () => {
  it('only sends JSON content type when a request has a body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    await apiClient.createGuest();
    await apiClient.createProject({ kind: 'github', value: 'https://github.com/example/repo' });

    const guestHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const projectHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(guestHeaders.has('Content-Type')).toBe(false);
    expect(projectHeaders.get('Content-Type')).toBe('application/json');
  });
});
