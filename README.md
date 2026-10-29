# Dogfight — JavaScript Game Labs 01–03

A continuing space-flight game built with vanilla JavaScript, Vite, ES modules, and the Canvas 2D API. Lab 01 established the fixed-step event/game loop; Lab 02 added the entity model and combat; Lab 03 adds cancellable asynchronous asset loading, a local HTTP lobby, sprite sheets, and Web Audio without replacing the existing simulation.

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
| `F`        | Fire while held                              |
| `R`        | Reset the ship                               |

The ship has acceleration, drag, a speed limit, a hull meter, and a small animated flame. It wraps at the arena edges; asteroids drift and bounce. Destroy asteroids, collect shield/rapid-fire pickups, and respawn after being destroyed. A deterministic starfield makes movement visible. The on-canvas HUD shows score, hull, simulation steps per second, rendered frames per second, and the most recent JavaScript frame-processing time.

## Project map and architecture

```text
index.html
package.json
.nvmrc
eslint.config.js
.prettierrc.json
README.md
src/
  main.js             # Loading → lobby → game bootstrap and Lab 01 experiments
  assets/
    loader.js         # Abortable fetch, retry/backoff, concurrent progress-aware loading
  audio.js            # Web Audio context, decoded effect playback, event subscriptions
  events.js           # Small EventTarget/CustomEvent bridge injected into simulation
  hud.js              # DOM status updates driven by game events
  lobby.js            # HTTP room data, validation, refresh lifecycle, join event
  loop.js             # Fixed-step accumulator, optional comparison modes, timing metrics
  input.js            # Closure-backed keyboard state and just-pressed edges
  sim/
    vector.js         # Immutable vector operations with explicit in-place variants
    entity.js         # Shared identity and base entity behavior
    ship.js           # Ship extends Entity; private health and firing
    bullet.js         # Timed projectiles
    asteroid.js       # Drifting, bouncing, damageable obstacles
    pickup.js         # Stationary collidable effects
    explosion.js      # Short-lived particles
    homing.js         # Composable target-following behavior
    collision.js      # Circle-pair detection and collision resolution
    world.js          # Map store, iterable queries, deferred sweep
    game.js           # Game session, score, setup, and timed respawn
    arena.js          # Lab 01 pure wrap-around helper
  render/
    canvas.js         # Canvas 2D setup, resize observation, device-pixel ratio
    draw.js           # Loading screen, sprite/fallback rendering, effects, and HUD
    lobby-ui.js       # DOM room list that subscribes to Lobby events
tests/
  audio.test.js
  entities.test.js
  game.test.js
  input.test.js
  loader.test.js
  lobby.test.js
  loop.test.js
  render.test.js
  sim.test.js
public/
  api/rooms.json
  assets/manifest.json
  assets/arena.json
  assets/sprites.svg
  assets/*.wav
vite.config.js        # Development-only slow/corrupt/404 failure-test endpoints
```

`src/sim/` does not import the DOM, canvas, audio, or HUD modules. It publishes game notifications only through an injected `emit(type, detail)` function; `main.js` connects that boundary to an `EventTarget`/`CustomEvent` instance. The live game uses mutable entity objects and captures a small previous-state snapshot before each fixed simulation step; rendering blends those snapshots with the loop's interpolation alpha. The Lab 01 `integrate(ship, input, dt)` pure plain-object API remains as a compatibility adapter using the same physics tuning and is still covered by regression tests.

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
- [x] Preserve the existing `lab-01` Git tag at the completed Lab 01 commit.

### Stretch work

The optional gamepad, touch, frame-time histogram, and Web Worker exercises are not required for the lab's definition of done and are not included in this implementation.

---

## Lab 02 — Objects, Prototypes, and `this`: The Entity Model

Lab 02 extends this same game and repository. It does not replace the Lab 01 loop: the browser still uses the original `createLoop`, fixed 1/60-second accumulator, interpolation alpha, Canvas setup, keyboard closure, frame metrics, and developer experiment controls. The visible game now contains an entity world and a shootable ship.

### Play the expanded game

Use the Lab 01 controls plus `F` (hold to fire). Bullets travel from the ship's nose and inherit its velocity. Asteroids drift and bounce inside the arena; one has a low-speed homing component. Destroyed asteroids award 100 points and may drop a pickup. Shield and rapid-fire pickups are stationary, collidable objects. The ship has three private hull points; collision damage destroys it, creates particles, and respawns it at a seeded random safe location after two simulation seconds. The score and hull are shown alongside the unchanged Lab 01 performance HUD.

### Entity model and update lifecycle

`Vector2` provides immutable `add`, `sub`, `scale`, `normalize`, `rotate`, `dot`, `length`, and `fromAngle` operations. Explicit `addInPlace`/`subInPlace`/`scaleInPlace` methods are available where mutation is intended. `Entity` owns a private static ID counter, an inaccessible per-instance ID, position, velocity, angle, radius, alive flag, kind, and shared update behavior. `Ship`, `Bullet`, `Asteroid`, `Pickup`, and `Explosion` each extend `Entity` by one level; there is no deeper inheritance chain.

Objects remain dynamic property bags, and class methods are ordinary prototype lookups rather than per-instance copies. Object assignment copies a reference, `===` checks identity, and object spread makes only a shallow copy; nested component objects remain shared unless deliberately copied. The game mutates its entity objects during fixed-step updates, while `main.js` saves the small previous-position snapshot required for rendering interpolation.

`World` owns `Map<number, Entity>`, exposes insertion-order iteration and a lazy `ofKind(kind)` generator, and marks entities dead before sweeping them at the end of `step`. Each step updates a snapshot of entities so objects spawned mid-step start updating on the next step. The default circle-pair generator and resolver live separately in `collision.js`; a different collision-pair function can be passed to `World` without changing the manager. This deliberately keeps the current O(n²) collision scan swappable for a later spatial hash.

`GameSession` owns game-level score and the two-second respawn countdown. Simulation remains independent of DOM and canvas. The renderer interpolates the saved pre-step position/angle to the current entity state using the existing loop alpha; the ship's wrap-around interpolation takes the short route across arena edges. Lab 01's pure `integrate`/`createShip` helper API remains available for earlier examples and automated regression tests. The live class-based ship calls the same integration calculation, avoiding two different flight-physics implementations.

