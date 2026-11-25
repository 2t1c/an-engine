#!/usr/bin/env node
// cover-gen.mjs — the default route for generating a cover in our visual system.
//
// Nano Banana Pro (Google's name for Gemini 3 Pro Image) through the OpenRouter key this repo
// already carries — no extra credential, no MCP server, the same REST shape as every other LLM
// call here. Verified live 2026-09-04: one call, on-style on the first try.
//
//   node cover-gen.mjs --scene "A colossal wall of dead server racks…"
//   node cover-gen.mjs --prompt-file prompt.txt          # a fully assembled prompt, used verbatim
//   node cover-gen.mjs --scene "…" --ref style/references/crater.png --out covers/power-wall.png
//   node cover-gen.mjs --scene "…" --diagram             # diagram mode instead of a cover scene
//   node cover-gen.mjs --scene "…" --upload gtx          # also upload to Typefully, print media id
//   node cover-gen.mjs --scene "…" --dry                 # print the assembled prompt, call nothing
//
// Two styles. --style gtx (the default) is the locked GTX series below: engraved black-and-white,
// one red source, the hooded traveler. --style health is the health fleet's system, reverse-
// engineered from Tim Denning's covers in style/cover-health-system.md — the opposite idea, a fixed
// set of casting rules with a MEDIUM that rotates every post so the feed never reads as a template.
//
//   node cover-gen.mjs --style health --scene "A grocery aisle stretching to the horizon…"
//   node cover-gen.mjs --style health --scene "…" --medium ink --upload magnus
//   node cover-gen.mjs --style health --medium list      # print the eight mediums, call nothing
//
// --style graphic is the abstract/graphic system for the health ARTICLE lane (operator 2026-09-14:
// "continue down this path of abstract visual art… different styles, different components"), six
// looks derived from the covers in the Articles table — see style/cover-graphic-styles.md. The
// lead look is `concept`, dialled in on 0xHvdes's covers (operator, same day: "the idea and
// execution is everything here, it's simple and it has the meaning behind them"): one visual
// sentence, red ground, cut-out men in black suits, white objects, and nothing that is not the idea.
// `bio` is alexeixbt's register (operator, same day: "abstract biology with a certain technological
// style that creates a perception of high value"): a living structure rendered as a point cloud or
// wireframe in the dark, monochrome, one hairline accent, no instrument and no text in the frame.
//
//   node cover-gen.mjs --style graphic --look concept   --scene "…" --crop 5:2 --upload jasper
//   node cover-gen.mjs --style graphic --look bio       --scene "…" --crop 5:2 --upload jasper
//   node cover-gen.mjs --style graphic --look wire      --scene "…" --crop 5:2 --upload jasper
//   node cover-gen.mjs --style graphic --look halftone  --scene "…" --palette "black, cream, vermilion"
//   node cover-gen.mjs --style graphic --look list      # print the eight looks, call nothing
//
// --crop 5:2 centre-crops the saved image to the X Article cover ratio (1200x480) in pure JS, biased
// a third toward the top, and uploads THAT when --upload is set. --punch #rrggbb (or the look's own
// lock; concept carries #E00D22) then locks the dominant colour onto the target in pure JS, because the
// model returns a coral where the look says crimson. --from render.png skips the model and runs the
// same crop → lock → upload stage on an existing file:
//
//   node cover-gen.mjs --style graphic --look concept --from covers/x.png --crop 5:2 --upload jasper X recommends 5:2 and crops the
// sides in the feed, so every look here keeps the subject inside the middle 60 percent of the width.
//
// --scene is the ONE line that changes per article; everything else is the v7 master prompt from
// style/cover-visual-system.md, inlined here so the route works without reading the doc. Keep the
// two in step: the doc is the source of truth for the system, this is the executable copy.
//
// COST. Roughly $0.14 a call, and a call returns more than one image (Google decides how many, and
// the API has no knob for it) — so every image is saved and you pick. That is not cheap: use
// --model google/gemini-3.1-flash-image for rough passes and keep Pro for the final render.
//
// Env: OPENROUTER_API_KEY. With --upload: TYPEFULLY_API_KEY.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { loadEnv, requireEnv, typefully, cliArg } from './lib.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const DIAGRAM = args.includes('--diagram');
const scene = cliArg('scene', '');
const promptFile = cliArg('prompt-file', '');
const out = cliArg('out', 'cover.png');
const model = cliArg('model', 'google/gemini-3-pro-image');
const upload = cliArg('upload', '');
const refs = args.reduce((a, v, i) => (args[i - 1] === '--ref' ? [...a, v] : a), []);
const style = cliArg('style', 'gtx').toLowerCase();
const medium = cliArg('medium', '').toLowerCase();
const shot = cliArg('shot', 'medium').toLowerCase();
const subject = cliArg('subject', 'figure').toLowerCase();

const glook = cliArg('look', '').toLowerCase();
const palette = cliArg('palette', '');
const crop = cliArg('crop', '');
const from = cliArg('from', '');      // re-process an existing render (crop, colour lock, upload) with no model call
const punch = cliArg('punch', '');    // colour lock: #rrggbb, 'none', or empty for the look's default
if (!['gtx', 'health', 'graphic'].includes(style)) { console.error(`unknown --style ${JSON.stringify(style)} (gtx|health|graphic)`); process.exit(1); }

