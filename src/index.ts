import { getDocument } from 'pdfjs-dist';
import PassportOCR from './passport';
import type { PassportOCRHistory } from './passport/targets';
import KTPCardOCR, { KTPCardOCRHistory } from './ktp';

const ocrFileInput = document.querySelector<HTMLInputElement>("#ocr_file")!;
const ocrExecuteButton = document.querySelector<HTMLButtonElement>("#ocr_exec")!;
const ocrResultTextarea = document.querySelector<HTMLTextAreaElement>("#ocr_result")!;
const ocrErrorText = document.querySelector<HTMLParagraphElement>("#ocr_error")!;
const ocrSourceImageContainer = document.querySelector<HTMLDivElement>("#ocr_src_img_container")!;
const ocrProcessedImageContainer = document.querySelector<HTMLDivElement>("#ocr_proc_img_container")!;
const ocrCorrectResultButton = document.querySelector<HTMLButtonElement>("#ocr_correct_result")!;
const ocrHistoryTable = document.querySelector<HTMLTableElement>("#ocr_history")!;
const temporaryCanvas = document.createElement("canvas");


const history: PassportOCRHistory = {};

const OCR = new PassportOCR({
  // onProcessImage: (objectUrl) => {
  //   const processedImage = document.createElement("img");
  //   processedImage.src = objectUrl;
  //   processedImage.alt = "Canvas";
  //   ocrProcessedImageContainer.innerHTML = '';
  //   ocrProcessedImageContainer.appendChild(processedImage);
  // },
  history,
});

ocrFileInput.addEventListener("input", async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  ocrSourceImageContainer.innerHTML = '';
  OCR.canvas.clear();
  if (!file) return;
  const img = document.createElement("img");
  if (file.type === "application/pdf") {
    const pdf = await getDocument(await file.arrayBuffer()).promise;
    const firstPage = await pdf.getPage(1);
    const viewport = firstPage.getViewport({
      scale: 1,
    });

    temporaryCanvas.width = viewport.width;
    temporaryCanvas.height = viewport.height;
    const canvasContext = temporaryCanvas.getContext('2d')!;
    await firstPage.render({ canvasContext, viewport }).promise;
    img.src = temporaryCanvas.toDataURL();
  } else {
    img.src = URL.createObjectURL(file);
  }
  img.alt = file.name;
  ocrSourceImageContainer.appendChild(img);
});

ocrExecuteButton.addEventListener("click", async () => {
  if (ocrFileInput.files!.length === 0) {
    alert("No files specified");
    return;
  }
  ocrExecuteButton.disabled = true;
  console.time();
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
  console.timeEnd();
});

ocrCorrectResultButton.addEventListener("click", () => {
  const rawResult = ocrResultTextarea.value;
  if (!rawResult) {
    alert("No result available!");
    return;
  }
  try {
    const result = JSON.parse(rawResult);
    const history = OCR.updateHistory(result);
    const tableRows = [];

    for (let key of Object.keys(history)) {
      const historyWords = history[key as keyof typeof history];
      if (!historyWords) continue;

      const tableRow = document.createElement("tr");
      const tableHead = document.createElement("th");
      tableHead.innerText = key;
      tableRow.appendChild(tableHead);

      tableRow.append(...historyWords.map(word => {
        const tableCell = document.createElement("td");
        tableCell.innerText = word;
        return tableCell;
      }));
      tableRows.push(tableRow);
    }
    ocrHistoryTable.innerHTML = '';
    ocrHistoryTable.append(...tableRows);
    ocrErrorText.innerText = '';
  } catch (e: any) {
    ocrErrorText.innerText = e.toString();
  }
});