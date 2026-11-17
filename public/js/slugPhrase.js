/*
 * YCSlugPhrase — random WORD endings for public short-link slugs
 * (Redirects' Randomize button: /r/<slug>).
 *
 * Rule (Fred, 2026-11-17): Randomize appends random words to whatever is typed
 * until the slug has FIVE hyphen/underscore-separated parts, counting the typed
 * ones — but never fewer than THREE random words, and never past the slug limit
 * (64, routes/api.redirects.js SLUG_RE):
 *   ''           → blue-potato-hammer-meld-tulip      (5 words)
 *   'smith'      → smith-blue-potato-hammer-tulip     (4)
 *   'smith-tax'  → smith-tax-blue-potato-hammer       (3; 'smith-tax-' too)
 *   'a-b-c-d'    → a-b-c-d-blue-potato-hammer         (3 — the floor beats the 5-part cap)
 *   long prefix  → prefix + 3 words, or NOT OK when 3 words cannot fit
 *   'quo_call'   → quo_call_blue_potato_hammer       (underscore-only prefix keeps '_')
 * The random words are what make a link to a private page unguessable — a
 * client's name is known to exactly the person most likely to try — so the
 * floor holds and an oversize prefix is refused rather than given a weak tail.
 * What lands in the box is only a suggestion: staff edit it freely.
 *
 * The word count depends ONLY on the prefix (each word is budgeted at the
 * longest word, WORD_MAX), so a short draw can't sneak in an extra word and the
 * result is always ≤ the limit. Words come from crypto.getRandomValues,
 * rejection-sampled (no modulo bias) — never Math.random.
 *
 * WORDS: hand-curated, 3–6 lowercase letters, sorted. Vetted against the firm's
 * standards (nothing crude in a second reading, no violence, religion or
 * idolatry, no non-kosher foods, nothing that reads badly to a bankruptcy client
 * — debt, money trouble, legal jeopardy). Fred approves additions.
 */
