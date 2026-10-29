# Dogfight — Lab 01: The Event Loop Is the Game Loop

A small, playable space-flight game built with vanilla JavaScript, Vite, ES modules, and the Canvas 2D API. The simulation runs in fixed 1/60-second steps; the browser renders whenever it is ready.

## Run it

Use Node.js 22 (the version in `.nvmrc`) and npm:

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173/`. To make a production build and serve that build locally:

```powershell
npm run build
npm run preview
```

Run the quality checks from the project folder:

```powershell
npm run lint
npm run format:check
npm test
npm run build
```

### Controls and features

| Key        | Action                                       |
| ---------- | -------------------------------------------- |
| `W` or `↑` | Thrust in the direction the ship is pointing |
| `A` or `←` | Turn left                                    |
| `D` or `→` | Turn right                                   |
| `Space`    | Brake                                        |
| `R`        | Reset the ship                               |

The arena wraps at all four edges. The ship has acceleration, drag, a speed limit, and a small animated flame. A deterministic starfield makes movement visible. The on-canvas HUD shows simulation steps per second, rendered frames per second, and the most recent JavaScript frame-processing time.

## Project map and architecture

```text
index.html
package.json
.nvmrc
eslint.config.js
.prettierrc.json
README.md
src/
  main.js             # Connects input, simulation, rendering, and optional experiments
  loop.js             # Fixed-step accumulator, optional comparison modes, timing metrics
  input.js            # Closure-backed keyboard state and just-pressed edges
  sim/
    ship.js           # Plain ship data, pure integration, interpolation
    arena.js           # Pure wrap-around calculation
  render/
    canvas.js         # Canvas 2D setup, resize observation, device-pixel ratio
    draw.js           # Starfield, ship, and HUD drawing
tests/
  input.test.js
  loop.test.js
  sim.test.js
