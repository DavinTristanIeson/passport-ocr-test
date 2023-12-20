const canvas = document.querySelector<HTMLCanvasElement>("#visualizer")!;
const fileInput = document.querySelector<HTMLInputElement>("#visualizer_file")!;
const posX = document.querySelector<HTMLSpanElement>("#pos-x")!;
const posY = document.querySelector<HTMLSpanElement>("#pos-y")!;

fileInput.addEventListener("input", async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  const ctx = canvas.getContext('2d')!;
  if (!file) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const img = new Image();
  img.src = URL.createObjectURL(file);
  img.alt = file.name;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
  });
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);
});

canvas.addEventListener("mousemove", (ev) => {
  const canvasSize = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(ev.clientX - canvasSize.left, canvas.width));
  const y = Math.max(0, Math.min(ev.clientY - canvasSize.top, canvas.height));
  posX.innerText = `${x} (${x / canvas.width})`;
  posY.innerText = `${y} (${y / canvas.height})`;
});