// How much of the frame the subject occupies. The first batch came back with the subject tiny in
// every frame and the operator could not read what was happening — so this is a dial now, and it
// defaults to medium rather than wide. The three covers he pointed at (a half-body portrait, two men
// on a wall, a warehouse-sized brain) share exactly one property: one legible subject filling a
// large share of the frame, with the environment as ground behind it.
const SHOTS = {
  close: 'SHOT SIZE — CLOSE. The subject fills the frame: a person from head to waist, or an object taking up more than half the frame height. It is large, sharp and unmistakable. The background falls away into darkness or into a single flat tone and carries no detail that competes. A viewer reads this in a quarter of a second at thumbnail size.',
  medium: 'SHOT SIZE — MEDIUM. The subject occupies roughly a third to a half of the frame height and is completely legible: you can see what the person is doing, how they are standing, what they are holding, where their face is turned. The setting is readable around them but is clearly secondary. Never so far away that the subject becomes a silhouette or a detail.',
  wide: 'SHOT SIZE — WIDE. One small figure against one enormous thing, the figure a clear dark shape but small in the frame. Use this only when the scale contrast IS the idea; it makes the moment harder to read, so it is the exception.',
};
if (!SHOTS[shot]) { console.error(`unknown --shot ${JSON.stringify(shot)} (close|medium|wide)`); process.exit(1); }

// What the subject IS. 'object' is the move from the warehouse-brain cover: one enormous literal
// thing standing where it cannot be, no person needed. For health and fitness it is often the most
// legible option there is, because the idea becomes a thing you can see.
// The "unexplained situation" clause has to bend for object mode: a car-sized sugar cube in a kitchen
// IS a metaphor made literal, which the figure-mode wording forbids outright. Both versions still
// demand the same thing — nothing in the picture explains itself.
const GAP = {
  figure: `THE SUBJECT IS PRESENT, THE ARGUMENT IS NOT. The ordinary thing the piece is about belongs in the frame and should be plainly recognisable. What must never appear is the claim about it: no diagram, no chart, no cutaway, no symbol, no measuring instrument, nothing that shows a mechanism or a result. The image stages one strange, specific, entirely mundane-looking moment around that thing and offers no explanation for it. A viewer should recognise the territory and still want to know what is happening here.`,
  pair: `THE SUBJECT IS PRESENT, THE ARGUMENT IS NOT. The ordinary thing the piece is about belongs in the frame and should be plainly recognisable. What must never appear is the claim about it: no diagram, no chart, no symbol, no measuring instrument, nothing showing a mechanism or a result. The image stages one strange, specific, mundane-looking moment between these two people around that thing, and explains nothing.`,
  object: `THE OBJECT IS LITERAL AND THE SITUATION IS UNEXPLAINED. The thing itself is drawn exactly as the real thing looks — no symbol, no diagram, no stylisation, no glow, nothing added to signal meaning. All the strangeness comes from its size and from where it is standing. Nothing in the room acknowledges it, nothing has been moved to accommodate it, and nothing explains why it is there.`,
};

const SUBJECTS = {
  figure: `WHAT IS IN THE FRAME: exactly one person, alone, caught mid-action — reaching, carrying, waiting, listening, dressing, turning away. Never posing for the camera, never neutral, never addressing the lens. They may be seen from behind, in profile, or three-quarters with their eyes going somewhere outside the frame; if the face is visible it is caught mid-thought, never smiling at the viewer.`,
  object: `WHAT IS IN THE FRAME: no person at all. One enormous, ordinary, literal object stands where it could not possibly be — filling a room it could never fit inside, resting in a landscape at the wrong scale, occupying a building. It is rendered plainly and in full detail, exactly as the real thing looks, just impossibly large and impossibly placed. Nothing explains it and nothing reacts to it.`,
  pair: `WHAT IS IN THE FRAME: exactly two people together, caught mid-moment — sitting, walking, waiting, talking to each other and not to the camera. They read as one subject, close enough that they form a single shape in the composition. Neither looks at the lens.`,
};
if (!SUBJECTS[subject]) { console.error(`unknown --subject ${JSON.stringify(subject)} (figure|object|pair)`); process.exit(1); }

// The eight mediums of the health system. Each carries its own aspect ratio on purpose: Denning's 16
// covers span 0.92 to 2.13 and never repeat, and that inconsistency is what makes the set read as
// found rather than produced. A generator defaults to one ratio forever, which is the tell we are
// avoiding — so the ratio rotates with the medium.
const MEDIUMS = {
  photo: ['3:2', 'A photograph on 35mm colour film. Available light only, one clear direction to it. Visible grain, mild halation on the highlights, slightly soft — the look of a good frame from a cheap camera, not a commercial shoot.'],
  render: ['16:9', 'A 3D render of an impossible, too-clean place: one mundane thing standing where it cannot be, soft ambient occlusion, mid-90s CGI stillness, a pink-and-green dusk or a single flat interior colour. Nothing moves.'],
  editorial: ['4:5', 'An editorial photograph on medium format: one person in a place that does not match how they are dressed, natural light at the very edge of the day, wind in the fabric, a lot of empty space around them.'],
};

if (medium === 'list') {
  for (const [k, [ratio, look]] of Object.entries(MEDIUMS)) console.log(`${k.padEnd(10)} ${ratio.padEnd(7)} ${look.slice(0, 96)}…`);
  process.exit(0);
}
if (medium && !MEDIUMS[medium]) { console.error(`unknown --medium ${JSON.stringify(medium)}; try --medium list`); process.exit(1); }

if (!scene && !promptFile && !from && !(style === 'graphic' && cliArg('look', '') === 'list')) {
  console.error('usage: node cover-gen.mjs [--style gtx|health] --scene "<one sentence>" [--medium ink] [--ref img.png] [--out cover.png] [--diagram] [--upload gtx] [--dry]');
  process.exit(1);
}