### `this` bug, demonstration, and repair

A class method is not automatically bound to its instance. Passing `ship.fire` directly as a callback detaches it; when called without its receiver, strict class code sees `this === undefined` and cannot read the ship's weapon state. The entity test deliberately performs this detached call and verifies that it throws. The real shooting path safely invokes `this.player.fire(this.world)` from `GameSession`, preserving the receiver.

For an event listener you could use `button.addEventListener('click', () => ship.fire(world))`: the arrow closes over `ship` and `world`, but creates a callback for that registration. Or use `ship.fire.bind(ship, world)`: it makes a bound function that retains the receiver and arguments. A class-field arrow (`fire = () => ...`) is convenient for callbacks but allocates one function per instance rather than sharing a prototype method. Here the shared class method plus explicit method call keeps that memory cost out of every entity.

### Composition instead of another inheritance branch

The reusable homing behavior in `homing.js` is a small component object with an `update(entity, world, dt)` function. Both `Bullet` and `Asteroid` can hold that same component and choose a target kind; neither must inherit a special `HomingBullet` or `HomingAsteroid` branch. `Ship` also has a `Map` of timed pickup effects and a weapon component field. `Pickup` stays a plain stationary collidable entity that applies an effect to a ship; it is not a ship subclass. If behavior were encoded only through inheritance, homing bullets and asteroids would require duplicated branches or a hierarchy such as `Entity → Moving → Homing → Bullet/Asteroid`, while a pickup would be forced into an irrelevant ship/weapon ancestry. The composed behavior is independently attachable and testable, and its data stays local to each entity.

### Lab 02: prove it to yourself

Open the browser DevTools Console and predict the outputs first. These three exercises are the required console experiments in the Lab 02 assignment; their related language behavior is also covered by automated unit tests.

1. **Delegation, not copying:**
   ```js
   const a = { hello: 'first' };
   const b = Object.create(a);
   b.hello; // "first", found on a through the prototype chain
   a.hello = 'changed';
   b.hello; // "changed"; b did not get a copied hello property
   Object.hasOwn(b, 'hello'); // false
   ```
2. **Call-site `this`:**
   ```js
   class A {
     m() {
       return this;
     }
   }
   const a = new A();
   const m = a.m;
   m(); // undefined in a module/class method (or a TypeError if the method reads this)
   m.call(a) === a; // true: explicit binding
   ```
   Passing `ship.fire` to an event API has the same detached-receiver problem. Try it in a scratch snippet; the game calls the method through `this.player.fire(...)` rather than handing the unbound method to the event system.
3. **Object keys versus `Map` keys:**
   ```js
   const o = { 1: 'x' };
   const m = new Map([[1, 'x']]);
   o[1]; // "x": object property keys are strings/symbols
   m.get('1'); // undefined: Map distinguishes number 1 from string "1"
   m.get(1); // "x"
   ```

Optional generator exercise: run `for (const bullet of world.ofKind('bullet')) { console.log(bullet.id); break; }` while paused at a breakpoint in `main.js`. Breaking early stops the generator; converting the entire world to `[...world]` just to find one item would create an unnecessary temporary array.

### Lab 02 reflection answers

1. **The four `this` rules, from highest to lowest precedence:** `new` binding, explicit `call`/`apply`/`bind`, implicit `obj.method()` receiver, and default binding (`undefined` in strict direct calls, otherwise `globalThis`). `setTimeout(ship.fire, 100)` detaches the method; any receiver supplied by the timer host is not `ship`, so the method cannot access that ship's weapon state. An arrow wrapper is concise but creates a callback closure; `bind` creates a bound function and can retain arguments; an arrow class field is easy to pass around but costs one function per instance.
2. **Arrows and `this`:** an arrow has no local `this`; it closes over the surrounding lexical `this`, so `.bind`, `.call`, and `.apply` cannot replace it. Arrows are useful for short callbacks that should capture an enclosing instance. They are less suitable for a method shared by many instances if defining one arrow per instance is unnecessary.
3. **Why `Map` for entities:** it accepts numeric IDs without string coercion, exposes `.size` and insertion-order iteration, and has no inherited property keys such as `"constructor"`. Its `delete` operation also makes explicit removal clear. The world still defers deletion until after its update/collision pass.
4. **Why composition here:** homing is a capability shared by two different entity kinds. An inheritance-only design would duplicate homing logic or create a branching/deep `Moving → Homing → Bullet/Asteroid` hierarchy; the component is attached only where wanted. A pickup is collidable and stationary without pretending to be a ship or subclass.
5. **Optional prototype chain:** `s → Ship.prototype → Entity.prototype → Object.prototype → null`. Looking up `s.update` checks the instance, then `Ship.prototype`; if Ship does not define `update`, lookup continues to `Entity.prototype`. This implementation does define `Ship.update`, which overrides the inherited movement method.
6. **Optional `new` sketch:** `function construct(Ctor, ...args) { const instance = Object.create(Ctor.prototype); const result = Ctor.apply(instance, args); return result && (typeof result === 'object' || typeof result === 'function') ? result : instance; }`. This only approximates constructor functions: class constructors cannot be called with `.apply`, and native `new` also handles built-ins and `new.target`.
7. **Optional “class is sugar”:** classes use prototypes for shared methods, but add syntax and guarantees constructor functions do not automatically provide: class declarations are not callable without `new`, their bodies are strict, and prototype methods are non-enumerable. `extends` also establishes both instance-prototype and constructor inheritance links.
8. **Optional iterables:** an iterable has a `Symbol.iterator` that produces values on demand. `World` can be used in `for…of` and `ofKind` is a generator; `[...world]` eagerly allocates an array containing every entity, which can create avoidable work and memory pressure in a frequent game-loop query.

### Lab 02 verification and requirement audit

Statuses below reflect the code and tests actually run in this repository. A manual browser/DevTools exercise remains “needs manual verification”; a passing code test is not presented as evidence that the manual exercise was performed.

