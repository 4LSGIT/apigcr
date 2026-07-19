/**
 * Tests for services/pdfRenderService.js — the Phase 2B HTML→PDF layer.
 *
 * puppeteer-core is jest-mocked; what is under test is the LIFECYCLE — lazy
 * launch, the idle-close timer, relaunch after a crash, one-at-a-time
 * serialization, and the network lockdown. A REAL chromium render lives in
 * tests/pdfRenderIntegration.test.js, gated on PUPPETEER_EXECUTABLE_PATH.
 *
 *   npx jest tests/pdfRender.test.js
 */

const fs = require('fs');

jest.mock('puppeteer-core', () => ({
  launch: jest.fn(),
}));

const puppeteer = require('puppeteer-core');
const svc = require('../services/pdfRenderService');

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A controllable fake page. `requestHandlers` captures page.on('request', fn)
 * so a test can feed it fake requests mid-"navigation".
 */
function makePage(overrides = {}) {
  const page = {
    requestHandlers: [],
    setRequestInterception: jest.fn(async () => {}),
    on: jest.fn((event, fn) => {
      if (event === 'request') page.requestHandlers.push(fn);
    }),
    setContent: jest.fn(async () => {}),
    pdf: jest.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])), // %PDF
    close: jest.fn(async () => {}),
    ...overrides,
  };
  return page;
}

function makeBrowser(page) {
  return {
    connected: true,
    newPage: jest.fn(async () => page),
    close: jest.fn(async () => {}),
  };
}

function fakeRequest(url) {
  return {
    url: () => url,
    abort: jest.fn(async () => {}),
    continue: jest.fn(async () => {}),
  };
}

let existsSpy;

beforeEach(() => {
  jest.clearAllMocks();
  svc._resetForTest();
  // Deterministic binary resolution: pretend /usr/bin/chromium exists,
  // whatever machine the suite runs on.
  existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/usr/bin/chromium');
});

