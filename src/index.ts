import PassportOCR from './ocr';

const ocrFileInput = document.querySelector<HTMLInputElement>("#ocr_file")!;
const ocrExecuteButton = document.querySelector<HTMLButtonElement>("#ocr_exec")!;
const ocrResultTextarea = document.querySelector<HTMLTextAreaElement>("#ocr_result")!;
const ocrErrorText = document.querySelector<HTMLParagraphElement>("#ocr_error")!;
const ocrSourceImageContainer = document.querySelector<HTMLDivElement>("#ocr_src_img_container")!;
const ocrProcessedImageContainer = document.querySelector<HTMLDivElement>("#ocr_proc_img_container")!;

const OCR = new PassportOCR({
  onProcessImage: (objectUrl) => {
    const processedImage = document.createElement("img");
    processedImage.src = objectUrl;
    processedImage.alt = "Canvas";
    ocrProcessedImageContainer.innerHTML = '';
    ocrProcessedImageContainer.appendChild(processedImage);
  }
});

ocrFileInput.addEventListener("input", async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  ocrSourceImageContainer.innerHTML = '';
  OCR.clearCanvas();
  if (!file) return;
  const img = document.createElement("img");
  img.src = URL.createObjectURL(file);
  img.alt = file.name;
  ocrSourceImageContainer.appendChild(img);
});

ocrExecuteButton.addEventListener("click", async () => {
  if (ocrFileInput.files!.length === 0) {
    alert("No files specified");
    return;
  }
  ocrExecuteButton.disabled = true;
  try {
    const file = ocrFileInput.files![0];
    await OCR.mountFile(file);

    const result = await OCR.run();

    ocrResultTextarea.value = JSON.stringify(result);
    ocrErrorText.innerText = '';
  } catch (e: any) {
    ocrResultTextarea.value = '';
    ocrErrorText.innerText = e.toString();
    console.error(e);
  } finally {
    ocrExecuteButton.disabled = false;
  }
});