#### Lab 01 regression audit

| Lab / requirement                                                              | Implementing file and function                                                            | Status                    | Actual verification result                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lab 01 M1: rAF, fixed accumulator, clamped delta, alpha, idempotent start/stop | `src/loop.js` — `createLoop`, `frame`, `start`, `stop`                                    | Done                      | `tests/loop.test.js`: fixed steps, alpha, duplicate start/stop, and 250 ms clamp pass.                                                                                                  |
| Lab 01 metrics: steps/s, frames/s, latest frame duration; HUD                  | `src/loop.js` — `updateMetrics`; `src/render/draw.js` — `drawHud`                         | Done                      | `tests/render.test.js` checks 60 steps/s, 120 frames/s, 2.50 ms, plus Lab 02 score/hull labels.                                                                                         |
| Lab 01 M2: closure input, held keys, just-pressed edges                        | `src/input.js` — `createInput`                                                            | Done                      | `tests/input.test.js`: held-state, edge consumption, and experiment-control focus pass.                                                                                                 |
| Lab 01 flight physics, heading, thrust, drag, brake, speed clamp               | `src/sim/ship.js` — `integrate`, `Ship.update`; `src/sim/vector.js`                       | Done                      | `tests/sim.test.js`: pure compatibility integration, deterministic thrust, and speed clamp pass.                                                                                        |
| Lab 01 arena wrap-around                                                       | `src/sim/arena.js` — `wrapShip`; `src/sim/ship.js` — `Ship.update`                        | Done                      | `tests/sim.test.js` checks wrap coordinates; game session uses ship wrap on its fixed-step update.                                                                                      |
| Lab 01 M3: previous/current interpolation including angle and wrap seam        | `src/main.js` — `simulate`; `src/render/draw.js` — `drawWorldScene`, `interpolateWrapped` | Done                      | `tests/sim.test.js` checks angular and positional wrap interpolation.                                                                                                                   |
| Lab 01 Canvas DPR setup and resize                                             | `src/render/canvas.js` — `createCanvas`, `resize`                                         | Done                      | Browser check measured CSS 811.2×378.4 at DPR 1.25 as a 1014×473 backing canvas; after changing viewport to 695.2×619.4 at DPR 1 and dispatching resize, backing canvas became 695×619. |
| Lab 01 M3: starfield and animated thrust flame                                 | `src/render/draw.js` — `drawStarfield`, `drawShip`                                        | Done                      | Browser screenshot shows stars/ship; `tests/render.test.js` checks idle ship rendering and both added flame layers when thrusting.                                                      |
| Lab 01 controls still work in the expanded game                                | `src/input.js`; `src/sim/ship.js` — `Ship.update`; `src/main.js`                          | Needs manual verification | Input/physics tests pass; perform actual key play in the local browser to verify feel.                                                                                                  |
| Lab 01 experiment 1: optional 100 ms busy-wait and explanation                 | `src/main.js` — `render`; README Lab 01 Experiment 1                                      | Done                      | Existing browser measurements preserved: baseline 165.00 FPS/0.060 ms jitter; busy-wait 132.02 FPS/11.631 ms jitter/100.200 ms max frame time.                                          |
| Lab 01 experiment 2: rAF versus interval measurement                           | `src/loop.js`; `src/main.js`; README Lab 01 Experiment 2                                  | Partially done            | Existing measured foreground values preserved (rAF 165.00 FPS/0.060 ms; interval 62.50 FPS/0.605 ms). Five-second background-tab comparison still needs manual run.                     |
| Lab 01 experiment 3: fixed vs variable under 6× throttling                     | `src/loop.js`; `src/main.js`; README Lab 01 Experiment 3                                  | Partially done            | Existing unthrottled five-second positions preserved. Paired 6× DevTools runs remain manual; no results invented.                                                                       |
| Lab 01 event-loop theory, five console exercises, all eight reflections        | README Lab 01 sections                                                                    | Done                      | Content retained through this README update; source assignment re-opened and checked. Browser-console exercises are instructions, not claimed manual runs.                              |
| Lab 01 ESLint, Prettier, tests, production build, `lab-01` tag                 | `package.json`; configs; test files; Git history                                          | Done                      | Final checks listed in the completion report; tag `lab-01` remains on the original Lab 01 commit.                                                                                       |

#### Lab 02 deliverable audit