afterEach(() => {
  existsSpy.mockRestore();
  jest.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTABLE RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveExecutablePath', () => {
  test('finds the apt chromium', () => {
    expect(svc.resolveExecutablePath()).toBe('/usr/bin/chromium');
  });

  test('env PUPPETEER_EXECUTABLE_PATH wins over the candidates', () => {
    existsSpy.mockImplementation(() => true);
    process.env.PUPPETEER_EXECUTABLE_PATH = '/opt/custom/chrome';
    try {
      expect(svc.resolveExecutablePath()).toBe('/opt/custom/chrome');
    } finally {
      delete process.env.PUPPETEER_EXECUTABLE_PATH;
    }
  });

  test('no binary anywhere → ESIGN_RENDER_NO_BROWSER, and a miss is not memoized', () => {
    existsSpy.mockImplementation(() => false);
    expect(() => svc.resolveExecutablePath()).toThrow(expect.objectContaining({
      code: 'ESIGN_RENDER_NO_BROWSER',
    }));
    // chromium "gets installed" — the next call succeeds without a reset
    existsSpy.mockImplementation((p) => p === '/usr/bin/chromium');
    expect(svc.resolveExecutablePath()).toBe('/usr/bin/chromium');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

describe('browser lifecycle', () => {
  test('lazy: requiring the module launches nothing; first render launches once', async () => {
    expect(puppeteer.launch).not.toHaveBeenCalled();

    const page = makePage();
    puppeteer.launch.mockResolvedValue(makeBrowser(page));

    const pdf = await svc.renderHtmlToPdf('<h1>x</h1>');
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('launch args are pinned', async () => {
    const page = makePage();
    puppeteer.launch.mockResolvedValue(makeBrowser(page));
    await svc.renderHtmlToPdf('<p>x</p>');

    expect(puppeteer.launch).toHaveBeenCalledWith({
      executablePath: '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
      ],
    });
  });

  test('the browser is reused across renders while alive', async () => {
    const page = makePage();
    puppeteer.launch.mockResolvedValue(makeBrowser(page));

    await svc.renderHtmlToPdf('<p>1</p>');
    await svc.renderHtmlToPdf('<p>2</p>');
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
  });

  test('idle timer closes the browser after 60s; the next render relaunches', async () => {
    jest.useFakeTimers();

    const browser1 = makeBrowser(makePage());
    const browser2 = makeBrowser(makePage());
    puppeteer.launch.mockResolvedValueOnce(browser1).mockResolvedValueOnce(browser2);

    await svc.renderHtmlToPdf('<p>x</p>');
    expect(browser1.close).not.toHaveBeenCalled();

    jest.advanceTimersByTime(svc.IDLE_CLOSE_MS + 1);
    expect(browser1.close).toHaveBeenCalledTimes(1);

    await svc.renderHtmlToPdf('<p>y</p>');
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
  });

  test('each render RESETS the idle timer — activity keeps the browser alive', async () => {
    jest.useFakeTimers();
    const browser = makeBrowser(makePage());
    puppeteer.launch.mockResolvedValue(browser);

    await svc.renderHtmlToPdf('<p>1</p>');
    jest.advanceTimersByTime(svc.IDLE_CLOSE_MS - 1000);   // 59s of idle
    await svc.renderHtmlToPdf('<p>2</p>');                // timer re-arms
    jest.advanceTimersByTime(svc.IDLE_CLOSE_MS - 1000);   // 59s more
    expect(browser.close).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2000);                       // now past 60s idle
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  test('a dead browser (connected=false) is relaunched transparently', async () => {
    const browser1 = makeBrowser(makePage());
    const browser2 = makeBrowser(makePage());
    puppeteer.launch.mockResolvedValueOnce(browser1).mockResolvedValueOnce(browser2);

    await svc.renderHtmlToPdf('<p>1</p>');
    browser1.connected = false;                            // chromium crashed
    await svc.renderHtmlToPdf('<p>2</p>');

    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
    expect(browser2.newPage).toHaveBeenCalled();
  });

  test('a launch failure is a typed ESIGN_RENDER_FAILED, and the next attempt retries', async () => {
    puppeteer.launch
      .mockRejectedValueOnce(new Error('spawn ENOENT'))
      .mockResolvedValueOnce(makeBrowser(makePage()));

    await expect(svc.renderHtmlToPdf('<p>x</p>')).rejects.toMatchObject({
      code: 'ESIGN_RENDER_FAILED',
      message: expect.stringContaining('spawn ENOENT'),
    });
    await expect(svc.renderHtmlToPdf('<p>x</p>')).resolves.toBeInstanceOf(Buffer);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SERIALIZATION
// ─────────────────────────────────────────────────────────────────────────────

describe('render queue', () => {
  test('renders run one at a time, in call order', async () => {
    const order = [];
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });

    let call = 0;
    const page = makePage({
      setContent: jest.fn(async () => {
        call += 1;
        if (call === 1) {
          order.push('start-1');
          await gate;                  // first render parks here
          order.push('end-1');
        } else {
          order.push('start-2');
        }
      }),
    });
    puppeteer.launch.mockResolvedValue(makeBrowser(page));

    const p1 = svc.renderHtmlToPdf('<p>1</p>');
    const p2 = svc.renderHtmlToPdf('<p>2</p>');

    // Give the first render a beat to reach the gate; the second must NOT
    // have started.
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['start-1']);

    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start-1', 'end-1', 'start-2']);
  });

  test('a failed render fails ITS caller only; the queue continues', async () => {
    let call = 0;
    const page = makePage({
      setContent: jest.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('nav blew up');
      }),
    });
    puppeteer.launch.mockResolvedValue(makeBrowser(page));

    const p1 = svc.renderHtmlToPdf('<p>1</p>');
    const p2 = svc.renderHtmlToPdf('<p>2</p>');

    await expect(p1).rejects.toMatchObject({ code: 'ESIGN_RENDER_FAILED' });
    await expect(p2).resolves.toBeInstanceOf(Buffer);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NETWORK LOCKDOWN
// ─────────────────────────────────────────────────────────────────────────────

describe('network lockdown', () => {
  test('data: and about: requests continue; everything else aborts', async () => {
    const page = makePage();
    page.setContent.mockImplementation(async () => {
      const dataReq  = fakeRequest('data:image/png;base64,AAAA');
      const aboutReq = fakeRequest('about:blank');
      for (const h of page.requestHandlers) { h(dataReq); h(aboutReq); }
      expect(dataReq.continue).toHaveBeenCalled();
      expect(dataReq.abort).not.toHaveBeenCalled();
      expect(aboutReq.continue).toHaveBeenCalled();
    });
    puppeteer.launch.mockResolvedValue(makeBrowser(page));

    await svc.renderHtmlToPdf('<p>x</p>');
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);
  });

  test('an external reference fails the render with ESIGN_RENDER_EXTERNAL_REF listing the urls', async () => {
    const page = makePage();
    page.setContent.mockImplementation(async () => {
      for (const h of page.requestHandlers) {
        h(fakeRequest('https://cdn.example.com/font.woff2'));
        h(fakeRequest('https://tracker.example.com/pixel.gif'));
      }
    });
    puppeteer.launch.mockResolvedValue(makeBrowser(page));

    await expect(svc.renderHtmlToPdf('<p>x</p>')).rejects.toMatchObject({
      code: 'ESIGN_RENDER_EXTERNAL_REF',
      urls: [
        'https://cdn.example.com/font.woff2',
        'https://tracker.example.com/pixel.gif',
      ],
      message: expect.stringContaining('cdn.example.com/font.woff2'),
    });
    // no PDF was produced for a poisoned document
    expect(page.pdf).not.toHaveBeenCalled();
  });

  test('the page is closed even when the render fails', async () => {
    const page = makePage({ pdf: jest.fn(async () => { throw new Error('print died'); }) });
    puppeteer.launch.mockResolvedValue(makeBrowser(page));

    await expect(svc.renderHtmlToPdf('<p>x</p>')).rejects.toMatchObject({ code: 'ESIGN_RENDER_FAILED' });
    expect(page.close).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OPTIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('pdf options', () => {
  test('defaults: Letter, 0.75in margins, printBackground', async () => {
    const page = makePage();
    puppeteer.launch.mockResolvedValue(makeBrowser(page));
    await svc.renderHtmlToPdf('<p>x</p>');

    expect(page.pdf).toHaveBeenCalledWith({
      format: 'Letter',
      margin: { top: '0.75in', bottom: '0.75in', left: '0.75in', right: '0.75in' },
      printBackground: true,
    });
  });

  test('caller format/margins are honored', async () => {
    const page = makePage();
    puppeteer.launch.mockResolvedValue(makeBrowser(page));
    await svc.renderHtmlToPdf('<p>x</p>', {
      format: 'A4',
      margins: { top: '1in', bottom: '1in', left: '0.5in', right: '0.5in' },
    });

    expect(page.pdf).toHaveBeenCalledWith(expect.objectContaining({
      format: 'A4',
      margin: { top: '1in', bottom: '1in', left: '0.5in', right: '0.5in' },
    }));
  });

  test('setContent runs with networkidle0 and the 15s timeout', async () => {
    const page = makePage();
    puppeteer.launch.mockResolvedValue(makeBrowser(page));
    await svc.renderHtmlToPdf('<p>x</p>');

    expect(page.setContent).toHaveBeenCalledWith('<p>x</p>', {
      waitUntil: 'networkidle0',
      timeout: 15000,
    });
  });
});