```

`src/sim/` does not import the DOM, canvas, or browser APIs. `integrate(ship, input, dt)` reads a ship and an input interface and returns a new ship; `wrapShip` also returns a new object. This makes the physics easier to test and repeat. `main.js` retains the last two simulation states. The renderer blends them with the loop's interpolation alpha, so drawing can run at a display's refresh rate without changing the physics step.

`createInput(target)` uses a closure to keep its `Set`s private. A keydown edge remains available until a simulation step consumes it, which avoids losing a short key press on a display that renders more often than the simulation advances.

## Event loop, in beginner-friendly terms

JavaScript in a page runs one piece of JavaScript at a time on its main thread. The engine provides two important memory areas:

- The **heap** stores objects and other data that live beyond a single function call, such as the ship object and the input sets.
- The **call stack** records the functions currently running. A function runs to completion before another JavaScript callback can run; other JavaScript cannot interrupt it halfway through.

The browser supplies **Web APIs** such as timers, keyboard events, network requests, and `requestAnimationFrame`. They arrange for work and later make callbacks eligible to run; they do not make a long JavaScript callback run in parallel on the main thread.

When the call stack becomes empty, the browser's **event loop** selects work:

1. A callback such as a timer or click handler runs as a **task** (often called a macrotask).
2. When that task finishes, the browser drains the **microtask queue** completely. Promise `.then` callbacks, `await` continuations, and `queueMicrotask` callbacks run here. A microtask that queues another microtask runs before the drain is over.
3. When it is time to update the display, the browser runs eligible **`requestAnimationFrame` callbacks**, then performs style calculation, layout, and paint. Animation callbacks are part of a rendering opportunity, not ordinary tasks or microtasks.

The familiar ordering puzzle:

```js
console.log('1');
setTimeout(() => console.log('2'), 0);
Promise.resolve().then(() => console.log('3'));
console.log('4');
```

**Expected output: `1`, `4`, `3`, `2`, in that order.** The two direct logs run first on the current stack. After the stack empties, the promise reaction runs as a microtask. The timer callback is a later task, so it runs after the microtask drain. A zero-millisecond timer means “eligible no earlier than later,” not “run immediately.”

### Why the game loop uses a fixed timestep

The browser controls when frames are painted. A 60 Hz display has about 16.67 ms between refreshes; a 120 Hz display has about 8.33 ms. The fixed simulation step remains 1/60 second on either display. An accumulator collects elapsed time and calls `simulate(1 / 60)` as many times as needed. A 250 ms maximum elapsed-time clamp prevents an enormous catch-up burst after a pause. The remainder divided by the fixed step is `alpha`, between 0 and 1; the renderer blends the previous and current states by that fraction.

The renderer's angle interpolation follows the shorter arc around the circle. Without it, an angle just below `+π` interpolated to one just above `-π` would appear to spin almost a full revolution.

`requestAnimationFrame` is the normal scheduler: it aims to run just before a paint, follows the display's refresh cadence instead of assuming 16 ms, and browsers normally pause or throttle it in hidden tabs. A `setInterval(frame, 16)` timer is not synchronized to paint, its timing can drift or jitter, and browsers may throttle it in a background tab.

### What ES modules add

The entry script uses `<script type="module">`. Modules are strict by default, have their own scope instead of adding ordinary top-level declarations to the global scope, support explicit `import` and `export`, are deferred until the HTML has been parsed, and are evaluated once per module URL. This project uses named exports so the module API is explicit. Top-level `this` in a module is `undefined`.

## Prove it to yourself: five browser-console experiments

Open the game in a browser, press F12, and use the DevTools Console. For experiments involving script tags, create a small scratch HTML page or use the Console's Snippets panel. Predict the result before running each snippet.

1. **Task versus microtask order.** Run the canonical puzzle above. Then insert `queueMicrotask(() => console.log('5'));` immediately after the promise line. First output: `1, 4, 3, 5, 2`. The synchronous logs finish first, then microtasks drain in insertion order, and only then can the timer task run.
2. **A blocked main thread.** Run `setTimeout(() => console.log('timer'), 0); const t = Date.now(); while (Date.now() - t < 2000) {} console.log('done');`. You should see `done` before `timer`, roughly two seconds later. The event loop cannot dispatch the timer callback while this script still owns the call stack.
3. **Animation-frame cadence.** In a page console, run:
   ```js
   let last = 0,
     samples = 0;
   function measure(now) {
     if (last) console.log((now - last).toFixed(2), 'ms');
     last = now;
     if (++samples < 100) requestAnimationFrame(measure);
   }
   requestAnimationFrame(measure);
   ```
   Foreground values are often near 16.7 ms at 60 Hz or 8.3 ms at 120 Hz, with variation. Switch to another tab for a few seconds and return: rAF is normally paused or heavily throttled while hidden, so the first gap grows and the game clamps that elapsed time.
4. **Block scope and closures.** Run `for (var i = 0; i < 3; i++) setTimeout(() => console.log(i));`, then repeat with `let`. The `var` version prints `3, 3, 3`: all callbacks close over the same function-scoped binding after the loop. The `let` version prints `0, 1, 2`: each iteration has its own block-scoped binding.
5. **Module scope and `this`.** Compare `console.log(this)` in a classic `<script>` and in `<script type="module">`: a browser classic script has `window` as top-level `this`, while a module has `undefined`. Put `const secret = 1` at the top level of one module and try to read `secret` in a different module without importing it: it is not a shared global, and the other module cannot resolve that name.

## Project experiments: measure, then record your own evidence

The developer panel is deliberately hidden during ordinary play. Open `http://localhost:5173/?experiments=1` to show controlled switches for the timer scheduler, variable timestep, and the synchronous busy-wait. The panel's 10-second measurement reports the chosen modes, elapsed time, sample count, average frames per second, standard deviation of observed frame intervals, and average/maximum JavaScript frame-processing time. It writes the actual result to the page and the console; it does not fill in the README automatically.

For each trial, use the same browser, window size, power settings, and foreground state unless the trial specifically calls for changing them. Open DevTools before starting and keep the experiment conditions in your notes. Capture a screenshot of the canvas, HUD, selected experiment settings, and measured output. For CPU throttling use Chrome DevTools **Performance → CPU** and select **6× slowdown**. Record browser/version, display refresh rate if known, conditions, and screenshot filename. Results marked **integrated-browser run** are measurements captured from this workspace's browser session, not universal expected values; replace or supplement them with your own readings.

### Experiment 1 — 100 ms synchronous busy-wait

1. Start with `requestAnimationFrame`, fixed timestep, and the busy-wait checkbox off. Note the HUD and run a 10-second measurement.
2. Turn on **Block the main thread for 100 ms every 60th rendered frame** and repeat. Turn it off again after collecting evidence.
3. Record what you actually observe. Expect a visible hitch about once per 60 rendered frames; frame intervals and their jitter rise, average FPS falls, and keyboard input may feel delayed around each block. The HUD's frame-processing time includes the block and should show a large spike. Exact readings depend on the machine and browser.

