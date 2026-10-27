const sharp = require('sharp');
const fs = require('fs');
(async () => {
  const grad = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2000"><defs><linearGradient id="g"><stop offset="0" stop-color="#e33"/><stop offset="1" stop-color="#33e"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="1500" cy="1000" r="600" fill="#ff0" opacity=".7"/></svg>`);
  await sharp(grad).jpeg({ quality: 95 }).toFile('test/in/photo big.jpg');
  await sharp(grad).resize(800).png().toFile('test/in/sub/graphic.png');
  fs.writeFileSync('test/in/logo.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="45" fill="#0a7"/><text x="50" y="58" font-size="24" text-anchor="middle" fill="#fff">PB</text></svg>`);
  const frames = await Promise.all([0, 1, 2, 3].map(i => sharp({ create: { width: 400, height: 300, channels: 4, background: { r: i * 60, g: 120, b: 255 - i * 60, alpha: 1 } } }).png().toBuffer()));
  await sharp(frames, { join: { animated: true } }).gif({ delay: 200 }).toFile('test/in/anim.gif');
  const page = (c) => `q ${c} rg 72 72 451 698 re f Q BT /F1 48 Tf 100 400 Td (Page) Tj ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    `<< /Length ${page('1 0.5 0').length} >>\nstream\n${page('1 0.5 0')}\nendstream`,
    `<< /Length ${page('0 0.5 1').length} >>\nstream\n${page('0 0.5 1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n', offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  fs.writeFileSync('test/in/doc.pdf', pdf);
  console.log('samples ok');
})();
