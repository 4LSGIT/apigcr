const { environmentName, processAlertMeta } = require('../lib/processAlertMeta');

describe('process-level alert metadata', () => {
  test('uses the explicit environment in both context and grouping', () => {
    const meta = processAlertMeta({
      env: {
        ENVIRONMENT: 'Development',
        HOSTNAME: 'fredbook',
      },
      pid: 123,
      nodeVersion: 'v24.18.0',
      build: 'mt-42',
    });

    expect(meta.groupKey('uncaught_exception')).toBe('app:development:uncaught_exception');
    expect(meta.context).toEqual({
      environment: 'development',
      service: null,
      revision: null,
      instance: 'fredbook',
      build: 'mt-42',
      pid: 123,
      node_version: 'v24.18.0',
    });
  });

  test('identifies Cloud Run as production when no explicit environment exists', () => {
    const meta = processAlertMeta({
      env: {
        K_SERVICE: 'yisracase',
        K_REVISION: 'yisracase-00100-abc',
      },
      pid: 456,
      nodeVersion: 'v24.18.0',
    });

    expect(meta.groupKey('unhandled_rejection')).toBe('app:production:unhandled_rejection');
    expect(meta.context).toMatchObject({
      environment: 'production',
      service: 'yisracase',
      revision: 'yisracase-00100-abc',
      build: 'yisracase-00100-abc',
    });
  });

  test('normalizes unsafe environment text for the bounded group key', () => {
    expect(environmentName({ ENVIRONMENT: ' QA / Blue ' })).toBe('qa-blue');
    expect(environmentName({})).toBe('unknown');
  });
});
