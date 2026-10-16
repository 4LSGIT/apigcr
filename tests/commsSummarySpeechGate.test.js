// tests/commsSummarySpeechGate.test.js
//
// Comms archive v4.2 (services/commsSummarizeSweep.js, pure parts): the
// tightened RECORDING cue — live receptionist phrases are no longer a
// "recording", canonical recorded phrasings still are — as substantiveSpeakers
// (the guided retry) reads it, and the NO-SPEECH gate (speechGate), which
// skips a call with nothing but greetings, fillers, menus or hold / voicemail
// greetings. Real modules, synthetic transcripts; no DB.

'use strict';

const sweep = require('../services/commsSummarizeSweep');

const segs = (...lines) => lines.map(([s, t], i) => ({ s, a: i, b: i + 1, t }));
const gate = (...lines) => sweep.speechGate(segs(...lines));

describe('v4.2 RECORDING: canonical recorded phrasings only', () => {
  test('a live receptionist\'s phrases are not a recording', () => {
    for (const t of ['Please hold.', 'He is not available right now.', 'They are not available today.',
      'Would you like to leave a message?', 'Please stay on the line while I transfer you.',
      'Your mailbox was full, so I could not leave a message.', 'I will leave a voicemail for him.',
      'Please leave your name and number and I will have him call you.', 'Please leave a message for him with me.',
      'What is the number you called me from?', 'Is that the number you called from?',
      // a request to someone, and a caller's own conditional, are speech
      'Could you please leave a message to Stuart that I need the papers by Friday.', 'Please leave a message, for Stuart.',
      'Can you please leave a message on his desk?', 'If I don\'t answer please leave a message.',
      'And if I don\'t pick up, please leave me a voicemail.', 'It told me to press 1 and then it hung up.',
      'You\'re trying to reach Stuart? Hold on.', 'Leave your name and telephone number with me and I\'ll pass it on.']) {
      expect([t, sweep.RECORDING.test(t)]).toEqual([t, false]);
    }
  });

  test('voicemail greetings, carrier intercepts, menus and queue messages are', () => {
    for (const t of ['The person you are calling is not available.', 'Please leave a message after the tone.',
      'Record your message at the beep.', 'For billing, press 1.', 'Para español, oprima el nueve.',
      'You have reached the voicemail of Maria.', 'The mailbox is full and cannot accept messages.',
      'The number you have dialed has been disconnected or is no longer in service.',
      'Your call has been forwarded to an automated voice messaging system.',
      'Your call is important to us.', 'Please continue to hold.', 'Please hold for the next available representative.',
      'All of our agents are currently assisting other callers.', 'Calls will be answered in the order they were received.',
      'Please leave your name, number and a brief message.',
      'The number you have called is not in service.', 'The number you called is not in service.',
      'Please state your name after the tone and Google Voice will try to connect you.', 'Google Voice will try to connect you.',
      'There\'s no one available to take your call.', 'We\'re not able to take your call right now.',
      // a menu's "press N" opening its clause, in every canonical shape
      'Press 1 for billing.', 'To repeat these options, press 9.', 'Please press 2.', 'Or press star to return.',
      // the firm's own greeting shape (the live re-measurement)
      'At the sound of the tone, please leave your name, telephone number, and any brief message.',
      'At the sound of the beep.', 'Please leave your name, telephone number, and any brief message.',
      'The person you\'re trying to reach is not available.']) {
      expect([t, sweep.RECORDING.test(t)]).toEqual([t, true]);
    }
  });

  test('substantiveSpeakers: a receptionist who says "please hold" and "is not available" stays substantive (the retry is not suppressed)', () => {
    const call = segs(['A', 'Law office, good morning.'], ['B', 'Hi, is Stuart there?'],
      ['A', 'He is not available right now. Please hold, let me check.'], ['B', 'Sure, thank you.']);
    expect(sweep.substantiveSpeakers(call, [{ speaker: 'A' }, { speaker: 'B' }])).toEqual(['A', 'B']);
    const vm = segs(['A', 'Hey, Stuart.'], ['B', 'The person you are calling is not available. Please leave a message after the tone.']);
    expect(sweep.substantiveSpeakers(vm, [{ speaker: 'A' }, { speaker: 'B' }])).toEqual(['A']);   // B: a recording
  });
});