| Lab / requirement                                                                       | Implementing file and function                                                                          | Status                    | Actual verification result                                                                                                           |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Lab 02 M1: pure `Vector2` operations, `fromAngle`, explicit in-place variants           | `src/sim/vector.js` — `Vector2`                                                                         | Done                      | `tests/entities.test.js`: pure add, normalize, rotate, dot, fromAngle, and explicit in-place mutation pass.                          |
| Lab 02 M1: private static entity ID, fields and shared update                           | `src/sim/entity.js` — `Entity`                                                                          | Done                      | `tests/entities.test.js`: unique IDs, private ID, and class relationship pass.                                                       |
| Lab 02 M1: `Ship extends Entity`, one inheritance level                                 | `src/sim/ship.js` — `Ship`                                                                              | Done                      | `tests/entities.test.js` checks `instanceof` and methods on prototypes; other entity classes directly extend `Entity`.               |
| Lab 02 M2: `Map` store, spawn/get/deferred despawn, iterator, generator, safe sweep     | `src/sim/world.js` — `World`                                                                            | Done                      | `tests/entities.test.js`: insertion order, `ofKind`, mark-dead then sweep, and snapshot-safe spawn pass.                             |
| Lab 02 M2: bullet TTL, drifting/bouncing asteroids, ship nose fire + inherited velocity | `src/sim/bullet.js`; `src/sim/asteroid.js`; `src/sim/ship.js` — `Ship.fire`                             | Done                      | `tests/entities.test.js`: TTL removal, edge bounce, bullet origin/velocity, cooldown, and detached-`this` error pass.                |
| Lab 02 M3: swappable circle collision system; bullet damage to ships and asteroids      | `src/sim/collision.js` — `collisionPairs`, `resolveCollisions`; `src/sim/world.js` — `step`             | Done                      | `tests/entities.test.js`: circle pairs, replaceable system, ship damage, asteroid kill, and cleanup pass.                            |
| Lab 02 M3: private ship health, explosion particles, two-second safe respawn, score HUD | `src/sim/ship.js`; `src/sim/explosion.js`; `src/sim/game.js` — `GameSession.step`; `src/render/draw.js` | Done                      | `tests/game.test.js` checks score, pickup effect, respawn delay and protection; `tests/render.test.js` checks score/hull labels.     |
| Lab 02 M4: homing attachable to bullet and asteroid; stationary collidable pickups      | `src/sim/homing.js`; `src/sim/bullet.js`; `src/sim/asteroid.js`; `src/sim/pickup.js`                    | Done                      | `tests/entities.test.js` checks steering for both entity types, pickup application, and circle collision behavior.                   |
| Lab 02 M4: composition design note ≤1 page                                              | README Lab 02 “Composition instead of another inheritance branch”                                       | Done                      | Design trade-off and alternative hierarchy documented in a concise section.                                                          |
| Lab 02 `this` bug deliberately shown, corrected, explained                              | `src/sim/ship.js` — `Ship.fire`; `tests/entities.test.js`; README Lab 02                                | Done                      | Automated detached method throws; bound and normal method calls are checked; actual shooting uses a receiver-preserving method call. |
| Lab 02 console exercises and reflection                                                 | README Lab 02 sections                                                                                  | Needs manual verification | Three exact console exercises and reflection answers are documented; user-run console practice is not claimed.                       |
| Lab 02 lint, format, all tests, production build, `lab-02` tag                          | Project config, tests, Git                                                                              | Done                      | Final run: ESLint and Prettier pass; all 30 tests pass; Vite production build succeeds. `lab-02` is created on this verified commit. |

### Final project checks

Run all labs together from the project directory:

```powershell
npm run lint
npm run format:check
npm test
npm run build
```

The optional Lab 01 stretch (gamepad, touch, frame-time histogram, worker) and Lab 02 stretch (typed-array ECS and spatial hash benchmark) remain outside the required deliverables.

---

## Lab 03 — Asynchronous JavaScript: Loading, Lobby, and Sound