| Run                                 | Busy-wait | Average FPS | Frame-time/jitter observation                                           | Responsiveness and screenshot                          |
| ----------------------------------- | --------- | ----------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| Baseline (integrated-browser run)   | Off       | 165.00      | 0.060 ms interval jitter; 0.151 ms average / 0.400 ms max frame time    | No visible blocking; local screenshot still to collect |
| Experiment (integrated-browser run) | On        | 132.02      | 11.631 ms interval jitter; 1.819 ms average / 100.200 ms max frame time | Periodic hitch; local screenshot still to collect      |

These are actual 10-second measurements from one integrated browser session. They are an example, not a promise that another browser, display, or machine will produce the same numbers.

Why does this freeze the page? The `while` loop is synchronous JavaScript and keeps running on the main thread until it returns. While it occupies the call stack, the browser cannot execute another JavaScript task, process the game's next input callback, or reach its normal rendering work. Scheduling a timer, promise, or another rAF callback from the same thread cannot interrupt it; those callbacks must wait their turn. The browser may have compositor work that continues independently, but JavaScript cannot use that to keep this main-thread canvas and input responsive during the block.

### Experiment 2 — rAF versus a 16 ms interval

1. Open the developer panel and select **requestAnimationFrame**, fixed timestep. Click **Measure for 10 seconds** without changing tabs. Save the displayed output.
2. Select **setInterval (16 ms)** and repeat with the same window and conditions. The scheduler change restarts the loop.
3. For each scheduler, start another measurement, switch to another tab for five seconds, then return. Wait for the page's measurement output and record the actual elapsed time and samples. Hidden-tab timers are browser-dependent; do not assume the interval is completely unthrottled.
4. Restore `requestAnimationFrame` and fixed timestep before normal play.

| Scheduler                                         | Foreground average FPS (10 s) | Foreground frame-interval jitter (ms) | Hidden-tab observation (5 s away)             | Screenshot / conditions                                           |
| ------------------------------------------------- | ----------------------------- | ------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| `requestAnimationFrame` (integrated-browser run)  | 165.00                        | 0.060                                 | _manual 5-second background-tab run required_ | Integrated browser, foreground; local screenshot still to collect |
| `setInterval(frame, 16)` (integrated-browser run) | 62.50                         | 0.605                                 | _manual 5-second background-tab run required_ | Integrated browser, foreground; local screenshot still to collect |

The panel computes average FPS from the measured frame intervals and reports interval jitter as the population standard deviation in milliseconds. In a hidden tab the 10-second timer itself can be delayed; use the reported elapsed seconds and sample count when interpreting that run. The two foreground values above came from 10.00 s (`requestAnimationFrame`, 1,651 samples) and 10.01 s (`setInterval`, 625 samples), respectively.

### Experiment 3 — fixed versus variable timestep

1. Reset the ship, select **Fixed timestep**, then open DevTools Performance and choose **6× CPU slowdown**. Hold thrust for five seconds using a stopwatch, then click **Capture ship position** in the developer panel. Repeat without throttling from a reset state.
2. Select **Variable timestep**, reset, and repeat both trials. In this mode physics advances once per rendered frame using that frame's elapsed time (clamped to 250 ms), rather than fixed 1/60-second steps.
3. Record your four actual positions and conditions. Restore **Fixed timestep**. Small differences from input timing and manual timing are possible; compare the fixed pair with the variable pair rather than expecting perfect measurements from hand-timed key presses.

| Mode                              | CPU condition                     | Position after 5 s thrust (`x`, `y`) | Screenshot / notes                                    |
| --------------------------------- | --------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| Fixed (integrated-browser run)    | Normal; automated 5.00 s key hold | `(405.60, 317.08)`                   | Integrated browser; local screenshot still to collect |
| Fixed                             | 6× slowdown                       | _manual result required_             | _filename / notes_                                    |
| Variable (integrated-browser run) | Normal; automated 5.00 s key hold | `(405.60, 319.57)`                   | Integrated browser; local screenshot still to collect |
| Variable                          | 6× slowdown                       | _manual result required_             | _filename / notes_                                    |

