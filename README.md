# Curve Lane Bowling

A different kind of bowling game: no 3D, no models — just a top-down lane
drawn on a `<canvas>`, a curved line tracing every ball you roll, and three
timing-based meters (Power, Accuracy, Spin) that decide the shot.

## How it plays

Each roll goes through three quick timing stages. A cursor sweeps back and
forth across a bar; tap the button (or press `Space`) to lock it where it
stands:

1. **Power** — how hard you throw. Also affects how much a hook has time to
   develop (a slower ball hooks more, just like real bowling).
2. **Accuracy** — how close to dead-center you stop the cursor. Off-center
   locks send the ball down the lane at an angle.
3. **Spin** — locks in hook direction/strength. The ball's path curves more
   sharply the deeper it travels down the lane.

The resulting path is drawn live as a curved line on the lane, the ball
animates along it, and pins fall based on where the path crosses them (with
a bit of chain-reaction randomness for pins knocking into their neighbors).
Standard 10-frame bowling scoring applies, strikes/spares/10th-frame bonus
rolls included.

## Tech

Plain HTML/CSS/JS, no build step, no dependencies. Open `index.html`
directly or serve the folder with any static file server.

## Deployment

Pushing to `main` runs `.github/workflows/deploy.yml`, which publishes the
repo root to GitHub Pages via GitHub Actions (Settings → Pages → Source:
GitHub Actions).
