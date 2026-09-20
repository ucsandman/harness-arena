# Design brief: Harness Arena (marketing page)

## Foldlight

## The moment
Saturday, 6:40am, a high-school track in October. Fog sits on the infield and lane one is still wet from the sprinklers. I am at the finish with a clipboard, a steel timer clipped to it, thumb resting on the button. Two runners are on the line, same distance, same heat, and nobody speaks. The scoreboard behind the stands is dark except one row. The number that counts is the one the watch prints, not what either of them says after.

## Register and surface
brand; landing. Standalone page at `apps/web/marketing/index.html`; the product app's `globals.css` is untouched.

## Fold
scoreboard: one figure at absurd scale over a fixed strip of period cells that never moves. Gaze `down` applied as gravity: the figure sits on the strip, not at the top. Envelope measured: topBand=1.000 (>= 0.8), foldInk=0.081 (<= 0.3), bandRatio=0.039 (<= 0.4).

## Light
source at 10 o'clock, 5200K, lit 18%; key-angle 219deg; plate assets/plate-01.png provider=procedural. Fill: one row of amber seven-segment digits far behind the stands, 2000K, faint (the only chroma in the scene).

## Palette
--bg oklch(0.124 0 90) the room outside the lamp, plate p06 to p20
--surface oklch(0.207 0 90) the lit body of the subject, plate p55 to p72
--ink oklch(0.831 0 90) the face of the light source itself, plate p98 and up
--accent oklch(0.800 0.150 75) override: the amber seven-segment fill from light.fill; the fog key is neutral
--muted oklch(0.607 0 90) 62 percent from bg to ink, lifted to clear 4.5:1

## Type
Science Gothic (display, fonts.mjs rank 2 for led/flat/wght,tnum) over Pathway Extreme (body, rank 1 for screen/flat/wght); specimen docs/specimen.png read. Pathway Extreme lost display for reading as a wristwatch app; TikTok Sans for soft ovals and a brand name.

## Voice
person=second, tense=future (held), median 5 to 9, ceiling 13, headline 8 words, clause cap 1, volume quiet, labels sentence case.
empty: Nothing has run yet. Your first heat will show here.
loading: Both sides are still working. The count will land when the last test does.
error: The run stopped at the build step. Open the log and it will start again.
offline: Nothing since 4:12. The next result will wait for you.
done: Both times are in. The sheet will not change.
first-run: This page stays empty until your first heat.

## Motion
verb: settle. Travel budget 8px, transient 700ms after a 200ms hold, no transport. Twin: under prefers-reduced-motion the figure is simply present.

## Signature
The demo heat's real time is the whole fold, and the verdict strip under it is the only separator on the page.

## Never
scoreboard, stopwatch, finish tape (plus podium, trophy, medal, starting pistol, confetti, stadium floodlights). Negative prompt: "scoreboard, stopwatch, podium, trophy, medal, finish tape, starting pistol, confetti, stadium floodlights, studio softbox, two light sources, colour gel, bokeh balls, glossy advertising retouch, text, watermark, illustration, CGI look".

## Measured (2026-09-19)
PASS docs/fold-1440.png: cells=200x125 viewport=1440x900 foldRows=125 inkedRows=58 ground=rgb(9,9,8) 64% envelope=3 fold=scoreboard findings=0
FAIL docs/mobile.png: cells=200x1771 viewport=390x844 foldRows=433 inkedRows=699 ground=rgb(7,7,7) 78% envelope=3 fold=scoreboard findings=1 (SAAS_FOLD 3/6 on the full-page single-column stack; envelope itself passes; left open)
FAIL baseline-saas.png: SAAS_FOLD 3/6 AWWWARDS_FOLD 4/4
FAIL baseline-awwwards.png: SAAS_FOLD 2/6 AWWWARDS_FOLD 4/4
PASS index.html: nodes=81 rules=15 states=6/6 findings=0 (craft-lint, brand)
PASS styles/tokens.css: roles=5 oklch=5 fold=scoreboard kit=yes findings=0
PASS index.html: strings=43 words=310 sentences=45 beats=13 median=6 states=6/6 findings=0 (copy-lint)
fold-metrics --bands: contrastFails IN; hero 317px and scale 17.61x OUT of the generic brand band by design (the scoreboard recipe fixes the figure at 22vw)
Kitsch: a stranger names a departures board or a lap counter, not a track meet.
motion-twin reduce: live=0 substantive=0