(function (root) {
  'use strict';

  var WORDS = Object.freeze([
    'able', 'acacia', 'accord', 'acorn', 'agate', 'agave', 'agile', 'airy', 'album', 'alder',
    'alert', 'alley', 'almond', 'alpaca', 'alpine', 'alto', 'amber', 'amble', 'amity', 'ample',
    'anchor', 'angle', 'ant', 'anthem', 'anvil', 'apex', 'apple', 'apron', 'apt', 'aqua', 'arc',
    'arcade', 'arch', 'arctic', 'ardent', 'arena', 'aria', 'aroma', 'art', 'aspen', 'aster',
    'atlas', 'atrium', 'attic', 'autumn', 'avenue', 'avid', 'award', 'awning', 'axle', 'azure',
    'badge', 'bagel', 'bake', 'bakery', 'ballad', 'balmy', 'bamboo', 'banjo', 'banner', 'barge',
    'barley', 'barn', 'barrel', 'basalt', 'basil', 'basin', 'bask', 'basket', 'baton', 'bay',
    'bazaar', 'beach', 'beacon', 'bead', 'beam', 'bean', 'beckon', 'bee', 'beech', 'beet',
    'beetle', 'beige', 'bell', 'bench', 'beret', 'berry', 'beryl', 'bike', 'binder', 'birch',
    'bison', 'bistro', 'blink', 'bliss', 'blithe', 'block', 'bloom', 'blue', 'boat', 'bobbin',
    'bobble', 'bobcat', 'bold', 'bolt', 'bonnet', 'bonny', 'bonsai', 'book', 'boot', 'bottle',
    'bough', 'bowl', 'braid', 'branch', 'brass', 'brave', 'bravo', 'bread', 'breeze', 'breezy',
    'brew', 'brick', 'bridge', 'brief', 'bright', 'brisk', 'bronze', 'brooch', 'brook', 'broom',
    'brush', 'bubble', 'bubbly', 'bucket', 'buckle', 'buggy', 'bugle', 'build', 'bundle',
    'burrow', 'bus', 'bustle', 'busy', 'byte', 'cabana', 'cabin', 'cable', 'cactus', 'caddy',
    'cafe', 'cake', 'calf', 'calm', 'camel', 'cameo', 'camera', 'campus', 'canal', 'canary',
    'candid', 'candle', 'candor', 'candy', 'canoe', 'canopy', 'canter', 'canvas', 'canyon',
    'cap', 'cape', 'car', 'carafe', 'carbon', 'card', 'cargo', 'caring', 'carpet', 'carrot',
    'cart', 'carve', 'cashew', 'castle', 'cat', 'cave', 'cedar', 'celery', 'cellar', 'cello',
    'cereal', 'chai', 'chair', 'chalet', 'chalk', 'chart', 'cheer', 'cheery', 'chess', 'chic',
    'chime', 'chip', 'chirp', 'chisel', 'choice', 'chord', 'chorus', 'chrome', 'cicada',
    'cider', 'cipher', 'circle', 'circus', 'city', 'civic', 'clasp', 'clay', 'clean', 'clear',
    'clever', 'cliff', 'climb', 'clip', 'cloak', 'clock', 'cloud', 'cloudy', 'clover', 'coach',
    'coast', 'coat', 'cobalt', 'cobble', 'cocoa', 'cocoon', 'code', 'coffee', 'coil', 'coin',
    'comet', 'comfy', 'comma', 'conch', 'condor', 'cone', 'cookie', 'copper', 'coral', 'cord',
    'cork', 'corn', 'corner', 'cosmic', 'cosmos', 'couch', 'cove', 'cozy', 'cradle', 'craft',
    'crafty', 'crane', 'crate', 'crater', 'crayon', 'cream', 'creek', 'crepe', 'crest', 'crisp',
    'crown', 'cruise', 'crumb', 'cub', 'cube', 'cup', 'curly', 'curve', 'cushy', 'cyan',
    'cycle', 'cymbal', 'dabble', 'dahlia', 'dainty', 'daisy', 'dale', 'dance', 'dandy',
    'dapper', 'daring', 'darts', 'dash', 'data', 'date', 'dawn', 'dazzle', 'dear', 'deep',
    'deer', 'deft', 'delta', 'delve', 'denim', 'depot', 'derby', 'desert', 'desk', 'dew',
    'dewy', 'dial', 'diary', 'dill', 'diner', 'dinghy', 'dingo', 'dish', 'ditto', 'dive',
    'dock', 'dog', 'dome', 'domino', 'donut', 'doodle', 'door', 'dot', 'dove', 'dowel', 'doze',
    'draw', 'dream', 'dreamy', 'drift', 'drive', 'drum', 'duck', 'duet', 'duffel', 'dune',
    'dusk', 'dynamo', 'eager', 'eagle', 'early', 'earth', 'earthy', 'ease', 'easel', 'echo',
    'egret', 'elated', 'elk', 'elm', 'ember', 'emblem', 'emu', 'engine', 'enigma', 'epic',
    'eraser', 'ethos', 'exact', 'fable', 'fabled', 'fabric', 'fair', 'falcon', 'fame', 'fan',
    'fancy', 'farm', 'fast', 'favor', 'fawn', 'feast', 'felt', 'fender', 'fennel', 'fern',
    'ferret', 'ferry', 'fetch', 'fiber', 'field', 'fiesta', 'fig', 'filter', 'finch', 'finial',
    'fir', 'firm', 'fit', 'fjord', 'flag', 'flask', 'flax', 'fleet', 'flint', 'flit', 'float',
    'flora', 'floral', 'floret', 'flour', 'flow', 'fluent', 'fluffy', 'flute', 'fly', 'foal',
    'foam', 'focus', 'fog', 'foggy', 'fold', 'folder', 'fond', 'fondue', 'forage', 'forest',
    'fork', 'forte', 'fossil', 'fox', 'frame', 'frank', 'free', 'fresco', 'fresh', 'frolic',
    'frost', 'frosty', 'fun', 'funny', 'gadget', 'gala', 'galaxy', 'gale', 'galley', 'gallon',
    'gallop', 'garage', 'garden', 'garlic', 'garnet', 'gate', 'gather', 'gaze', 'gazebo',
    'gear', 'gecko', 'gelato', 'gem', 'gentle', 'gerbil', 'geyser', 'giant', 'gifted', 'giggle',
    'gilded', 'gimbal', 'girder', 'gizmo', 'glad', 'glade', 'glance', 'glass', 'glassy',
    'gleam', 'glen', 'glide', 'glider', 'globe', 'glossy', 'glove', 'glow', 'goat', 'goblet',
    'gold', 'golden', 'golf', 'gong', 'good', 'goose', 'gopher', 'gorge', 'grand', 'grape',
    'grassy', 'gravel', 'gray', 'graze', 'great', 'green', 'greet', 'grid', 'grin', 'groovy',
    'grotto', 'grove', 'grow', 'guava', 'guess', 'guide', 'guitar', 'gulf', 'gull', 'guppy',
    'gust', 'gusto', 'habit', 'hamlet', 'hammer', 'handy', 'hangar', 'happy', 'harbor', 'hardy',
    'hare', 'harp', 'hat', 'hatch', 'haven', 'hawk', 'haze', 'hazel', 'hearth', 'hearty',
    'heath', 'hedge', 'helix', 'helm', 'helmet', 'hen', 'heron', 'hike', 'hill', 'hinge',
    'hobby', 'hockey', 'hollow', 'homey', 'honest', 'honey', 'honor', 'hoop', 'hop', 'hope',
    'hopper', 'hornet', 'horse', 'hotel', 'hover', 'hum', 'humble', 'hummus', 'humor', 'husk',
    'hut', 'ibex', 'ibis', 'icicle', 'idea', 'ideal', 'igloo', 'iguana', 'image', 'impala',
    'index', 'indigo', 'ink', 'inlet', 'inn', 'invent', 'iris', 'iron', 'island', 'isle', 'ivy',
    'jacket', 'jade', 'jam', 'jar', 'jasper', 'jaunty', 'jazz', 'jazzy', 'jelly', 'jersey',
    'jest', 'jet', 'jigsaw', 'jingle', 'jockey', 'jog', 'jolly', 'jostle', 'jovial', 'joy',
    'joyful', 'judo', 'juggle', 'juice', 'jumbo', 'jump', 'jute', 'kale', 'karate', 'kayak',
    'kazoo', 'keen', 'kelp', 'kernel', 'kettle', 'key', 'keypad', 'khaki', 'kind', 'kindly',
    'kiosk', 'kitten', 'kiwi', 'knit', 'knot', 'koala', 'kudos', 'ladder', 'ladle', 'lagoon',
    'lake', 'lamb', 'lamp', 'laptop', 'larch', 'lariat', 'lark', 'laser', 'lasso', 'latch',
    'latte', 'laugh', 'launch', 'laurel', 'lava', 'leaf', 'leafy', 'leap', 'learn', 'ledge',
    'leek', 'legend', 'lemon', 'lemur', 'lens', 'lentil', 'level', 'lever', 'lift', 'lilac',
    'lily', 'limber', 'lime', 'linden', 'line', 'linen', 'liner', 'linger', 'lintel', 'lion',
    'listen', 'lively', 'llama', 'lobby', 'locker', 'locket', 'lodge', 'loft', 'lofty', 'logic',
    'loom', 'loop', 'lore', 'lounge', 'loyal', 'lucid', 'luck', 'lucky', 'lumber', 'lunar',
    'lute', 'lynx', 'lyric', 'macaw', 'magnet', 'magpie', 'major', 'mallet', 'mambo', 'mango',
    'manor', 'mantis', 'mantle', 'map', 'maple', 'marble', 'march', 'marina', 'market',
    'marmot', 'maroon', 'marsh', 'marvel', 'mascot', 'mask', 'mat', 'mauve', 'meadow', 'medal',
    'medley', 'mellow', 'melody', 'memo', 'mend', 'merit', 'merry', 'mesa', 'meteor', 'mica',
    'midday', 'mighty', 'mild', 'mill', 'mimosa', 'mingle', 'mink', 'minnow', 'mint', 'minty',
    'mirror', 'mirth', 'mist', 'misty', 'mitt', 'mitten', 'mix', 'mocha', 'modem', 'modern',
    'modest', 'moon', 'moose', 'mortar', 'mosaic', 'moss', 'mossy', 'moth', 'motor', 'motto',
    'mouse', 'muesli', 'munch', 'mural', 'museum', 'myrtle', 'myth', 'nap', 'napkin', 'natty',
    'navy', 'neat', 'nebula', 'nectar', 'nest', 'nestle', 'net', 'newt', 'nickel', 'nifty',
    'nimble', 'noble', 'nod', 'noodle', 'noon', 'notch', 'notion', 'nova', 'novel', 'nudge',
    'nugget', 'nutmeg', 'oak', 'oaken', 'oar', 'oasis', 'oat', 'oboe', 'ocean', 'ocelot',
    'ochre', 'office', 'okra', 'olive', 'onion', 'onyx', 'opal', 'open', 'opera', 'orange',
    'orbit', 'orca', 'orchid', 'oriole', 'ornate', 'osprey', 'otter', 'oval', 'owl', 'page',
    'pail', 'paint', 'palace', 'palm', 'panda', 'panel', 'pantry', 'papaya', 'paper', 'parade',
    'parcel', 'park', 'parka', 'parrot', 'pasta', 'pastel', 'pastry', 'patio', 'patter',
    'pause', 'peace', 'peak', 'peanut', 'pear', 'pearl', 'pebble', 'pecan', 'pedal', 'pellet',
    'pen', 'pencil', 'peony', 'pep', 'pepper', 'peppy', 'perch', 'pestle', 'petal', 'pewter',
    'piano', 'pickle', 'pie', 'pier', 'pigeon', 'pilaf', 'pillar', 'pillow', 'pilot', 'pin',
    'pine', 'pink', 'piston', 'pita', 'pivot', 'pixel', 'placid', 'plain', 'plan', 'plane',
    'planet', 'plank', 'plant', 'plate', 'play', 'plaza', 'pliers', 'plod', 'plover', 'plucky',
    'plum', 'plume', 'plush', 'pocket', 'podium', 'poem', 'poise', 'poised', 'polar', 'polite',
    'polka', 'pollen', 'polo', 'pond', 'ponder', 'pony', 'poplar', 'poppy', 'porch', 'port',
    'portal', 'posh', 'poster', 'potato', 'pouch', 'pretty', 'pride', 'prime', 'prism', 'prose',
    'proud', 'pueblo', 'puffin', 'pulley', 'pulsar', 'puma', 'pumice', 'puppet', 'puppy',
    'purple', 'putter', 'puzzle', 'pylon', 'quail', 'quaint', 'quarry', 'quartz', 'quasar',
    'quay', 'quest', 'quick', 'quiet', 'quill', 'quilt', 'quince', 'quinoa', 'quip', 'quirk',
    'rabbit', 'radar', 'radio', 'radish', 'radius', 'raft', 'rafter', 'rail', 'rain', 'rainy',
    'raisin', 'rake', 'rally', 'ramble', 'ramp', 'ranch', 'rapid', 'rapids', 'rare', 'raven',
    'ravine', 'read', 'ready', 'reason', 'recipe', 'red', 'reed', 'reef', 'reel', 'regal',
    'relax', 'relay', 'relish', 'resin', 'rest', 'revel', 'rhyme', 'rhythm', 'ribbon', 'rice',
    'riddle', 'ridge', 'ring', 'rinse', 'ripple', 'river', 'rivet', 'roam', 'robe', 'robin',
    'robot', 'robust', 'rock', 'rocket', 'rodeo', 'rondo', 'roomy', 'roost', 'rose', 'rosy',
    'rotor', 'router', 'rover', 'row', 'rowing', 'royal', 'ruby', 'rudder', 'rug', 'rugby',
    'rugged', 'ruler', 'russet', 'rust', 'rustic', 'safari', 'safe', 'saga', 'sage', 'sail',
    'salad', 'salmon', 'salsa', 'sand', 'sandal', 'sandy', 'sash', 'sassy', 'satin', 'savor',
    'savvy', 'saw', 'scarf', 'scenic', 'school', 'sconce', 'scone', 'scoop', 'screen', 'scribe',
    'scroll', 'scurry', 'sea', 'seal', 'season', 'sedan', 'sensor', 'sepia', 'sequin', 'serene',
    'server', 'sesame', 'settle', 'sew', 'shale', 'sharp', 'shed', 'sheep', 'shelf', 'shell',
    'shine', 'shiny', 'ship', 'shop', 'shore', 'shovel', 'shower', 'sienna', 'sieve', 'sign',
    'signal', 'silk', 'silken', 'silky', 'silo', 'silver', 'sing', 'sip', 'sitar', 'sizzle',
    'skate', 'sketch', 'ski', 'skiff', 'skim', 'sky', 'slalom', 'slate', 'sled', 'sleek',
    'sleepy', 'sleet', 'sleeve', 'slide', 'sloop', 'smart', 'smile', 'smooth', 'snappy',
    'snooze', 'snow', 'snowy', 'snug', 'soar', 'soccer', 'sock', 'socket', 'sofa', 'soft',
    'solace', 'solar', 'solid', 'solve', 'sonar', 'sonata', 'sonic', 'sonnet', 'sorbet',
    'sorrel', 'sort', 'soup', 'spark', 'sparky', 'sphere', 'spice', 'spiffy', 'spin', 'spiral',
    'splash', 'spool', 'spoon', 'sporty', 'spring', 'sprint', 'sprout', 'spruce', 'spry',
    'square', 'squash', 'stable', 'stack', 'stamp', 'staple', 'star', 'starry', 'steady',
    'steer', 'stem', 'still', 'stir', 'stone', 'stork', 'storm', 'story', 'stove', 'straw',
    'stream', 'stride', 'string', 'stroll', 'strum', 'studio', 'sturdy', 'style', 'suave',
    'subway', 'suede', 'sugar', 'suite', 'summer', 'summit', 'sun', 'sundae', 'sunlit', 'sunny',
    'sunset', 'super', 'supple', 'surf', 'swamp', 'swan', 'sweep', 'sweet', 'swift', 'swim',
    'swirl', 'swish', 'swoop', 'syrup', 'table', 'tablet', 'tack', 'tahini', 'talent', 'tall',
    'tan', 'tandem', 'tango', 'tape', 'tapir', 'taste', 'taupe', 'taxi', 'tea', 'teal',
    'teapot', 'tempo', 'tend', 'tender', 'tennis', 'tenor', 'tent', 'tern', 'theme', 'think',
    'thread', 'thrill', 'thyme', 'ticket', 'tide', 'tidy', 'tiger', 'tile', 'timber', 'tin',
    'tiny', 'tiptoe', 'toad', 'toast', 'today', 'toddle', 'toffee', 'tofu', 'toggle', 'token',
    'tomato', 'tongs', 'tonic', 'topaz', 'totter', 'toucan', 'tower', 'town', 'track', 'trail',
    'train', 'trait', 'tram', 'travel', 'tray', 'treat', 'tree', 'trek', 'trend', 'trendy',
    'trim', 'trio', 'tripod', 'trophy', 'tropic', 'trot', 'trout', 'trowel', 'truck', 'true',
    'trunk', 'trust', 'trusty', 'truth', 'tuba', 'tulip', 'tumble', 'tuna', 'tundra', 'tune',
    'tunnel', 'turnip', 'turret', 'turtle', 'tuxedo', 'tweed', 'twig', 'twirl', 'umber',
    'unfold', 'unity', 'upbeat', 'vale', 'valise', 'valley', 'valor', 'valve', 'van', 'vase',
    'vast', 'vault', 'vector', 'velvet', 'verse', 'vessel', 'vigor', 'villa', 'vine', 'vinyl',
    'viola', 'violet', 'violin', 'vision', 'visit', 'visor', 'vista', 'vital', 'vivid',
    'voyage', 'wade', 'waffle', 'wagon', 'walk', 'wallet', 'walnut', 'walrus', 'waltz',
    'wander', 'warm', 'warren', 'wash', 'watch', 'wave', 'wavy', 'wax', 'weave', 'wedge',
    'wheat', 'wheel', 'whirl', 'whisk', 'wicker', 'wicket', 'widget', 'willow', 'wind',
    'window', 'windy', 'wink', 'winter', 'wire', 'wiry', 'wisdom', 'wise', 'wish', 'wit',
    'witty', 'wobble', 'wolf', 'wombat', 'wonder', 'wooden', 'wool', 'woolly', 'wren', 'wrench',
    'write', 'yacht', 'yak', 'yam', 'yard', 'yarn', 'yawn', 'yodel', 'yucca', 'zany', 'zeal',
    'zebra', 'zenith', 'zephyr', 'zest', 'zesty', 'zigzag', 'zinc', 'zipper', 'zippy', 'zoom'
  ]);

  var MAX_LEN = 64;       // routes/api.redirects.js SLUG_RE {1,64}
  var MAX_SEGMENTS = 5;   // parts in the finished slug, typed ones included
  var MIN_WORDS = 3;      // random words, always
  var WORD_MAX = 6;       // longest word in WORDS (tests pin it)

  function defaultFill(buf) { return root.crypto.getRandomValues(buf); }

  // Unbiased index in [0, n): 32-bit draws above the largest multiple of n are
  // rejected. A rejection is < n / 2^32 likely, so 64 tries is a bound that
  // only a broken source reaches.
  function randomIndex(n, fill) {
    var limit = Math.floor(0x100000000 / n) * n;
    var buf = new Uint32Array(1);
    for (var i = 0; i < 64; i++) {
      fill(buf);
      if (buf[0] < limit) return buf[0] % n;
    }
    throw new Error('YCSlugPhrase: random source returned no usable value');
  }

  // → { ok:true, value, words } or { ok:false, maxTyped } (no room for MIN_WORDS).
  function extend(current, opts) {
    opts = opts || {};
    var fill = opts.fill || defaultFill;
    var base = String(current == null ? '' : current).trim();
    var typed = base.split(/[-_]+/).filter(Boolean).length;
    // Words follow the prefix's separator: underscores only → '_', else '-'.
    var sep = (/_/.test(base) && !/-/.test(base)) ? '_' : '-';
    var prefix = (base && !/[-_]$/.test(base)) ? base + sep : base;
    var fit = Math.floor((MAX_LEN - prefix.length + 1) / (WORD_MAX + 1));
    var count = Math.min(Math.max(MIN_WORDS, MAX_SEGMENTS - typed), fit);
    if (count < MIN_WORDS) return { ok: false, maxTyped: MAX_LEN - MIN_WORDS * (WORD_MAX + 1) };
    var out = [];
    for (var i = 0; i < count; i++) out.push(WORDS[randomIndex(WORDS.length, fill)]);
    return { ok: true, value: prefix + out.join(sep), words: count };
  }

  // A second press on an untouched result re-rolls the words on the SAME
  // prefix instead of treating the whole result as a new prefix (which would
  // stack — and, hitting the 5-part cap, shrink to the floor).
  function createRoller(opts) {
    var last = null;   // { source, value }
    return function roll(current) {
      var cur = String(current == null ? '' : current).trim();
      var source = (last && cur === last.value) ? last.source : cur;
      var r = extend(source, opts);
      last = r.ok ? { source: source, value: r.value } : null;
      return r;
    };
  }

  root.YCSlugPhrase = {
    WORDS: WORDS,
    MAX_LEN: MAX_LEN,
    MAX_SEGMENTS: MAX_SEGMENTS,
    MIN_WORDS: MIN_WORDS,
    WORD_MAX: WORD_MAX,
    randomIndex: randomIndex,
    extend: extend,
    createRoller: createRoller,
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* Node/CommonJS export (unit tests). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).YCSlugPhrase;
}