This lab extends the same local game and repository. It does not replace the fixed-step simulation. See the [original Lab 03 assignment](https://github.com/rmalkevy/Programming-Practice-Projects/blob/main/courses/javascript/lab-03-async-javascript.md).

### Play the game

```powershell
npm install
npm run dev
```

Open the Vite URL (usually `http://localhost:5173/`). The app loads its manifest, required sprite sheet and arena definition, plus optional decoded audio. The canvas draws an actual progress bar while requests settle. When required data is ready, the app fetches the local room list, refreshes it periodically, and displays the lobby. Enter a pilot name, select a room, and choose **Join selected room**. Joining starts the existing local game with the room's asteroid count and seed. The first Join click also asks the browser to resume Web Audio; if the browser blocks it, the game remains playable and reports the audio problem in the accessible status text.

Use the Lab 01/02 controls documented above. With `?experiments=1`, the existing game-loop experiments remain available after joining. That panel also has a sequential-versus-concurrent asset transfer measurement.

### Architecture and loading lifecycle

```text
main.js
  ├─ creates EventTarget, Web Audio owner, canvas, and lobby UI
  ├─ fetchJson/loadJson + withRetry → manifest
  ├─ loadAll (parallel required/optional items + item progress)
  ├─ decode optional audio before play; draw sprites from the loaded sheet
  ├─ Lobby.refresh() → GET /api/rooms.json → roomsChanged
  └─ Lobby.join() → GameSession → original fixed-step createLoop

src/sim/
  └─ emits event names/details through an injected emit function only
      ├─ events.js → EventTarget/CustomEvent
      ├─ audio.js → fired / hit / exploded
      └─ hud.js → scoreChanged / roomJoined / audioError
```

The simulation imports neither the audio module nor the DOM HUD. Its event callback is injected by the bootstrap, so simulation and Canvas tests do not need a browser. The lobby's data layer extends `EventTarget`; `src/render/lobby-ui.js` subscribes to it and owns DOM rendering. A generation counter prevents stale room responses from replacing new data. The polling loop schedules its next timeout only after the current refresh finishes; `Lobby.stop()` aborts an in-flight request, clears the timer, and invalidates old results. Each HTTP room request combines a request controller with `AbortSignal.timeout(3000)`.

The request URL `/api/rooms.json` maps directly to `public/api/rooms.json`, so Vite copies the same static endpoint into the production `dist/api/rooms.json`. Each room contains an `arena` configuration; the selected room's asteroid count and seed are passed into `GameSession`, while current Canvas dimensions remain the logical play area.

`public/assets/manifest.json` names the sprite sheet, arena JSON, and three local PCM sound effects. `loadAll()` starts independent entries concurrently, reports progress after each item settles, tolerates failed optional sounds, and rejects with `AssetLoadError` if any required asset fails. Image fetches check HTTP status before decoding through an object URL; this is important because otherwise an `<img>` error hides whether the server actually returned 404. Audio buffers are decoded before entering the lobby. Ship, bullet, and asteroid draw calls use the source rectangles `(0,0,32,32)`, `(40,8,16,16)`, and `(64,0,48,48)` from the same sheet. If a sheet is unavailable, the renderer still has the previous procedural shapes as a fallback; a required-sheet loading failure is shown with a retry option instead of starting in a misleading partial state.

`withRetry(fn, { attempts, baseMs, signal })` uses exponential backoff with full jitter for network `TypeError`s and HTTP 5xx. It does not retry `HttpError` 4xx, malformed JSON, or cancellation. The cancellable delay removes its timer and abort listener on completion or cancellation. `loadImage`, `loadAudio`, `loadJson`, and `fetchJson` all accept a signal; JSON and audio fetches check `response.ok`.

### Async JavaScript: the essential model

#### Callbacks and the reason Promises help

A callback is a function passed to an API to be invoked later, such as an image `load` handler or a timer. Callbacks are still how browser events are delivered. A chain of dependent callbacks can become deeply nested (“callback hell”), every layer must remember its own error branch, and control is inverted: the API receiving a callback controls when/how often it calls it. There is also no built-in way to wait for several callback operations together. Promises wrap one eventual result in a consistent contract.

#### Promise state, chaining, and errors

A Promise starts **pending** and may settle exactly once, either as **fulfilled** with a value or **rejected** with a reason. Settlement cannot move backward or change to the other terminal state. Calling `.then(onFulfilled, onRejected)` returns a new promise. A normal return fulfills that next promise; returning another promise makes the chain wait for it; throwing rejects it. `.catch(handler)` is the rejection form of `.then`. `.finally(handler)` runs after either outcome and normally passes the original value or rejection onward. If the `finally` handler itself throws or returns a rejected promise, that new failure replaces the previous outcome.

Promise reactions always run asynchronously as **microtasks**, even if the promise is already fulfilled:

```js
Promise.resolve('later').then(console.log);
console.log('now');
// now
// later
```

Rejections keep propagating until a handler catches them. If a chain has no rejection handler, browsers report an `unhandledrejection` event/console error; Node's default unhandled-rejection mode terminates the process with a non-zero status. Attach a meaningful catch, or let a caller deliberately handle the rejected operation; do not make a successful-looking fallback that hides a real failure.

#### `async`/`await` is non-blocking Promise syntax

An `async` function always returns a promise. `await` suspends only that function: it returns control to the event loop, and resumes the function as a microtask when the awaited promise settles. Rejection resumes by throwing at the `await`, so `try/catch` works naturally:

```js
async function loadArena() {
  try {
    const arena = await loadJson('/assets/arena.json');
    return arena;
  } catch (error) {
    console.error('Arena loading failed:', error);
    throw error;
  }
}
```

This is the asynchronous equivalent of:

```js
function loadArena() {
  return loadJson('/assets/arena.json').then(
    (arena) => arena,
    (error) => {
      console.error('Arena loading failed:', error);
      throw error;
    },
  );
}
```

The function gives the current task back to the event loop at `await`; it is not holding the JavaScript call stack while the network works.

#### Promise combinators

| Combinator                   | Settlement rule                                                                                                           | A game-related use                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Promise.all(values)`        | Fulfills when all fulfill, preserving input order; rejects on the first rejection. It does **not** cancel the other work. | Required sprite and arena assets; the loader also handles optional entries and per-item progress.                             |
| `Promise.allSettled(values)` | Waits for every outcome and returns `{ status, value/reason }` records.                                                   | Report which optional sound effects could not be decoded while allowing the game to continue.                                 |
| `Promise.race(values)`       | Takes the first settlement, fulfilled or rejected.                                                                        | Apply a timeout by racing a task with a timeout rejection (prefer `AbortSignal.timeout` when the request itself should stop). |
| `Promise.any(values)`        | Takes the first fulfillment; rejects with `AggregateError` only if all reject.                                            | Future asset mirrors: accept the first working CDN.                                                                           |

When `Promise.all` rejects, its other promises keep running unless their shared `AbortSignal` is explicitly aborted. The loader wraps each entry with progress accounting, then joins the concurrent work with `Promise.all`; required failures are collected and never returned as a successful asset result.

#### `fetch`, response bodies, timeouts, and retry

`fetch(url)` fulfills when response headers arrive. An HTTP 404 is still a fulfilled fetch promise; inspect `response.ok` and `response.status`. Reading `response.json()`, `.arrayBuffer()`, or `.blob()` is a second asynchronous operation that consumes the response body. `fetchJson()` centralizes the status check so a 404 cannot masquerade as an empty successful room list.

Promises do not have a `.cancel()` method. `AbortController` supplies a signal to APIs that support it; calling `controller.abort()` asks the fetch/body read and our own signal-aware work to stop. `AbortSignal.timeout(ms)` creates a signal that aborts after a deadline. An application can combine a lifecycle controller with a timeout using `AbortSignal.any([controller.signal, AbortSignal.timeout(ms)])`. A cancellable function should accept a signal, check `signal.aborted` before starting work, pass it to cancellable APIs, listen for `abort` during timers or custom work, clean up listeners/timers, and reject with the abort reason.

For retryable transient failures, exponential backoff increases the delay after each attempt (`baseMs × 2ⁿ`) and jitter randomizes the wait so many clients do not retry in lockstep. Do not retry permanent client errors (400–499), corrupt data, or an intentional cancellation. This project tests retries without external network access.

#### Events, async iteration, and Web Audio

An event reports repeated facts over time (“a shot fired”, “rooms changed”). A promise represents one eventual result (“this manifest finished loading”). `EventTarget` and `CustomEvent(type, { detail })` provide a small browser-native event channel. The game injects an emitter; audio and HUD subscribe independently. To turn one event into one promise, use a once listener:

```js
const ready = new Promise((resolve) => {
  lobby.addEventListener('roomsChanged', resolve, { once: true });
});
await ready;
```

An async iterable's `next()` returns a promise, so `for await (const item of source)` waits for each next value. A `ReadableStream` such as `response.body` can yield download chunks before the whole file arrives. That makes byte-level progress possible if the server provides `Content-Length`; this lab keeps assets small and does not implement the optional streaming stretch.

Web Audio loading has distinct steps: fetch bytes, read `arrayBuffer()`, decode with `AudioContext.decodeAudioData()`, then play an `AudioBuffer` through a new `AudioBufferSourceNode`. This app decodes during loading, not on the first shot. Browsers may keep an `AudioContext` suspended until a user gesture; Join calls `resume()` from the click path. Separate source nodes allow short effects to overlap. Audio failures are surfaced, but sound is optional and cannot prevent flight.

### Five task/microtask ordering puzzles

Run each snippet in a **visible foreground browser tab**. `requestAnimationFrame` depends on a rendering opportunity, so do not run the rAF puzzles in a background tab.

1. **`await`, a timer scheduled inside `.then`, and rAF**

   ```js
   console.log('sync 1');
   Promise.resolve().then(() => {
     console.log('then');
     setTimeout(() => {
       console.log('timer');
       requestAnimationFrame(() => console.log('raf'));
     }, 0);
   });
   (async () => {
     console.log('async start');
     await null;
     console.log('async resume');
   })();
   console.log('sync 2');
   ```

   **Output:** `sync 1`, `async start`, `sync 2`, `then`, `async resume`, `timer`, `raf`. The first logs are on the current stack. The `.then` and `await` continuations are microtasks in the order queued. The `.then` creates a timer task; that timer schedules rAF for a later visible rendering opportunity.

2. **Chaining and `finally`**

   ```js
   Promise.resolve(2)
     .then((value) => {
       console.log('then', value);
       return value * 3;
     })
     .then((value) => console.log('next', value))
     .finally(() => console.log('finally'));
   console.log('sync');
   ```

   **Output:** `sync`, `then 2`, `next 6`, `finally`. Each continuation is asynchronous; each `.then` receives the prior handler's result.

3. **A rejection through catch**

   ```js
   Promise.reject(new Error('boom'))
     .catch((error) => {
       console.log('caught', error.message);
       return 'recovered';
     })
     .then((value) => console.log(value));
   console.log('stack done');
   ```

   **Output:** `stack done`, `caught boom`, `recovered`. The catch turns rejection into a fulfilled value for the next link.

4. **Two async continuations and a queued microtask**

   ```js
   async function first() {
     console.log('first');
     await Promise.resolve();
     console.log('first resume');
   }
   async function second() {
     console.log('second');
     await 0;
     console.log('second resume');
   }
   first();
   second();
   queueMicrotask(() => console.log('queued'));
   console.log('sync end');
   ```

   **Output:** `first`, `second`, `sync end`, `first resume`, `second resume`, `queued`. Both async functions run synchronously until their first `await`; their resumptions enter the microtask queue before the explicit `queueMicrotask`.

5. **A microtask queues another microtask**

   ```js
   Promise.resolve().then(() => {
     console.log('A');
     queueMicrotask(() => console.log('C'));
     console.log('B');
   });
   queueMicrotask(() => console.log('D'));
   console.log('sync');
   ```

   **Output:** `sync`, `A`, `B`, `D`, `C`. `A`'s callback appends `C` behind `D`, which was already waiting. The browser drains the microtask queue until empty before choosing another task.

### Five original Lab 03 console experiments

1. **Promise and async order.** First run:

   ```js
   Promise.resolve(1).then(console.log);
   console.log(2);
   ```

   Output: `2`, then `1`. Now run the async puzzle, first without the timer and then with the timer line at the top:

   ```js
   async function a() {
     console.log(1);
     await null;
     console.log(2);
   }
   a();
   console.log(3);
   setTimeout(() => console.log(4), 0);
   ```

   The async output is `1`, `3`, `2`, then `4`: `await` yields to a microtask even for `null`, while the timer is a later task.

2. **HTTP error versus network error.** Run `fetch('/api/no-such-room.json').then((r) => console.log(r.ok, r.status))`. The request fulfills with `false 404`; it does not reject merely because of the status. A request to an invalid host rejects due to a network failure (often a `TypeError`). Use same-origin paths to avoid CORS masking the lesson.
3. **Sequential versus parallel waits.** Run:

   ```js
   const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
   let start = performance.now();
   await delay(1000);
   await delay(1000);
   console.log('sequential ms', (performance.now() - start).toFixed(0));
   start = performance.now();
   await Promise.all([delay(1000), delay(1000)]);
   console.log('parallel ms', (performance.now() - start).toFixed(0));
   ```

   Expect about 2000 ms then about 1000 ms, with normal timer scheduling variation.

4. **Abort a request.** For the original external demonstration, try `fetch('https://httpbin.org/delay/5', { signal: controller.signal }).catch((e) => console.log(e.name))`, then call `controller.abort()`; expect `AbortError`. This project has a local slow endpoint for controlled testing. `AbortSignal.timeout(1000)` aborts with `TimeoutError` if the request lasts longer.
5. **Unhandled rejection.** Run `Promise.reject(new Error('x'))` and observe the browser's unhandled-rejection console report. Then install `window.addEventListener('unhandledrejection', (event) => console.log(event.reason.message))` and repeat. In Node, `node -e "Promise.reject(new Error('x'))"` exits non-zero by default because Node treats the unhandled rejection as a process failure.

### Reproducible project measurements

Join any room, open the app with `?experiments=1`, then click **Compare sequential vs concurrent asset loading**. The measurement downloads the same five local manifest resources in sequence and with `Promise.all`, uses a unique cache-busting query and `cache: 'no-store'`, and records browser, time, byte count, and elapsed time. It measures local HTTP transfer/body-read time (not image/audio decode), so results depend on browser, machine, and server.

| Browser run (2026-10-29, local Vite)         | Requests | Sequential await | `Promise.all` | Bytes each | Conditions                                 |
| -------------------------------------------- | -------: | ---------------: | ------------: | ---------: | ------------------------------------------ |
| Integrated browser, Chrome 150 / Electron 43 |        5 |         14.30 ms |       4.90 ms |     21,656 | localhost, cache disabled for each request |

These are actual results from this workspace's integrated browser, not a general performance guarantee. To collect your own, capture the complete JSON in the panel and replace/add a row with browser/version and conditions. The measurement button runs only in the developer experiments panel.

### Failure gallery: actual browser run and recovery

In the Vite **development** build, the lobby exposes **Development failure gallery**. Select a case and click **Run loading failure test**. The test endpoints exist only in the Vite dev middleware; they are not included in the production bundle. The loading screen exposes the actual progress, status, and **Retry loading** button. After a failure, choose **Normal loading** in the loading screen's developer selector and retry to recover. Optional audio failures instead allow the game to continue with a status message.

These four cases were run in the integrated browser on 2026-10-29. The messages below were read from the actual loading UI; no page-level exception or unhandled rejection occurred. Chrome logged the deliberate 404 as “Failed to load resource: the server responded with a status of 404 (Not Found)”; the two slow-endpoint requests were cancelled by the timeout/abort cases and reported `net::ERR_ABORTED` in the browser's request-failure event. Each case was then retried with Normal loading selected, and all four returned to the lobby with three rooms.

| Scenario                   | Actual UI result                                                               | Recovery behavior                                                                                         | Browser verification                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Required sprite HTTP 404   | `sprites: Request failed for /api/dev/missing-sprites.svg: HTTP 404 Not Found` | Required asset blocks startup; Retry remains visible. Choose Normal loading and retry to enter the lobby. | Vite route returns HTTP 404; regression test verifies a 404 is attempted once, not retried.            |
| Arena request timeout      | `arena: signal timed out`                                                      | Timeout cancels that item; loading remains in an error state with Retry.                                  | Local slow endpoint exceeds the manifest's 250 ms timeout; no unhandled rejection.                     |
| Abort during asset loading | `Aborted by the Lab 03 failure test.`                                          | Shared controller cancels outstanding requests; the Retry button remains available.                       | The browser reports aborted slow-endpoint requests; cancellation test covers loader and lobby signals. |
| Corrupt arena JSON         | `arena: Unexpected end of JSON input`                                          | Parse error is permanent (not retried); Retry allows another attempt, and Normal loading recovers.        | Actual HTTP 200 body was invalid JSON; no unhandled rejection.                                         |

No screenshots are committed; the observed UI messages are the failure-gallery evidence. To save your own evidence, use the local Vite development page, run one failure at a time, wait for the visible error and Retry button, then press **Win+Shift+S** and capture the canvas plus error controls. For request evidence, open DevTools → **Network**, select the failed request, and capture its status/body. For console evidence, open DevTools → **Console**, enable **Preserve log**, and capture any output; the expected recovery path should not emit an unhandled rejection.

### Lab 03 reflection answers

1. **Promise states and microtasks.** A promise is pending, then settles once to fulfilled(value) or rejected(reason). A `.then` attached after fulfillment still queues a reaction; it runs as a microtask after the current JavaScript stack, not inline.
2. **Desugaring `await`.** `async function f() { const a = await g(); return a + 1; }` must call `g()` immediately, turn a synchronous throw into a rejected promise, and await its returned value. One close equivalent is:

   ```js
   function f() {
     let result;
     try {
       result = g();
     } catch (error) {
       return Promise.reject(error);
     }
     return Promise.resolve(result).then((value) => value + 1);
   }
   ```

   The async function returns control at its `await`; its continuation resumes as a microtask after `g()` settles.

3. **Ordering puzzle.** Given `setTimeout(log1); Promise.resolve().then(log2).then(log3); (async () => { log4; await 0; log5 })(); log6`, the order is `log4`, `log6`, `log2`, `log5`, `log3`, `log1`. The async IIFE logs before it suspends; the current script logs `log6`; then the first `.then` reaction is queued before the `await 0` continuation; that continuation queues the second chained reaction; the timer is a later task.
4. **The four combinators.** `all` is suitable for the required manifest assets; `allSettled` reports optional sound failures; `race` can model the first response/timeout; `any` can choose a healthy mirror. If `all` rejects, it rejects its own result immediately, but the other input operations keep running unless explicitly aborted.
5. **Why fetch accepts a 404.** HTTP status is a valid response to a network request, not a transport failure, so `fetch` fulfills with a `Response`. First await the headers and check `ok`; then separately await the body parser such as `json()`. Body streaming is separate so the browser can deliver data incrementally.
6. **Cancellation.** A controller owns an `AbortSignal`; APIs and custom work listen to that signal and reject when it is aborted. A custom function checks already-aborted input, forwards the signal to fetch, checks during delays, removes listeners/timers in cleanup, and rejects with `signal.reason`. The promise itself is not mutated with a cancel method.
7. **Promise versus event.** Use a promise for one result and an event for repeated changes. Await one event with `new Promise((resolve) => target.addEventListener('ready', resolve, { once: true }))`; publish a promise result as an event with `promise.then((value) => target.dispatchEvent(new CustomEvent('ready', { detail: value })))`, while also attaching a catch for failures.
8. **Unhandled rejection.** Browsers dispatch `unhandledrejection` and report the failure to DevTools, allowing page-level observation. Node's default policy treats it as an uncaught failure and exits non-zero. A page may continue after one failed task, while an unhandled failure in a server process may leave it in an invalid state; both surfaces make the bug visible rather than silently pretending success.

### Lab 03 requirement traceability

The table distinguishes automated evidence from actions that still need a real user/browser. A code path or test does not count as proof that a manual exercise was performed.

| Lab / requirement                                                                           | Implementation                                                                                      | Status                                                   | Actual verification                                                                                                                                                               |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lab 01: rAF, fixed accumulator, clamp, interpolation, lifecycle, metrics                    | `src/loop.js`; `src/main.js`; `src/render/draw.js`                                                  | Implemented                                              | Loop tests cover fixed steps, alpha, duplicate start/stop, and long-frame clamp; HUD tests cover steps/s, FPS, and frame time.                                                    |
| Lab 01: keyboard input, ship physics, wrap, Canvas DPR/resize, starfield/flame              | `src/input.js`; `src/sim/ship.js`; `src/sim/arena.js`; `src/render/canvas.js`; `src/render/draw.js` | Implemented; tactile feel manual                         | Simulation and input regression tests pass. Browser join and W/F input were exercised; screenshot/resizing remain user-repeatable manual checks.                                  |
| Lab 01 experiments and documentation                                                        | `src/main.js`; `src/loop.js`; combined README                                                       | Implemented; background-tab and 6× manual runs remain    | Existing Lab 01 measurements were preserved. Current default is still fixed rAF; previous manual experiment gaps remain listed in the Lab 01 audit.                               |
| Lab 02: `Vector2`, `Entity`, `Ship extends Entity`, `Map` World and iterators               | `src/sim/vector.js`; `src/sim/entity.js`; `src/sim/ship.js`; `src/sim/world.js`                     | Implemented                                              | Entity/world tests pass.                                                                                                                                                          |
| Lab 02: bullets, asteroids, collisions, health, explosions, score, pickups, homing, respawn | `src/sim/{bullet,asteroid,collision,explosion,pickup,homing,game}.js`                               | Implemented                                              | Combat and game tests pass, including safe two-second respawn.                                                                                                                    |
| Lab 02: `this`, composition, console exercises, reflection                                  | `src/sim/homing.js`; `src/sim/ship.js`; README                                                      | Implemented; console exercises manual                    | Automated receiver/composition tests pass; original explanations and exercises remain in the Lab 02 README section.                                                               |
| Lab 03 M1: `loadImage`, `loadAudio`, `loadJson`, `fetchJson`, `response.ok`, aborts         | `src/assets/loader.js`                                                                              | Implemented                                              | Loader tests cover successful/error fetches, corrupt JSON, image abort, audio decode, and status checks.                                                                          |
| Lab 03 M1: retry/backoff/jitter, no 4xx retry, cancellation cleanup                         | `src/assets/loader.js` — `withRetry`, `abortableDelay`                                              | Implemented                                              | Tests verify attempts/delays, no retry on HTTP 4xx, cancellation during backoff, and timeout propagation.                                                                         |
| Lab 03 M1: concurrent required/optional loading and item progress                           | `src/assets/loader.js` — `loadAll`; `public/assets/manifest.json`                                   | Implemented                                              | Tests prove both loaders start before either settles, progress reaches 1, optional failure is tolerated, and required failure rejects.                                            |
| Lab 03 M1: loading screen, progress, clear errors, cancellation, retry                      | `src/main.js`; `src/render/draw.js` — `drawLoadingScreen`; `index.html`                             | Implemented                                              | Integrated browser showed progress/startup and all four failure messages with retry visible.                                                                                      |
| Lab 03 M2: sprite-sheet drawing and fallback                                                | `src/render/draw.js`; `public/assets/sprites.svg`                                                   | Implemented                                              | Render tests assert all three source rectangles; browser loaded the sprite asset and entered gameplay.                                                                            |
| Lab 03 M2: Web Audio context, gesture unlock, decoded buffers, overlapping SFX              | `src/audio.js`; `src/assets/loader.js`; `src/main.js`                                               | Implemented; audible output requires manual verification | Fake-context tests verify gesture unlock, separate overlapping source nodes, and cleanup. Browser Join exercised unlock, but speakers/headphones were not independently assessed. |
| Lab 03 M2: decoupled simulation/audio/HUD events                                            | `src/sim/world.js`; `src/sim/game.js`; `src/events.js`; `src/audio.js`; `src/hud.js`                | Implemented                                              | Search confirms `src/sim/` imports neither audio nor HUD; tests cover injected events and audio subscriptions.                                                                    |
| Lab 03 M3: validated HTTP lobby, room selection, local arena config                         | `src/lobby.js`; `src/render/lobby-ui.js`; `public/api/rooms.json`; `src/main.js`                    | Implemented                                              | Browser loaded three rooms, selected Training sector, and started the game; unit tests cover validation and join event.                                                           |
| Lab 03 M3: timeout, periodic refresh, cancellation, stale-response defense                  | `src/lobby.js` — `refresh`, `start`, `stop`, `join`                                                 | Implemented                                              | Tests cover timeout recovery, abort on stop, and stale response ordering; the live lobby request and refresh ran in browser.                                                      |
| Lab 03 M4: five ordering puzzles and five original console exercises                        | README Lab 03 sections                                                                              | Written; manual console execution required               | Snippets and deterministic expected outputs are documented; they were not run as manual student exercises.                                                                        |
| Lab 03 M4: 404, timeout, abort, corrupt JSON recovery                                       | Dev-only routes in `vite.config.js`; loading UI in `src/main.js`                                    | Implemented and browser-run                              | All four messages and Retry buttons were observed; retrying with Normal loading returned to the three-room lobby; no page-level exception/unhandled rejection.                    |
| Lab 03 concurrent-vs-sequential actual timing                                               | `src/main.js` experiment panel; `README.md` result table                                            | Implemented and measured                                 | Integrated browser measured 14.30 ms sequential vs 4.90 ms concurrent for five cache-busted local requests, 21,656 bytes each.                                                    |
| Lab 03 reflection, theory, setup, architecture, failure evidence                            | README Lab 03 sections                                                                              | Written                                                  | Includes all eight answers and all required concepts; failure messages and measurements come from actual browser runs.                                                            |
| Lab 03 complete checks and `lab-03` tag                                                     | `package.json`; tests; Git                                                                          | Checks passed; local commit/tag follows                  | `npm test`: 53 passed, 0 failed; ESLint and Prettier pass; Vite production build succeeds with all public assets. The completion commit will receive the new `lab-03` tag.        |

### Lab 03 deliverable checklist

- [x] Local asset manifest with sprites, arena data, and sound effects; required/optional semantics.
- [x] Abortable image/audio/JSON loading; `fetchJson` checks HTTP status.
- [x] Concurrent `loadAll`, actual item progress, exponential backoff/jitter, cancellation, no HTTP 4xx retry.
- [x] Canvas loading screen, status/error text, cancel and retry controls.
- [x] Spritesheet drawImage source rectangles plus procedural fallback.
- [x] Web Audio decode during loading, click-path unlock, overlapping source nodes.
- [x] Injected `EventTarget`/`CustomEvent` event boundary; simulation imports no audio or HUD module.
- [x] Static HTTP lobby, validated room data, room configuration, timed periodic refresh, cancellation, stale-response guard.
- [x] Five task/microtask puzzles, five original console experiments, all eight Lab 03 reflection answers.
- [x] Actual sequential/concurrent browser timing and all four development failure modes exercised.
- [ ] Manually listen to the effects on the target device, execute the console exercises yourself, and capture screenshots if required by the instructor. Browser automation already exercised all four retry-to-normal paths.
- [x] Final tests, lint, formatting check, and production build pass; create the Lab 03 commit and `lab-03` tag locally. No push is performed.

The optional Lab 03 stretch—byte-level stream progress, priority async-generator loading, and hand-written `Promise.all`/`allSettled`—is not implemented; it is not part of the required definition of done.
