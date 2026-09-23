import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { warnOnce } from '../../src/shared/warn-once';

describe('warnOnce', () => {
  const originalWarn = console.warn;
  let warn: ReturnType<typeof mock>;

  beforeEach(() => {
    warn = mock(() => {});
    console.warn = warn;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it('logs the message on the first call only', () => {
    const warnDeprecated = warnOnce('deprecated');

    warnDeprecated();
    warnDeprecated();
    warnDeprecated();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('deprecated');
  });

  it('logs nothing until it is called', () => {
    warnOnce('deprecated');

    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a separate once-flag per warning', () => {
    const warnFirst = warnOnce('first');
    const warnSecond = warnOnce('second');

    warnFirst();
    warnSecond();
    warnFirst();

    expect(warn.mock.calls).toEqual([['first'], ['second']]);
  });
});
