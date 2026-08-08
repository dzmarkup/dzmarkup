const pageSizes = {
  '8.5x11': { width: 612, height: 792 },
  '11x17': { width: 792, height: 1224 },
};

export function getDims(size, orientation) {
  const s = pageSizes[size] || pageSizes['8.5x11'];
  return orientation === 'landscape'
    ? { width: s.height, height: s.width }
    : { width: s.width, height: s.height };
}

function wrapText(text, font, fontSize, maxWidth) {
  const paragraphs = text.split('\n');
  const lines = [];
  for (const para of paragraphs) {
    if (para.trim() === '') { lines.push(''); continue; }
    const words = para.split(' ');
    let line = '';
    for (const word of words) {
      const testLine = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(testLine, fontSize) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = testLine;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

export function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function generatePDF(items, filename) {
  const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
  const outDoc = await PDFDocument.create();
  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  const included = items.filter((i) => i.included);
  if (included.length === 0) throw new Error('No items selected to include.');

  for (const item of included) {
    if (item.type === 'pdf') {
      const srcDoc = await PDFDocument.load(item.data);
      const copiedPages = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
      copiedPages.forEach((p) => outDoc.addPage(p));
    } else if (item.type === 'image') {
      const dims = getDims(item.pageSize, item.orientation);
      const page = outDoc.addPage([dims.width, dims.height]);
      const img = item.imageType === 'jpg' ? await outDoc.embedJpg(item.data) : await outDoc.embedPng(item.data);
      const scale = Math.min(dims.width / img.width, dims.height / img.height) * 0.92;
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: (dims.width - w) / 2, y: (dims.height - h) / 2, width: w, height: h });
    } else {
      const dims = getDims(item.pageSize, item.orientation);
      const margin = 54;
      const fontSize = 12;
      const lineHeight = fontSize * 1.4;
      const maxWidth = dims.width - margin * 2;
      const lines = wrapText(item.content, font, fontSize, maxWidth);
      let page = outDoc.addPage([dims.width, dims.height]);
      let y = dims.height - margin;
      for (const line of lines) {
        if (y < margin) {
          page = outDoc.addPage([dims.width, dims.height]);
          y = dims.height - margin;
        }
        page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0.11, 0.12, 0.13) });
        y -= lineHeight;
      }
    }
  }

  const bytes = await outDoc.save();
  downloadBytes(bytes, filename);
}