The normal-speed positions above came from separate, reset trials with an automated five-second `W` hold in the integrated browser; the arena wraps, so compare the displayed coordinates together with velocity. For the throttled trials, turn on DevTools 6× CPU slowdown, reset, hold `W` for five seconds, release, and immediately click **Capture ship position**. The position button records coordinates and velocity without adding globals or logging each frame. Record whether you used a stopwatch or automated hold. Do not compare trials unless the starting state and thrust duration match.

## Reflection — answers

1. **Trace the runtime.** The heap holds the timer callback and promise reaction while the call stack runs the current script. `setTimeout(f, 0)` asks a Web API to make `f` eligible as a later task. `Promise.resolve().then(g)` queues `g` as a microtask. After the current stack empties, the event loop drains `g` before selecting the timer task `f`. Rendering may happen at a rendering opportunity after that work.
2. **Why a 100 ms loop freezes the page.** JavaScript callbacks run to completion on the main thread. During the loop the stack never empties, so input handlers and other JavaScript tasks cannot run; the browser also loses the normal opportunity to update layout and paint. Code on that same blocked thread cannot preempt itself. Work must be split across tasks/frames or moved to a worker where appropriate.
3. **Tasks and microtasks.** A task runs when selected by the event loop; after it completes, the microtask queue is drained until empty before the next task or rendering opportunity. A recursively replenished microtask queue can keep that drain nonempty and starve paint. A timer chain schedules each next callback as a separate task, leaving the browser opportunities between tasks to render or process other work.
4. **Where rAF runs and why it helps.** rAF callbacks run as part of the browser's rendering update, before style/layout/paint, after the current task and its microtask drain. Compared with `setInterval(fn, 16)`, rAF is aligned with paint, adapts to the display's actual refresh rate, and is normally paused or throttled in hidden tabs so it avoids unnecessary background work.
5. **The accumulator.** Add elapsed time to an accumulator, call simulation repeatedly with the same fixed `step` while enough time remains, and retain the fractional remainder. Clamp elapsed time after a hitch so the loop cannot enter an unbounded catch-up spiral. `alpha = accumulator / step` describes the fraction of a step left over; the renderer uses it to blend previous and current state for smooth display.
6. **Determinism and multiplayer.** A deterministic simulation produces the same result from the same initial state, fixed time steps, and input sequence. That makes replays and debugging reproducible and helps multiplayer clients agree on simulation results; variable frame-dependent physics can diverge across machines with different performance.
7. **What closures capture.** A closure retains access to the lexical variables (bindings) in which it was created, not a frozen copy of each value. In a `var` loop all callbacks refer to the same function-scoped `i`, whose value is `3` when they run. A `let` loop creates a distinct binding per iteration, so callbacks see `0`, `1`, and `2`.
8. **Five module changes.** A module's top-level declarations are module-scoped rather than ordinary globals; `import`/`export` provide explicit linking; module code is strict by default; modules are deferred until HTML parsing completes; and each module URL is evaluated once and can be shared by importers. Additionally, top-level `this` is `undefined`.

## Deliverable checklist

- [x] Vite project, `"type": "module"`, ESLint, Prettier, and `.nvmrc`.
- [x] `createLoop` with rAF default, fixed-step clamped accumulator, interpolation alpha, start/stop protection, and simulation/frame/frame-time metrics in the HUD.
- [x] Private-set `createInput` closure with `isDown` and `justPressed`.
- [x] Pure ship integration and arena wrapping with no DOM/canvas imports in `src/sim/`.
- [x] Interpolated rendering with shortest-angle interpolation, DPR scaling, resize handling, starfield, and thrust flame.
- [x] Optional busy-wait, rAF/interval, and fixed/variable timestep comparisons.
- [x] Automated tests for simulation, input edges, interpolation, and loop behavior.
- [x] Setup, architecture, event-loop theory, five console experiments, project-experiment procedures/results tables, eight reflection answers, and evidence-collection instructions.
- [x] Record real foreground measurements for the busy-wait, both scheduler modes, and normal-speed fixed/variable trials.
- [ ] Collect local screenshots, background-tab measurements, and fixed/variable trials under 6× CPU throttling.
- [ ] Create the `lab-01` Git tag after all checks pass.

### Stretch work

The optional gamepad, touch, frame-time histogram, and Web Worker exercises are not required for the lab's definition of done and are not included in this implementation.