// The v7 master prompt. Everything before [SCENE] is fixed; the SCENE line is the article's idea.
const MASTER = `Aspect ratio 21:9, ultra-wide landscape, final crop 1200x480 (2.5:1).

A digital drawing that emulates scratchboard and wood-engraving technique — coarse, heavy black ink, visible variable-weight hatching and stipple grain. Black-and-white line work throughout, with exactly ONE color in the image: red. The red has exactly ONE source per image and that source is the image's only light — a lantern in his hand, OR a distant crack of light, OR a glow seeping from the void, OR one red object, OR a red MEDIUM that flows from a single source: falling sand, a river of light, drifting embers, mist, a current. Never two sources. When the red is a point, it touches only the source, its rays, and its glow on him and the nearest surfaces. When the red is a medium, it may spread and fill the central band with depth, but it never reaches the flanks: the left and right edges stay black. Everything that is not the red is pure black and white. NOT a fine uniform engraving filter, NO halftone, NO gray midtones, no second color anywhere. A screen-native illustration, not a scan of a print: no paper, no plate edge, no margin.

70 to 90 percent of the frame is solid black or near-black — a few lit shapes emerging from darkness. Exactly ONE void — a colossal opening, stairwell, tunnel or oculus of pure solid black occupying at least one third of the frame; the environment curls around it. No sun, no moon, no planets, no decorative swirls, no ornament.

A single hooded traveler in a long coat, always seen from behind, face never visible, placed in the lower third just left of center, facing INTO the void. He is small against the colossal environment but never tiny: about one quarter of the frame height — close enough that his silhouette reads instantly at thumbnail size, never a distant speck.

WHAT HE CARRIES — exactly one of these, and never two objects at once:
- Nothing. Both hands free. This is the default; if the scene does not name an object, he carries none.
- The lantern: the series' signature object, always the same tall hexagonal iron lantern with a single flame. When he carries it, THE LANTERN IS THE IMAGE'S ONE RED SOURCE and no other red may appear anywhere in the frame.
- One object the scene names, drawn in the same engraved black-and-white line work: a closed book, a rolled chart, a key, a staff, a length of rope, a blade, a compass, a folded coat, a dead bulb. AN OBJECT THAT DOES NOT EMIT LIGHT STAYS PURE BLACK AND WHITE, and the red then lives somewhere else in the scene.
Never a carried light AND a second light in the environment. Whatever holds the red, holds it alone.

WHAT HIS BODY IS DOING — the scene names one; every gesture must read from behind, in silhouette:
- standing perfectly still, hands at his sides — resolve
- one arm reaching forward toward the light — aspiration
- one arm raised overhead holding the lantern high — searching
- both arms spread wide — awe, surrender
- one hand raised to shield his eyes from the glow — revelation
- head bowed, shoulders dropped — weight, grief
- one hand pressed flat against a wall, door or surface — contact, testing
- crouched low, one knee down, one hand to the ground — reading a trace
- leaning hard into wind or sand, coat pulled taut behind him — struggle
- mid-stride, coat swinging, one arm swept back — momentum
- turned three-quarters, looking back over his shoulder — doubt (still no facial features)
- flying: body horizontal or rising, arms forward, the long coat streaming into ragged wing-like folds — no wings, no vehicle, just the coat and momentum
Default when the scene does not say: walking, arms at his sides.

Whenever there is ground and a light, his long shadow stretches back toward the viewer. Mood: solemn, ominous, awe at the threshold. No words, no letters, no logo, no watermark.

Luminance is graded from the center outward: the brightest region sits in the central band, and brightness falls away toward both sides — the left and right thirds and all four edges are near-solid black, so the eye is pulled inward.

Build the scene in three or four depth planes so it has the density of a real engraving: black silhouetted structure in the near foreground framing both sides, the figure mid-depth, finely engraved structure behind him, and the red source at the deepest or highest point. Each plane is separated by contrast, not by gray.

SCENE: ${scene}

The drawn scene fills the entire canvas and bleeds off all four edges: the outermost pixels on every side are black ink of the environment itself. Edge-to-edge artwork, no white along the borders.`;

const DIAGRAM_MASTER = `Aspect ratio 21:9, ultra-wide landscape, final crop 1200x480 (2.5:1). Full bleed, edge to edge; the outermost pixels on every side are solid black.

An annotated scientific diagram drawn in the same visual system as our covers: solid black background, all lines and lettering in thin white ink with a hand-engraved quality, labels in a classic serif typeface, small caps for axis titles. Any illustrative elements are drawn as black-and-white scratchboard engravings with dense hatching — no photographs, no color gradients, no gray fills. Exactly ONE element is red: the highlighted element described below, and its glow. Nothing else in the image is red.

Every word must be spelled exactly as written, legible at small size, no extra text, no invented labels, no title, no caption, no watermark.

DIAGRAM: ${scene}`;

// Deterministic medium pick: the same scene always lands on the same medium, different scenes spread
// across the eight. Regenerate an article's cover next year and it comes back the same.
const pickMedium = (seed) => {
  const keys = Object.keys(MEDIUMS);
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return keys[h % keys.length];
};

const chosen = medium || pickMedium(scene || promptFile);
const [ratio, look] = MEDIUMS[chosen] || [];