describe('v4.2 speechGate: skip only a call with no real speech', () => {
  test(`the threshold: a speaker needs ${sweep.SPEECH_MIN_WORDS} substantive words`, () => {
    expect(sweep.SPEECH_MIN_WORDS).toBe(2);
  });

  test('"Hello? Hello?" and dead air: skipped, with its counts', () => {
    const r = gate(['A', 'Hello?'], ['B', 'Hello? Hello?'], ['A', 'Hello, can you hear me?'], ['B', 'Hi there. Okay, bye.']);
    expect(r).toEqual({ skip: true, reason: 'no_speech', counts: { segments: 4, speakers: 2, words: 12, substantive: 0,
      max_speaker_substantive: 0, by_speaker: { A: { words: 6, substantive: 0, cue_sentences: 0 }, B: { words: 6, substantive: 0, cue_sentences: 0 } } } });
  });

  test('a phone menu, a hold message, a voicemail greeting with no message left: skipped', () => {
    expect(gate(['A', 'For billing, press 1. For claims, press 2. To repeat these options, press 9.']).skip).toBe(true);
    expect(gate(['A', 'Please continue to hold. Your call is important to us.'], ['B', 'Hello?']).skip).toBe(true);
    expect(gate(['A', 'Hi, you have reached Maria. Please leave a message after the tone.'], ['B', 'Hello?']).skip).toBe(true);
    expect(gate(['A', 'Hello?'], ['B', 'Maria?']).skip).toBe(true);                 // one stray word each: no conversation
    // per SPEAKER, not summed: one word each is still no conversation
    expect(gate(['A', 'Hey Maria.'], ['B', 'Stuart.']).skip).toBe(true);
  });

  test('call screening: the cue sits mid-sentence, so the whole SENTENCE is dropped; a message after it is kept', () => {
    const screen = 'Please state your name after the tone and Google Voice will try to connect you.';
    expect(gate(['A', screen]).skip).toBe(true);
    expect(gate(['A', `${screen} Hi, it's Maria, call me back.`]).skip).toBe(false);
    expect(gate(['A', screen], ['B', 'Maria.']).skip).toBe(true);                    // a first name to the screener, no message
  });

  test('a voicemail greeting whose every sentence is recording (no "press star" line) is skipped; the cues added for it', () => {
    expect(gate(['A', 'Thank you for calling. You have reached the law office. Please leave your name, number and a brief message.']).skip).toBe(true);
    expect(gate(['A', 'Thanks for calling. There is no one available to take your call. Have a nice day.']).skip).toBe(true);
    expect(gate(['A', 'No one is available to take your call.'], ['B', 'Hello?']).skip).toBe(true);
    expect(gate(['A', 'We are unable to take your call right now.'], ['B', 'Hello?']).skip).toBe(true);
    // "you've reached" is a gate cue but no RECORDING cue (a receptionist says it live): it drops only its own sentence
    expect([sweep.RECORDING.test('You have reached the law office.'), sweep.GATE_CUES.test('You have reached the law office.')]).toEqual([false, true]);
    expect(gate(['A', 'You have reached the law office. This is Anna, how can I help you?']).skip).toBe(false);
    // …and "you've reached out" is no greeting at all
    expect(sweep.GATE_CUES.test('I see you\'ve reached out to me.')).toBe(false);
    expect(gate(['A', 'Hi Stuart, I see you\'ve reached out to me, please call me back.']).skip).toBe(false);
  });

  test('a left message that asks the listener to leave one if unanswered is kept (the conditional is speech)', () => {
    expect(gate(['A', 'Hi Stuart, this is Maria, please call me back and if I don\'t answer please leave a message.']).skip).toBe(false);
    expect(gate(['A', 'Call me back at 248-555-0100, and if I don\'t pick up, please leave me a voicemail.']).skip).toBe(false);
  });

  test('the conditional look-back is bounded: 20k repeats of "please leave" test in well under a second', () => {
    const t0 = Date.now();
    expect(sweep.RECORDING.test(`${'please leave '.repeat(20_000)}x`)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('the sentence splitter is linear: 50k periods that end no sentence ("Mr. Mr. …") in well under a second', () => {
    const t0 = Date.now();
    expect(gate(['A', 'Mr. '.repeat(50_000)]).counts.by_speaker.A.cue_sentences).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('a message and a menu in ONE segment: the message is its own sentence and is kept', () => {
    expect(gate(['A', 'Hi, this is Stuart from the law office, please call me back. To send your message, press 1.']).skip).toBe(false);
    expect(gate(['A', 'Hi, you\'ve reached John, please leave a message after the tone. Hi John, this is Stuart from the law office, '
      + 'please call me back about your filing. To send your message, press 1. To re-record, press 2.']).skip).toBe(false);
  });

  test('sentence ends: a title, an initial or "a.m." does not end a sentence; a phone number before a period does', () => {
    // "Mr." does not split, so the cue drops the whole of "Hi Mr. Smith, please leave a message…": nothing left
    expect(gate(['A', 'Hi Mr. Smith, please leave a message after the tone.']).skip).toBe(true);
    expect(gate(['A', 'Hi J. Smith, please leave a message after the tone.']).skip).toBe(true);
    // split at "Mr." and "please leave a message for Mr." would be a sentence without a cue (… for him is live): 6 words kept
    expect(gate(['A', 'Please leave a message for Mr. Smith after the tone.']).skip).toBe(true);
    expect(gate(['A', 'The office opens at 9 a.m. please leave a message after the tone.']).skip).toBe(true);
    // a number then a period IS a sentence end: the cue sentence after it is dropped, the number kept
    expect(gate(['A', 'Call 248-555-0100. Please leave a message after the tone.']).counts.by_speaker.A).toEqual({ words: 9, substantive: 3, cue_sentences: 1 });
  });

  test('a message left by a person is NEVER skipped — two words of content are enough', () => {
    expect(gate(['A', 'Call me.']).skip).toBe(false);
    expect(gate(['A', 'Hi, it\'s Maria.']).skip).toBe(false);
    expect(gate(['A', 'Hi, 248 555 0100.']).skip).toBe(false);                     // a call-back number alone
    // a phone number written as ONE token (7+ digits) is enough on its own: hyphenated, unbroken, dotted
    expect(gate(['A', 'Hi, 248-555-0100.']).skip).toBe(false);
    expect(gate(['A', 'Hi, 2485550100.']).skip).toBe(false);
    expect(gate(['A', 'Hi, 248.555.0100.']).skip).toBe(false);
    expect(gate(['A', 'Hi, 555-010.']).skip).toBe(true);                             // 6 digits: one word
    expect(gate(['A', 'Hello? Maria?']).skip).toBe(true);
    // a greeting merged with the message left after the beep (one label): the message's sentences count
    expect(gate(['A', 'You have reached Maria. Please leave a message after the tone. Hi, this is Stuart, call me back.']).skip).toBe(false);
    // the greeting on one label, the message on another
    expect(gate(['A', 'Please leave a message after the tone.'], ['B', 'Hi, it\'s Stuart, call me back.']).skip).toBe(false);
  });

  test('a live call is not skipped, even when a receptionist says "please hold"', () => {
    expect(gate(['A', 'Law office.'], ['B', 'Is Stuart there?'], ['A', 'Please hold.']).skip).toBe(false);
  });

  test('input shapes: the stored JSON string, full_text alone (one speaker), nothing at all', () => {
    expect(sweep.speechGate(JSON.stringify(segs(['A', 'Hello?']))).skip).toBe(true);
    expect(sweep.speechGate(JSON.stringify(segs(['A', 'Call me back.']))).skip).toBe(false);
    expect(sweep.speechGate('not json').skip).toBe(false);
    expect(sweep.speechGate([], 'Hi, call me back.').skip).toBe(false);
    expect(sweep.speechGate([], 'Hello? Hello?').skip).toBe(true);
    expect(sweep.speechGate(null, '')).toMatchObject({ skip: false, reason: null });   // nothing to judge: the 'empty' skip is the sweep's
  });
});
