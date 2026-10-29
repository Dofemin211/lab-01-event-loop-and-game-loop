export function createCanvas(canvas) {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('This browser could not create a Canvas 2D context.');
  }

  let width = 0;
  let height = 0;

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  window.addEventListener('resize', resize);
  resize();

  return {
    canvas,
    context,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
  };
}