// The health master. Everything above SCENE is the casting law from style/cover-health-system.md;
// the MEDIUM line is what rotates; SCENE is the article. The banned list is not style preference —
// these are eighteen affiliate pages carrying an FTC disclaimer, and a physique, a clinical setting
// or a visible symptom above a supplement link reads as a claim no caption can walk back.
const HEALTH_MASTER = `Aspect ratio ${ratio}. A single photographic or illustrated image, edge to edge, no border and no frame.

MEDIUM: ${look}

${SUBJECTS[subject]}

${SHOTS[shot]}

${GAP[subject]}


COMPOSITION: deep shadow is welcome, empty space is welcome, and the subject must always be the most legible thing in the frame. Whatever the moment is, a viewer should be able to tell what is happening without being told.

CENTRE-SAFE FRAMING, and this one is absolute. The cover gets cropped and the sides are what goes. Everything that carries the picture — the person, whatever they are doing, whatever makes the moment strange — sits inside the middle 60 percent of the width and is complete there. The outer left and right thirds hold nothing but environment: ground, wall, sky, distance. Nothing essential comes within a tenth of any edge, no part of the person is cut by a border, and the foreground is the centre of the frame rather than something in a corner. If it were cropped to a square from the middle, the picture would still be the whole picture.

COLOUR: one committed grade for the whole frame, and hold it. Film colour, not digital colour — restrained saturation, highlights that roll off rather than clip, shadows that go slightly milky instead of pure black, a single colour temperature bias across the image. Never the grey-blue of corporate stock, and never boosted, never HDR, never teal-and-orange.

IT MUST NOT LOOK RENDERED. This is the part that fails most often, so treat it as the brief. No glossy or waxy skin, no beauty retouching, no symmetrical face, no perfect teeth, no flawless hair. Real skin with pores and texture, stray hairs, creased and ordinary clothing that nobody styled. No over-sharpening, no HDR halo, no impossibly clean bokeh, no lens flare added for effect. A slight focus miss, a little motion blur, a horizon a degree off level, a slightly awkward pose — those are wanted, not faults. It should look like a real frame someone actually took, including its mistakes.

IT MUST LOOK FOUND, NOT DESIGNED. No graphic layout, no vignette, no colour-matched palette, no stock-photography cleanliness. It should look like one real image someone came across and kept, not a picture built to be a cover.

Inside the safe middle, place the subject deliberately and off the exact centre line — a little left or right of it, high or low in the frame. Avoid perfect one-point perspective and mirror symmetry unless the scene asks for it by name; a corridor, an aisle or a road running dead straight to a vanishing point behind the subject's head is one composition among many, not the default.

THE BODY MAY BE THE SUBJECT, BUT IT MAY NEVER BE EVIDENCE. A portrait of an athletic person is a portrait; the same person beside a product, or paired with a second image, or holding a measurement, is a claim. A strong or lean body in frame is fine when it is lit and shot as an editorial portrait and nothing in the picture offers it as a result: no before-and-after or split framing, no scales, tape measures, calipers or assessment mirrors, no gym equipment, no product, no numbers anywhere.

BANNED, without exception: no medical or clinical apparatus, no hospital, clinic, laboratory or gym setting, no white coats, no stethoscopes, no monitors; no visible illness, injury, wound, distress or emaciation; no pills, capsules, powders, supplements, syringes or product of any kind; no cigarettes, alcohol, drugs or vapes; no children; no anatomical or medical imagery; no crowds. No text, no letters, no numbers, no signage, no logo, no watermark anywhere in the image.

SCENE: ${scene}`;


// ---- the graphic system: eight looks, one master frame --------------------------------------
// Each look carries its own default palette (ground, line/figure, accent) and its own medium cue.
// The frame around them is constant: no text, no product, no clinic, no anatomical realism, one
// subject inside the middle 60 percent of the width, the ground running edge to edge, rendered
// 21:9 and cropped to 5:2.
export const GRAPHIC_LOOKS = {
  concept: {
    palette: 'a pure, fully saturated crimson poster red for the ground, hex #E00D22, the red of a fire engine: not coral, not tomato, not brick, not dusty or faded, and the paper grain never dulls it. White for every object and for the faces, shirts and hands; black for the suits and shoes. Red, white and black only. Red may appear once more, inside the picture, on the one thing the picture is about',
    lock: '#E00D22',
    medium: 'STYLE: a conceptual editorial illustration of the kind that runs on the cover of a business magazine: ONE visual metaphor, stated with the fewest possible elements, that a reader decodes in under a second and that means something once decoded. Human figures are men in plain black suits with white shirts, rendered as posterised photographic cut-outs: two tones with a coarse screen-print grain, the face and hands flat white with a few black shadow marks, no drawn outline. Never vector silhouettes, never photographic detail. Objects are simple white solids (a cube, a sphere, a ribbon of road, a length of cable, a strip of tape, a door) with a soft paper texture and one soft, long shadow laid on the ground. The ground is one flat, fully saturated crimson red (#E00D22) with a faint mottled paper grain that never dulls the colour, and it runs to every edge of the frame. Flat lighting, no gradients beyond the shadows, no outlines, no texture beyond the grain, no extra colour, no decoration: every element in the frame has a job in the sentence. NOT a photograph, NOT 3D rendered, NOT a vector cartoon.',
    evidence: '0xHvdes: the Principles covers (1.6M, 1.6M and 1.2M views at 7.3–8.3 bookmarks/1K) and the tape cover (8.1); one visual sentence each, three colours, one to four elements',
  },
  wire: {
    palette: 'a deep midnight-blue ground, warm cream for every line, and one small electric-orange accent',
    medium: 'STYLE: a flat two-colour screen print or risograph. Bold flat fields of colour, visible print grain, a slight misregistration of the inks, matte paper texture. The subject is drawn as continuous line work, a single line that never lifts from the paper where the scene allows it, with the accent colour used exactly once as the thing the picture is about. Entirely illustrated: NOT a photograph, NOT photorealistic, NOT 3D rendered, no shading gradients, no glossy surfaces.',
    evidence: 'our own: the Jasper article cover; the corpus: rubenhassid\'s two-tone series (2.3–6.3M)',
  },
  halftone: {
    palette: 'a black ground, a cream halftone for the figure, and one flat vermilion-orange for the symbol',
    medium: 'STYLE: a two-tone halftone print in the manner of a 1950s newspaper photograph pushed through a screen print. The human figure is a coarse halftone in one ink, printed as if from an old anonymous photograph or engraving, seen from behind or with the face hidden or turned away. On top of it, one oversized flat graphic symbol in the accent colour, printed as a solid shape with a slight offset, the only smooth surface in the image. Visible dot screen, paper grain, ink bleed. The scene is printed directly onto the black ground: its shadows and darks are the ground\'s own black, so the room\'s wall and floor run out to the left and right edges of the frame as halftone and dissolve into black there. No paper edge, no print border, no cream card or rectangle of photograph sitting on a black field; the black of the ground and the black of the print are one and the same. NOT a photograph, NOT photorealistic, no gradients except the halftone itself.',
    evidence: 'rubenhassid: six covers 2.3–6.3M (the asterisk series)',
  },
  engraved: {
    palette: 'black ink on white paper only, no colour at all',
    medium: 'STYLE: a digital drawing that emulates scratchboard and wood engraving. Dense variable-weight hatching and stipple, pure black and white, no grey wash, no halftone. Seventy to ninety percent of the frame is solid black or near-black; the subject emerges from darkness in fine white line. Exactly one void of pure black, enormous, that the small figure faces or falls toward: a hole, a cave mouth, a whirlpool, a tunnel, a night sky. One small human figure, seen from behind, never more than a quarter of the frame tall, dwarfed by the one enormous thing. A screen-native illustration, not a scan: no paper edge, no margin.',
    evidence: 'thedankoe: the largest covers in the corpus (225.7M, 16.6M, 13.1M, 11.3M, 6.4M), the GTX system minus its red',
  },
  flat: {
    palette: 'a saturated poster red ground, off-white shapes, and black for the silhouettes',
    medium: 'STYLE: a flat vector editorial illustration in the manner of a 1960s exhibition poster. Two or three flat colours only, hard edges, no gradients, no outlines, no texture beyond a faint paper tooth. Human beings appear only as small featureless silhouettes. The idea is a spatial metaphor made of simple shapes: a road that forks, a crowd walking one way and one figure the other, a wall with three doors, a staircase into a head. Bold, legible at thumbnail size. NOT a photograph, NOT 3D, no shading.',
    evidence: 'the corpus\'s Bauhaus-adjacent covers and our own Bauhaus head; 0xHvdes is NOT this look (their figures are photo cut-outs, their ground is grained: see concept)',
  },
  bio: {
    palette: 'a near-black slate ground with the faintest cold blue-green cast; the structure in white and pale grey light; one hairline accent in signal red used once, along the one path the article is about; nothing else',
    medium: 'STYLE: biology rendered as data, in the register of high-end scientific visualisation: one living structure from any system of the body (a nerve fibre or a neuron; a strand of gut lining with its villi; a branching blood vessel or an alveolar tree; a muscle fibre as banded bundles of filaments; a lattice of bone; a sheet of skin cells as tiles; a single cell with its membrane; a mitochondrion as a folded capsule; a hormone or molecule as a lattice of points and lines; a whole organ only as a hollow outline made of points) built entirely from a point cloud, a fine wireframe mesh, or thousands of luminous filaments, seen against darkness. The look of a research render or an instrument\'s display, not of a photograph and not of an illustration: precise, cold, expensive. Volumetric depth: the structure fills the middle of the frame, near parts sharp and bright, far parts softening into the dark; a shallow depth of field; a faint glow where the points are densest; fine scan-line or grid texture only in the darkest areas, barely visible. Monochrome, with the single accent used once. The biology is abstracted, never pictured: tissue is lattice, mesh, filament or point cloud; a whole organ is a hollow silhouette of points with no surface detail; no photoreal tissue, no cross-sections, no blood, no pathology, and no instrument in the frame (no monitor, panel, readout, dial or machine), only the structure floating in the dark as if it were the display. The dark is uniform from edge to edge: no lighter rectangle, panel, screen, box or frame behind or around the structure. If a head or a figure is in the scene it is an empty cloud of points, with no organ drawn inside it. NOT a photograph, NOT a flat illustration, NOT a cartoon, no text of any kind, not even tick marks or scan labels.',
    evidence: 'alexeixbt: the particle-brain scan cover (4.8M impressions, the biggest article in their set, linked by the operator 2026-09-14), the plexus face (0.79M) and the wireframe king (1.1M); their feed is grayscale neuron microscopy (6.4M, 2.7M, 2.4M views)',
  },
  threshold: {
    palette: 'HERE: a black void with fine white star speckle and print grain; THERE: the found fragment carries the only colour in the frame (an old oil painting\'s muted blues and creams by default; an engraving\'s ink, a photograph\'s sepia or a map\'s buff when the scene says so); the figure, the ground and the rim of the edge solid black; nothing else',
    medium: 'STYLE: a mixed-media collage built from two worlds and one edge. HERE is a matte black field with fine white star speckle and the grain of an old print, and it fills most of the frame, running to every edge. THERE is a fragment of a found image in another medium: by default an old oil painting with visible craquelure and canvas weave (a sky of tall cumulus, a sea, a field at dawn), or an engraving, a sepia photograph or an old map when the scene says so; it is the only colour in the frame. The edge between the two worlds is physical and rough, as the scene names it: torn paper, cut card, split rock, a crack, a doorway, a window, a layer peeled back. The human element is a solid black silhouette cut from a photograph, in plain clothes, seen from behind or in profile, the face never visible; it may be a hand, or absent when the scene puts an object at the edge instead. The light comes only from THERE into HERE, so every shadow falls away from the fragment toward the viewer; the ground under the figure is dark cracked stone or plain boards, lit by that light alone. Grainy, tactile, high contrast, the collage seams visible: NOT a clean digital render, NOT a photograph, NOT a cartoon, no text. GEOMETRY, unless the scene moves it: HERE takes at least three fifths of the frame; THERE sits inside the middle 60 percent of the width, about three quarters of the height, a little right of the centre line; the figure stands on the centre line at the edge, about half the frame tall, its head inside the brightest part of THERE; the ground band is the bottom third; the stars thin toward the corners.',
    evidence: 'alexeixbt: Fix Yourself in 1 Day (1.08M impressions, 5.4 bookmarks/1K, the highest saves in their set; the cover the operator sent) and the tunnel of light (0.24M); thedankoe\'s engraved cave figure (16.6M) is the same picture in another medium. The grammar (two worlds, one edge, the silhouette, light from THERE) is in style/cover-threshold-logic.md',
  },
  spotlight: {
    palette: 'a black stage, one warm white spotlight, and nothing else',
    medium: 'STYLE: dense pen-and-ink illustration of a single object standing alone on a black stage under one hard spotlight from above and slightly ahead. The object is drawn with obsessive cross-hatching, its shadow long and sharp, everything outside the pool of light solid black. Monochrome, no colour, no text. The object is ordinary and literal (a chess king, a coil of rope, a wound-up alarm clock, a single chair) and slightly larger than life. NOT a photograph, NOT 3D rendered, no gradients beyond the hatching.',
    evidence: 'incentivising and thedankoe: the chess covers at 15.6 and 13.6 bookmarks/1K, the binoculars cover at 15.9',
  },
};
const GRAPHIC_FRAME = (lookKey, pal, sceneLine) => `Aspect ratio 21:9, ultra-wide landscape; the image will be cropped to 5:2 (1200x480), so keep everything that matters clear of the top and bottom 6 percent. A single graphic image filling the whole frame edge to edge, no border, no frame, no margin.

${GRAPHIC_LOOKS[lookKey].medium}

PALETTE: ${pal}. One committed palette for the whole frame; nothing outside it.

COMPOSITION, and this one is absolute: everything that carries the picture sits inside the middle 60 percent of the width and is complete there. The subject fills roughly two thirds of the frame height, placed slightly off the exact centre line, and nothing essential comes within a tenth of any edge. X crops the sides of a cover in the feed; the picture must still be the whole picture as a square cut from the middle.

THE GROUND RUNS EDGE TO EDGE. The background the scene stands on (the wall, floor, sky, road, water, paper or flat colour) continues across the full width and full height of the frame at the same colour and texture. The outer thirds are the same scene continued, simply emptier: more ground, the road or cable running on, a secondary element that can be lost to the crop without loss (a crowd, the other figures). Never a card, an inset, a print with a paper edge, a border, a vignette, a letterbox, a change of colour at the sides, or a picture sitting on a black field.

THE SUBJECT IS THE DOMAIN, THE CLAIM IS WITHHELD. The one physical thing the article owns is in the frame, unmissable, and made strange by scale, place or material. Never a diagram of the argument, never the product, never a person in medical distress.

BANNED, without exception: no text, letters, numbers, signage, logo or watermark; no pills, capsules, powders, bottles or product of any kind; no medical or clinical apparatus, hospital, laboratory, white coat or stethoscope; no realistic anatomy (a stylised head or silhouette is fine, an anatomical brain or organ is not); no visible illness, injury or distress; no cigarettes, alcohol or drugs; no children; no photographic realism.

SCENE: ${sceneLine}`;

if (style === 'graphic' && (glook === 'list' || medium === 'list')) {
  for (const [k, v] of Object.entries(GRAPHIC_LOOKS)) console.log(`${k.padEnd(10)} palette: ${v.palette}\n           evidence: ${v.evidence}\n`);
  process.exit(0);
}
if (style === 'graphic' && !GRAPHIC_LOOKS[glook]) { console.error(`--style graphic needs --look ${Object.keys(GRAPHIC_LOOKS).join('|')} (or --look list)`); process.exit(1); }

const prompt = promptFile ? readFileSync(promptFile, 'utf8')
  : DIAGRAM ? DIAGRAM_MASTER
  : style === 'graphic' ? GRAPHIC_FRAME(glook, palette || GRAPHIC_LOOKS[glook].palette, scene)
  : style === 'health' ? HEALTH_MASTER
  : MASTER;

if (style === 'health' && !DRY) console.log(`style health · medium ${chosen} · ${ratio} · shot ${shot} · subject ${subject}`);
if (style === 'graphic' && !DRY) console.log(`style graphic · look ${glook} · 21:9 → crop ${crop || 'none'}`);

if (DRY) { console.log(prompt); process.exit(0); }

const env = loadEnv();
let saved = [];
if (from) { saved = [from]; console.log(`from ${from} · no model call`); }
else {
requireEnv(env, ['OPENROUTER_API_KEY']);

// Rule 4 of the visual system: lock the look with self-reference. Attaching approved covers is
// what keeps the series one series, so a --ref is worth more than any extra prompt wording.
const content = [{ type: 'text', text: prompt }];
for (const r of refs) {
  const mime = extname(r).toLowerCase() === '.jpg' || extname(r).toLowerCase() === '.jpeg' ? 'image/jpeg' : 'image/png';
  content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${readFileSync(r).toString('base64')}` } });
}
if (refs.length) content.push({ type: 'text', text: 'Match the line technique, contrast and figure scale of the reference images exactly. Change only the scene.' });

const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'gtx-cover-gen' },
  body: JSON.stringify({ model, modalities: ['image', 'text'], messages: [{ role: 'user', content }], usage: { include: true } }),
});
const text = await res.text();
if (!res.ok) { console.error(`OpenRouter ${res.status}: ${text.slice(0, 400)}`); process.exit(1); }
const j = JSON.parse(text);
const images = j.choices?.[0]?.message?.images || [];
if (!images.length) {
  console.error('No image came back. Model said:', String(j.choices?.[0]?.message?.content || '').slice(0, 300));
  process.exit(1);
}

mkdirSync(dirname(out) || '.', { recursive: true });
saved = [];
images.forEach((im, i) => {
  const url = im.image_url?.url || im.url || '';
  const b64 = url.split(',')[1];
  if (!b64) return;
  const path = i === 0 ? out : out.replace(/(\.\w+)?$/, `-${i + 1}$1`);
  writeFileSync(path, Buffer.from(b64, 'base64'));
  saved.push(path);
});
console.log(`${saved.length} image(s) · ${model} · $${(j.usage?.cost ?? 0).toFixed(4)}`);
for (const p of saved) console.log('  ' + p);
if (style === 'gtx') console.log('Downscale to 1200x480 with a good resampler and push blacks to #000 before publishing.');
}


// ---- --crop W:H — the X Article cover is 5:2 and the feed crops the sides, so the file that goes
// up is the crop, not the render. Pure JS (zlib is built in; no image library in the sandbox):
// decode the PNG, centre-crop to the ratio biased a third toward the top (heads and coils keep
// their clear space, feet and necks run off the bottom), bilinear-resize to 1200 wide, re-encode.
function decodePng(bytes) {
  const zlib = require('node:zlib');
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG (the model returned another format)');
  let pos = 8, idat = [], w = 0, h = 0, ct = 0, bd = 0;
  while (pos < bytes.length) {
    const len = bytes.readUInt32BE(pos), type = bytes.toString('ascii', pos + 4, pos + 8), body = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); bd = body[8]; ct = body[9]; if (bd !== 8 || body[12] !== 0) throw new Error('unsupported PNG (bit depth / interlace)'); }
    else if (type === 'IDAT') idat.push(body); else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct]; if (!ch) throw new Error('unsupported PNG colour type');
  const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = w * ch; const rows = []; let prev = Buffer.alloc(stride); let i = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[i++]; const line = Buffer.from(raw.subarray(i, i + stride)); i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255; else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
    }
    rows.push(line); prev = line;
  }
  return { w, h, ch, rows };
}
function encodePng(outW, outH, out) {
  const zlib = require('node:zlib');
  const crc = (buf) => { let c = ~0; for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(outW, 0); ihdr.writeUInt32BE(outH, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function cropPng(bytes, ratio, outW = 1200) {
  const { w, h, ch, rows } = decodePng(bytes);
  const cw = w, chh = Math.min(h, Math.round(w / ratio)), y0 = Math.floor((h - chh) * 0.35);
  const outH = Math.round(outW / ratio); const out = Buffer.alloc((outW * 3 + 1) * outH);
  for (let Y = 0; Y < outH; Y++) {
    const sy = Math.max(0, (Y + 0.5) * chh / outH - 0.5 + y0), y1 = Math.min(h - 1, Math.floor(sy)), y2 = Math.min(h - 1, y1 + 1), fy = sy - Math.floor(sy);
    const r1 = rows[y1], r2 = rows[y2]; const o0 = Y * (outW * 3 + 1); out[o0] = 0;
    for (let X = 0; X < outW; X++) {
      const sx = Math.max(0, (X + 0.5) * cw / outW - 0.5), x1 = Math.min(w - 1, Math.floor(sx)), x2 = Math.min(w - 1, x1 + 1), fx = sx - Math.floor(sx);
      const a = x1 * ch, b = x2 * ch;
      for (let c = 0; c < 3; c++) {
        const cc = ch < 3 ? 0 : c;
        out[o0 + 1 + X * 3 + c] = Math.round((r1[a + cc] * (1 - fx) + r1[b + cc] * fx) * (1 - fy) + (r2[a + cc] * (1 - fx) + r2[b + cc] * fx) * fy);
      }
    }
  }
  return encodePng(outW, outH, out);
}

// ---- --punch #rrggbb — the colour lock. The model returns the ground a shade off the look (a coral
// where the look says crimson: measured hue 2° / sat 0.72 against 0xHvdes's 355° / 0.94; operator
// 2026-09-14: "compared to 0xHvdes our color seems pale"). Find the dominant chromatic colour of the
// image, rotate its hue onto the target and scale its saturation and value to the target's; neutrals
// (the white cut-outs, the black suits) and the grain are left alone, and the anti-aliased edges move
// proportionally so nothing halos. The concept look carries its lock (#E00D22); --punch none skips it.
function lockPng(bytes, hex) {
  const { w, h, ch, rows } = decodePng(bytes);
  if (ch < 3) throw new Error('greyscale PNG; lock skipped');
  const toHsv = (r, g, b) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let hh = 0; if (d) { if (mx === r) hh = ((g - b) / d) % 6; else if (mx === g) hh = (b - r) / d + 2; else hh = (r - g) / d + 4; hh *= 60; if (hh < 0) hh += 360; } return [hh, mx ? d / mx : 0, mx]; };
  const toRgb = (hh, sat, v) => { const c = v * sat, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = v - c; let r = 0, g = 0, b = 0; if (hh < 60) [r, g, b] = [c, x, 0]; else if (hh < 120) [r, g, b] = [x, c, 0]; else if (hh < 180) [r, g, b] = [0, c, x]; else if (hh < 240) [r, g, b] = [0, x, c]; else if (hh < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x]; return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]; };
  const dist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const [tH, tS, tV] = toHsv(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16));
  // 1. the dominant chromatic hue, from a 36-bin histogram over a 4x4 sample of the chromatic pixels
  const bins = new Array(36).fill(0);
  for (let y = 0; y < h; y += 4) { const r = rows[y]; for (let x = 0; x < w; x += 4) { const o = x * ch; const [hh, sat, v] = toHsv(r[o], r[o + 1], r[o + 2]); if (sat >= 0.25 && v >= 0.15) bins[Math.floor(hh / 10) % 36]++; } }
  let top = 0; for (let k = 1; k < 36; k++) if (bins[k] > bins[top]) top = k;
  if (!bins[top]) throw new Error('no chromatic ground found; lock skipped');
  const centre = top * 10 + 5; let sx = 0, sy = 0, ss = 0, sv = 0, n = 0, rr = 0, gg = 0, bb = 0;
  for (let y = 0; y < h; y += 4) { const r = rows[y]; for (let x = 0; x < w; x += 4) { const o = x * ch; const [hh, sat, v] = toHsv(r[o], r[o + 1], r[o + 2]); if (sat >= 0.25 && v >= 0.15 && dist(hh, centre) <= 15) { sx += Math.cos(hh * Math.PI / 180); sy += Math.sin(hh * Math.PI / 180); ss += sat; sv += v; n++; rr += r[o]; gg += r[o + 1]; bb += r[o + 2]; } } }
  let dH = Math.atan2(sy, sx) * 180 / Math.PI; if (dH < 0) dH += 360; const dS = ss / n, dV = sv / n;
  const from = '#' + [rr, gg, bb].map((c) => Math.round(c / n).toString(16).padStart(2, '0')).join('');
  // 2. every pixel within 35° of that hue moves with it, proportionally; neutrals stay where they are
  const shift = tH - dH, sMul = tS / dS, vMul = Math.min(1.25, Math.max(0.85, tV / dV));
  const out = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const r = rows[y]; const o0 = y * (w * 3 + 1); out[o0] = 0;
    for (let x = 0; x < w; x++) {
      const o = x * ch; let R = r[o], G = r[o + 1], B = r[o + 2];
      const [hh, sat, v] = toHsv(R, G, B);
      if (sat >= 0.12 && dist(hh, dH) <= 35) { let nh = (hh + shift) % 360; if (nh < 0) nh += 360; [R, G, B] = toRgb(nh, Math.min(1, sat * sMul), Math.min(1, v * vMul)); }
      out[o0 + 1 + x * 3] = R; out[o0 + 2 + x * 3] = G; out[o0 + 3 + x * 3] = B;
    }
  }
  return { buf: encodePng(w, h, out), from, to: '#' + hex.toLowerCase(), hue: [Math.round(dH), Math.round(tH)], sat: [dS.toFixed(2), tS.toFixed(2)] };
}
let stage = [...saved];
if (crop) {
  const m = crop.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/); if (!m) { console.error(`--crop wants W:H, e.g. 5:2 (got ${JSON.stringify(crop)})`); process.exit(1); }
  const ratio = Number(m[1]) / Number(m[2]); stage = [];
  for (const p of saved) {
    try { const outP = p.replace(/(\.\w+)?$/, `-${m[1]}x${m[2]}.png`); writeFileSync(outP, cropPng(readFileSync(p), ratio)); console.log(`  cropped ${crop} → ${outP}`); stage.push(outP); }
    catch (e) { console.error(`  crop failed for ${p}: ${e.message}`); stage.push(p); }
  }
}
const lockTarget = punch === 'none' ? '' : (punch || (style === 'graphic' && GRAPHIC_LOOKS[glook] ? GRAPHIC_LOOKS[glook].lock || '' : ''));
if (lockTarget) {
  const m = lockTarget.match(/^#?([0-9a-fA-F]{6})$/); if (!m) { console.error(`--punch wants #rrggbb or none (got ${JSON.stringify(lockTarget)})`); process.exit(1); }
  const next = [];
  for (const p of stage) {
    try { const outP = p.replace(/(\.\w+)?$/, '-lock.png'); const r = lockPng(readFileSync(p), m[1]); writeFileSync(outP, r.buf); console.log(`  colour lock → ${r.to}: ground ${r.from} (hue ${r.hue[0]}°, sat ${r.sat[0]}) → hue ${r.hue[1]}°, sat ${r.sat[1]} → ${outP}`); next.push(outP); }
    catch (e) { console.error(`  colour lock failed for ${p}: ${e.message}`); next.push(p); }
  }
  stage = next;
}
let uploadPath = stage[0];

if (upload) {
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  // GTX and LearningToan are not in accounts.mjs (that file is the affiliate fleet), so they are
  // named here; every fleet account resolves by key OR handle so --upload magnus just works.
  const SETS = { gtx: 151393, geniusgtx: 151393, learningtoan: 201212 };
  const { ACCOUNTS } = await import('./accounts.mjs');
  for (const [key, a] of Object.entries(ACCOUNTS)) {
    if (!a.socialSetId) continue;
    SETS[key.toLowerCase()] = a.socialSetId;
    if (a.handle) SETS[a.handle.toLowerCase()] = a.socialSetId;
  }
  const socialSetId = SETS[upload.toLowerCase()] || (/^\d+$/.test(upload) ? Number(upload) : null);
  if (!socialSetId) { console.error(`unknown --upload target ${JSON.stringify(upload)}`); process.exit(1); }
  const tf = typefully(env);
  const mediaId = await tf.uploadMedia(socialSetId, uploadPath.split('/').pop(), readFileSync(uploadPath));
  console.log(`uploaded to social set ${socialSetId} · media id ${mediaId}`);
  console.log('Set it as the article cover with a PATCH: {"platforms":{"x_article":{"cover_media_id":"' + mediaId + '"}}}');
}
